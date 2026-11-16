import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {createRequestMetrics} from '../src/metrics.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {createConversationStore} from '../src/state.mjs';
import {auth,sse,event,completed,message,tool,toolDeclaration} from './helpers.mjs';

const manager={current:async f=>f()};
const body={model:'gpt-6-astra',input:'PRIVATE_PROMPT',tools:[toolDeclaration]};
const send=(fetch,patch={},signal)=>fetch(BASE_URL+'/responses',{signal,body:JSON.stringify({...body,...patch})});
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('metrics distinguish upstream arrival from validated tools and never export payloads',async()=>{
 const rows=[];let gate;
 const released=new Promise(r=>{gate=r;});
 const native=tool();const terminal=completed([native]);
 terminal.response.usage={input_tokens:30,input_tokens_details:{cached_tokens:20},output_tokens:10,output_tokens_details:{reasoning_tokens:4}};
 const fetch=makeFetch(async()=>auth(),manager,{}, {onMetrics:r=>rows.push(r),fetchImpl:async()=>new Response(new ReadableStream({
  async start(c){c.enqueue(new TextEncoder().encode(event({type:'response.function_call_arguments.delta',delta:'PRIVATE_ARGUMENTS'})));await delay(20);c.enqueue(new TextEncoder().encode(event(terminal)));c.close();gate();}
 }),{headers:{'content-type':'text/event-stream'}})});
 const response=await send(fetch,{stream:true});const text=await response.text();await released;
 assert.match(text,/response.completed/);assert.equal(rows.length,1);
 const r=rows[0];assert.equal(r.outcome,'completed');assert.equal(r.tool_calls,1);
 assert.ok(r.client_first_tool_ms>=r.upstream_first_tool_ms+10);
 assert.ok(r.total_ms>=r.validated_terminal_ms);assert.equal(r.input_tokens,30);assert.equal(r.cached_tokens,20);assert.equal(r.reasoning_tokens,4);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|workspace|test-refresh|run_officejs|echo/);
 assert.ok(Object.values(r).every(v=>typeof v==='number'||v==='completed'));
});

test('metrics finish exactly once for buffered, HTTP failure, rejection and stream cancellation',async()=>{
 for(const kind of ['buffered','http','reject','cancel']){
  const rows=[];const fetch=makeFetch(async()=>auth(),manager,{}, {onMetrics:r=>rows.push(r),fetchImpl:async()=>{
   if(kind==='http')return new Response('PRIVATE_ERROR',{status:429});
   if(kind==='cancel')return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event({type:'response.output_text.delta',delta:'one'})));}}),{headers:{'content-type':'text/event-stream'}});
   return sse();
  }});
  const response=await send(fetch,kind==='reject'?{model:''}:kind==='cancel'?{stream:true}:{});
  if(kind==='cancel'){const reader=response.body.getReader();await reader.read();await reader.cancel();}else await response.text();
  assert.equal(rows.length,1,kind);assert.equal(rows[0].outcome,{buffered:'completed',http:'http_error',reject:'error',cancel:'cancelled'}[kind]);
 }
});

test('metrics record failed requests cancelled before headers and isolate a failing sink',async()=>{
 let started;const ready=new Promise(r=>{started=r;});const rows=[],controller=new AbortController();
 const fetch=makeFetch(async()=>auth(),manager,{}, {onMetrics:r=>rows.push(r),fetchImpl:async(_u,i)=>{started();return new Promise((_,reject)=>i.signal.addEventListener('abort',()=>reject(i.signal.reason),{once:true}));}});
 const pending=send(fetch,{},controller.signal);await ready;controller.abort(new Error('PRIVATE_REASON'));await assert.rejects(pending);
 assert.equal(rows.length,1);assert.equal(rows[0].outcome,'cancelled');assert.ok(rows[0].headers_ms>=0);
 for(const sink of [()=>{throw Error('sink');},async()=>{throw Error('sink');}]){
  const safe=makeFetch(async()=>auth(),manager,{}, {onMetrics:sink,fetchImpl:async()=>sse()});assert.equal((await send(safe)).status,200);
 }
});

test('repair timing and tokens include the correction round',async()=>{
 const rows=[];let calls=0;
 const declaration={type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd'],additionalProperties:false}};
 const native=fixed=>({...tool(),call_id:fixed?'call_fixed':'call_bad',arguments:JSON.stringify({summary:fixed?'codex2api.function_cmd/exec_command':'Run command',code:'echo probe',extended_summary:'{}',destructive:false,references:[]})});
 const fetch=makeFetch(async()=>auth(),manager,{}, {onMetrics:r=>rows.push(r),fetchImpl:async()=>{calls++;await delay(10);return sse([completed([native(calls>1)])]);}});
 const response=await send(fetch,{tools:[declaration]});assert.equal(response.status,200);assert.equal(calls,2);
 assert.equal(rows.length,1);assert.equal(rows[0].repair_count,1);assert.ok(rows[0].repair_ms>=9);assert.equal(rows[0].input_tokens,20);
});

test('optional observer handles split SSE and isolates malformed events',()=>{
 let time=0;const rows=[];const m=createRequestMetrics(r=>rows.push(r),()=>time);
 m.start('prepare_ms');time=10;m.start('upload_ms');time=30;m.end('upload_ms');time=40;m.end('prepare_ms');
 const p=m.observer('client');const bytes=new TextEncoder().encode(event(completed([message('PRIVATE')])));
 for(let n=0;n<bytes.length;n+=3)p.push(bytes.slice(n,n+3));
 m.observer('upstream').push(new TextEncoder().encode('data: broken\n\n'));
 time=50;m.finish();m.finish('failed');assert.equal(rows.length,1);assert.equal(rows[0].prepare_local_ms,20);assert.equal(rows[0].observer_errors,1);assert.equal(rows[0].outcome,'completed');
 assert.equal(createRequestMetrics(),null);
});

test('upload and scope queue timings are separated from local preparation',async()=>{
 const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=';
 const rows=[];let uploadStarted,finishUpload;
 const ready=new Promise(r=>{uploadStarted=r;});const release=new Promise(r=>{finishUpload=r;});
 const fetch=makeFetch(async()=>auth(),manager,{}, {state:createConversationStore(),onMetrics:r=>rows.push(r),fetchImpl:async url=>{
  if(url.endsWith('/attachments')){uploadStarted();await release;return Response.json({openai_file_id:'file-probe'});}
  return sse();
 }});
 const call=input=>fetch(BASE_URL+'/responses',{headers:{'x-bps-session':'shared'},body:JSON.stringify({...body,input})});
 const first=call([{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+image},{type:'input_text',text:'probe'}]}]);
 await ready;const second=call('queued');await delay(25);finishUpload();await Promise.all([first,second]);
 assert.equal(rows.length,2);const upload=rows.find(r=>r.upload_count===1),queued=rows.find(r=>r.upload_count===0);
 assert.ok(upload.upload_ms>=20);assert.ok(queued.scope_queue_ms>=15);
 assert.ok(Math.abs(upload.prepare_ms-upload.prepare_local_ms-upload.upload_ms)<0.03);
 assert.equal(queued.upload_ms,0);
});
