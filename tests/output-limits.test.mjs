import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {createConversationStore} from '../src/state.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,sse,completed,tool,toolDeclaration} from './helpers.mjs';
const manager={current:async f=>f()};

test('a true output-limit terminal preserves reason and reasoning usage without dispatching unfinished tools',async()=>{
 for(const stream of [false,true]){
  let calls=0;const state=createConversationStore();
  const end=completed([tool()]);end.type='response.incomplete';end.response.status='incomplete';end.response.incomplete_details={reason:'max_output_tokens'};
  end.response.usage={input_tokens:200,output_tokens:1000,output_tokens_details:{reasoning_tokens:900},total_tokens:1200};
  const fetch=makeFetch(async()=>auth(),manager,{}, {state,fetchImpl:async()=>{calls++;return sse([{type:'response.output_item.done',item:tool()},end]);}});
  const response=await fetch(BASE_URL+'/responses',{headers:{'x-bps-session':'output-limit'},body:JSON.stringify({model:'gpt-6-astra',input:'generate an artifact',stream,tools:[toolDeclaration]})});
  assert.equal(response.status,200);const text=await response.text();
  assert.match(text,/max_output_tokens/);assert.match(text,/reasoning_tokens/);assert.match(text,/900/);
  assert.doesNotMatch(text,/"name":"echo"|"name":"run_officejs"|response.completed/);
  assert.equal(calls,1,'an accepted, output-limited generation must not be silently retried');
  const next=await fetch(BASE_URL+'/responses',{headers:{'x-bps-session':'output-limit'},body:JSON.stringify({model:'gpt-6-astra',previous_response_id:'resp_test',input:'continue'})});
  assert.equal(next.status,400);assert.equal(calls,1,'incomplete tool history must not enter continuation cache');
 }
});

test('client output-limit fields are not forwarded as unsupported BPS wire fields',async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{
  const wire=JSON.parse(init.body);
  assert.equal(wire.max_output_tokens,undefined);assert.equal(wire.max_tokens,undefined);assert.equal(wire.max_completion_tokens,undefined);
  return sse();
 }});
 const response=await fetch(BASE_URL+'/responses',{body:JSON.stringify({model:'gpt-6-astra',input:'short answer',max_output_tokens:4096,max_tokens:4096,max_completion_tokens:4096})});
 assert.equal(response.status,200);
});
