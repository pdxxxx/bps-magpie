export function fieldsFromOptions(options={}){
 const proxy=options.proxy;
 const timeout=Number.isFinite(options.timeoutMs)?options.timeoutMs:1800000;
 return {mode:proxy==="direct"?"direct":typeof proxy==="string"&&proxy&&proxy!=="inherit"?"proxy":"inherit",proxy:typeof proxy==="string"&&!['direct','inherit'].includes(proxy)?proxy:"",seconds:String(timeout/1000),cache:options.continuationCache!==false};
}
export function optionsFromFields(fields,base={}){
 const seconds=Number(fields.seconds);
 if(!Number.isSafeInteger(seconds)||seconds<1||seconds>3600)throw new Error("超时须为 1–3600 秒的整数。");
 let proxy;
 if(fields.mode==="inherit")proxy="inherit";
 else if(fields.mode==="direct")proxy="direct";
 else if(fields.mode==="proxy"){
   let parsed;try{parsed=new URL(String(fields.proxy).trim());}catch{throw new Error("请输入有效的 HTTP(S) 代理地址。");}
   if(!["http:","https:"].includes(parsed.protocol)||!parsed.hostname||parsed.search||parsed.hash||!['','/'].includes(parsed.pathname))throw new Error("插件独立代理只接受 HTTP(S)；SOCKS 请在 Magpie 中配置并选择继承。");
   proxy=parsed.href;
 }else throw new Error("无效的代理模式。");
 if(typeof fields.cache!=="boolean")throw new Error("请选择是否启用会话缓存。");
 const {models:_obsolete,...preserved}=base;
 return {...preserved,timeoutMs:seconds*1000,proxy,continuationCache:fields.cache};
}
