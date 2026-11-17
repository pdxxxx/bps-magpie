import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {createResetPanel,runPanelAction,panelProxy} from "../src/reset-panel.mjs";
import {CONSUME_URL,USAGE_URL,availableResetCredit,consumeReset} from "../src/quota.mjs";
import {auth} from "./helpers.mjs";

async function fixture(t,{extra={},failPost=false,failReadAfter=false}={}){
 const directory=await mkdtemp(path.join(tmpdir(),"bps-panel-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const account={...auth(),accountId:"test@example.invalid"};
 await writeFile(path.join(directory,"plugin-auth.json"),JSON.stringify({bps:account,...extra}));
 let posts=0,entered,unblock;const sent=[];
 const deps={fetchImpl:async(url,init)=>{
  if(url===CONSUME_URL){posts++;sent.push(JSON.parse(init.body));if(entered){entered();await new Promise(r=>{unblock=r;});}if(failPost)throw new Error("SECRET_TOKEN upstream timeout");return Response.json({code:"success",windows_reset:2});}
  if(posts&&failReadAfter)return new Response("PRIVATE_BODY",{status:503});
  return Response.json(url===USAGE_URL?{account_id:"workspace-a",rate_limit:{primary_window:{used_percent:posts?0:40}},rate_limit_reset_credits:{available_count:posts?1:2}}:{available_count:posts?1:2,credits:[{id:"PRIVATE_CARD",status:"available",reset_type:"codex_rate_limits",expires_at:"2030-01-01"}]});
 }};
 return {directory,deps,panel:createResetPanel({directory,deps}),account,sent,posts:()=>posts,block:fn=>{entered=fn;},unblock:()=>unblock()};
}
test("panel preview and cancel are read-only; confirmed reset targets one credit once",async t=>{
 const f=await fixture(t);const list=await f.panel.list();assert.equal(list.rows[0].count,2);
 const preview=await f.panel.preview("bps");assert.equal(f.posts(),0);
 assert.equal((await f.panel.preview("bps")).operation.requestId,preview.operation.requestId);
 await assert.rejects(f.panel.commit("bps",preview.operation.requestId,false),/确认/);assert.equal(f.posts(),0);
 const out=await f.panel.commit("bps",preview.operation.requestId,true);assert.equal(f.posts(),1);assert.equal(out.row.count,1);assert.equal(out.row.windows[0].used,0);assert.equal(out.row.operation.status,"success");
 assert.deepEqual(f.sent[0],{redeem_request_id:preview.operation.requestId,credit_id:"PRIVATE_CARD"});
 assert.equal((await f.panel.commit("bps",preview.operation.requestId,true)).replayed,true);assert.equal(f.posts(),1);
 assert.doesNotMatch(JSON.stringify([list,preview,out]),/PRIVATE_CARD|access|refresh|workspace-a/);
});
test("unknown result persists across reloads and manual retry keeps the same card and ID",async t=>{
 const f=await fixture(t,{failPost:true});const p=await f.panel.preview("bps");const first=await f.panel.commit("bps",p.operation.requestId,true);
 assert.equal(first.row.operation.status,"unknown");assert.doesNotMatch(JSON.stringify(first),/SECRET_TOKEN/);
 const next=createResetPanel({directory:f.directory,deps:f.deps});const same=await next.preview("bps");assert.equal(same.operation.requestId,p.operation.requestId);
 await next.commit("bps",same.operation.requestId,true);assert.equal(f.posts(),2);assert.deepEqual(f.sent[0],f.sent[1]);
});
test("post-reset read failure remains success and never replays consumption",async t=>{
 const f=await fixture(t,{failReadAfter:true});const p=await f.panel.preview("bps");const out=await f.panel.commit("bps",p.operation.requestId,true);
 assert.equal(out.row.operation.status,"success");assert.match(out.warning,/已成功/);assert.equal(out.row.count,null);
 await f.panel.commit("bps",p.operation.requestId,true);assert.equal(f.posts(),1);
});
test("simultaneous confirmations and another slot of the same workspace cannot spend twice",async t=>{
 const f=await fixture(t,{extra:{"bps#other":auth()}});const p=await f.panel.preview("bps");
 await assert.rejects(f.panel.preview("bps#other"),/另一账号/);
 let ready;const waiting=new Promise(r=>{ready=r;});f.block(ready);const first=f.panel.commit("bps",p.operation.requestId,true);await waiting;
 await assert.rejects(f.panel.commit("bps",p.operation.requestId,true),/正在进行/);f.unblock();await first;assert.equal(f.posts(),1);
});
test("identity changes, expired access and missing accounts reject before consumption",async t=>{
 const f=await fixture(t);const p=await f.panel.preview("bps");
 await writeFile(path.join(f.directory,"plugin-auth.json"),JSON.stringify({bps:{...f.account,subject:"someone-else"}}));
 await assert.rejects(f.panel.commit("bps",p.operation.requestId,true),/已改变/);
 await writeFile(path.join(f.directory,"plugin-auth.json"),JSON.stringify({bps:{...f.account,expires:0}}));
 await assert.rejects(f.panel.preview("bps"),/续期/);
 await writeFile(path.join(f.directory,"plugin-auth.json"),'{}');await assert.rejects(f.panel.preview("bps"),/已移除/);assert.equal(f.posts(),0);
});
test("legacy uncertain receipts block a new reset",async t=>{
 const f=await fixture(t),dir=path.join(f.directory,"bps-resets");await mkdir(dir);
 await writeFile(path.join(dir,randomUUID()+".json"),JSON.stringify({status:"unknown",scope:createHash("sha256").update("workspace-a").digest("hex")}));
 await assert.rejects(f.panel.preview("bps"),/旧版/);assert.equal(f.posts(),0);
});
test("account proxy follows account then provider and resolves saved password without leaking it",()=>{
 const providers={providers:[{id:"bps",proxy:"http://provider:8080",accountProxies:{"a@example.invalid":"@saved"}}]};
 const proxy=panelProxy(providers,{proxies:[{id:"saved",url:"http://proxy:8080",user:"u@x",pass:"p/a"}]},"A@example.invalid");assert.equal(proxy,"http://u%40x:p%2Fa@proxy:8080/");
 assert.equal(panelProxy(providers,{},"other"),"http://provider:8080/");assert.equal(panelProxy({}, {},"a"),undefined);
 assert.throws(()=>panelProxy(providers,{},"a@example.invalid"),/不存在/);
 providers.providers[0].accountProxies["a@example.invalid"]="direct";assert.equal(panelProxy(providers,{},"a@example.invalid"),"");
});
test("panel command replay publishes a public result without repeating POST",async t=>{
 const f=await fixture(t),results=path.join(f.directory,"results");const p=await f.panel.preview("bps");
 const options={bpsPanelAction:{id:"a".repeat(32),at:Date.now(),provider:"bps",kind:"commit",account:"bps",requestId:p.operation.requestId,confirm:true}};
 await runPanelAction({directory:f.directory,results,options,deps:f.deps});
 await runPanelAction({directory:f.directory,results,options,deps:f.deps});assert.equal(f.posts(),1);
 const script=await readFile(path.join(results,"a".repeat(32)+".js"),"utf8");assert.match(script,/bpsPanelResult/);assert.doesNotMatch(script,/PRIVATE_CARD|test-refresh|workspace-a|Bearer/);
 const stale={...options,bpsPanelAction:{...options.bpsPanelAction,id:"b".repeat(32),at:Date.now()-121000}};await runPanelAction({directory:f.directory,results,options:stale,deps:f.deps});assert.equal(f.posts(),1);
});
test("credit selection uses the soonest usable card and excludes expired or malformed details",async()=>{
 const result=await availableResetCredit(auth(),{fetchImpl:async()=>Response.json({credits:[{id:"expired",status:"available",reset_type:"codex_rate_limits",expires_at:"2020-01-01"},{id:"invalid",status:"available",reset_type:"codex_rate_limits",expires_at:"bad"},{id:"never",status:"available",reset_type:"codex_rate_limits",expires_at:null},{id:"soon",status:"available",reset_type:"codex_rate_limits",expires_at:"2030-01-01"}]})});assert.equal(result.id,"soon");
});
test("reset handles both confirmed success codes and explicit no-consumption outcomes",async()=>{
 for(const code of ['reset','success']){
  const out=await consumeReset(auth(),{requestId:randomUUID(),creditId:'card'},{fetchImpl:async()=>Response.json({code,windows_reset:2})});assert.equal(out.status,'success');
 }
 for(const code of ['nothing_to_reset','no_credit','already_redeemed','already_used']){
  const out=await consumeReset(auth(),{requestId:randomUUID(),creditId:'card'},{fetchImpl:async()=>Response.json({code,windows_reset:0})});assert.equal(out.status,'finished');
 }
});
