import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {bridgeInstallError} from "../src/platforms.mjs";
import {startBridge} from "../src/bridge.mjs";
import {makeFetch} from "../src/provider.mjs";
import {BASE_URL} from "../src/constants.mjs";
import {auth} from "./helpers.mjs";

test("incomplete GitHub install fails locally with actionable installation error",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"bps-missing-"));
  try{
    let calls=0;
    const fetch=makeFetch(async()=>auth(),{current:get=>get()},{},{binary:path.join(root,"missing"),fetchImpl:async()=>{calls++;throw new Error("Must not reach upstream");}});
    const response=await fetch(BASE_URL+"/responses",{method:"POST",body:JSON.stringify({model:"gpt-6-astra",input:"ping",stream:true})});
    const body=await response.json();
    assert.equal(response.status,500);assert.equal(body.error.code,"basispoints_bridge_unavailable");
    assert.match(body.error.message,/Update the GitHub plugin/);assert.match(body.error.message,/releases\/tag\/v/);
    assert.match(body.error.message,new RegExp(`${process.platform}-${process.arch}`));
    assert.doesNotMatch(body.error.message,/Run npm|Go 1\./);assert.equal(calls,0);
    assert.equal(response.headers.get("x-magpie-sign-in"),null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("directory and non-executable bridge report installation failure",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"bps-binary-"));
  try{
    const binary=path.join(root,"broken.exe");writeFileSync(binary,"not an executable",{mode:0o600});
    for(const value of [root,binary])await assert.rejects(startBridge('{}',"test",{binary:value}),error=>error.code==="basispoints_bridge_unavailable");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("unsupported architecture is explicit instead of prescribing a compiler",()=>{
  assert.match(bridgeInstallError("missing","win32","ia32").message,/does not support win32-ia32/);
  assert.doesNotMatch(bridgeInstallError("missing","win32","ia32").message,/Go installation|npm run/);
});
