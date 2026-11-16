const WINDOW=256*1024,CHUNK=32*1024;
const failure=code=>Object.assign(new Error('BPS relay '+code+'; no automatic request replay was attempted'),{code:'BPS_RELAY_'+code.toUpperCase()});

export function relayOptions(options={}){
  if(options.relayEnabled!==undefined&&typeof options.relayEnabled!=='boolean')throw new Error('relayEnabled must be a boolean');
  if(options.relayEnabled!==true)return null;
  const raw=typeof options.relayUrl==='string'?options.relayUrl.trim():'';
  const token=typeof options.relayToken==='string'?options.relayToken.trim():'';
  if(/[\s\p{Cc}\p{Cf}\\?#]/u.test(raw))throw new Error('Invalid characters in WSS relay URL');
  let url;try{url=new URL(raw);}catch{throw new Error('Enter a valid WSS relay URL');}
  if(url.protocol!=='wss:'||!url.hostname||url.username||url.password||url.search||url.hash||url.pathname!=='/relay')throw new Error('Relay URL must be wss://host/relay without userinfo or query');
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new Error('Enter a valid relay access token');
  return {url:url.href,token};
}

// One WSS connection multiplexes bounded HTTP requests. Connection loss fails
// active requests; only a later caller may establish a new channel.
export function createRelayFetch(config,{socketFactory,now=Date.now,connectTimeoutMs=60000}={}){
  const records=new Map();let socket,dial,nextID=0,heartbeat,lastPong=0,reconnectAt=0,failures=0,closed=false,usable=false;
  const factory=socketFactory||((url,opts)=>{if(!globalThis.Bun)throw failure('runtime_requires_bun');return new WebSocket(url,opts);});
  function send(frame,ws=socket){if(!ws||ws.readyState!==1)throw failure('disconnected');ws.send(JSON.stringify(frame));}
  async function writable(rec){while(rec.ws.bufferedAmount>WINDOW){if(rec.finished||rec.ws.readyState!==1)throw failure('disconnected');await new Promise(r=>setTimeout(r,10));}}
  function finish(rec,error){
    if(rec.finished)return;rec.finished=true;records.delete(rec.id);rec.signal?.removeEventListener('abort',rec.abort);
    if(error){rec.reject(error);try{rec.controller?.error(error);}catch{};rec.uploadReject?.(error);}
    rec.uploadWake?.();
  }
  function failChannel(ws){
    if(socket!==ws)return;socket=undefined;usable=false;clearInterval(heartbeat);heartbeat=undefined;
    reconnectAt=now()+Math.min(5000,500*2**Math.min(failures++,4));
    for(const rec of records.values())if(rec.ws===ws)finish(rec,failure('disconnected'));
    try{ws.close();}catch{}
  }
  function onFrame(ws,raw){
    if(socket!==ws)return;
    try{
      if(typeof raw!=='string'||Buffer.byteLength(raw)>128*1024)throw failure('invalid_frame');
      const f=JSON.parse(raw);
      if(f.type==='hello'){if(f.status!==1||f.bytes!==WINDOW)throw failure('protocol');return;}
      if(f.type==='pong'){lastPong=now();return;}
      const rec=records.get(f.id);if(!rec||rec.ws!==ws)return;
      switch(f.type){
        case 'ready':
          if(rec.ready||f.bytes!==WINDOW)throw failure('protocol');rec.ready=true;rec.credit=f.bytes;rec.uploadWake?.();break;
        case 'upload_credit':
          if(!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>CHUNK||rec.credit+f.bytes>WINDOW)throw failure('protocol');rec.credit+=f.bytes;rec.uploadWake?.();break;
        case 'head':{
          if(rec.controller||!Number.isInteger(f.status)||f.status<200||f.status>599||!f.headers||typeof f.headers!=='object'||Array.isArray(f.headers))throw failure('protocol');
          const headers=new Headers(f.headers);
          const stream=new ReadableStream({start(c){rec.controller=c;},pull(){pump(rec);},cancel(){try{send({type:'cancel',id:rec.id},ws);}catch{}finish(rec,failure('cancelled'));}});
          rec.resolve(new Response([204,205,304].includes(f.status)?null:stream,{status:f.status,headers}));break;
        }
        case 'data':{
          if(!rec.controller||rec.end||typeof f.data!=='string'||f.data.length>Math.ceil(CHUNK/3)*4)throw failure('protocol');
          const bytes=Buffer.from(f.data,'base64');if(!bytes.length||bytes.length>CHUNK||bytes.toString('base64')!==f.data)throw failure('protocol');
          rec.queued+=bytes.length;if(rec.queued>WINDOW)throw failure('flow_control');rec.queue.push(bytes);pump(rec);break;
        }
        case 'end':if(!rec.controller||rec.end)throw failure('protocol');rec.end=true;pump(rec);break;
        case 'error':finish(rec,failure(['capacity','invalid_request','invalid_headers','upstream_transport','cancelled','response_limit'].includes(f.code)?f.code:'request_failed'));break;
        default:throw failure('protocol');
      }
    }catch{failChannel(ws);}
  }
  function pump(rec){
    if(rec.finished||!rec.controller)return;
    while(rec.queue.length&&rec.controller.desiredSize>0){const bytes=rec.queue.shift();rec.queued-=bytes.length;rec.controller.enqueue(new Uint8Array(bytes));try{send({type:'credit',id:rec.id,bytes:bytes.length},rec.ws);}catch{failChannel(rec.ws);return;}}
    if(rec.end&&!rec.queue.length){rec.controller.close();finish(rec);}
  }
  async function connect(){
    if(closed)throw failure('closed');if(socket?.readyState===1&&usable)return socket;if(dial)return dial;
    if(now()<reconnectAt)throw failure('reconnect_backoff');
    dial=new Promise((resolve,reject)=>{
      let ws,settled=false;
      const timer=setTimeout(()=>{reject(failure('connect_timeout'));if(ws)failChannel(ws);},connectTimeoutMs);timer.unref?.();
      try{ws=factory(config.url,{headers:{authorization:'Bearer '+config.token},proxy:'',perMessageDeflate:false});socket=ws;}catch{clearTimeout(timer);reject(failure('connect_failed'));return;}
      ws.onopen=()=>{};
      ws.onmessage=e=>{
        if(!settled){
          let hello;try{hello=JSON.parse(e.data);}catch{}
          if(hello?.type!=='hello'||hello.status!==1||hello.bytes!==WINDOW){clearTimeout(timer);reject(failure('protocol'));failChannel(ws);return;}
          clearTimeout(timer);settled=true;usable=true;lastPong=now();failures=0;
          heartbeat=setInterval(()=>{if(now()-lastPong>180000){failChannel(ws);return;}try{send({type:'ping'},ws);}catch{failChannel(ws);}},20000);heartbeat.unref?.();resolve(ws);return;
        }
        onFrame(ws,e.data);
      };
      const end=()=>{clearTimeout(timer);if(!settled)reject(failure('connect_failed'));failChannel(ws);};ws.onclose=end;ws.onerror=end;
    });
    try{return await dial;}finally{dial=undefined;}
  }
  async function fetchRelay(input,init={}){
    const signal=init.signal??(input instanceof Request?input.signal:undefined);signal?.throwIfAborted();
    let abort;
    const ws=await Promise.race([connect(),...(signal?[new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]:[])]).finally(()=>{if(abort)signal.removeEventListener('abort',abort);});
    signal?.throwIfAborted();
    const url=input instanceof Request?input.url:String(input),method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    let raw=init.body;if(raw===undefined&&input instanceof Request)raw=await input.arrayBuffer();
    const bytes=raw==null?Buffer.alloc(0):typeof raw==='string'?Buffer.from(raw):raw instanceof ArrayBuffer?Buffer.from(raw):ArrayBuffer.isView(raw)?Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength):null;
    if(!bytes)throw failure('unsupported_body');
    const headers=Object.fromEntries(new Headers(init.headers??(input instanceof Request?input.headers:undefined)));
    const id=++nextID;
    return new Promise((resolve,reject)=>{
      const rec={id,ws,signal,resolve,reject,ready:false,credit:0,queue:[],queued:0,total:0,finished:false,end:false};records.set(id,rec);
      rec.abort=()=>{try{send({type:'cancel',id},ws);}catch{}finish(rec,signal.reason||failure('cancelled'));};signal?.addEventListener('abort',rec.abort,{once:true});if(signal?.aborted){rec.abort();return;}
      (async()=>{
        send({type:'start',id,url,method,headers,length:bytes.length},ws);
        let offset=0;
        while(!rec.ready||offset<bytes.length){
          if(rec.finished)throw failure('cancelled');
          if(!rec.ready||rec.credit<1){await new Promise((r,j)=>{rec.uploadWake=r;rec.uploadReject=j;});rec.uploadWake=undefined;rec.uploadReject=undefined;continue;}
          await writable(rec);if(rec.finished)throw failure('cancelled');const n=Math.min(CHUNK,rec.credit,bytes.length-offset);rec.credit-=n;send({type:'upload',id,data:bytes.subarray(offset,offset+n).toString('base64')},ws);offset+=n;
        }
        if(!rec.finished)send({type:'uploaded',id},ws);
      })().catch(error=>finish(rec,error?.code?.startsWith('BPS_RELAY_')?error:failure('transport')));
    });
  }
  fetchRelay.close=()=>{closed=true;if(socket)failChannel(socket);};
  return fetchRelay;
}
