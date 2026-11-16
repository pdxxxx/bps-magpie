import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,sse,event,completed,message} from './helpers.mjs';

const manager={current:async f=>f()};
const cmd="Write-Output 'hello'";
const declaration={type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'},workdir:{type:'string'}},required:['cmd'],additionalProperties:false}};
const wrapper=(summary='Run command',code=cmd,id='original')=>({type:'function_call',id:'fc_'+id,call_id:'call_'+id,name:'run_officejs',arguments:JSON.stringify({summary,code,extended_summary:'{}',destructive:false,references:[]}),status:'completed'});
const native=(items,id='response-original')=>{const result=completed(items);result.response.id=id;return result;};
const send=(fetch,stream=false,patch={})=>fetch(BASE_URL+'/responses',{headers:{'x-bps-session':'repair-test'},body:JSON.stringify({model:'gpt-6-astra',input:'Run one command',tools:[declaration],stream,...patch})});

test('raw command with missing marker is corrected before dispatch using the same account and operation',async()=>{
 let calls=0,firstClosed=false,repairClosed=false;
 const open=(value,onCancel)=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event(value)));},cancel(){onCancel();}}),{headers:{'content-type':'text/event-stream'}});
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,BASE_URL+'/responses');assert.equal(init.headers.get('chatgpt-account-id'),'workspace-a');
  if(calls===1)return open(native([wrapper()]),()=>{firstClosed=true;});
  assert.equal(firstClosed,true);const wire=JSON.parse(init.body);
  assert.equal(wire.metadata.agent_iteration,'2');assert.equal(wire.reasoning_effort,'medium');
  assert.ok(wire.input.some(i=>i.type==='function_call_output'&&JSON.parse(i.output).executed===false));
  assert.equal(wire.input.filter(i=>i.type==='function_call').at(-1).call_id,'call_original');
  return open(native([wrapper('codex2api.function_cmd/exec_command',cmd,'fixed')],'repair-response'),()=>{repairClosed=true;});
 }});
 const response=await send(fetch);assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.id,'response-original');assert.equal(result.output[0].name,'exec_command');
 assert.equal(JSON.parse(result.output[0].arguments).cmd,cmd);assert.equal(result.output[0].call_id,'call_fixed');
 assert.equal(result.usage.total_tokens,26);assert.equal(calls,2);assert.equal(repairClosed,true);
});

test('streaming correction withholds invalid tools and retains already streamed text exactly once',async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>++calls===1?sse([{type:'response.output_text.delta',delta:'VISIBLE_ONCE'},native([message('VISIBLE_ONCE'),wrapper()])]):sse([native([message('HIDDEN_REPAIR_TEXT'),wrapper('codex2api.function_cmd/exec_command',cmd,'fixed')])])});
 const response=await send(fetch,true);const text=await response.text();
 assert.doesNotMatch(text,/HIDDEN_REPAIR_TEXT|"kind":"repair"|run_officejs|response.failed/);
 assert.equal((text.match(/event: response.output_text.delta/g)||[]).length,1);
 assert.equal((text.match(/event: response.function_call_arguments.done/g)||[]).length,1);
 assert.equal((text.match(/event: response.completed/g)||[]).length,1);assert.equal(calls,2);
});

test('correction cannot change a known tool target or execute a new operation',async()=>{
 const codeTool={type:'function',name:'run_code',parameters:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}};
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{
  calls++;if(calls===1)return sse([native([wrapper('codex2api.function_cmd/exec_command')])]);
  assert.fail('A valid command must not be corrected');
 }});
 // A declared raw-code target with invalid metadata can request correction;
 // the replacement remains bound to that exact target.
 const invalid=wrapper('codex2api.function_code/run_code','text(1)');
 const args=JSON.parse(invalid.arguments);args.extended_summary='not-json';invalid.arguments=JSON.stringify(args);
 let rejectedCalls=0;
 const rejected=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>++rejectedCalls===1?sse([native([invalid])]):sse([native([wrapper('codex2api.function_cmd/exec_command','text(1)','other')])])});
 assert.equal((await send(fetch)).status,200);assert.equal(calls,1);
 const response=await send(rejected,false,{tools:[declaration,codeTool]});assert.equal(response.status,502);const result=await response.json();
 assert.deepEqual(result.output,[]);assert.match(result.error.message,/changed an operation/);assert.equal(rejectedCalls,2);
});

test('correcting a raw payload restores its original bytes instead of accepting edited code',async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>++calls===1?sse([native([wrapper()])]):sse([native([wrapper('codex2api.function_cmd/exec_command','CHANGED_CODE','fixed')])])});
 const response=await send(fetch);assert.equal(response.status,200);const result=await response.json();
 assert.equal(JSON.parse(result.output[0].arguments).cmd,cmd);assert.doesNotMatch(JSON.stringify(result),/CHANGED_CODE/);assert.equal(calls,2);
});

test('invalid correction stops after two attempts and keeps aggregate usage',async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse([native([wrapper()],'attempt-'+calls)]);}});
 const response=await send(fetch);assert.equal(response.status,502);const result=await response.json();
 assert.match(result.error.message,/after 2 corrections/);assert.deepEqual(result.output,[]);assert.equal(result.usage.total_tokens,39);assert.equal(calls,3);
});

test('unknown tools, schema failures, disabled tools and incomplete responses are not automatically regenerated',async()=>{
 for(const mode of ['unknown','schema','none','incomplete']){
  let calls=0;const item=wrapper();const args=JSON.parse(item.arguments);
  if(mode==='unknown')args.code=JSON.stringify({name:'not_declared',arguments:{}});
  if(mode==='schema')args.code=JSON.stringify({name:'exec_command',arguments:{cmd:123}});
  item.arguments=JSON.stringify(args);
  const end=native([item]);if(mode==='incomplete'){end.type='response.incomplete';end.response.status='incomplete';end.response.incomplete_details={reason:'max_output_tokens'};}
  const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse([end]);}});
  const response=await send(fetch,false,mode==='none'?{tool_choice:'none'}:{});assert.equal(response.status,mode==='incomplete'?200:502);const result=await response.json();
  assert.deepEqual(result.output,[]);assert.equal(calls,1);
  if(mode==='incomplete')assert.equal(result.incomplete_details.reason,'max_output_tokens');
 }
});

test('HTTP refusal and invalid correction stream fail once without leaking upstream bodies',async()=>{
 for(const status of [401,403,429,200]){
  let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>++calls===1?sse([native([wrapper()])]):new Response('PRIVATE_UPSTREAM_BODY',{status})});
  const response=await send(fetch);assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/PRIVATE_UPSTREAM_BODY/);assert.equal(calls,2);
 }
});

test('client cancellation terminates a stalled correction and does not launch another request',async()=>{
 let calls=0,started;const ready=new Promise(r=>{started=r;});const abort=new AbortController();
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{
  if(++calls===1)return sse([native([wrapper()])]);started();
  return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
 }});
 const pending=fetch(BASE_URL+'/responses',{signal:abort.signal,body:JSON.stringify({model:'gpt-6-astra',input:'test',tools:[declaration]})});
 await ready;abort.abort(new Error('cancel-correction'));await assert.rejects(pending,/cancel-correction/);assert.equal(calls,2);
});

test('custom patch correction preserves a large raw payload across framed stream boundaries',async()=>{
 const patch='*** Begin Patch\n*** Add File: example.txt\n'+'+原始内容\n'.repeat(12000)+'*** End Patch';
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{
  calls++;return sse([native([wrapper(calls===1?'Apply patch':'codex2api.custom/apply_patch',patch,calls===1?'bad':'fixed')])]);
 }});
 const response=await send(fetch,false,{tools:[{type:'custom',name:'apply_patch',format:{type:'text'}}]});
 assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.output[0].type,'custom_tool_call');assert.equal(result.output[0].input,patch);assert.equal(calls,2);
});

test('trailing primary events cannot be mistaken for the correction response',async()=>{
 let calls=0;const wrong=native([wrapper('codex2api.function_cmd/exec_command','WRONG_OPERATION','wrong')],'wrong-stream');
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>++calls===1?sse([native([wrapper()]),wrong]):sse([native([wrapper('codex2api.function_cmd/exec_command',cmd,'fixed')])])});
 const response=await send(fetch);assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.output[0].call_id,'call_fixed');assert.doesNotMatch(JSON.stringify(result),/WRONG_OPERATION|wrong-stream/);assert.equal(calls,2);
});

test('a stalled correction is subject to the same progress deadline without another correction',async()=>{
 let calls=0,cancelled=false;
 const fetch=makeFetch(async()=>auth(),manager,{}, {streamIdleMs:50,fetchImpl:async()=>++calls===1?sse([native([wrapper()])]):new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
 const response=await send(fetch);assert.equal(response.status,504);const result=await response.json();assert.equal(result.error.code,'basispoints_stream_timeout');assert.equal(calls,2);assert.equal(cancelled,true);
});
