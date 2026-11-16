import test from "node:test";
import assert from "node:assert/strict";
import {makeFetch} from "../src/provider.mjs";
import {createConversationStore,conversationScope} from "../src/state.mjs";
import {BASE_URL} from "../src/constants.mjs";
import {auth,sse,completed,message,toolDeclaration} from "./helpers.mjs";

const manager={current:async getAuth=>getAuth()};
const headers={"x-bps-session":"default-compatibility"};
const input={model:"gpt-6-astra",input:"continue",stream:false};
const hosted=[{type:"web_search"},{type:"image_generation"},{type:"file_search"}];
const encrypted={type:"encrypted_content",encrypted_content:"HISTORY_CIPHERTEXT"};
const history=()=>[
 {type:"agent_message",author:"/root/worker",recipient:"/root",content:"Old agent header",encrypted_content:"HISTORY_CIPHERTEXT"},
 {role:"assistant",content:[{type:"output_text",text:"Visible conclusion"},encrypted]},
 {role:"user",content:"Current plaintext task"}
];
const send=(fetch,body=input,path="/responses")=>fetch(BASE_URL+path,{method:"POST",headers,body:typeof body==="string"?body:JSON.stringify(body)});
const terminal=id=>{const event=completed();event.response.id=id;return event;};

test("default hosted-tool omission stays on BPS and preserves client function and custom tools",async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,BASE_URL+"/responses");
  const wire=JSON.parse(init.body);assert.equal(wire.tools,undefined);
  const prompt=JSON.stringify(wire.input);
  assert.match(prompt,/Hosted tools unavailable through Basispoints: file_search, image_generation, web_search/);
  assert.match(prompt,/Do not claim to have used them/);
  assert.match(prompt,/echo/);assert.match(prompt,/custom_echo/);
  return sse();
 }});
 const response=await send(fetch,{...input,tools:[...hosted,toolDeclaration,{type:"custom",name:"custom_echo"}]});
 assert.equal(response.status,200,await response.text());
 assert.equal(response.headers.get("x-bps-warning-count"),"1");assert.equal(calls,1);
});

test("tool_choice none disables hosted and client tools without fallback or a capability warning",async()=>{
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{
  assert.equal(url,BASE_URL+"/responses");assert.doesNotMatch(init.body.toString(),/Hosted tools unavailable|Client tool catalog/);return sse();
 }});
 const response=await send(fetch,{...input,tools:[...hosted,toolDeclaration],tool_choice:"none"});
 assert.equal(response.status,200,await response.text());assert.equal(response.headers.get("x-bps-warning-count"),null);
});

test("forced unsupported hosted tools and unknown tool types still fail before network access",async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});
 for(const patch of [
  {tools:hosted,tool_choice:{type:"web_search"}},
  {tools:hosted,tool_choice:"required"},
  {tools:[{type:"unknown_hosted_tool"}]}
 ]){const response=await send(fetch,{...input,...patch});assert.equal(response.status,400,await response.text());}
 assert.equal(calls,0);
});

test("historical ciphertext is omitted before transmission and caching while tool history and opaque state survive",async()=>{
 const state=createConversationStore(),account=auth();
 const items=history();items.splice(2,0,
  {type:"reasoning",summary:[],encrypted_content:"REASONING_OPAQUE"},
  {type:"compaction",encrypted_content:"COMPACTION_OPAQUE"},
  {type:"function_call",call_id:"call_history",name:"echo",arguments:'{"text":"literal encrypted_content","ticket":9007199254740993}'},
  {type:"function_call_output",call_id:"call_history",output:[{type:"input_text",text:"Visible tool result"},encrypted]}
 );
 const fetch=makeFetch(async()=>account,manager,{}, {state,fetchImpl:async(_url,init)=>{
  const wire=init.body.toString();assert.doesNotMatch(wire,/HISTORY_CIPHERTEXT/);
  for(const value of ["Encrypted content omitted","Old agent header","Visible conclusion","Visible tool result","Current plaintext task","9007199254740993","COMPACTION_OPAQUE"])assert.ok(wire.includes(value),value);
  assert.ok(JSON.parse(wire).input.some(item=>item.type==="function_call"&&item.name==="run_officejs"));
  return sse([terminal("history-cleaned")]);
 }});
 const declaration={...toolDeclaration,parameters:{...toolDeclaration.parameters,properties:{...toolDeclaration.parameters.properties,ticket:{type:"integer"}}}};
 const raw=JSON.stringify({...input,input:items,tools:[declaration]});
 const response=await send(fetch,raw);assert.equal(response.status,200,await response.text());
 assert.equal(response.headers.get("x-bps-continuation"),"cached");
 const saved=state.snapshot(conversationScope(account,new Headers(headers),input.model),"history-cleaned").previous.toString();
 assert.doesNotMatch(saved,/HISTORY_CIPHERTEXT/);
 assert.match(saved,/REASONING_OPAQUE/);assert.match(saved,/COMPACTION_OPAQUE/);
 assert.equal(JSON.parse(saved).input.length,items.length);
});

test("continuation expands older cached history before applying default encrypted-content omission",async()=>{
 const state=createConversationStore(),account=auth(),scope=conversationScope(account,new Headers(headers),input.model);
 const prior=terminal("old-parent");
 state.complete(scope,Buffer.from(JSON.stringify({...input,input:history().slice(0,2)})),prior,JSON.stringify(prior));
 const fetch=makeFetch(async()=>account,manager,{}, {state,fetchImpl:async(_url,init)=>{
  assert.doesNotMatch(init.body.toString(),/HISTORY_CIPHERTEXT|previous_response_id/);
  assert.match(init.body.toString(),/Encrypted content omitted/);assert.match(init.body.toString(),/new task/);
  return sse([terminal("clean-child")]);
 }});
 const response=await send(fetch,{...input,previous_response_id:"old-parent",input:"new task"});assert.equal(response.status,200,await response.text());
 assert.doesNotMatch(state.snapshot(scope,"clean-child").previous.toString(),/HISTORY_CIPHERTEXT/);
});

test("standalone compaction applies the same default historical omission and preserves its opaque result",async()=>{
 const marker={type:"compaction",id:"compact-clean",encrypted_content:"NEW_OPAQUE_WINDOW"};
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(_url,init)=>{
  assert.doesNotMatch(init.body.toString(),/HISTORY_CIPHERTEXT/);assert.match(init.body.toString(),/Encrypted content omitted/);
  assert.equal(JSON.parse(init.body).input.at(-1).type,"compaction_trigger");return sse([completed([message("context"),marker])]);
 }});
 const response=await send(fetch,{...input,input:history(),tools:hosted},"/responses/compact");
 assert.equal(response.status,200);assert.deepEqual((await response.json()).output.at(-1),marker);
});

test("current encrypted tasks and tool results are rejected even with metadata tails or compaction",async()=>{
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async()=>{calls++;return sse();}});
 const current=[
  {role:"user",content:[encrypted]},
  {type:"agent_message",content:"Readable task header",encrypted_content:"HISTORY_CIPHERTEXT"},
  {type:"agent_message",content:[encrypted]},
  {type:"function_call_output",call_id:"old",output:[encrypted]},
  {type:"custom_tool_call_output",call_id:"old",output:[encrypted]}
 ];
 for(const path of ["/responses","/responses/compact"])for(const item of current)for(const tail of [[],[{type:"reasoning",summary:[],encrypted_content:"REASONING_OPAQUE"},{type:"compaction_trigger"}]]){
  const response=await send(fetch,{...input,input:[{role:"user",content:"Earlier task"},item,...tail]},path);
  const text=await response.text();assert.equal(response.status,400,text);assert.match(text,/encrypted_content/);assert.doesNotMatch(text,/HISTORY_CIPHERTEXT/);
 }
 assert.equal(calls,0);
});

test("image upload and reprepare retain both compatibility defaults",async()=>{
 const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=";
 let calls=0;
 const fetch=makeFetch(async()=>auth(),manager,{}, {fetchImpl:async(url,init)=>{
  calls++;if(url===BASE_URL+"/attachments")return Response.json({openai_file_id:"file-compatibility"});
  assert.equal(url,BASE_URL+"/responses");assert.doesNotMatch(init.body.toString(),/HISTORY_CIPHERTEXT/);
  assert.match(init.body.toString(),/file-compatibility/);assert.match(init.body.toString(),/Encrypted content omitted/);
  assert.match(init.body.toString(),/Hosted tools unavailable/);return sse();
 }});
 const response=await send(fetch,{...input,tools:[...hosted,toolDeclaration],input:[...history(),{role:"user",content:[{type:"input_image",image_url:"data:image/png;base64,"+png},{type:"input_text",text:"Describe"}]}]});
 assert.equal(response.status,200,await response.text());assert.equal(response.headers.get("x-bps-warning-count"),"1");assert.equal(calls,2);
});
