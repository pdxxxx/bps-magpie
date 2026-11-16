import test from "node:test";
import assert from "node:assert/strict";
import { BPSPlugin } from "../index.mjs";
import { makeFetch,bpsHeaders } from "../src/provider.mjs";
import { BASE_URL } from "../src/constants.mjs";
import { auth,sse,event,completed,message,tool,toolDeclaration } from "./helpers.mjs";

const manager={current:async getAuth=>getAuth()};
const input={model:"gpt-6-astra",input:"ping",stream:false};
const send=(fetch,body=input,signal)=>fetch(BASE_URL+"/responses",{method:"POST",body:typeof body==="string"?body:JSON.stringify(body),signal});
test("Magpie hook shape uses Responses, automatic models and scoped session headers",async()=>{
 const hooks=await BPSPlugin({client:{}},{models:["gpt-6-astra","custom-model"]});
 assert.equal(Object.hasOwn(hooks,"tool"),false);assert.equal(Object.hasOwn(hooks,"tools"),false);assert.equal(typeof hooks.auth.usage,"function");assert.equal(hooks.auth.maxConcurrency,4);
 const cfg={};await hooks.config(cfg);assert.equal(cfg.provider["bps"].npm,"@ai-sdk/openai");assert.equal(hooks.auth.methods[0].type,"oauth");assert.deepEqual(cfg.provider["bps"].models,{});
 const output={headers:{}};await hooks["chat.headers"]({model:{providerID:"bps"},sessionID:"conversation"},output);assert.equal(output.headers["x-bps-session"],"conversation");
});
test("headers use current bearer identity and never a Codex cookie",()=>{
 const headers=bpsHeaders(auth());assert.equal(headers.get("x-openai-account-user-id"),"user-a");assert.equal(headers.get("x-openai-account-id"),"workspace-a");assert.equal(headers.get("cookie"),null);
});
test("real Go bridge prepares request and returns a validated JSON response",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{calls++;assert.equal(url,BASE_URL+"/responses");const wire=JSON.parse(init.body);assert.equal(wire.model,"gpt-6-astra");assert.equal(wire.stream,true);assert.equal(wire.reasoning_effort,"xhigh");assert.equal(wire.tools,undefined);assert.equal(init.headers.get("x-basispoints-auth-mode"),"chatgpt");assert.equal(init.redirect,"error");return sse();}});
 const response=await send(fetch,{...input,reasoning:{effort:"max"}});assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,"completed");assert.equal(result.output[0].content[0].text,"pong");assert.equal(result.usage.total_tokens,13);assert.equal(calls,1);
});
test("text streams before the terminal response",async()=>{
 let upstream;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>new Response(new ReadableStream({start(c){upstream=c;c.enqueue(new TextEncoder().encode(event({type:"response.output_text.delta",delta:"hello"})));}}),{headers:{"content-type":"text/event-stream"}})});
 const response=await send(fetch,{...input,stream:true});assert.equal(response.status,200);const reader=response.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/hello/);
 upstream.enqueue(new TextEncoder().encode(event(completed([message("hello")]))));upstream.close();while(!(await reader.read()).done){}
});
test("native tool calls convert only after a complete validated terminal batch",async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>sse([completed([tool()])])});
 const response=await send(fetch,{...input,tools:[toolDeclaration]});assert.equal(response.status,200);const result=await response.json();assert.equal(result.output[0].name,"echo");assert.deepEqual(JSON.parse(result.output[0].arguments),{text:"ping"});assert.equal(result.output[0].call_id,"call_native");
 // A new bridge process reconstructs a complete tool history for turn two.
 const next=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{const wire=JSON.parse(init.body);assert.ok(wire.input.some(x=>x.type==="function_call"&&x.name==="run_officejs"));return sse();}});
 assert.equal((await send(next,{...input,tools:[toolDeclaration],input:[{type:"message",role:"user",content:"ping"},...result.output,{type:"function_call_output",call_id:"call_native",output:"pong"}]})).status,200);
});
test("undeclared tool never reaches the client as an executable tool",async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>sse([completed([tool("not-declared")])])});
 const response=await send(fetch,{...input,tools:[toolDeclaration]});assert.equal(response.status,502);const body=await response.text();assert.doesNotMatch(body,/"name":"not-declared"/);
});
test("invalid schemas and incomplete history fail before upstream",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});
 for(const body of [{...input,previous_response_id:"missing"},{...input,tools:[{...toolDeclaration,parameters:{$ref:"https://attacker.invalid/schema"}}]},{...input,input:[{type:"function_call_output",call_id:"missing",output:"x"}]}]){assert.equal((await send(fetch,body)).status,400);}
 assert.equal(calls,0);
});
test("429 and 403 remain upstream errors without retry or sensitive body",async()=>{
 for(const status of [403,429,401]){let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return new Response("SECRET_PROVIDER_BODY",{status,headers:{"retry-after":"31"}});}});const response=await send(fetch);assert.equal(response.status,status);assert.equal(response.headers.get("retry-after"),"31");assert.equal(response.headers.get("x-magpie-sign-in"),status===401?"expired":null);assert.doesNotMatch(await response.text(),/SECRET/);assert.equal(calls,1);}
});

test("upstream usage-policy refusal remains 403 without sign-out, replay or raw details",async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return Response.json({error:{message:'403: This request was blocked by our usage policy. PRIVATE_CONTEXT'}},{status:403});}});
 const response=await send(fetch);const body=await response.json();
 assert.equal(response.status,403);assert.equal(body.error.code,'basispoints_usage_policy_blocked');assert.equal(response.headers.get('x-magpie-sign-in'),null);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_CONTEXT/);
});

test('a stalled refusal body remains cancellable instead of hanging error classification',async()=>{
 let ready;const arrived=new Promise(r=>{ready=r;});let cancelled=false;const abort=new AbortController();
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{ready();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403,headers:{'content-type':'application/json'}});}});
 const pending=send(fetch,input,abort.signal);await arrived;await new Promise(r=>setImmediate(r));abort.abort(new Error('cancel refusal'));
 await assert.rejects(pending,/cancel refusal/);assert.equal(cancelled,true);
});
test("truncated SSE is not accepted as a successful nonstream response",async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>sse([{type:"response.output_text.delta",delta:"partial"}])});assert.equal((await send(fetch)).status,502);
});
test("a completed response releases an upstream that leaves its connection open",{timeout:3000},async()=>{
 let cancelled=false;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event(completed())));},cancel(){cancelled=true;}}),{headers:{"content-type":"text/event-stream"}})});
 const response=await send(fetch);assert.equal(response.status,200);assert.equal(cancelled,true);
});
test("route validation blocks credential forwarding to arbitrary origins",async()=>{
 let calls=0;const fetch=makeFetch(async()=>{calls++;return auth();},manager,{}, {fetchImpl:async()=>assert.fail("network called")});
 const response=await fetch("https://attacker.invalid/responses",{body:JSON.stringify(input)});assert.equal(response.status,400);assert.equal(calls,0);
});
test("stream cancellation aborts upstream and stops its bridge",async()=>{
 let signal;let cancelled=false;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event({type:"response.output_text.delta",delta:"first"})));},cancel(){cancelled=true;}}),{headers:{"content-type":"text/event-stream"}});}});
 const response=await send(fetch,{...input,stream:true});const reader=response.body.getReader();await reader.read();await reader.cancel();assert.equal(signal.aborted,true);assert.equal(cancelled,true);
});
test("invalid image data is rejected before any attachment upload",async()=>{
 let calls=0;const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});const response=await send(fetch,{...input,input:[{role:"user",content:[{type:"input_image",image_url:"data:image/png;base64,invalid"}]}]});assert.equal(response.status,400);assert.equal(calls,0);
});
test("native inline images upload and use file IDs on the same account",async()=>{
 const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=";let count=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{count++;assert.equal(init.headers.get("chatgpt-account-id"),"workspace-a");if(url.endsWith("/attachments")){assert.match(init.headers.get("content-type"),/multipart/);return Response.json({openai_file_id:"file-uploaded"});}assert.match(init.body.toString(),/file-uploaded/);assert.doesNotMatch(init.body.toString(),/data:image/);return sse();}});
 const response=await send(fetch,{...input,input:[{role:"user",content:[{type:"input_image",image_url:"data:image/png;base64,"+image},{type:"input_text",text:"Describe"}]}]});assert.equal(response.status,200,await response.text());assert.equal(count,2);
});
