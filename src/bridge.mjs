import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_BODY } from "./constants.mjs";
import {terminalObserver} from "./events.mjs";
import {progressReader} from "./progress.mjs";

export const binaryPath=fileURLToPath(new URL(`../bin/bps-bridge-${process.platform}-${process.arch}${process.platform==="win32"?".exe":""}`,import.meta.url));

export async function startBridge(raw,scope,{signal,upload,binary=binaryPath,compact=false,previous,terminal,catalog,keepContext=false,streamIdleMs}={}) {
  signal?.throwIfAborted();
  if(!existsSync(binary)) throw new Error("BPS bridge is not built for this platform. Run npm run build in the plugin directory (Go 1.27.4+ required).");
  if(Buffer.byteLength(raw)>MAX_BODY) throw Object.assign(new Error("BPS request exceeds 64 MiB"),{status:413});
  const child=spawn(binary,[],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  let pending=Buffer.alloc(0),dead=false,upstreamReader;
  const exit=new Promise(resolve=>{child.once("error",()=>resolve(-1));child.once("exit",code=>resolve(code??-1));});
  child.stdin.on("error",()=>{});
  child.stderr.resume();
  const iterator=child.stdout[Symbol.asyncIterator]();
  function dispose(){
    if(dead) return; dead=true; signal?.removeEventListener("abort",dispose);
    upstreamReader?.cancel(); child.stdin.destroy(); child.stdout.destroy(); child.kill();
  }
  signal?.addEventListener("abort",dispose,{once:true});
  async function send(bytes){
    signal?.throwIfAborted();
    if(dead) throw new Error("BPS bridge was cancelled");
    await new Promise((resolve,reject)=>child.stdin.write(bytes,error=>error?reject(error):resolve()));
  }
  async function line(){
    for(;;){
      const end=pending.indexOf(10);
      if(end>=0){const value=pending.subarray(0,end);pending=pending.subarray(end+1);try{return JSON.parse(value.toString());}catch{throw new Error("Invalid BPS bridge handshake");}}
      const part=await iterator.next();
      if(part.done) throw new Error("BPS bridge exited before preparing the request");
      pending=Buffer.concat([pending,part.value]);
      if(pending.length>96*1024*1024) throw new Error("BPS bridge control frame is too large");
    }
  }
  try{
    await send(JSON.stringify({raw:Buffer.from(raw).toString("base64"),scope,compact,keepContext,previous:previous?.toString("base64"),terminal:terminal?.toString("base64"),catalog:catalog?.toString("base64")})+"\n");
    let prepared;
    for(;;){
      const event=await line();
      if(event.kind==="error") throw Object.assign(new Error(event.message || "Invalid BPS request"),{status:400});
      if(event.kind==="request"){prepared=event;break;}
      if(event.kind!=="upload" || !upload) throw new Error("Unsupported BPS bridge handshake");
      const id=await upload(Buffer.from(event.body,"base64"),event.contentType);
      await send(JSON.stringify({id})+"\n");
    }
    if(prepared.protocol!==2||typeof prepared.context!=="string")throw new Error("BPS bridge is out of date; rebuild the plugin binary");
    return {body:Buffer.from(prepared.body,"base64"),context:Buffer.from(prepared.context,"base64"),catalog:Buffer.from(prepared.catalog||"","base64"),effort:prepared.effort,warnings:prepared.warnings||[],dispose,
      stream(upstream){
        if(!upstream) {dispose();throw new Error("BPS returned an empty stream");}
        upstreamReader=progressReader(upstream,{idleMs:streamIdleMs});
        let pumpError;
        const pump=(async()=>{
          try{for(;;){const part=await upstreamReader.read();if(part.done)break;await send(part.value);}child.stdin.end();}
          catch(error){pumpError=error;child.stdin.destroy();child.kill();}
        })();
        return new ReadableStream({
          async pull(controller){
            try{
              signal?.throwIfAborted();
              if(pending.length){const value=pending;pending=Buffer.alloc(0);controller.enqueue(new Uint8Array(value));return;}
              const part=await iterator.next();
              if(!part.done){controller.enqueue(new Uint8Array(part.value));return;}
              const code=await exit;
              // A terminal can arrive before the upstream closes its connection.
              upstreamReader.cancel();
              await pump;
              if(pumpError && code!==0) throw pumpError;
              if(code!==0) throw new Error("BPS stream conversion failed or the upstream stream was incomplete");
              controller.close();dispose();
            }catch(error){controller.error(signal?.aborted?signal.reason:pumpError||error);dispose();}
          },cancel(){dispose();}
        });
      }};
  }catch(error){dispose();throw error;}
}

export async function collectResponse(stream){
  const reader=stream.getReader();
  let terminal,bytes=0;
  const observer=terminalObserver((event,raw)=>{terminal={...event,raw};});
  try{
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>128*1024*1024)throw new Error("Buffered BPS response exceeds 128 MiB");observer.push(part.value);}
    observer.finish();
    if(!terminal)throw new Error("BPS stream ended without a terminal response");
    return terminal;
  }finally{await reader.cancel().catch(()=>{});}
}
