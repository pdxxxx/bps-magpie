import test from "node:test";
import assert from "node:assert/strict";
import {accessModelCatalog,fetchModelCatalog,MODELS_URL} from "../src/models.mjs";
import {createFetch} from "../src/network.mjs";
import {BPSPlugin} from "../index.mjs";
import {auth} from "./helpers.mjs";
const allowed=models=>({allowed:true,model_catalog:{models}});
test("BPS access catalog filters disabled restricted and malformed models",()=>{
 const data=allowed([{id:"gpt-6-astra",label:"Astra"},{id:"gpt-6-astra",label:"duplicate"},{id:"gpt-hidden",available:false},{id:"gpt-disabled",enabled:false},{id:"gpt-picker",model_picker_enabled:false},{id:"gpt-policy",policy:{state:"unconfigured"}},{id:"gpt-restricted"},{id:"gpt-bad",enabled:"false"},{id:"not-a-gpt"},null]);data.model_catalog.restricted_models=["gpt-restricted"];const models=accessModelCatalog(data);assert.deepEqual(Object.keys(models),["gpt-6-astra"]);assert.equal(models["gpt-6-astra"].name,"Astra");
});
test("model reasoning variants come only from the upstream catalog",()=>{
 const models=accessModelCatalog(allowed([{id:"gpt-6-astra",efforts:[{value:"low"},{value:"high"},{value:"high"},{value:"unknown"}]},{id:"gpt-empty",efforts:[]},{id:"gpt-unknown"}]));assert.deepEqual(Object.keys(models["gpt-6-astra"].variants),["low","high"]);assert.equal(models["gpt-empty"].capabilities.reasoning,false);assert.equal(models["gpt-unknown"].variants,undefined);assert.equal(models["gpt-6-astra"].limit,undefined);
});
test("denied and empty access catalogs are authoritative empty model lists",()=>{assert.deepEqual(accessModelCatalog({allowed:false}),{});assert.deepEqual(accessModelCatalog(allowed([])),{});});
test("missing and malformed model envelopes do not create fallback models",()=>{for(const body of [null,{},[],{allowed:"true"},{allowed:true},{allowed:true,model_catalog:{models:null}}, {...allowed([]),model_catalog:{models:[],restricted_models:[{}]}}])assert.throws(()=>accessModelCatalog(body));});
test("model discovery uses the BPS access endpoint and selected account proxy",async()=>{
 let calls=0;const fetchImpl=createFetch({proxy:"http://127.0.0.1:7891"},{fetchImpl:async(url,init)=>{calls++;assert.equal(url,MODELS_URL);assert.equal(init.method,"GET");assert.equal(init.redirect,"error");assert.equal(init.proxy,"http://127.0.0.1:7891/");assert.equal(init.headers.get("chatgpt-account-id"),"workspace-a");assert.equal(init.headers.get("authorization"),"Bearer "+auth().access);assert.equal(init.headers.get("accept"),"application/json");return Response.json(allowed([{id:"gpt-6-astra"}]));}});const models=await fetchModelCatalog(auth(),{fetchImpl});assert.deepEqual(Object.keys(models),["gpt-6-astra"]);assert.equal(calls,1);
});
test("model discovery errors and oversized bodies stay explicit without leaking upstream text",async()=>{
 for(const status of [401,403,429,503])await assert.rejects(fetchModelCatalog(auth(),{fetchImpl:async()=>new Response("PRIVATE_TOKEN",{status})}),error=>error.status===status&&!error.message.includes("PRIVATE_TOKEN"));await assert.rejects(fetchModelCatalog(auth(),{fetchImpl:async()=>new Response("{}",{headers:{"content-length":String(9*1024*1024)}})}),/size limit/);
});
test("model discovery requires an account and respects cancellation before egress",async()=>{
 let calls=0;const deps={fetchImpl:async()=>{calls++;return Response.json(allowed([]));}};await assert.rejects(fetchModelCatalog(undefined,deps),/登录/);const abort=new AbortController();abort.abort(new Error("cancelled"));await assert.rejects(fetchModelCatalog(auth(),{...deps,signal:abort.signal}),/cancelled/);assert.equal(calls,0);
});
test("provider automatically discovers models after login and ignores obsolete manual options",async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async url=>{calls++;assert.equal(url,MODELS_URL);return Response.json(allowed([{id:"gpt-6-astra"}]));};try{const hooks=await BPSPlugin({},{models:["old-manual-model"]});const cfg={};await hooks.config(cfg);assert.deepEqual(cfg.provider.bps.models,{});assert.deepEqual(await hooks.provider.models({models:{old:{}}}),{});assert.equal(calls,0);assert.deepEqual(Object.keys(await hooks.provider.models({}, {auth:auth()})),["gpt-6-astra"]);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test("dynamic model metadata uses normalized capabilities required by Magpie",()=>{
 const model=accessModelCatalog(allowed([{id:"gpt-6-astra",efforts:[{value:"low"},{value:"medium"},{value:"high"},{value:"xhigh"}]}]))["gpt-6-astra"];
 assert.equal(model.capabilities?.reasoning,true);assert.equal(model.capabilities?.toolcall,true);assert.equal(model.capabilities?.attachment,true);assert.equal(model.capabilities?.input?.image,true);assert.equal(model.capabilities?.output?.text,true);
 assert.deepEqual(model.api,{id:"gpt-6-astra",url:"https://bps.openai.com/basispoints/api",npm:"@ai-sdk/openai"});assert.deepEqual(Object.keys(model.variants),["low","medium","high","xhigh"]);
});
