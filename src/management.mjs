import { readFile,mkdir,open,rm,rename,stat,readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID,createHash } from "node:crypto";
import { CLIENT_ID } from "./constants.mjs";
import { queryQuota,consumeReset } from "./quota.mjs";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const accountPattern=/^bps(?:#[A-Za-z0-9_-]+)?$/;
function check(args,keys){
  if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).some(k=>!keys.includes(k)))throw new Error("Invalid management tool arguments");
}
function identity(auth){return createHash("sha256").update((auth.uid||auth.subject||auth.accountId)+"\0"+auth.workspaceId).digest("hex");}
function quotaScope(auth){return createHash("sha256").update(auth.workspaceId).digest("hex");}
const schema=properties=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const accountField={type:"string",description:"Exact account key returned by bps_accounts"};

export function managementTools({directory,deps={}}){
  function configDir(){if(typeof directory!=="string"||!path.isAbsolute(directory))throw new Error("Management tools require the Magpie host configuration directory");return directory;}
  async function accounts(){
    const file=path.join(configDir(),"plugin-auth.json");
    let data;try{if((await stat(file)).size>8*1024*1024)throw new Error("Auth storage is too large");data=JSON.parse(await readFile(file,"utf8"));}catch(e){if(e.code==="ENOENT")return {};throw new Error("Cannot read Magpie plugin account storage");}
    if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("Invalid Magpie account storage");
    return Object.fromEntries(Object.entries(data).filter(([key,a])=>accountPattern.test(key)&&a?.type==="oauth"&&a.clientId===CLIENT_ID));
  }
  async function selected(key,signal,requireFresh=true){
    if(typeof key!=="string"||!accountPattern.test(key))throw new Error("Choose an exact BPS account key");
    const getAuth=async()=>{const a=(await accounts())[key];if(!a)throw new Error("Selected BPS account is no longer signed in");return a;};
    signal?.throwIfAborted();
    const auth=await getAuth();
    // MCP tool callbacks are not in Magpie's account renewal scope. Never
    // race its cross-process rotating-token lock by refreshing from here.
    if(!auth.workspaceId)throw new Error("Selected account has no workspace identity");
    if(requireFresh&&(!auth.access||!Number.isFinite(auth.expires)||auth.expires<=Date.now()+45000))throw new Error("请先在 Magpie 刷新此账号额度或重新登录，让宿主续期凭据后再使用管理工具。");
    return auth;
  }
  async function stateDir(){const root=path.join(configDir(),"bps-resets");await mkdir(root,{recursive:true,mode:0o700});return root;}
  async function operation(id){
    if(typeof id!=="string"||!uuid.test(id))throw new Error("Invalid reset request ID");
    const root=await stateDir();const file=path.join(root,id+".json");
    try{
      if((await stat(file)).size>2*1024*1024)throw new Error();
      const record=JSON.parse(await readFile(file,"utf8"));
      if(record.requestId!==id||!Number.isFinite(record.createdAt)||!accountPattern.test(record.account)||typeof record.identity!=="string"||!["prepared","unknown","success","confirmed_consumed","confirmed_not_consumed"].includes(record.status))throw new Error();
      return {file,record};
    }catch{throw new Error("Reset request is missing or invalid; do not delete uncertain receipts");}
  }
  async function save(file,record){
    const temp=file+"."+randomUUID()+".tmp";
    let handle;
    try{handle=await open(temp,"wx",0o600);await handle.writeFile(JSON.stringify(record));await handle.sync();await handle.close();handle=null;await rename(temp,file);}finally{await handle?.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
  }
  async function lock(key,scope){
    const root=await stateDir();
    const legacy=path.join(root,createHash("sha256").update(key).digest("hex")+".lock");
    try{await stat(legacy);throw new Error("A legacy reset lock exists; inspect its receipt before manual recovery");}catch(e){if(e.code!=="ENOENT")throw e;}
    const file=path.join(root,scope+".lock");
    let handle;try{handle=await open(file,"wx",0o600);}catch(e){if(e.code==="EEXIST")throw new Error("A reset for this account is already running; query quota before retrying");throw e;}
    try{await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now()}));await handle.sync();}catch(e){await handle.close();await rm(file,{force:true}).catch(()=>{});throw e;}
    return async()=>{await handle.close();await rm(file,{force:true});};
  }
  async function recordsFor(auth){
    const names=(await readdir(await stateDir())).filter(name=>name.endsWith(".json")&&uuid.test(name.slice(0,-5)));
    if(names.length>4096)throw new Error("Too many reset receipts; archive reviewed final receipts before continuing");
    const records=[];
    for(const name of names){const {record}=await operation(name.slice(0,-5));if(record.scope===quotaScope(auth)||record.identity===identity(auth))records.push(record);}
    return records.sort((a,b)=>b.createdAt-a.createdAt||a.requestId.localeCompare(b.requestId));
  }
  function publicRecord(record){
    return {requestId:record.requestId,account:record.account,status:record.status,createdAt:new Date(record.createdAt).toISOString(),attempts:record.attempts||0,result:record.result};
  }
  function bind(record,account,auth){if(record.account!==account||record.identity!==identity(auth))throw new Error("Reset request belongs to a different account or authorization");}
  async function executeReset(args,ctx,retry){
    check(args,["account","request_id","confirm"]);if(args.confirm!==true)throw new Error("Explicit reset confirmation is required");
    const auth=await selected(args.account,ctx.abort);const release=await lock(args.account,quotaScope(auth));
    try{
      const {file,record}=await operation(args.request_id);bind(record,args.account,auth);
      if(record.status!=="prepared" && !(retry&&record.status==="unknown"))return {...record.result,status:record.status,requestId:record.requestId,replayed:true,message:record.status==="success"?"此请求已经成功，不会重复消费。":"此请求已有回执；先用 bps_reset_status 查询，不会重复消费。"};
      if(record.status==="prepared"&&retry)throw new Error("Use bps_reset for a prepared request");
      const anchor=record.status==="unknown"?(record.firstAttemptAt||record.createdAt):record.createdAt;
      if(Date.now()-anchor>600000)throw new Error("Reset retry/preparation window expired; inspect the receipt and verify the actual quota before resolving it");
      const pending=(await recordsFor(auth)).find(r=>r.status==="unknown"&&r.requestId!==record.requestId);
      if(pending)throw new Error("Another reset is uncertain: "+pending.requestId+"; resolve it before spending another credit");
      ctx.abort?.throwIfAborted();
      record.status="unknown";record.scope=quotaScope(auth);record.firstAttemptAt??=Date.now();record.attempts=(record.attempts||0)+1;
      await save(file,record);
      try{
        const result=await consumeReset(auth,record.requestId,{...deps,signal:ctx.abort});
        record.status="success";record.result=result;
        try{await save(file,record);}catch{result.warning="重置已成功，但本地回执保存失败；请查询额度，不要再次消费。";}
        return result;
      }catch(error){
        record.result={status:"unknown",requestId:record.requestId,message:"未能确认重置结果，不会自动重试。先查额度；明确要求重试时只用原 request_id。",error:error.message};
        try{await save(file,record);}catch{record.result.warning="状态回写失败；发送前的 unknown 回执仍保留，不要另建兑换请求。";}
        return record.result;
      }
    }finally{await release().catch(()=>{});}
  }
  return {
    bps_diagnostics:{description:"Check this plugin's build, proxy mode, cache limits and saved credential freshness locally. Makes no upstream calls and never returns tokens, prompts or proxy credentials.",args:schema({}),async execute(args){check(args,[]);const base=deps.diagnose?await deps.diagnose():{liveNetworkChecked:false};const all=Object.values(await accounts());return {...base,accounts:{saved:all.length,fresh:all.filter(a=>Number.isFinite(a.expires)&&a.expires>Date.now()+45000).length,needsRenewal:all.filter(a=>!Number.isFinite(a.expires)||a.expires<=Date.now()+45000).length}};}},
    bps_accounts:{description:"List only this plugin's signed-in accounts without exposing credentials.",args:schema({}),async execute(args){check(args,[]);return {accounts:Object.entries(await accounts()).map(([key,a])=>({account:key,label:a.accountId||key,workspace:a.workspaceId}))};}},
    bps_quota:{description:"Read ChatGPT/Codex quota, credit balance, reset counts and expiry for one BPS account. Does not reset or consume credits.",args:schema({account:accountField}),async execute(args,ctx={}){check(args,["account"]);return queryQuota(await selected(args.account,ctx.abort),{...deps,signal:ctx.abort});}},
    bps_prepare_reset:{description:"Read quota and prepare one account-bound reset request. Does not consume a reset credit. Call bps_reset only when the user explicitly requested a reset.",args:schema({account:accountField}),async execute(args,ctx={}){
      check(args,["account"]);const auth=await selected(args.account,ctx.abort);const release=await lock(args.account,quotaScope(auth));
      try{
      const records=await recordsFor(auth);const pending=records.find(r=>r.status==="unknown");
      if(pending)throw new Error("An uncertain reset already exists: "+pending.requestId+"; use bps_reset_status and resolve it before preparing another");
      const prepared=records.find(r=>r.status==="prepared"&&Date.now()-r.createdAt<=600000);
      if(prepared){bind(prepared,args.account,auth);return {requestId:prepared.requestId,account:prepared.account,reused:true,expiresInSeconds:Math.max(0,Math.floor((600000-Date.now()+prepared.createdAt)/1000)),message:"已有准备请求，复用原 request_id，不另建兑换。"};}
      const quota=await queryQuota(auth,{...deps,signal:ctx.abort});
      if(quota.resets?.count===undefined)throw new Error("Remaining reset count is unknown; consumption is disabled");
      if(quota.resets.count<1)throw new Error("No available reset credits");
      const id=randomUUID();const root=await stateDir();
      await save(path.join(root,id+".json"),{requestId:id,account:args.account,identity:identity(auth),scope:quotaScope(auth),createdAt:Date.now(),status:"prepared"});
      return {requestId:id,account:args.account,remaining:quota.resets.count,expiresInSeconds:600,message:"将消耗 1 次 Codex 重置次数。仅在用户明确要求重置时调用 bps_reset，confirm=true。"};
      }finally{await release().catch(()=>{});}
    }},
    bps_reset:{description:"Consume one prepared Codex reset credit only when explicitly requested by the user. Requires confirm=true; uncertain operations are not automatically repeated.",args:schema({account:accountField,request_id:{type:"string"},confirm:{type:"boolean",const:true}}),execute:(args,ctx={})=>executeReset(args,ctx,false)},
    bps_retry_reset:{description:"Only on an explicit user instruction, retry an uncertain reset within 10 minutes, using exactly its ORIGINAL redeem request ID. This can consume a credit if the first attempt never reached upstream. Never use a new ID as a retry.",args:schema({account:accountField,request_id:{type:"string"},confirm:{type:"boolean",const:true}}),execute:(args,ctx={})=>executeReset(args,ctx,true)},
    bps_reset_status:{description:"Read saved reset receipts locally, including older receipts with offset/limit or one exact request_id. No upstream calls or credit consumption; expired saved access tokens are accepted.",args:{...schema({account:accountField,request_id:{type:"string",description:"Optional exact reset request ID; cannot be combined with pagination"},offset:{type:"integer",minimum:0,description:"Zero-based offset, default 0"},limit:{type:"integer",minimum:1,maximum:100,description:"Page size, default 100"}}),required:["account"]},async execute(args,ctx={}){
      check(args,["account","request_id","offset","limit"]);
      const exact=Object.hasOwn(args,"request_id");
      if(exact&&(Object.hasOwn(args,"offset")||Object.hasOwn(args,"limit")))throw new Error("Choose either request_id or pagination, not both");
      const offset=Object.hasOwn(args,"offset")?args.offset:0,limit=Object.hasOwn(args,"limit")?args.limit:100;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("Receipt offset must be a nonnegative integer and limit must be between 1 and 100");
      const auth=await selected(args.account,ctx.abort,false);
      if(exact){
        const {record}=await operation(args.request_id);
        if(record.scope!==quotaScope(auth)&&record.identity!==identity(auth))throw new Error("Reset request belongs to a different account or authorization");
        return {operations:[publicRecord(record)],total:1,offset:0,limit:1,hasMore:false};
      }
      const records=await recordsFor(auth),hasMore=offset+limit<records.length;
      return {operations:records.slice(offset,offset+limit).map(publicRecord),total:records.length,offset,limit,hasMore,...(hasMore?{nextOffset:offset+limit}:{})};
    }},
    bps_resolve_reset:{description:"Record a HUMAN-CONFIRMED outcome after checking the actual account externally. Does not call the reset endpoint. Never infer consumed/not_consumed from usage percentages or guess to unblock an uncertain operation.",args:schema({account:accountField,request_id:{type:"string"},outcome:{type:"string",enum:["consumed","not_consumed"]},confirm:{type:"boolean",const:true}}),async execute(args,ctx={}){
      check(args,["account","request_id","outcome","confirm"]);if(args.confirm!==true||!["consumed","not_consumed"].includes(args.outcome))throw new Error("A human-confirmed reset outcome is required");
      const auth=await selected(args.account,ctx.abort,false);const release=await lock(args.account,quotaScope(auth));
      try{const {file,record}=await operation(args.request_id);bind(record,args.account,auth);if(record.status!=="unknown")throw new Error("Only an uncertain reset can be manually resolved");record.status="confirmed_"+args.outcome;record.result={status:record.status,requestId:record.requestId,confirmedBy:"user",confirmedAt:new Date().toISOString()};await save(file,record);return record.result;}finally{await release().catch(()=>{});}
    }}
  };
}
