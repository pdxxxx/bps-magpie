// Leave proxy unspecified to preserve Magpie's account/provider/global scope.
// An explicit override applies to every provider endpoint.
export function proxyOption(options={}) {
  const value=options.proxy;
  if(value===undefined || value===null || value==="" || value==="inherit")return undefined;
  if(value==="direct")return "";
  if(typeof value!=="string")throw new Error("proxy must be inherit, direct, or an HTTP(S) proxy URL");
  let url;try{url=new URL(value);}catch{throw new Error("Invalid proxy URL");}
  if(!["http:","https:"].includes(url.protocol)||!url.hostname||url.hash||url.search||!['','/'].includes(url.pathname))throw new Error("Plugin proxy accepts HTTP(S) URLs; configure SOCKS in Magpie and use inherit");
  return url.href;
}

export function createFetch(options={}, {fetchImpl, supportsProxy=!!globalThis.Bun}={}) {
  const current=typeof options==="function"?options:()=>options;
  // Validate at load, before authentication or any request can have effects.
  proxyOption(current());
  return async (input,init={})=>{
    const proxy=proxyOption(current());
    if(proxy!==undefined && !supportsProxy && !fetchImpl)throw new Error("Explicit plugin proxy requires Bun (Magpie runtime); Node tests use an injected transport");
    const request=proxy===undefined?init:{...init,proxy};
    try{return await (fetchImpl||globalThis.fetch)(input,request);}
    catch(error){
      if(init.signal?.aborted)throw init.signal.reason||error;
      // A proxy failure can contain URL userinfo or headers. Keep details out
      // of account cards/tool responses without silently trying a direct path.
      throw Object.assign(new Error(proxy===undefined?"Network request failed; check Magpie connectivity and proxy settings":"Network request through configured proxy failed; no direct fallback attempted"),{code:"BPS_NETWORK_ERROR"});
    }
  };
}

export async function readJSON(response,limit,label="upstream") {
  const declared=response.headers.get("content-length");
  if(declared && /^\d+$/.test(declared) && Number(declared)>limit){await response.body?.cancel();throw new Error(label+" response exceeds size limit");}
  if(!response.body)throw new Error(label+" response is empty");
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw new Error(label+" response exceeds size limit");chunks.push(value);}
    try{return JSON.parse(Buffer.concat(chunks,bytes).toString("utf8"));}catch{throw new Error("Invalid "+label+" JSON response");}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
