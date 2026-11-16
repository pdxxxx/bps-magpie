import test from "node:test";
import assert from "node:assert/strict";
import {makeFetch} from "../src/provider.mjs";
import {BASE_URL} from "../src/constants.mjs";
import {auth,sse,completed,message,toolDeclaration,tool} from "./helpers.mjs";
const marker={id:"cmp_test",type:"compaction",encrypted_content:"opaque-test-context"};
const manager={current:async f=>f()};
test("standalone compact uses a native trigger and returns a reusable compaction window",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{calls++;assert.equal(url,BASE_URL+"/responses");const body=JSON.parse(init.body);assert.equal(body.input.at(-1).type,"compaction_trigger");assert.equal(body.tools,undefined);return sse([completed([message("context"),marker])]);}});
 const response=await fetch(BASE_URL+"/responses/compact",{body:JSON.stringify({model:"gpt-6-astra",input:"Summarize history",tools:[toolDeclaration]})});assert.equal(response.status,200);const value=await response.json();assert.equal(value.object,"response.compaction");assert.deepEqual(value.output.at(-1),marker);assert.equal(value.usage.total_tokens,13);assert.equal(calls,1);
 const continuation=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{assert.match(init.body.toString(),/opaque-test-context/);return sse();}});
 assert.equal((await continuation(BASE_URL+"/responses",{body:JSON.stringify({model:"gpt-6-astra",input:[...value.output,{role:"user",content:"continue"}]})})).status,200);
});
test("compact preserves numeric precision and rejects a text answer without state",async()=>{
 const raw='{"model":"gpt-6-astra","input":[{"role":"user","content":"compact 9007199254740993"}],"metadata":{"big":9007199254740993}}';
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{assert.match(init.body.toString(),/9007199254740993/);return sse();}});
 assert.equal((await fetch(BASE_URL+"/responses/compact",{body:raw})).status,502);
});
test("compact rejects invalid input and streaming before the network call",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});
 for(const body of [{model:"gpt-6-astra",input:[]},{model:"gpt-6-astra",input:"hi",stream:true},{model:"gpt-6-astra"}])assert.equal((await fetch(BASE_URL+"/responses/compact",{body:JSON.stringify(body)})).status,400);
 assert.equal(calls,0);
});
test("Request objects preserve method, JSON body and session headers",async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>sse()});
 const request=new Request(BASE_URL+"/responses",{method:"POST",headers:{"x-bps-session":"test"},body:JSON.stringify({model:"gpt-6-astra",input:"hello"})});
 assert.equal((await fetch(request)).status,200);assert.equal((await fetch(new Request(BASE_URL+"/responses"))).status,405);
});
test("compact does not dispatch new tools returned by upstream",async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>sse([completed([tool()])])});
 const response=await fetch(BASE_URL+"/responses/compact",{body:JSON.stringify({model:"gpt-6-astra",input:"hello",tools:[toolDeclaration]})});assert.equal(response.status,502);
});
test("cancelling a stalled Request body stops before credentials or network",{timeout:3000},async()=>{
 const abort=new AbortController();let authReads=0;
 const request=new Request(BASE_URL+"/responses",{method:"POST",body:new ReadableStream({}),duplex:"half",signal:abort.signal});
 const fetch=makeFetch(async()=>{authReads++;return auth();},manager,{}, {fetchImpl:async()=>assert.fail("network called")});
 const pending=fetch(request);setTimeout(()=>abort.abort(new Error("cancelled by caller")),20);
 try{await assert.rejects(pending,/cancelled by caller/);assert.equal(authReads,0);}finally{await request.body.cancel().catch(()=>{});}
});
test("request timeout is a 504 and does not replay an accepted call",{timeout:3000},async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{timeoutMs:1000},{fetchImpl:async(_url,init)=>{calls++;return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true}));}});
 const response=await fetch(BASE_URL+"/responses",{body:JSON.stringify({model:"gpt-6-astra",input:"wait"})});assert.equal(response.status,504);assert.equal(calls,1);
});

test("request cancellation reaches the original body source",{timeout:3000},async()=>{
 const abort=new AbortController();let cancelled=false,reads=0;
 const request=new Request(BASE_URL+"/responses",{method:"POST",body:new ReadableStream({cancel(){cancelled=true;}}),duplex:"half",signal:abort.signal});
 const fetch=makeFetch(async()=>{reads++;return auth();},manager,{}, {fetchImpl:async()=>assert.fail("network called")});
 const pending=fetch(request);setTimeout(()=>abort.abort(new Error("source-cancel-test")),20);
 try{await assert.rejects(pending,/source-cancel-test/);assert.equal(cancelled,true);assert.equal(request.bodyUsed,true);assert.equal(reads,0);}finally{await request.body.cancel().catch(()=>{});}
});
test("Request bodies are consumed once and cannot be silently replayed",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});
 const request=new Request(BASE_URL+"/responses",{method:"POST",body:JSON.stringify({model:"gpt-6-astra",input:"hello"})});
 assert.equal((await fetch(request)).status,200);assert.equal(request.bodyUsed,true);
 assert.equal((await fetch(request)).status,400);assert.equal(calls,1);
});
