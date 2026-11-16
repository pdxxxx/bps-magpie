import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beginLogin, normalizeTokens, refreshTokens, createCredentialManager } from "../src/auth.mjs";
import { CLIENT_ID, REDIRECT_URI, TOKEN_URL } from "../src/constants.mjs";
import { tokens, auth, jwt } from "./helpers.mjs";

function callback(flow,patch={}) {const u=new URL(REDIRECT_URI);u.search=new URLSearchParams({state:new URL(flow.url).searchParams.get("state"),code:"test-code",...patch});return u.href;}
test("PKCE login uses the Excel client, checks state and exchanges once",async()=>{
 let calls=0;let request;
 const flow=await beginLogin(undefined,{}, {fetchImpl:async(url,init)=>{calls++;assert.equal(url,TOKEN_URL);assert.equal(init.redirect,"error");request=JSON.parse(init.body);return Response.json(tokens());}});
 const url=new URL(flow.url);assert.equal(url.searchParams.get("client_id"),CLIENT_ID);assert.equal(url.searchParams.get("redirect_uri"),REDIRECT_URI);
 assert.equal((await flow.callback(callback(flow,{state:"wrong"}))).type,"failed");assert.equal(calls,0);
 const result=await flow.callback(callback(flow));assert.equal(result.type,"success");assert.equal(result.workspaceId,"workspace-a");
 assert.equal(createHash("sha256").update(request.code_verifier).digest("base64url"),url.searchParams.get("code_challenge"));
 assert.equal(request.grant_type,"authorization_code");assert.equal((await flow.callback(callback(flow))).type,"failed");assert.equal(calls,1);
});
test("callback rejects missing state, duplicate code, foreign origin and bare code",async()=>{
 let calls=0;const flow=await beginLogin(undefined,{}, {fetchImpl:async()=>{calls++;throw 0;}});
 for(const value of ["code-only",callback(flow).replace("bps.openai.com","attacker.invalid"),callback(flow)+"&code=second",REDIRECT_URI+"?code=x",callback(flow)+"#fragment"]){assert.equal((await flow.callback(value)).type,"failed");}
 assert.equal(calls,0);
});
test("cancelled login never exchanges the code",async()=>{
 const c=new AbortController();const flow=await beginLogin(undefined,{signal:c.signal},{fetchImpl:async()=>{assert.fail("network called");}});c.abort();assert.equal((await flow.callback(callback(flow))).type,"failed");
});
test("tokens require the Excel grant, workspace, refresh token and ID audience",()=>{
 for(const patch of [{access_token:jwt({client_id:"codex",exp:9999999999})},{refresh_token:""},{id_token:jwt({aud:"codex"})},{access_token:"bad"},{id_token:""}])assert.throws(()=>normalizeTokens(tokens(patch)));
 assert.throws(()=>normalizeTokens(tokens(),{...auth(),workspaceId:"another"}),/workspace/);
 assert.throws(()=>normalizeTokens(tokens(),{...auth(),subject:"another"}),/identity/);
});
test("refresh preserves identity and rotates refresh tokens",async()=>{
 const old=auth();const next=await refreshTokens(old,{fetchImpl:async(url,init)=>{assert.equal(url,TOKEN_URL);const body=JSON.parse(init.body);assert.equal(body.client_id,CLIENT_ID);assert.equal(body.refresh_token,old.refresh);return Response.json(tokens({refresh_token:"rotated",id_token:undefined}));}});
 assert.equal(next.refresh,"rotated");assert.equal(next.accountId,old.accountId);assert.equal(next.subject,old.subject);
});
test("invalid_grant marks expired without leaking token endpoint body",async()=>{
 await assert.rejects(refreshTokens(auth(),{fetchImpl:async()=>Response.json({error:"invalid_grant",description:"SECRET_BODY"},{status:400})}),e=>e.signIn==="expired"&&!e.message.includes("SECRET_BODY"));
});
test("parallel requests share one refresh and persist the full account",async()=>{
 let saved={...auth(),expires:0};let calls=0,writes=0;
 const manager=createCredentialManager({auth:{set:async({body,path})=>{assert.equal(path.id,"bps");saved=body;writes++;}}},{fetchImpl:async()=>{calls++;await new Promise(r=>setTimeout(r,15));return Response.json(tokens({refresh_token:"new-refresh"}));}});
 const results=await Promise.all(Array.from({length:8},()=>manager.current(async()=>saved)));
 assert.equal(calls,1);assert.ok(writes>=1);assert.ok(results.every(a=>a.refresh==="new-refresh"));assert.equal(saved.workspaceId,"workspace-a");
});
test("refresh cache cannot resurrect an account changed during refresh",async()=>{
 let saved={...auth(),expires:0};
 const manager=createCredentialManager({auth:{set:async()=>assert.fail("must not overwrite account")}},{fetchImpl:async()=>{saved={...auth(),refresh:"other-login"};return Response.json(tokens());}});
 await assert.rejects(manager.current(async()=>saved),/Account changed/);
});
test("a reused refresh token cannot cross workspace identity through the cache",async()=>{
 let calls=0;const manager=createCredentialManager({}, {fetchImpl:async()=>{calls++;return Response.json(tokens({refresh_token:"rotated"}));}});
 await manager.refresh(auth());await assert.rejects(manager.refresh({...auth(),workspaceId:"different-workspace"}),/bound to another/);assert.equal(calls,1);
});

test("refresh persistence rejects an identity change even with the same refresh token",async()=>{
 for(const changed of [{workspaceId:"workspace-b"},{subject:"subject-b"},{clientId:"different-client"}]){
  let saved={...auth(),expires:0},writes=0;
  const manager=createCredentialManager({auth:{set:async()=>{writes++;}}},{fetchImpl:async()=>{saved={...saved,...changed};return Response.json(tokens({refresh_token:"rotated"}));}});
  await assert.rejects(manager.current(async()=>saved),/Account changed/);assert.equal(writes,0);
 }
});

test("a cancelled refresh waiter stays cancelled after another caller persisted rotation",async()=>{
 const abort=new AbortController();let saved={...auth(),expires:0};
 const manager=createCredentialManager({auth:{set:async()=>assert.fail("already persisted")}}, {fetchImpl:async()=>{const next=tokens({refresh_token:"rotated"});saved=normalizeTokens(next);abort.abort(new Error("cancelled-refresh-waiter"));return Response.json(next);}});
 await assert.rejects(manager.current(async()=>saved,abort.signal),/cancelled-refresh-waiter/);
});
test("missing host persistence fails before rotating a refresh token",async()=>{
 let calls=0;const manager=createCredentialManager({}, {fetchImpl:async()=>{calls++;return Response.json(tokens({refresh_token:"rotated"}));}});
 await assert.rejects(manager.current(async()=>({...auth(),expires:0})),/persist/);assert.equal(calls,0);
});
