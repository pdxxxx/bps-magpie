import {createHash} from "node:crypto";

const fault=message=>Object.assign(new Error(message),{status:400,code:"basispoints_previous_response_not_found"});
export function accountScope(auth){
  return createHash("sha256").update(JSON.stringify([auth.clientId,auth.uid||auth.subject||auth.accountId,auth.workspaceId])).digest("hex");
}
export function promptRoutingKey(auth,source){
  if(typeof source.prompt_cache_key!=="string"||!source.prompt_cache_key)return undefined;
  return 'bps-'+createHash('sha256').update(JSON.stringify([accountScope(auth),source.model,source.prompt_cache_key])).digest('hex').slice(0,32);
}
export function conversationScope(auth,headers,model){
  // A child thread must never inherit its parent agent's tool catalog.
  const thread=headers.get("thread-id")||headers.get("x-bps-session")||headers.get("session_id");
  if(!thread || typeof model!=="string" || !model)return null;
  const owner=accountScope(auth);
  return {owner,key:createHash("sha256").update(JSON.stringify([owner,thread,model])).digest("hex")};
}

// Only raw protocol bytes live here. No tokens, filesystem persistence or
// background timers. In-flight snapshots are immutable; expiry is lazy.
export function createConversationStore({enabled=true,maxEntries=128,maxBytes=32*1024*1024,maxEntryBytes=4*1024*1024,ttlMs=30*60*1000,now=Date.now}={}){
  if(typeof enabled!=="boolean"||[maxEntries,maxBytes,maxEntryBytes,ttlMs].some(x=>!Number.isSafeInteger(x)||x<1))throw new Error("Invalid continuation cache limits");
  const entries=new Map(),locks=new Map();let bytes=0,skipped=0;
  function remove(key){const old=entries.get(key);if(old){bytes-=old.size;entries.delete(key);}}
  function prune(){const time=now();for(const [key,entry]of entries)if(time-entry.touched>=ttlMs)remove(key);}
  function read(key){prune();const entry=entries.get(key);if(!entry)return;entry.touched=now();entries.delete(key);entries.set(key,entry);return entry;}
  function put(key,owner,data){
    const size=Object.values(data).reduce((n,v)=>n+(Buffer.isBuffer(v)?v.length:typeof v==="string"?Buffer.byteLength(v):0),256);
    // A rejected replacement must never leave the prior catalog active.
    if(size>maxEntryBytes||size>maxBytes){remove(key);skipped++;return false;}
    prune();remove(key);while(entries.size>=maxEntries||bytes+size>maxBytes)remove(entries.keys().next().value);
    entries.set(key,{owner,...data,size,touched:now()});bytes+=size;return true;
  }
  async function serial(scope,signal,run){
    if(!enabled||!scope)return run();
    const previous=locks.get(scope.key)||Promise.resolve();let release;
    const gate=new Promise(r=>{release=r;});const tail=previous.catch(()=>{}).then(()=>gate);locks.set(scope.key,tail);
    let aborted;
    try{
      if(signal?.aborted)throw signal.reason;
      await Promise.race([previous.catch(()=>{}),...(signal?[new Promise((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener("abort",aborted,{once:true});})]:[])]);
      signal?.throwIfAborted();return await run();
    }finally{
      if(aborted)signal.removeEventListener("abort",aborted);release();
      void tail.finally(()=>{if(locks.get(scope.key)===tail)locks.delete(scope.key);});
    }
  }
  return {
    enabled,serial,
    snapshot(scope,previousID,{explicitTools=false}={}){
      if(previousID!==undefined&&previousID!==null&&previousID!==""&&(typeof previousID!=="string"||previousID.length>256))throw fault("Invalid previous_response_id");
      if(previousID && (!enabled||!scope))throw fault("Continuation requires enabled caching and a stable thread/session header; send full history instead");
      if(!enabled||!scope)return {};
      const catalog=read("catalog:"+scope.key)?.catalog;
      if(!previousID)return {catalog};
      const previous=read("response:"+scope.key+":"+previousID);
      if(!previous||previous.conflicted||previous.owner!==scope.owner)throw fault("Previous response is unavailable for this account, model and thread (expired, evicted or restarted); send full history");
      if(previous.requiresCatalog&&!catalog&&!explicitTools)throw fault("The prior tool catalog was evicted; send the complete tools declaration explicitly");
      return {catalog,previous:previous.context,terminal:previous.terminal};
    },
    catalog(scope,raw){if(enabled&&scope&&raw?.length)put("catalog:"+scope.key,scope.owner,{catalog:Buffer.from(raw)});},
    complete(scope,context,event,raw,{requiresCatalog=false}={}){
      if(!enabled||!scope||event.type!=="response.completed"||event.response?.status!=="completed"||!Array.isArray(event.response.output))return false;
      if(!context?.length){skipped++;return false;}
      const id=event.response.id;if(typeof id!=="string"||!id||id.length>256)return false;
      const key="response:"+scope.key+":"+id;
      const existing=read(key);
      if(existing){
        if(existing.conflicted)return false;
        // A reused ID must not silently switch the meaning of a continuation.
        if(!existing.context.equals(context)||!existing.terminal.equals(Buffer.from(raw))){put(key,scope.owner,{conflicted:true});skipped++;return false;}
        return true;
      }
      return put(key,scope.owner,{context:Buffer.from(context),terminal:Buffer.from(raw),requiresCatalog});
    },
    forgetOwner(owner){for(const [key,entry]of entries)if(entry.owner===owner)remove(key);},
    diagnostics(){prune();return {enabled,entries:entries.size,bytes,maxEntries,maxBytes,maxEntryBytes,ttlSeconds:ttlMs/1000,skippedEntries:skipped};}
  };
}
