import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
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

const port=39846;
// A Magpie page service, available on loopback only. The opaque ID is
// scoped to testing this saved configuration. Never put the relay key in a URL.
export function startProbePage(options){
 const config=relayOptions(options),id=options.relayProbeId;
 if(!config||typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))return;
 let running;
 const server=createServer(async(req,res)=>{
  const nonce=randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  const render=(status,title,detail)=>{
   res.statusCode=status;
   res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>测试 WSS</title><style>:root{color-scheme:light dark;font:16px system-ui}main{max-width:32em;margin:3em auto;padding:1em}button{font:inherit;padding:.4em .8em}</style><main><small>BPS · WSS 中继</small><h2>'+title+'</h2><p>'+detail+'</p><button id="back">返回设置</button></main><script nonce="'+nonce+'">document.getElementById("back").onclick=()=>history.back()</script></html>');
  };
  if(req.headers.host!=='127.0.0.1:'+port||req.method!=='GET'||req.url!=='/probe/'+id){render(404,'无法测试此配置','请重新启用 BPS 插件，打开设置后重试。');return;}
  try{
   running??=measureRelay(config).finally(()=>{running=undefined;});
   const {median,values}=await running;
   render(200,'WSS 已连通 · '+median+' ms','本机到中继的三次往返：'+values.join(' / ')+' ms。显示中位数，不含建立连接、认证或模型推理。');
  }catch(err){render(502,'WSS 测试失败',err.message);}
 });
 server.on('error',()=>console.warn('BPS: WSS diagnostic page could not bind its local port'));
 server.listen(port,'127.0.0.1');server.unref();
 return server;
}
