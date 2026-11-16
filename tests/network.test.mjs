import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {createFetch,proxyOption,readJSON} from "../src/network.mjs";
import {beginLogin} from "../src/auth.mjs";
import {makeFetch} from "../src/provider.mjs";
import {queryQuota,USAGE_URL,CREDITS_URL} from "../src/quota.mjs";
import {BASE_URL,TOKEN_URL,REDIRECT_URI} from "../src/constants.mjs";
import {auth,tokens,sse} from "./helpers.mjs";

test("proxy selection supports inheritance, explicit direct and HTTP(S) overrides",()=>{
 assert.equal(proxyOption({}),undefined);assert.equal(proxyOption({proxy:"inherit"}),undefined);assert.equal(proxyOption({proxy:"direct"}),"");
 assert.equal(proxyOption({proxy:"http://127.0.0.1:7891"}),"http://127.0.0.1:7891/");
 for(const proxy of [true,"socks5://localhost:1080","ftp://localhost","https://proxy.invalid/path","http://proxy.invalid/?x=1"]){assert.throws(()=>proxyOption({proxy}));}
});
test("proxy is never silently bypassed and connection errors do not expose credentials",async()=>{
 let calls=0;const fetch=createFetch({proxy:"http://name:SECRET@localhost:7891"},{fetchImpl:async(_url,init)=>{calls++;assert.match(init.proxy,/SECRET/);throw new Error("http://name:SECRET@localhost:7891");}});
 await assert.rejects(fetch("https://example.invalid"),e=>!e.message.includes("SECRET")&&e.message.includes("no direct fallback"));assert.equal(calls,1);
});
test("inherit leaves the host scope intact while direct is explicit",async()=>{
 const seen=[];const fetchImpl=async(_url,init)=>{seen.push(init);return Response.json({});};
 await createFetch({},{fetchImpl})("https://example.invalid",{});await createFetch({proxy:"direct"},{fetchImpl})("https://example.invalid",{});
 assert.equal("proxy" in seen[0],false);assert.equal(seen[1].proxy,"");
});
test("OAuth, inference and quota use one configured network transport",async()=>{
 const seen=[];const net=createFetch({proxy:"http://127.0.0.1:7891"},{fetchImpl:async(url,init)=>{
   seen.push(url);assert.equal(init.proxy,"http://127.0.0.1:7891/");
   if(url===TOKEN_URL)return Response.json(tokens());if(url===BASE_URL+"/responses")return sse();
   return Response.json(url===USAGE_URL?{account_id:"workspace-a",plan_type:"plus"}:{available_count:2});
 }});
 const flow=await beginLogin(undefined,{}, {fetchImpl:net});const callback=new URL(REDIRECT_URI);callback.search=new URLSearchParams({code:"test-code",state:new URL(flow.url).searchParams.get("state")});assert.equal((await flow.callback(callback.href)).type,"success");
 const fetch=makeFetch(async()=>auth(),{current:async f=>f()},{},{fetchImpl:net});assert.equal((await fetch(BASE_URL+"/responses",{body:JSON.stringify({model:"gpt-6-astra",input:"hi"})})).status,200);
 await queryQuota(auth(),{fetchImpl:net});
 for(const url of [TOKEN_URL,BASE_URL+"/responses",USAGE_URL,CREDITS_URL])assert.ok(seen.includes(url));
});
test("bounded JSON cancels oversized streaming data without a content length",async()=>{
 let cancelled=false;let reads=0;
 const res=new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(100));},cancel(){cancelled=true;}}));
 await assert.rejects(readJSON(res,50,"test"),/size limit/);assert.ok(cancelled);assert.ok(reads<5);
});
test("Bun actually routes a request through the configured HTTP proxy",{skip:!globalThis.Bun},async()=>{
 let received;const proxy=http.createServer((req,res)=>{received=req.url;res.setHeader("content-type","application/json");res.end('{"proxied":true}');});
 await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));
 try{const fetch=createFetch({proxy:"http://127.0.0.1:"+proxy.address().port});const response=await fetch("http://bps-proxy-test.invalid/probe",{signal:AbortSignal.timeout(3000)});assert.deepEqual(await response.json(),{proxied:true});assert.equal(received,"http://bps-proxy-test.invalid/probe");}
 finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
});
