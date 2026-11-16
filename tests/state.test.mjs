import test from "node:test";
import assert from "node:assert/strict";
import {createConversationStore,conversationScope} from "../src/state.mjs";
import {makeFetch} from "../src/provider.mjs";
import {BASE_URL} from "../src/constants.mjs";
import {auth,sse,completed,message,tool,toolDeclaration,event} from "./helpers.mjs";

const headers={"x-bps-session":"session-a"};
const scope=()=>conversationScope(auth(),new Headers(headers),"gpt-6-astra");
const context=Buffer.from('{"model":"gpt-6-astra","input":[]}');
const terminal=(id,output=[message()])=>{const e=completed(output);e.response.id=id;return e;};
const manager={current:async fn=>fn()};
const request=(fetch,body,extraHeaders={},route="/responses")=>fetch(BASE_URL+route,{headers:{...headers,...extraHeaders},body:JSON.stringify({model:"gpt-6-astra",input:"hello",...body})});

test("cache enforces TTL, byte limits, LRU eviction and conflicting response IDs",()=>{
 let time=0;const cache=createConversationStore({maxEntries:2,maxBytes:2000,maxEntryBytes:1000,ttlMs:100,now:()=>time});const s=scope();
 for(const id of ["one","two","three"]){const e=terminal(id);assert.equal(cache.complete(s,context,e,JSON.stringify(e)),true);}
 assert.throws(()=>cache.snapshot(s,"one"),/unavailable/);assert.ok(cache.snapshot(s,"three").previous);
 const conflict=terminal("three",[message("different")]);assert.equal(cache.complete(s,context,conflict,JSON.stringify(conflict)),false);assert.throws(()=>cache.snapshot(s,"three"),/unavailable/);
 assert.equal(cache.complete(s,context,terminal("large"),"x".repeat(2000)),false);assert.ok(cache.diagnostics().bytes<=2000);
 time=101;assert.equal(cache.diagnostics().entries,0);
});
test("scope isolates accounts, models and child thread headers",()=>{
 const first=scope();assert.notEqual(first.key,conversationScope({...auth(),workspaceId:"other"},new Headers(headers),"gpt-6-astra").key);
 assert.notEqual(first.key,conversationScope(auth(),new Headers(headers),"other-model").key);
 assert.notEqual(first.key,conversationScope(auth(),new Headers({...headers,"thread-id":"child"}),"gpt-6-astra").key);
 assert.equal(conversationScope(auth(),new Headers(),"gpt-6-astra"),null);
});
test("cancelled preparation cannot break another request's catalog lock",async()=>{
 const cache=createConversationStore();const s=scope();let release;const gate=new Promise(r=>{release=r;});const order=[];
 const first=cache.serial(s,undefined,async()=>{order.push("start");await gate;order.push("end");});
 const abort=new AbortController();const second=cache.serial(s,abort.signal,()=>assert.fail("cancelled request ran"));abort.abort(new Error("cancelled"));await assert.rejects(second,/cancelled/);
 const third=cache.serial(s,undefined,()=>order.push("third"));release();await Promise.all([first,third]);assert.deepEqual(order,["start","end","third"]);
});
test("previous_response_id expands history but never carries old instructions",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{
  calls++;const wire=init.body.toString();if(calls===2){assert.match(wire,/first-user/);assert.match(wire,/first-answer/);assert.match(wire,/second-user/);assert.match(wire,/new-instructions/);assert.doesNotMatch(wire,/old-instructions|previous_response_id/);}
  return sse([terminal("r"+calls,[message(calls===1?"first-answer":"second-answer")])]);
 }});
 const first=await request(fetch,{input:"first-user",instructions:"old-instructions"});assert.equal(first.status,200);assert.equal(first.headers.get("x-bps-continuation"),"cached");
 const response=await request(fetch,{previous_response_id:"r1",input:"second-user",instructions:"new-instructions"});assert.equal(response.status,200,await response.text());assert.equal(calls,2);
});
test("tool output continuation inherits the declared catalog and explicit [] clears it",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{
  calls++;if(calls===1)return sse([terminal("tool-parent",[tool()])]);
  if(calls===2){const wire=JSON.parse(init.body);assert.ok(wire.input.some(i=>i.type==="function_call"&&i.name==="run_officejs"));return sse([terminal("tool-result")]);}
  return sse([terminal("invalid-new-call",[tool()])]);
 }});
 assert.equal((await request(fetch,{tools:[toolDeclaration]})).status,200);
 const response=await request(fetch,{previous_response_id:"tool-parent",input:[{type:"function_call_output",call_id:"call_native",output:"pong"}]});assert.equal(response.status,200,await response.text());
 assert.equal((await request(fetch,{tools:[]})).status,502);
 assert.equal((await request(fetch,{})).status,502,"cleared tools must stay cleared");
});
test("streaming completion is available for a later non-streaming continuation",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse([terminal("s"+calls,[message("流式文本")])]);}});
 const streamed=await request(fetch,{stream:true});assert.match(await streamed.text(),/response.completed/);
 assert.equal((await request(fetch,{previous_response_id:"s1",input:"follow-up"})).status,200);
});
test("missing, expired, disabled and cross-thread continuations fail before upstream",async()=>{
 let time=0,calls=0;const state=createConversationStore({ttlMs:100,now:()=>time});const fetch=makeFetch(async()=>auth(),manager,{}, {state,fetchImpl:async()=>{calls++;return sse([terminal("parent")]);}});
 await request(fetch,{});assert.equal((await request(fetch,{previous_response_id:"parent"},{"thread-id":"child"})).status,400);assert.equal(calls,1);
 time=101;assert.equal((await request(fetch,{previous_response_id:"parent"})).status,400);assert.equal(calls,1);
 const disabled=makeFetch(async()=>auth(),manager,{continuationCache:false},{fetchImpl:async()=>{calls++;return sse();}});assert.equal((await request(disabled,{previous_response_id:"parent"})).status,400);
 assert.equal((await fetch(BASE_URL+"/responses",{body:JSON.stringify({model:"gpt-6-astra",previous_response_id:"parent",input:"x"})})).status,400);assert.equal(calls,1);
});
test("concurrent incremental catalogs merge while generation remains parallel",{timeout:5000},async()=>{
 let release;const gate=new Promise(r=>{release=r;});let calls=0;const wires=[];const guard=setTimeout(()=>release(),3000);
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{calls++;const index=calls;wires.push(init.body.toString());if(index===2)release();if(index<=2)await gate;return sse([terminal("parallel-"+index)]);}});
 const alpha={...toolDeclaration,name:"alpha_tool"},beta={...toolDeclaration,name:"beta_tool"};
 try{const results=await Promise.all([request(fetch,{input:[{type:"additional_tools",tools:[alpha]},{role:"user",content:"alpha"}]}),request(fetch,{input:[{type:"additional_tools",tools:[beta]},{role:"user",content:"beta"}]})]);assert.ok(results.every(r=>r.status===200));assert.match(wires[1],/alpha_tool/);assert.match(wires[1],/beta_tool/);assert.equal((await request(fetch,{})).status,200);assert.match(wires[2],/alpha_tool/);assert.match(wires[2],/beta_tool/);}finally{clearTimeout(guard);release();}
});
test("compaction continuation retains the compacted window instead of old full history",async()=>{
 let calls=0;const marker={id:"cmp",type:"compaction",encrypted_content:"opaque-window"};
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{calls++;if(calls===1)return sse([terminal("compact-parent",[marker])]);assert.doesNotMatch(init.body.toString(),/old-large-history/);assert.match(init.body.toString(),/opaque-window/);return sse([terminal("after-compact")]);}});
 assert.equal((await request(fetch,{input:"old-large-history"},{},"/responses/compact")).status,200);assert.equal((await request(fetch,{previous_response_id:"compact-parent",input:"continue"})).status,200);
});
test("failed generations are never stored and HTTP 401 invalidates old owner state",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;if(calls===1)return sse([terminal("before-401")]);return new Response("expired",{status:401});}});
 await request(fetch,{});assert.equal((await request(fetch,{})).status,401);assert.equal((await request(fetch,{previous_response_id:"before-401"})).status,400);assert.equal(calls,2);
});
test("catalog control items cannot resurrect a tool after a continuation clears it",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return calls===1?sse([terminal("catalog-parent")]):sse([terminal("should-fail",[tool()])]);}});
 await request(fetch,{input:[{type:"additional_tools",tools:[toolDeclaration]},{role:"user",content:"remember tool"}]});
 const response=await request(fetch,{previous_response_id:"catalog-parent",tools:[],input:"do not use tools"});assert.equal(response.status,502);
});
test("failed and cancelled terminal details survive without creating continuation state",async()=>{
 for(const kind of ["response.failed","response.cancelled"]){let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse([{type:kind,response:{id:"unsuccessful",status:kind.endsWith("failed")?"failed":"cancelled",output:[],error:{code:"server_error",message:"PRIVATE_UPSTREAM_DETAIL"},usage:{input_tokens:5,output_tokens:0,total_tokens:5}}}]);}});
 const response=await request(fetch,{});assert.equal(response.status,502);const result=await response.json();assert.ok(result.error);assert.equal(result.usage.input_tokens,5);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UPSTREAM_DETAIL/);assert.equal((await request(fetch,{previous_response_id:"unsuccessful"})).status,400);assert.equal(calls,1);}
});
test("unsupported persistent conversation and background semantics fail before upstream",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});
 for(const body of [{conversation:"conv-test"},{background:true}])assert.equal((await request(fetch,body)).status,400);assert.equal(calls,0);
});
test("catalog eviction requires explicit tools instead of silently dropping capabilities",async()=>{
 let calls=0;const state=createConversationStore({maxEntries:1});const fetch=makeFetch(async()=>auth(),manager,{}, {state,fetchImpl:async()=>{calls++;return sse([terminal("evict-"+calls)]);}});
 await request(fetch,{tools:[toolDeclaration]});assert.equal((await request(fetch,{previous_response_id:"evict-1"})).status,400);assert.equal(calls,1);
 assert.equal((await request(fetch,{previous_response_id:"evict-1",tools:[toolDeclaration]})).status,200);assert.equal(calls,2);
});

test("oversized catalog replacement invalidates the old tool catalog",()=>{
 const cache=createConversationStore({maxEntryBytes:1000,maxBytes:4000});const s=scope();
 cache.catalog(s,Buffer.from('[{"name":"old_tool"}]'));
 const e=terminal("catalog-parent");assert.equal(cache.complete(s,context,e,JSON.stringify(e),{requiresCatalog:true}),true);
 cache.catalog(s,Buffer.from("x".repeat(1200)));
 assert.equal(cache.snapshot(s).catalog,undefined);
 assert.throws(()=>cache.snapshot(s,"catalog-parent"),/catalog.*evicted/);
 assert.ok(cache.snapshot(s,"catalog-parent",{explicitTools:true}).previous);
});
