import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";

async function page({provider="bps",rows,unknown=false,tabs=false}={}){
 const all=[];
 function node(tag){const n={tagName:tag,children:[],listeners:{},textContent:"",dataset:{},disabled:false,hidden:false,className:"",append(...xs){this.children.push(...xs);for(const x of xs)x.parent=this;},replaceChildren(...xs){this.children=xs;},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},addEventListener(k,fn){this.listeners[k]=fn;}};all.push(n);return n;}
 const ids=Object.fromEntries(["panel","refresh","rows","status"].map(id=>[id,node('div')]));let options={relayToken:"PRIVATE_TEST_TOKEN",unrelated:true},now=2000000;const sent=[];
 if(tabs)for(const id of ['section','tab','connection-tab','connection-section']){ids[id]=node('div');ids[id].setAttribute=(k,v)=>{ids[id][k]=v;};ids[id].focus=()=>{};}
 ids.panel.querySelectorAll=()=>all.filter(n=>n.tagName==='button');
 const ctx={document:{getElementById:id=>ids[id.replace(/^reset-/,"")],createElement:node,head:node('head'),querySelectorAll:()=>all.filter(n=>n.tagName==='button')},crypto:globalThis.crypto,setTimeout,clearTimeout,Date:class extends Date {static now(){return now+=1100;}},magpie:{ready:Promise.resolve(),context:{provider:{id:provider}},options:{get:async()=>options,set:async value=>{options=value;sent.push(value.bpsPanelAction);}}}};
 const operation={requestId:"550e8400-e29b-41d4-a716-446655440000",status:unknown?"unknown":"prepared"};
 const baseline=rows||[{account:"bps",label:"<b>account@example.invalid</b>",count:2,windows:[],operation:unknown?operation:null}];
 ctx.document.head.append=script=>{const cmd=sent.at(-1);queueMicrotask(()=>{
  const result=cmd.kind==='list'?{ok:true,rows:baseline}:cmd.kind==='preview'?{ok:true,account:"bps",operation}:{ok:true,row:{...baseline[0],count:1,operation:{...operation,status:'success'}},message:'已重置 2 个额度窗口。'};
  ctx.bpsPanelResult(cmd.id,result);script.onload?.();
 });};
 await runInNewContext(await readFile(new URL('../ui/reset-panel.js',import.meta.url),'utf8'),ctx);
 const buttons=()=>{const out=[];function visit(n){if(n.tagName==='button')out.push(n);n.children.forEach(visit);}visit(ids.rows);return out;};
 return {ids,sent,options:()=>options,buttons};
}
test('panel merges label count and reset, requires confirmation and preserves connection options',async()=>{
 const p=await page();assert.equal(p.sent.length,1);assert.equal(p.sent[0].kind,'list');
 assert.equal(p.ids.rows.children[0].children[0].children[0].textContent,'<b>account@example.invalid</b>');
 await p.buttons().find(b=>b.textContent==='重置').listeners.click();assert.deepEqual(p.sent.map(c=>c.kind),['list','preview']);
 await p.buttons().find(b=>b.textContent==='取消').listeners.click();assert.equal(p.sent.length,2);
 await p.buttons().find(b=>b.textContent==='重置').listeners.click();await p.buttons().find(b=>b.textContent==='确认使用 1 次').listeners.click();
 assert.equal(p.sent.at(-1).kind,'commit');assert.equal(p.sent.at(-1).confirm,true);assert.equal(p.options().relayToken,'PRIVATE_TEST_TOKEN');assert.equal(p.options().unrelated,true);assert.match(p.ids.status.textContent,/已重置/);
 assert.equal(p.ids.rows.children[0].children[0].children[1].textContent,'剩余 1 次');
});
test('another provider opens no account data and zero or unknown counts disable reset',async()=>{
 const other=await page({provider:'unrelated'});assert.equal(other.sent.length,0);assert.equal(other.ids.panel.hidden,true);
 for(const count of [null,0]){const p=await page({rows:[{account:'bps',label:'a',count,windows:[]}]});assert.equal(p.buttons()[0].disabled,true);}
});
test('unknown result offers only explicit original-operation retry',async()=>{
 const p=await page({unknown:true});await p.buttons().find(b=>b.textContent==='核对原操作').listeners.click();
 assert.ok(p.buttons().some(b=>b.textContent==='确认核对原操作'));assert.ok(!p.buttons().some(b=>b.textContent==='确认使用 1 次'));
});
test('two tabs stay in the same document and load accounts only on first reset visit',async()=>{
 const p=await page({tabs:true});assert.equal(p.sent.length,0);
 p.ids.tab.listeners.click();await new Promise(r=>setTimeout(r,10));
 assert.equal(p.ids['connection-section'].hidden,true);assert.equal(p.ids.section.hidden,false);assert.equal(p.sent.length,1);
 p.ids['connection-tab'].listeners.click();assert.equal(p.ids.section.hidden,true);
 p.ids.tab.listeners.click();assert.equal(p.sent.length,1);
});
