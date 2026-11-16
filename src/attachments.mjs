// Long-lived host cache: hashes and file IDs only. No image data or credentials
// survive a completed upload; concurrent waiters retain independent cancellation.
export function createAttachmentStore({maxEntries=128,maxPending=16,ttlMs=10*60*1000,now=Date.now}={}){
  if([maxEntries,maxPending,ttlMs].some(n=>!Number.isSafeInteger(n)||n<1))throw new Error('Invalid attachment cache limits');
  const ready=new Map(),pending=new Map();
  let active=0;
  function prune(){for(const [key,entry] of ready)if(entry.expires<=now())ready.delete(key);}
  function forgetOwner(owner){
    for(const [key,entry] of ready)if(entry.owner===owner)ready.delete(key);
    // Invalidation stops reuse, not unrelated in-flight callers. Removing the
    // mapping also prevents a late completion from repopulating this cache.
    for(const [key,entry] of pending)if(entry.owner===owner)pending.delete(key);
  }
  async function use(owner,digest,signal,upload,metrics){
    signal?.throwIfAborted();
    if(typeof owner!=='string'||!owner||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return upload(signal);
    prune();const key=owner+':'+digest,hit=ready.get(key);
    if(hit){ready.delete(key);ready.set(key,hit);metrics?.count('upload_cache_hits');return hit.id;}
    let entry=pending.get(key);
    if(!entry){
      if(active>=maxPending)throw new Error('BPS attachment upload capacity exhausted');
      active++;
      entry={owner,controller:new AbortController(),waiters:0,done:false};pending.set(key,entry);
      const current=entry;
      entry.promise=Promise.resolve().then(()=>{current.controller.signal.throwIfAborted();return upload(current.controller.signal);}).then(id=>{
        current.controller.signal.throwIfAborted();
        if(typeof id!=='string'||!/^file-[A-Za-z0-9_-]{1,251}$/.test(id))throw new Error('BPS returned an invalid attachment ID');
        if(!current.controller.signal.aborted&&pending.get(key)===current){
          while(ready.size>=maxEntries)ready.delete(ready.keys().next().value);
          ready.set(key,{id,owner,expires:now()+ttlMs});
        }
        return id;
      }).finally(()=>{active--;current.done=true;if(pending.get(key)===current)pending.delete(key);});
      entry.promise.catch(()=>{});
    }else metrics?.count('upload_coalesced');
    entry.waiters++;
    let aborted;
    try{
      return await Promise.race([entry.promise,...(signal?[new Promise((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();})]:[])]);
    }finally{
      if(aborted)signal.removeEventListener('abort',aborted);
      if(--entry.waiters===0&&!entry.done){if(pending.get(key)===entry)pending.delete(key);entry.controller.abort(new Error('Attachment upload has no remaining callers'));}
    }
  }
  return {use,forgetOwner,diagnostics(){prune();return {entries:ready.size,pending:pending.size,active,maxEntries,maxPending,ttlMs};}};
}
