import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_BODY } from "./constants.mjs";
import {terminalObserver} from "./events.mjs";
import {progressReader} from "./progress.mjs";

export const binaryPath=fileURLToPath(new URL(`../bin/bps-bridge-${process.platform}-${process.arch}${process.platform==="win32"?".exe":""}`,import.meta.url));

export async function startBridge(raw,scope,{signal,upload,repair,binary=binaryPath,compact=false,previous,terminal,catalog,keepContext=false,streamIdleMs,metrics,promptCacheKey}={}) {
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
  async function line(allowEOF=false){
    for(;;){
      const end=pending.indexOf(10);
      if(end>=0){const value=pending.subarray(0,end);pending=pending.subarray(end+1);try{return JSON.parse(value.toString());}catch{throw new Error("Invalid BPS bridge handshake");}}
      const part=await iterator.next();
      if(part.done){if(allowEOF&&pending.length===0)return null;throw new Error("BPS bridge exited before preparing the request");}
      pending=Buffer.concat([pending,part.value]);
      if(pending.length>96*1024*1024) throw new Error("BPS bridge control frame is too large");
    }
  }
  try{
    await send(JSON.stringify({protocol:3,raw:Buffer.from(raw).toString("base64"),scope,compact,keepContext,promptCacheKey,previous:previous?.toString("base64"),terminal:terminal?.toString("base64"),catalog:catalog?.toString("base64")})+"\n");
    let prepared;
    for(;;){
      const event=await line();
      if(event.kind==="error") throw Object.assign(new Error(event.message || "Invalid BPS request"),{status:400});
      if(event.kind==="request"){prepared=event;break;}
      if(event.kind!=="upload" || !upload) throw new Error("Unsupported BPS bridge handshake");
      const id=await upload(Buffer.from(event.body,"base64"),event.contentType,event.cacheKey);
      await send(JSON.stringify({id})+"\n");
    }
    if(prepared.protocol!==3||typeof prepared.context!=="string")throw new Error("BPS bridge is out of date; rebuild the plugin binary");
    return {body:Buffer.from(prepared.body,"base64"),context:Buffer.from(prepared.context,"base64"),catalog:Buffer.from(prepared.catalog||"","base64"),effort:prepared.effort,warnings:prepared.warnings||[],dispose,
      stream(upstream){
        if(!upstream) {dispose();throw new Error("BPS returned an empty stream");}
        let pumpError,pump,repairs=0,repairActive=false;
        const clientObserver=metrics?.observer('client');
        function startPump(source){
          const reader=progressReader(source,{idleMs:streamIdleMs});upstreamReader=reader;
          const upstreamObserver=metrics?.observer('upstream');
          pump=(async()=>{
            try{
              for(;;){const part=await reader.read();if(part.done)break;
                upstreamObserver?.push(part.value);
                for(let off=0;off<part.value.byteLength;off+=64*1024){await send(JSON.stringify({data:Buffer.from(part.value.subarray(off,off+64*1024)).toString("base64")})+"\n");}
              }
              await send('{"end":true}\n');
            }catch(error){pumpError=error;child.stdin.destroy();child.kill();}
          })();
        }
        async function stopPump(){upstreamReader?.cancel();await pump;}
        startPump(upstream);
        return new ReadableStream({
          async pull(controller){
            try{
              for(;;){
                signal?.throwIfAborted();
                const part=await line(true);
                if(part===null){
                  const code=await exit;await stopPump();
                  if(pumpError&&code!==0)throw pumpError;
                  if(code!==0)throw new Error("BPS stream conversion failed or the upstream stream was incomplete");
                  controller.close();dispose();return;
                }
                if(part.kind==="data"){
                  if(typeof part.data!=="string")throw new Error("Invalid BPS stream frame");
                  const value=Buffer.from(part.data,"base64");if(value.length>64*1024)throw new Error("BPS stream frame exceeds limit");
                  clientObserver?.push(value);
                  controller.enqueue(new Uint8Array(value));return;
                }
                if(part.kind==="repair"){
                  if(repairActive||++repairs>2||typeof part.body!=="string")throw new Error("Invalid BPS correction request");
                  metrics?.count('repair_count');metrics?.start('repair_ms');
                  repairActive=true;await stopPump();if(pumpError)throw pumpError;
                  try{
                    const body=Buffer.from(part.body,"base64");
                    if(!repair||body.length>MAX_BODY)throw new Error("BPS correction is unavailable");
                    const source=await repair(body);signal?.throwIfAborted();
                    if(!source)throw new Error("BPS correction returned an empty stream");
                    startPump(source);
                  }catch(error){
                    signal?.throwIfAborted();
                    // Only a fixed message crosses IPC; upstream bodies and headers never do.
                    await send('{"end":true,"error":"correction request failed"}\n');
                    pump=Promise.resolve();
                  }
                  continue;
                }
                if(part.kind==="repair_done"){
                  if(!repairActive)throw new Error("Unexpected BPS correction completion");
                  await stopPump();if(pumpError)throw pumpError;repairActive=false;metrics?.end('repair_ms');continue;
                }
                throw new Error("Invalid BPS stream control frame");
              }
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
