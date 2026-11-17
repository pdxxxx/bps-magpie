import { createHash, randomUUID } from "node:crypto";
import { BASE_URL, MAX_BODY } from "./constants.mjs";
import { startBridge, collectResponse } from "./bridge.mjs";
import { readJSON } from "./network.mjs";
import {createConversationStore,conversationScope,accountScope,promptRoutingKey} from "./state.mjs";
import {observeResponseStream} from "./events.mjs";
import {createRequestMetrics} from "./metrics.mjs";
import {createAttachmentStore} from "./attachments.mjs";

export function bpsHeaders(auth,{accept="text/event-stream",contentType="application/json"}={}) {
  const headers=new Headers({authorization:`Bearer ${auth.access}`,"chatgpt-account-id":auth.workspaceId,"x-openai-account-id":auth.workspaceId,
    "x-basispoints-auth-mode":"chatgpt","content-type":contentType,accept,origin:"https://bps.openai.com",
    "user-agent":"Mozilla/5.0","accept-encoding":"identity",
    "x-openai-internal-basispoints-client-product":"basispoints-excel-plugin","x-openai-internal-basispoints-client-agent-profile":"excel"});
  try{const at=JSON.parse(Buffer.from(auth.access.split(".")[1],"base64url"));const identity=at["https://api.openai.com/auth"];const user=identity?.chatgpt_user_id || identity?.user_id;if(typeof user==="string" && user.trim() && !/[\r\n]/.test(user))headers.set("x-openai-account-user-id",user.trim());}catch{}
  return headers;
}

export function apiError(status,code,message,headers={}) {
  return Response.json({error:{type:status===400?"invalid_request_error":status===401?"authentication_error":status===429?"rate_limit_error":"server_error",code,message}},{status,headers});
}

async function upstreamError(response,signal){
  const headers={};
  let usagePolicyBlocked=false;
  const retry=response.headers.get("retry-after");
  if(retry && (/^\d{1,6}$/.test(retry) || (retry.length<80 && Number.isFinite(Date.parse(retry)))))headers["retry-after"]=retry;
  if(response.status===401)headers["x-magpie-sign-in"]="expired";
  if(response.status===403&&response.body&&signal){
    const reader=response.body.getReader();const cancel=()=>{void reader.cancel().catch(()=>{});};
    const timer=setTimeout(cancel,1500);signal.addEventListener('abort',cancel,{once:true});
    try{
      const chunks=[];let size=0;
      for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384)break;chunks.push(part.value);}
      if(size<=16384){const problem=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));usagePolicyBlocked=typeof problem?.error?.message==="string"&&/blocked by our usage policy/i.test(problem.error.message);}
    }catch{}finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
  }
  await response.body?.cancel().catch(()=>{});
  signal?.throwIfAborted();
  const status=response.status>=400&&response.status<=599?response.status:502;
  return apiError(status,usagePolicyBlocked?"basispoints_usage_policy_blocked":status===401?"basispoints_auth_expired":status===403?"basispoints_access_denied":status===429?"basispoints_rate_limited":"basispoints_upstream_error",
    usagePolicyBlocked?"BPS upstream blocked this request under its usage policy; no automatic replay was attempted":status===401?"Excel/BPS authorization was rejected; sign in again":status===403?"This Excel/BPS account or model is not permitted":`Excel/BPS upstream returned HTTP ${response.status}`,headers);
}

export function makeFetch(getAuth,credentials,options={},deps={}){
  const fetchImpl=deps.fetchImpl || ((...args)=>globalThis.fetch(...args));
  if(options.continuationCache!==undefined&&typeof options.continuationCache!=="boolean")throw new Error("continuationCache must be a boolean");
  const state=deps.state||createConversationStore({enabled:options.continuationCache!==false});
  const attachments=deps.attachments||createAttachmentStore();
  const timeoutMs=options.timeoutMs??30*60*1000;
  if(!Number.isInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>60*60*1000)throw new Error("timeoutMs must be between 1000 and 3600000");
  return async function(input,init={}) {
    let bridge,cacheScope,owner,streaming=false,outcome='rejected';
    const metrics=createRequestMetrics(deps.onMetrics);
    const controller=new AbortController();
    const callerSignal=init.signal??(input instanceof Request?input.signal:undefined);
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(callerSignal?[callerSignal]:[])]);
    try{
      const target=new URL(input instanceof Request?input.url:String(input));
      const compact=target.pathname===new URL(BASE_URL).pathname+"/responses/compact";
      if(target.origin!==new URL(BASE_URL).origin || (!compact&&target.pathname!==new URL(BASE_URL).pathname+"/responses") || target.search || target.hash || target.username || target.password) return apiError(400,"basispoints_route_unsupported","This provider accepts /responses and /responses/compact on its configured origin only");
      if((init.method||(input instanceof Request?input.method:"POST")).toUpperCase()!=="POST")return apiError(405,"method_not_allowed","Use POST /responses");
      let raw=typeof init.body==="string"?init.body:Buffer.isBuffer(init.body)||init.body instanceof Uint8Array?Buffer.from(init.body).toString("utf8"):init.body instanceof ArrayBuffer?Buffer.from(init.body).toString("utf8"):null;
      if(init.body===undefined && input instanceof Request){
        if(input.bodyUsed||input.body?.locked)return apiError(400,"basispoints_request_invalid","Request body has already been consumed or is locked");
        // Consume the original body so cancellation reaches its producer.
        const reader=input.body?.getReader();const chunks=[];let size=0;
        if(reader){
          const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
          try{for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BODY)throw Object.assign(new Error("BPS request exceeds 64 MiB"),{status:413});chunks.push(part.value);}raw=Buffer.concat(chunks,size).toString("utf8");}finally{signal.removeEventListener("abort",abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
        }
      }
      if(raw===null || Buffer.byteLength(raw)>MAX_BODY)return apiError(raw===null?400:413,"basispoints_request_invalid","Request must be JSON and no larger than 64 MiB");
      let source;try{source=JSON.parse(raw);}catch{return apiError(400,"basispoints_request_invalid","Invalid request JSON");}
      if(!source || typeof source!=="object" || Array.isArray(source))return apiError(400,"basispoints_request_invalid","Request must be an object");
      if(source.conversation!=null||source.background===true)return apiError(400,"basispoints_request_invalid","Conversation resources and background jobs are unsupported; use foreground full history or scoped previous_response_id");
      if(compact && source.stream===true)return apiError(400,"basispoints_request_invalid","The standalone compact endpoint returns JSON; omit stream or set it to false");
      metrics?.start('auth_ms');
      const auth=await credentials.current(getAuth,signal);
      owner=accountScope(auth);
      metrics?.end('auth_ms');
      const incoming=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
      cacheScope=conversationScope(auth,incoming,source.model);
      const scope=cacheScope?.key||createHash("sha256").update(auth.workspaceId+randomUUID()).digest("hex");
      const requestOptions={method:"POST",redirect:"error",signal};
      metrics?.start('scope_queue_ms');
      await state.serial(cacheScope,signal,async()=>{
      metrics?.end('scope_queue_ms');metrics?.start('prepare_ms');
      const saved=state.snapshot(cacheScope,source.previous_response_id,{explicitTools:Object.hasOwn(source,"tools")});
      bridge=await startBridge(raw,scope,{signal,binary:deps.binary,streamIdleMs:deps.streamIdleMs,metrics,promptCacheKey:promptRoutingKey(auth,source),compact,keepContext:!!cacheScope&&state.enabled,...saved,async repair(body){
        metrics?.start('repair_headers_ms');
        const response=await fetchImpl(BASE_URL+"/responses",{...requestOptions,headers:bpsHeaders(auth),body});
        metrics?.end('repair_headers_ms');
        if(!response.ok){if([400,401,403,404].includes(response.status))attachments.forgetOwner(owner);if(response.status===401&&cacheScope)state.forgetOwner(cacheScope.owner);await response.body?.cancel();throw new Error("BPS tool correction request failed");}
        if(!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")){await response.body?.cancel();throw new Error("BPS tool correction returned an invalid stream");}
        return response.body;
      },async upload(body,contentType,digest){
        metrics?.start('upload_ms');
        try{
        return await attachments.use(owner,digest,signal,async uploadSignal=>{
        metrics?.count('upload_count');
        const response=await fetchImpl(BASE_URL+"/attachments",{...requestOptions,signal:AbortSignal.any([uploadSignal,AbortSignal.timeout(timeoutMs)]),headers:bpsHeaders(auth,{contentType,accept:"application/json"}),body});
        if(!response.ok)throw Object.assign(new Error("BPS attachment upload failed"),{upstream:response});
        const data=await readJSON(response,65536,"BPS attachment");
        const id=data.openai_file_id;
        if(typeof id!=="string" || !/^file-[A-Za-z0-9_-]{1,251}$/.test(id))throw new Error("BPS returned an invalid attachment ID");
        return id;
        },metrics);
        }finally{metrics?.end('upload_ms');}
      }});
      metrics?.end('prepare_ms');
      state.catalog(cacheScope,bridge.catalog);
      });
      metrics?.start('headers_ms');
      const response=await fetchImpl(BASE_URL+"/responses",{...requestOptions,headers:bpsHeaders(auth),body:bridge.body});
      metrics?.end('headers_ms');
      if(!response.ok){outcome='http_error';bridge.dispose();if([400,401,403,404].includes(response.status))attachments.forgetOwner(owner);if(response.status===401&&cacheScope)state.forgetOwner(cacheScope.owner);return await upstreamError(response,signal);}
      if(!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")){await response.body?.cancel();throw new Error("BPS did not return the expected SSE response");}
      const stream=bridge.stream(response.body);
      const headers={"cache-control":"no-store","x-bps-effort":bridge.effort,"x-bps-continuation":cacheScope&&state.enabled?"memory-limited":"full-history-required"};
      if(bridge.warnings.length)headers["x-bps-warning-count"]=String(bridge.warnings.length);
      if(source.stream===true){
        let terminalSeen=false;
        const reader=observeResponseStream(stream,(event,raw)=>{terminalSeen=true;if(event.type==='response.failed'||event.type==='error')attachments.forgetOwner(owner);state.complete(cacheScope,bridge.context,event,raw,{requiresCatalog:bridge.catalog.length>2});}).getReader();
        const wrapped=new ReadableStream({
          async pull(c){try{const p=await reader.read();if(p.done){metrics?.finish();c.close();}else c.enqueue(p.value);}catch(e){
            if(callerSignal?.aborted){metrics?.finish('cancelled');c.error(callerSignal.reason||e);controller.abort();return;}
            if(terminalSeen){metrics?.finish();c.close();controller.abort();return;}
            const code=e.code==="basispoints_stream_timeout"?e.code:signal.aborted&&signal.reason?.name==="TimeoutError"?"basispoints_timeout":"basispoints_transport_error";
            const message=code==="basispoints_stream_timeout"?"BPS upstream stream made no progress before the deadline; no automatic replay was attempted":code==="basispoints_timeout"?"BPS request timed out; no automatic replay was attempted":"BPS stream ended before a complete response; no automatic replay was attempted";
            const failure={type:"response.failed",response:{status:"failed",output:[],error:{code,message}}};
            metrics?.finish(code.includes('timeout')?'timeout':'transport_error');
            c.enqueue(new TextEncoder().encode("\n\nevent: response.failed\ndata: "+JSON.stringify(failure)+"\n\n"));c.close();controller.abort();
          }},
          async cancel(){metrics?.finish('cancelled');controller.abort();await reader.cancel().catch(()=>{});}
        });
        const result=new Response(wrapped,{status:200,headers:{...headers,"content-type":"text/event-stream"}});
        streaming=true;return result;
      }
      const terminal=await collectResponse(stream);
      if(terminal.type==='response.failed'||terminal.type==='error')attachments.forgetOwner(owner);
      outcome=undefined;
      if(terminal.type!=="response.completed")return Response.json(terminal.response||{error:terminal.error||{code:"basispoints_upstream_error",message:"BPS failed before completion"},...(terminal.usage?{usage:terminal.usage}:{})},{status:!compact&&terminal.type==="response.incomplete"?200:502,headers});
      if(compact){
        const value=terminal.response;const output=value?.output;
        if(value?.status!=="completed"||!Array.isArray(output)||output.some(x=>!x||!["message","compaction"].includes(x.type))||output.filter(x=>x.type==="compaction").length!==1||output.some(x=>x.type==="compaction"&&(typeof x.encrypted_content!=="string"||!x.encrypted_content)))return apiError(502,"basispoints_compaction_incomplete","BPS did not return a complete compacted context window");
        headers["x-bps-continuation"]=state.complete(cacheScope,bridge.context,terminal,terminal.raw,{requiresCatalog:bridge.catalog.length>2})?"cached":"full-history-required";
        return Response.json({...value,object:"response.compaction"},{headers});
      }
      headers["x-bps-continuation"]=state.complete(cacheScope,bridge.context,terminal,terminal.raw,{requiresCatalog:bridge.catalog.length>2})?"cached":"full-history-required";
      return Response.json(terminal.response,{headers});
    }catch(error){
      const timedOut=signal.aborted&&signal.reason?.name==="TimeoutError";
      outcome=callerSignal?.aborted?'cancelled':timedOut||error.code==='basispoints_stream_timeout'?'timeout':'error';
      bridge?.dispose();controller.abort();
      if(callerSignal?.aborted)throw callerSignal.reason || error;
      if(error.upstream){if(error.upstream.status===401&&cacheScope)state.forgetOwner(cacheScope.owner);return await upstreamError(error.upstream);}
      if(timedOut)return apiError(504,"basispoints_timeout","BPS request timed out; no automatic replay was attempted");
      if(error.code==="basispoints_stream_timeout")return apiError(504,error.code,error.message);
      const status=error.signIn==="expired"?401:error.status||502;
      return apiError(status,["basispoints_previous_response_not_found","basispoints_bridge_unavailable"].includes(error.code)?error.code:status===400?"basispoints_request_invalid":status===401?"basispoints_auth_expired":"basispoints_transport_error",error.message || "BPS request failed",status===401?{"x-magpie-sign-in":"expired"}:{});
    }finally{if(!streaming)metrics?.finish(outcome);}
  };
}
