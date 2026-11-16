import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,event,completed} from './helpers.mjs';
import {progressReader} from '../src/progress.mjs';

const encoder=new TextEncoder();
const manager={current:async getAuth=>getAuth()};
const send=(fetch,stream=false)=>fetch(BASE_URL+'/responses',{body:JSON.stringify({model:'gpt-6-astra',input:'progress check',stream})});

test('silent upstream fails promptly without replay and releases its connection',async()=>{
 let calls=0,cancelled=false;
 const fetch=makeFetch(async()=>auth(),manager,{timeoutMs:2000},{streamIdleMs:50,fetchImpl:async()=>{
  calls++;return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(event({type:'response.created',response:{id:'idle',status:'in_progress',output:[]}})));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 }});
 const start=Date.now();const response=await send(fetch);
 assert.equal(response.status,504);assert.equal((await response.json()).error.code,'basispoints_stream_timeout');
 assert.ok(Date.now()-start<1000);assert.equal(calls,1);assert.equal(cancelled,true);
});

test('comment-only keepalives do not conceal a stalled streaming response',async()=>{
 let interval,calls=0,cancelled=false;
 const fetch=makeFetch(async()=>auth(),manager,{timeoutMs:2000},{streamIdleMs:70,fetchImpl:async()=>{
  calls++;return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(event({type:'response.output_text.delta',delta:'first'})));interval=setInterval(()=>c.enqueue(encoder.encode(': keepalive\r\n\r\n')),10);},cancel(){clearInterval(interval);cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 }});
 try{
  const response=await send(fetch,true);const text=await response.text();
  assert.match(text,/first/);assert.match(text,/response.failed/);assert.match(text,/basispoints_stream_timeout/);
  assert.doesNotMatch(text,/response.completed/);assert.equal(calls,1);assert.equal(cancelled,true);
 }finally{clearInterval(interval);}
});

test('fragmented data replenishes upstream wait budget and successful terminal cancels an open connection',async()=>{
 let interval,cancelled=false;
 const encoded=encoder.encode(event(completed()));let offset=0;
 const fetch=makeFetch(async()=>auth(),manager,{timeoutMs:2000},{streamIdleMs:80,fetchImpl:async()=>new Response(new ReadableStream({start(c){interval=setInterval(()=>{if(offset<encoded.length){c.enqueue(encoded.slice(offset,offset+100));offset+=100;}},25);},cancel(){clearInterval(interval);cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
 try{const response=await send(fetch);assert.equal(response.status,200,await response.text());assert.equal(cancelled,true);}finally{clearInterval(interval);}
});

test('truncated upstream after streaming begins reports one explicit failure terminal',async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return new Response(event({type:'response.output_text.delta',delta:'partial'}),{headers:{'content-type':'text/event-stream'}});}});
 const response=await send(fetch,true);const text=await response.text();
 assert.match(text,/partial/);assert.equal((text.match(/event: response.failed/g)||[]).length,1);assert.match(text,/basispoints_transport_error/);assert.equal(calls,1);
});

test('total timeout after streaming starts reports a terminal instead of hanging or replaying',async()=>{
 let calls=0,interval;
 const fetch=makeFetch(async()=>auth(),manager,{timeoutMs:1000},{streamIdleMs:2000,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(c){interval=setInterval(()=>c.enqueue(encoder.encode(event({type:'response.reasoning_summary_text.delta',delta:'thinking'}))),80);},cancel(){clearInterval(interval);}}),{headers:{'content-type':'text/event-stream'}});}});
 try{const response=await send(fetch,true);const text=await response.text();assert.match(text,/basispoints_timeout/);assert.match(text,/response.failed/);assert.equal(calls,1);}finally{clearInterval(interval);}
});

test('downstream pauses do not consume the upstream progress budget',async()=>{
 let n=0;
 const reader=progressReader(new ReadableStream({pull(c){c.enqueue(encoder.encode('data: chunk-'+n+++'\n\n'));}}),{idleMs:30});
 try{assert.equal((await reader.read()).done,false);await new Promise(r=>setTimeout(r,100));assert.equal((await reader.read()).done,false);}finally{reader.cancel();}
});

test('progress timeout remains bounded when the upstream cancellation callback never resolves',async()=>{
 let cancelled=false;
 const reader=progressReader(new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}}),{idleMs:30});
 const start=Date.now();await assert.rejects(reader.read(),{code:'basispoints_stream_timeout'});assert.ok(Date.now()-start<500);assert.equal(cancelled,true);
});
