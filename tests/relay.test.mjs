import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayFetch,relayOptions} from '../src/relay.mjs';
import {createFetch} from '../src/network.mjs';
import {fieldsFromOptions,optionsFromFields} from '../ui/settings.mjs';

const config={url:'wss://relay.invalid/relay',token:'test-'.repeat(10)};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(reply){
 let sockets=0;const all=[];
 const factory=()=>{sockets++;const ws={readyState:0,bufferedAmount:0,send(raw){reply(ws,JSON.parse(raw));},close(){this.readyState=3;this.onclose?.();},emit(f){this.onmessage?.({data:JSON.stringify(f)});}};all.push(ws);queueMicrotask(()=>{ws.readyState=1;ws.onopen?.();ws.emit({type:'hello',status:1,bytes:262144});});return ws;};
 return {factory,all,get sockets(){return sockets;}};
}
test('relay requires explicit enablement and never embeds a deployment address',async()=>{
 assert.equal(relayOptions({}),null);assert.equal(relayOptions({relayEnabled:false,relayUrl:'invalid'}),null);
 for(const relayUrl of ['ws://relay.invalid/relay','wss://a:b@relay.invalid/relay','wss://relay.invalid/path','wss://relay.invalid/relay?token=x'])assert.throws(()=>relayOptions({relayEnabled:true,relayUrl,relayToken:config.token}));
 assert.deepEqual(relayOptions({relayEnabled:true,relayUrl:config.url,relayToken:config.token}),config);
 const fields=fieldsFromOptions({});assert.equal(fields.relayEnabled,false);assert.equal(fields.relayUrl,'');assert.equal(fields.relayToken,'');
 assert.equal(optionsFromFields({...fields,relayEnabled:true,relayUrl:config.url,relayToken:config.token}).relayEnabled,true);
 let direct=0;const f=createFetch({relayEnabled:false,relayUrl:config.url},{fetchImpl:async()=>{direct++;return new Response('ok');}});await f('https://bps.openai.com');assert.equal(direct,1);
});
test('one channel preserves multiple request identities, bodies, statuses and credits',async()=>{
 const received=new Map();let starts=0,credits=0;
 const mock=fixture((ws,f)=>{if(f.type==='start'){starts++;received.set(f.id,[]);ws.emit({type:'ready',id:f.id,bytes:262144});}
  if(f.type==='upload'){received.get(f.id).push(Buffer.from(f.data,'base64'));ws.emit({type:'upload_credit',id:f.id,bytes:Buffer.from(f.data,'base64').length});}
  if(f.type==='uploaded'){ws.emit({type:'head',id:f.id,status:403,headers:{'content-type':'text/plain','retry-after':'4'}});const bytes=Buffer.concat(received.get(f.id));for(let p=0;p<bytes.length;p+=32768)ws.emit({type:'data',id:f.id,data:bytes.subarray(p,p+32768).toString('base64')});ws.emit({type:'end',id:f.id});}
  if(f.type==='credit')credits+=f.bytes;
 });
 const fetch=createRelayFetch(config,{socketFactory:mock.factory});
 try{for(let i=0;i<3;i++){const content='图片'.repeat(10000);const res=await fetch('https://bps.openai.com/basispoints/api/responses',{method:'POST',body:content});assert.equal(res.status,403);assert.equal(res.headers.get('retry-after'),'4');assert.equal(await res.text(),content);}assert.equal(starts,3);assert.equal(mock.sockets,1);assert.equal(credits,180000);}finally{fetch.close();}
});
test('disconnect fails a submitted request and never replays it; later calls reconnect',async()=>{
 let starts=0,time=0;
 const mock=fixture((ws,f)=>{if(f.type==='start'){starts++;ws.emit({type:'ready',id:f.id,bytes:262144});}if(f.type==='uploaded')ws.close();});
 const fetch=createRelayFetch(config,{socketFactory:mock.factory,now:()=>time});
 try{await assert.rejects(fetch('https://bps.openai.com/basispoints/api/responses',{method:'POST',body:'x'}),/disconnected/);assert.equal(starts,1);await assert.rejects(fetch('https://bps.openai.com'),/backoff/);assert.equal(starts,1);time=6000;await assert.rejects(fetch('https://bps.openai.com/basispoints/api/responses',{method:'POST',body:'x'}),/disconnected/);assert.equal(starts,2);}finally{fetch.close();}
});
test('cancelling one concurrent request does not close the channel or another request',async()=>{
 const pending=[];const cancelled=[];
 const mock=fixture((ws,f)=>{if(f.type==='start'){ws.emit({type:'ready',id:f.id,bytes:262144});}if(f.type==='uploaded')pending.push({ws,id:f.id});if(f.type==='cancel')cancelled.push(f.id);});
 const fetch=createRelayFetch(config,{socketFactory:mock.factory});const abort=new AbortController();
 try{const first=fetch('https://bps.openai.com',{signal:abort.signal});const second=fetch('https://bps.openai.com');await tick();abort.abort(new Error('caller cancelled'));await assert.rejects(first,/caller cancelled/);assert.equal(mock.all[0].readyState,1);const {ws,id}=pending[1];ws.emit({type:'head',id,status:200,headers:{}});ws.emit({type:'data',id,data:Buffer.from('ok').toString('base64')});ws.emit({type:'end',id});assert.equal(await(await second).text(),'ok');assert.equal(cancelled.length,1);}finally{fetch.close();}
});
test('configuration errors and failed handshakes never fall back to direct HTTP',async()=>{
 const fetch=createRelayFetch(config,{socketFactory(){throw new Error('PRIVATE_TOKEN');}});
 await assert.rejects(fetch('https://bps.openai.com'),e=>!e.message.includes('PRIVATE_TOKEN')&&e.message.includes('connect_failed'));fetch.close();
});
