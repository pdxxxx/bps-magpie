import {mkdir,open,rename,unlink,readdir,stat,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {relayOptions} from './relay.mjs';

// A dedicated diagnostic socket cannot mistake a production heartbeat for
// the response to a probe. No model, account token or upstream HTTP request.
export function measureRelay(config,{dial=(url,opts)=>new WebSocket(url,opts),clock=()=>performance.now(),helloMs=60000,pongMs=10000}={}){
 return new Promise((resolve,reject)=>{
  let ws,timer,start,ready=false,done=false;
  const values=[];
  function finish(err){
   if(done)return;done=true;clearTimeout(timer);
   if(ws){ws.onclose=ws.onerror=ws.onmessage=null;try{ws.close();}catch{}}
   if(err)reject(new Error(err));else resolve({values,median:[...values].sort((a,b)=>a-b)[1]});
  }
  function ping(){
   clearTimeout(timer);timer=setTimeout(()=>finish('等待中继 pong 超时'),pongMs);
   start=clock();ws.send('{"type":"ping"}');
  }
  try{
   ws=dial(config.url,{headers:{authorization:'Bearer '+config.token},proxy:'',perMessageDeflate:false});
   timer=setTimeout(()=>finish('中继握手超时'),helloMs);
   ws.onerror=ws.onclose=()=>finish('连接失败：请检查地址、密钥和网络');
   ws.onmessage=({data})=>{
    if(done)return;
    try{
     const received=clock();
     if(typeof data!=='string'||data.length>1024)throw Error();
     const f=JSON.parse(data);
     if(!ready){
      if(f?.type!=='hello'||f.status!==1||f.bytes!==262144)throw Error();
      ready=true;ping();return;
     }
     if(f?.type!=='pong')throw Error();
     values.push(Math.max(0,Math.round((received-start)*10)/10));
     if(values.length===3)finish();else ping();
    }catch{finish('中继协议响应无效');}
   };
  }catch{finish('无法建立 WSS 连接');}
 });
}

// Static page images are a supported Magpie plugin resource. The provider
// writes an inert status card; the UI never changes origin or opens a socket.
const defaultDir=fileURLToPath(new URL('../ui/probe-results/',import.meta.url));
function card(ok,heading,detail){
 const bg=ok?'#e3f4ea':'#fbe8e7',fg=ok?'#124831':'#7a211a';
 return '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="92" viewBox="0 0 500 92" role="img"><title>'+heading+'。'+detail+'</title><rect width="500" height="92" rx="10" fill="'+bg+'"/><g fill="'+fg+'" font-family="system-ui,sans-serif"><text x="16" y="35" font-size="20">'+heading+'</text><text x="16" y="65" font-size="15">'+detail+'</text></g></svg>';
}
export async function runRequestedProbe(options,{dir=defaultDir,measure=measureRelay,now=Date.now}={}){
 const t=options.relayTest;
 if(!t||!options.relayEnabled||typeof t.id!=='string'||!(/^[a-f0-9]{32}$/).test(t.id)||!Number.isSafeInteger(t.at)||t.at>now()+2000||now()-t.at>95000)return;
 const cfg=relayOptions(options);
 await mkdir(dir,{recursive:true,mode:0o700});
 if(!(await lstat(dir)).isDirectory())throw Error('Invalid result directory');
 for(const item of await readdir(dir,{withFileTypes:true})){
  if(!item.isFile()||!/^[a-f0-9]{32}\.(?:lock|svg|[a-f0-9-]{36}\.tmp)$/.test(item.name))continue;
  const name=path.join(dir,item.name);
  if(await stat(name).then(s=>now()-s.mtimeMs>10*60*1000,()=>false))await unlink(name).catch(()=>{});
 }
 const base=path.join(dir,t.id);
 // Short-lived lock also deduplicates helper CLI hosts seeing the same option.
 let lock;
 try{lock=await open(base+'.lock','wx',0o600);}catch(e){if(e.code==='EEXIST')return;throw e;}
 await lock.close();
 let result;
 try{
  const {median,values}=await measure(cfg);
  if(values.length!==3||![median,...values].every(x=>Number.isFinite(x)&&x>=0))throw Error('Invalid sample');
  result=card(true,'WSS 已连通 · '+median+' ms','三次往返：'+values.join(' / ')+' ms（不含建连）');
 }catch(e){
  const causes=['等待中继 pong 超时','中继握手超时','中继协议响应无效'];
  result=card(false,'WSS 测试失败',causes.includes(e.message)?e.message:'请检查地址、密钥和网络后重试。');
 }
 const temp=base+'.'+randomUUID()+'.tmp';
 const file=await open(temp,'wx',0o600);
 try{await file.writeFile(result);}finally{await file.close();}
 await rename(temp,base+'.svg');
}
