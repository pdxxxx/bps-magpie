import test from "node:test";
import assert from "node:assert/strict";
import {fieldsFromOptions,optionsFromFields} from "../ui/settings.mjs";
import {readFile} from "node:fs/promises";

test("settings preserve unrelated options and remove obsolete manual model configuration",()=>{
 const fields=fieldsFromOptions({models:["old-model"],proxy:"direct",timeoutMs:120000});assert.equal(fields.mode,"direct");assert.equal(fields.seconds,"120");assert.equal(fields.models,undefined);
 const options=optionsFromFields({...fields,mode:"proxy",proxy:"http://127.0.0.1:7891"},{models:["old-model"],futureOption:true});assert.equal(options.models,undefined);assert.equal(options.futureOption,true);assert.equal(options.proxy,"http://127.0.0.1:7891/");
 for(const patch of [{seconds:"0"},{seconds:"3601"},{seconds:"1.5"},{mode:"proxy",proxy:"socks5://localhost:1080"},{cache:"yes"}])assert.throws(()=>optionsFromFields({...fields,...patch}));
});
async function pageElements(){const html=await readFile(new URL("../ui/index.html",import.meta.url),"utf8");const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{value:"",textContent:"",hidden:false,disabled:id==="controls",dataset:{},listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}}]));return {html,elements};}
test("settings controller loads and saves only connection options",async()=>{
 const {elements}=await pageElements();const oldDocument=globalThis.document,oldMagpie=globalThis.magpie;let saved={models:["legacy"],customPreserved:true};
 globalThis.document={getElementById:id=>elements.get(id)};globalThis.magpie={ready:Promise.resolve(),options:{get:async()=>saved,set:async options=>{saved=options;return options;}}};
 try{await import("../ui/app.js?controller-test");assert.equal(elements.get("controls").disabled,false);elements.get("mode").value="proxy";elements.get("mode").listeners.change();assert.equal(elements.get("proxy-row").hidden,false);elements.get("proxy").value="http://127.0.0.1:7891";elements.get("seconds").value="300";elements.get("cache").checked=false;await elements.get("settings").listeners.submit({preventDefault(){}});assert.equal(saved.timeoutMs,300000);assert.equal(saved.models,undefined);assert.equal(saved.customPreserved,true);assert.equal(saved.continuationCache,false);elements.get("seconds").value="0";await elements.get("settings").listeners.submit({preventDefault(){}});assert.equal(elements.get("status").dataset.error,"true");assert.equal(saved.timeoutMs,300000);}finally{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldMagpie===undefined)delete globalThis.magpie;else globalThis.magpie=oldMagpie;}
});
async function bundledPage(host,{timeout=false}={}){
 const {html,elements}=await pageElements();const {runInNewContext}=await import("node:vm");const source=await readFile(new URL("../ui/app.bundle.js",import.meta.url),"utf8");
 const scope={document:{getElementById:id=>elements.get(id)},URL,magpie:host,setTimeout:timeout?(fn=>{queueMicrotask(fn);return 1;}):setTimeout,clearTimeout:timeout?(()=>{}):clearTimeout};await runInNewContext(source,scope,{filename:"app.bundle.js"});return {elements,html,source};
}
test("minimal settings bundle uses a classic script and hides advanced options initially",async()=>{
 let saved={customPreserved:true};const page=await bundledPage({ready:Promise.resolve(),options:{get:async()=>saved,set:async options=>{saved=options;return options;}}});
 assert.match(page.html,/<script src="app\.bundle\.js" defer><\/script>/);assert.doesNotMatch(page.html,/type="module"|id="models"|账号与额度|bps_quota|bps_reset/);assert.match(page.html,/<details><summary>高级选项<\/summary>/);assert.doesNotMatch(page.source,/^\s*(?:import|export)\b/m);assert.equal(page.elements.get("controls").disabled,false);assert.equal(page.elements.get("status").textContent,"设置已读取。");page.elements.get("seconds").value="120";await page.elements.get("settings").listeners.submit({preventDefault(){}});assert.equal(saved.timeoutMs,120000);assert.equal(saved.customPreserved,true);
});
test("settings page reports an actionable error when its host bridge is missing",async()=>{const page=await bundledPage(undefined);assert.equal(page.elements.get("controls").disabled,true);assert.match(page.elements.get("status").textContent,/未能连接 Magpie/);});
test("settings page stops waiting when the host handshake times out",async()=>{const page=await bundledPage({ready:new Promise(()=>{}),options:{get:async()=>assert.fail("not ready")}}, {timeout:true});assert.equal(page.elements.get("controls").disabled,true);assert.match(page.elements.get("status").textContent,/超时/);});
test("plugin and provider use BPS identifiers and a packaged icon",async()=>{
 const pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")),svg=await readFile(new URL("../ui/icon.svg",import.meta.url),"utf8");assert.equal(pkg.name,"opencode-bps-auth");assert.equal(pkg.magpie.name,"BPS");assert.equal(pkg.magpie.page.icon,"ui/icon.svg");assert.equal(Buffer.from(pkg.magpie.icon.split(",")[1],"base64").toString(),svg);const {BPSPlugin}=await import("../index.mjs");const hooks=await BPSPlugin({});const cfg={};await hooks.config(cfg);assert.equal(hooks.auth.provider,"bps");assert.equal(cfg.provider.bps.name,"BPS");assert.deepEqual(cfg.provider.bps.models,{});
});
