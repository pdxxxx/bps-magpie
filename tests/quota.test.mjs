import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,readFile,rm } from "node:fs/promises";
import os from "node:os";
import {randomUUID} from "node:crypto";
import path from "node:path";
import { projectUsage,resetDetails,queryQuota,consumeReset,USAGE_URL,CREDITS_URL,CONSUME_URL } from "../src/quota.mjs";
import { managementTools } from "../src/management.mjs";
import { auth } from "./helpers.mjs";

const usage={account_id:"workspace-a",plan_type:"plus",credits:{balance:"123456789.123456789",has_credits:true,unlimited:false},rate_limit:{primary_window:{used_percent:37,limit_window_seconds:18000,reset_at:2000000000},secondary_window:null},rate_limit_reset_credits:{available_count:9}};
test("quota projects supplied amounts, keeps decimal precision and labels Codex windows aside",()=>{
 const result=projectUsage(usage,{available_count:2,credits:[{expires_at:"2030-01-02T00:00:00Z"},{expiresAt:"2030-01-01T00:00:00Z"}]});
 assert.equal(result.balance,"123456789.123456789 Codex 点数");assert.equal(result.resets.count,2);assert.equal(result.resets.until,"2030-01-01T00:00:00.000Z");assert.equal(result.resets.each.length,2);assert.equal(result.windows.length,1);assert.equal(result.windows[0].used,37);assert.equal(result.windows[0].aside,true);
});
test("quota never fabricates zero when usage or reset counts are missing",()=>{
 assert.equal(projectUsage({}).resets,undefined);
 const result=projectUsage({rate_limit:{primary_window:{reset_after_seconds:10}}});assert.equal(result.windows[0].used,undefined);assert.equal(result.balance,undefined);
 assert.equal(resetDetails({available_count:0,credits:[{status:"available"}]}).count,0);
 assert.equal(resetDetails({credits:[]}).count,0);
 assert.equal(resetDetails({availableCount:"2"}).count,2);
 assert.equal(resetDetails({available_count:-1}).count,undefined);
});
test("reset credit details filter redeemed and unrelated records without exposing IDs",()=>{
 const result=resetDetails({credits:[{id:"SECRET_CARD_ID",status:"available",reset_type:"codex_rate_limits",expires_at:"2030-01-01"},{status:"redeemed"},{reset_type:"other"},null,{status:"available"}]});
 assert.equal(result.count,2);assert.equal(result.each.length,1);assert.doesNotMatch(JSON.stringify(result),/SECRET_CARD_ID/);
});
test("quota validates workspace and sends the correct bearer and account",async()=>{
 const seen=[];const result=await queryQuota(auth(),{fetchImpl:async(url,init)=>{seen.push(url);assert.equal(init.method,"GET");assert.equal(init.headers.get("chatgpt-account-id"),"workspace-a");assert.equal(init.headers.get("openai-beta"),"codex-1");return Response.json(url===USAGE_URL?usage:{available_count:2});}});
 assert.equal(result.resets.count,2);assert.equal(seen.length,2);
 await assert.rejects(queryQuota(auth(),{fetchImpl:async(url)=>Response.json(url===USAGE_URL?{account_id:"wrong"}:{})}),/workspace/);
});
test("reset-details failure preserves available usage and keeps missing counts unknown",async()=>{
 const result=await queryQuota(auth(),{fetchImpl:async(url)=>url===USAGE_URL?Response.json({plan_type:"plus"}):new Response("SECRET",{status:403})});assert.equal(result.resets,undefined);assert.ok(result.warning);assert.equal(result.signIn,"kept");
});
test("reset sends one redeem ID and reports successful consume despite readback failure",async()=>{
 let posts=0;const id="11111111-1111-4111-8111-111111111111";
 const result=await consumeReset(auth(),id,{fetchImpl:async(url,init)=>{if(url===CONSUME_URL){posts++;assert.deepEqual(JSON.parse(init.body),{redeem_request_id:id});return Response.json({code:"success",windows_reset:2,credit:{id:"SECRET_ID",redeemed_at:"2030-01-01T00:00:00Z"}});}throw new Error("readback unavailable");}});
 assert.equal(result.status,"success");assert.equal(result.windowsReset,2);assert.ok(result.warning);assert.equal(posts,1);assert.doesNotMatch(JSON.stringify(result),/SECRET_ID/);
});

async function setup(t,fetchImpl){
 const directory=await mkdtemp(path.join(os.tmpdir(),"bps-management-test-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(path.join(directory,"plugin-auth.json"),JSON.stringify({"bps":auth(),"another-provider":{type:"api",key:"OTHER_SECRET"},"bps#second":{...auth(),uid:"another-identity",workspaceId:"workspace-b"}}));
 return {directory,tools:managementTools({directory,deps:{fetchImpl}})};
}
test("management tools list only own accounts and never disclose credentials",async t=>{
 const {tools}=await setup(t,async()=>assert.fail("must not call network"));const result=await tools.bps_accounts.execute({});assert.equal(result.accounts.length,2);assert.doesNotMatch(JSON.stringify(result),/test-refresh|OTHER_SECRET|unsigned-test/);
});
test("reset requires preparation, confirmation and matching account, and duplicate calls do not consume twice",async t=>{
 let posts=0;const {tools}=await setup(t,async(url)=>{if(url===CONSUME_URL){posts++;return Response.json({code:"success",windows_reset:2});}return Response.json(url===USAGE_URL?usage:{available_count:2});});
 const prepared=await tools.bps_prepare_reset.execute({account:"bps"});assert.equal(posts,0);
 await assert.rejects(tools.bps_reset.execute({account:"bps",request_id:prepared.requestId,confirm:false}),/confirmation/);
 await assert.rejects(tools.bps_reset.execute({account:"bps#second",request_id:prepared.requestId,confirm:true}),/different account/);
 const args={account:"bps",request_id:prepared.requestId,confirm:true};assert.equal((await tools.bps_reset.execute(args)).status,"success");
 assert.equal((await tools.bps_reset.execute(args)).replayed,true);assert.equal(posts,1);
});
test("unknown consume result persists across plugin instances and never automatically retries",async t=>{
 let posts=0;const fetchImpl=async(url)=>{if(url===CONSUME_URL){posts++;throw new Error("connection lost");}return Response.json(url===USAGE_URL?usage:{available_count:2});};
 const {tools,directory}=await setup(t,fetchImpl);const prepared=await tools.bps_prepare_reset.execute({account:"bps"});const args={account:"bps",request_id:prepared.requestId,confirm:true};
 assert.equal((await tools.bps_reset.execute(args)).status,"unknown");const restarted=managementTools({directory,deps:{fetchImpl}});
 assert.equal((await restarted.bps_reset.execute(args)).replayed,true);assert.equal(posts,1);
 const state=await readFile(path.join(directory,"bps-resets",prepared.requestId+".json"),"utf8");assert.doesNotMatch(state,/test-refresh|unsigned-test/);
});
test("management cannot consume unknown/zero counts and never races expired credential refresh",async t=>{
 const {tools,directory}=await setup(t,async(url)=>Response.json(url===USAGE_URL?{account_id:"workspace-a"}:{}));
 await assert.rejects(tools.bps_prepare_reset.execute({account:"bps"}),/unknown/);
 await writeFile(path.join(directory,"plugin-auth.json"),JSON.stringify({"bps":{...auth(),expires:0}}));await assert.rejects(tools.bps_quota.execute({account:"bps"}),/宿主续期/);
});
test("repeated prepare reuses one request and unknown status blocks a new redemption",async t=>{
 let posts=0;const {tools}=await setup(t,async(url)=>{if(url===CONSUME_URL){posts++;throw new Error("lost response");}return Response.json(url===USAGE_URL?usage:{available_count:2});});
 const first=await tools.bps_prepare_reset.execute({account:"bps"});const second=await tools.bps_prepare_reset.execute({account:"bps"});assert.equal(second.requestId,first.requestId);assert.equal(second.reused,true);
 await tools.bps_reset.execute({account:"bps",request_id:first.requestId,confirm:true});
 await assert.rejects(tools.bps_prepare_reset.execute({account:"bps"}),/uncertain reset/);assert.equal(posts,1);
 const status=await tools.bps_reset_status.execute({account:"bps"});assert.equal(status.operations[0].status,"unknown");assert.equal(status.operations[0].attempts,1);
});
test("manual retry uses exactly the original redeem ID and respects upstream idempotency",async t=>{
 const ids=[];let charges=0;const redeemed=new Set();
 const {tools}=await setup(t,async(url,init)=>{if(url===CONSUME_URL){const id=JSON.parse(init.body).redeem_request_id;ids.push(id);if(!redeemed.has(id)){redeemed.add(id);charges++;throw new Error("response lost after consumption");}return Response.json({code:"success",windows_reset:2});}return Response.json(url===USAGE_URL?usage:{available_count:1});});
 const prepared=await tools.bps_prepare_reset.execute({account:"bps"});const args={account:"bps",request_id:prepared.requestId,confirm:true};
 assert.equal((await tools.bps_reset.execute(args)).status,"unknown");assert.equal((await tools.bps_retry_reset.execute(args)).status,"success");assert.deepEqual(ids,[prepared.requestId,prepared.requestId]);assert.equal(charges,1);
 assert.equal((await tools.bps_retry_reset.execute(args)).replayed,true);assert.equal(ids.length,2);
});
test("manual resolution records an explicit outcome without another upstream request",async t=>{
 let posts=0;const {tools,directory}=await setup(t,async(url)=>{if(url===CONSUME_URL){posts++;throw new Error("timeout");}return Response.json(url===USAGE_URL?usage:{available_count:2});});
 const prepared=await tools.bps_prepare_reset.execute({account:"bps"});await tools.bps_reset.execute({account:"bps",request_id:prepared.requestId,confirm:true});
 await assert.rejects(tools.bps_resolve_reset.execute({account:"bps",request_id:prepared.requestId,outcome:"not_consumed",confirm:false}),/human-confirmed/);
 const result=await tools.bps_resolve_reset.execute({account:"bps",request_id:prepared.requestId,outcome:"not_consumed",confirm:true});assert.equal(result.status,"confirmed_not_consumed");assert.equal(posts,1);
 const next=await tools.bps_prepare_reset.execute({account:"bps"});assert.notEqual(next.requestId,prepared.requestId);
 await writeFile(path.join(directory,"plugin-auth.json"),JSON.stringify({"bps":{...auth(),expires:0}}));assert.equal((await tools.bps_reset_status.execute({account:"bps"})).operations.length,2);
});
test("concurrent reset calls cannot both consume, including a shared workspace alias",async t=>{
 let posts=0;let resume;const gate=new Promise(r=>{resume=r;});let arrived;const started=new Promise(r=>{arrived=r;});
 const {tools,directory}=await setup(t,async(url)=>{if(url===CONSUME_URL){posts++;arrived();await gate;return Response.json({code:"success",windows_reset:1});}return Response.json(url===USAGE_URL?usage:{available_count:2});});
 const prepared=await tools.bps_prepare_reset.execute({account:"bps"});await writeFile(path.join(directory,"plugin-auth.json"),JSON.stringify({"bps":auth(),"bps#alias":auth()}));
 const args={account:"bps",request_id:prepared.requestId,confirm:true};const first=tools.bps_reset.execute(args);await started;
 try{await assert.rejects(tools.bps_reset.execute(args),/already running/);await assert.rejects(tools.bps_prepare_reset.execute({account:"bps#alias"}),/already running/);}finally{resume();}
 assert.equal((await first).status,"success");assert.equal(posts,1);
});
test("zero epoch does not manufacture a 1970 reset date and null usage is rejected",async()=>{
 const result=projectUsage({rate_limit:{primary_window:{used_percent:4,reset_at:0,reset_after_seconds:20}}},undefined,{now:2000000000000});assert.equal(result.windows[0].resetsAt,new Date(2000000020000).toISOString());
 await assert.rejects(queryQuota(auth(),{fetchImpl:async()=>Response.json(null)}),/Invalid quota/);
});

test("reset receipt history supports pagination and exact lookup without fresh tokens or network",async t=>{
 let online=true;const {tools,directory}=await setup(t,async url=>{assert.equal(online,true);return Response.json(url===USAGE_URL?usage:{available_count:2});});
 const prepared=await tools.bps_prepare_reset.execute({account:"bps"});const receiptDir=path.join(directory,"bps-resets");
 const base=JSON.parse(await readFile(path.join(receiptDir,prepared.requestId+".json"),"utf8"));base.status="unknown";
 await writeFile(path.join(receiptDir,base.requestId+".json"),JSON.stringify(base));
 for(let i=1;i<105;i++){const requestId=randomUUID();await writeFile(path.join(receiptDir,requestId+".json"),JSON.stringify({...base,requestId,createdAt:base.createdAt+i,status:"success"}));}
 online=false;await writeFile(path.join(directory,"plugin-auth.json"),JSON.stringify({"bps":{...auth(),expires:0},"bps#second":{...auth(),workspaceId:"workspace-b",uid:"other"}}));
 const first=await tools.bps_reset_status.execute({account:"bps"});assert.equal(first.total,105);assert.equal(first.operations.length,100);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,100);
 const last=await tools.bps_reset_status.execute({account:"bps",offset:first.nextOffset,limit:100});assert.equal(last.operations.length,5);assert.equal(last.hasMore,false);assert.equal(last.operations.at(-1).requestId,base.requestId);assert.equal(new Set([...first.operations,...last.operations].map(r=>r.requestId)).size,105);
 const exact=await tools.bps_reset_status.execute({account:"bps",request_id:base.requestId});assert.equal(exact.operations.length,1);assert.equal(exact.operations[0].status,"unknown");
 await assert.rejects(tools.bps_reset_status.execute({account:"bps#second",request_id:base.requestId}),/different account/);
 assert.doesNotMatch(JSON.stringify(exact),/test-refresh|unsigned-test/);
});
test("reset receipt lookup validates bounds and never calls upstream",async t=>{
 const {tools}=await setup(t,async()=>assert.fail("network called"));
 for(const extra of [{offset:-1},{offset:1.5},{offset:"0"},{limit:0},{limit:101},{limit:null},{request_id:"../receipt"},{request_id:"11111111-1111-4111-8111-111111111111",offset:0}]){
  await assert.rejects(tools.bps_reset_status.execute({account:"bps",...extra}));
 }
 const empty=await tools.bps_reset_status.execute({account:"bps",offset:100,limit:20});assert.equal(empty.total,0);assert.equal(empty.operations.length,0);assert.equal(empty.hasMore,false);
});
