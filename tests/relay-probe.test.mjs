import test from 'node:test';
import assert from 'node:assert/strict';
import {measureRelay,runRequestedProbe} from '../src/relay-probe.mjs';
import {relayOptions} from '../src/relay.mjs';
import {fieldsFromOptions,optionsFromFields} from '../ui/settings.mjs';
const config={url:'wss://relay.example/relay',token:'test'.repeat(10)};
const hello=JSON.stringify({type:'hello',status:1,bytes:262144});
test('RTT uses three pongs after hello on one socket, excluding a long setup',async()=>{
 let time=0,dials=0,closed=false;const delays=[75,20,41];
 const dial=(u,opts)=>{
  dials++;assert.equal(u,config.url);assert.equal(opts.headers.authorization,'Bearer '+config.token);
  const ws={send(raw){assert.deepEqual(JSON.parse(raw),{type:'ping'});queueMicrotask(()=>{time+=delays.shift();ws.onmessage({data:'{"type":"pong"}'});});},close(){closed=true;}};
  queueMicrotask(()=>{time+=5500;ws.onmessage({data:hello});});return ws;
 };
 assert.deepEqual(await measureRelay(config,{dial,clock:()=>time}),{median:41,values:[75,20,41]});assert.equal(dials,1);assert.ok(closed);
});
test('no pong, bad handshake or disconnect never produces a latency',async()=>{
 for(const kind of ['timeout','protocol','disconnect']){
  const dial=()=>{const ws={send(){if(kind==='disconnect')ws.onclose();},close(){}};
   queueMicrotask(()=>ws.onmessage({data:kind==='protocol'?'{}':hello}));return ws;};
  await assert.rejects(measureRelay(config,{dial,pongMs:20}),/超时|无效|失败/);
 }
});
test('settings and runtime trim outer whitespace but reject hidden or malformed relay input',()=>{
 const base={relayEnabled:true,relayUrl:config.url,relayToken:config.token},fields=fieldsFromOptions(base);
 assert.deepEqual(relayOptions({...base,relayUrl:' '+config.url+'\t',relayToken:'\n'+config.token+' '}),config);
 for(const patch of [{relayUrl:'wss://re\tlay.example/relay'},{relayUrl:config.url+'?'},{relayUrl:'wss://re\u200blay.example/relay'},{relayToken:'x'.repeat(35)+' x'}]){
  assert.throws(()=>relayOptions({...base,...patch}));assert.throws(()=>optionsFromFields({...fields,...patch}));
 }
});

test('a saved test produces one inert result per click without disclosing its URL or token',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bps-probe-'));
 const base={relayEnabled:true,relayUrl:config.url,relayToken:config.token},id='abc0'.repeat(8);
 let calls=0;const deps={dir,measure:async()=>{calls++;return {values:[11,19,15],median:15};}};
 try{
  const opts={...base,relayTest:{id,at:Date.now()}};
  await Promise.all([runRequestedProbe(opts,deps),runRequestedProbe(opts,deps)]);
  const card=await fs.readFile(path.join(dir,id+'.svg'),'utf8');assert.match(card,/15 ms/);assert.doesNotMatch(card,/script|relay.example|testtest/);assert.equal(calls,1);
  const bad='def0'.repeat(8);
  await runRequestedProbe({...base,relayTest:{id:bad,at:Date.now()}},{...deps,measure:async()=>{throw new Error(config.token)}});
  const failure=await fs.readFile(path.join(dir,bad+'.svg'),'utf8');assert.match(failure,/测试失败/);assert.ok(!failure.includes(config.token));
  for(const v of [{id:'../bad',at:Date.now()},{id,at:Date.now()-120000}])await runRequestedProbe({...base,relayTest:v},deps);
  assert.equal(calls,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
