import test from "node:test";
import assert from "node:assert/strict";
import {diagnose,bridgeInfo} from "../src/diagnostics.mjs";
import {createConversationStore} from "../src/state.mjs";
import {terminalObserver} from "../src/events.mjs";
import {event,completed} from "./helpers.mjs";

test("diagnostics reports protocol and limits without secrets or network activity",async()=>{
 const result=await diagnose({proxy:"http://user:PROXY_SECRET@localhost:7891"},createConversationStore());assert.equal(result.bridge.protocol,3);assert.equal(result.buildMatches,true);assert.equal(result.liveNetworkChecked,false);assert.doesNotMatch(JSON.stringify(result),/PROXY_SECRET|localhost|user:/);assert.ok(result.continuation.maxBytes>0);
});
test("missing bridge has a useful local diagnosis",async()=>{assert.equal((await bridgeInfo("Z:/definitely-missing-bps-test.exe")).available,false);});
test("terminal observer handles split UTF-8/CRLF and preserves cancellation terminals",()=>{
 const terminal=completed();terminal.response.output[0].content[0].text="中文";const raw=event(terminal).replaceAll("\n","\r\n");const bytes=new TextEncoder().encode(raw);const got=[];const observer=terminalObserver((e,r)=>got.push([e,r]));for(const b of bytes)observer.push(Uint8Array.of(b));observer.finish();assert.equal(got.length,1);assert.equal(got[0][0].response.output[0].content[0].text,"中文");
 const cancelled=terminalObserver(e=>got.push([e]));cancelled.push(new TextEncoder().encode(event({type:"response.cancelled",response:{status:"cancelled"}})));cancelled.finish();assert.equal(got.at(-1)[0].type,"response.cancelled");
});
