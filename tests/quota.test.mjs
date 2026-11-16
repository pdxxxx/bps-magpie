import test from "node:test";
import assert from "node:assert/strict";
import { projectUsage,resetDetails,queryQuota,USAGE_URL,CREDITS_URL } from "../src/quota.mjs";
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

test("zero epoch does not manufacture a 1970 reset date and null usage is rejected",async()=>{
 const result=projectUsage({rate_limit:{primary_window:{used_percent:4,reset_at:0,reset_after_seconds:20}}},undefined,{now:2000000000000});assert.equal(result.windows[0].resetsAt,new Date(2000000020000).toISOString());
 await assert.rejects(queryQuota(auth(),{fetchImpl:async()=>Response.json(null)}),/Invalid quota/);
});
