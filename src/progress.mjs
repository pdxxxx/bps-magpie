// Bound time spent waiting for original upstream data. Local backpressure is
// outside this budget; SSE comments and blank lines do not reset it.
export const STREAM_IDLE_MS=120_000;
export function progressReader(stream,{idleMs=STREAM_IDLE_MS}={}){
  if(!Number.isFinite(idleMs)||idleMs<=0)throw new Error('Invalid BPS stream progress timeout');
  const reader=stream.getReader();let remaining=idleMs,lineStart=true,comment=false,closed=false;
  function meaningful(bytes){
    let progress=false;
    for(const byte of bytes){
      if(byte===10){lineStart=true;comment=false;continue;}
      if(byte===13)continue;
      if(lineStart){comment=byte===58;lineStart=false;}
      if(!comment)progress=true;
    }
    return progress;
  }
  function cancel(reason){if(closed)return;closed=true;void reader.cancel(reason).catch(()=>{});}
  return {
    cancel,
    async read(){
      const started=performance.now();let timer;
      const error=Object.assign(new Error('BPS upstream stream made no progress before the deadline; no automatic replay was attempted'),{name:'TimeoutError',code:'basispoints_stream_timeout',status:504});
      try{
        const result=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(error);cancel(error);},Math.max(0,remaining));})]);
        if(result.done)return result;
        remaining=meaningful(result.value)?idleMs:remaining-(performance.now()-started);
        if(remaining<=0){cancel(error);throw error;}
        return result;
      }finally{clearTimeout(timer);}
    }
  };
}
