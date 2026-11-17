import {readFile,mkdir,open,rename,unlink,readdir,stat,lstat} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {CLIENT_ID} from "./constants.mjs";
import {queryQuota,availableResetCredit,consumeReset} from "./quota.mjs";
import {createFetch,proxyOption} from "./network.mjs";

const accountPattern=/^bps(?:#[A-Za-z0-9_-]+)?$/;
const actionPattern=/^[a-f0-9]{32}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultResults=fileURLToPath(new URL("../ui/reset-results/",import.meta.url));
const hash=value=>createHash("sha256").update(value).digest("hex");
const identity=a=>hash(JSON.stringify([a.clientId,a.workspaceId,a.subject||a.uid]));
const fault=message=>Object.assign(new Error(message),{panel:true});
function publicError(error){
  if(error.panel)return error.message;
  if(error.status===401)return "账号授权已失效，请在 Magpie 刷新额度或重新登录。";
  if(error.status===403)return "上游拒绝了额度操作，请检查账号权限；使用中继时需升级 BPS Relay 至 0.1.1。";
  if(error.status===429)return "上游请求过于频繁，请稍后刷新。";
  return "未能完成操作。请检查网络或中继连接，然后刷新核对结果。";
}
async function json(file,fallback){
  try{return JSON.parse(await readFile(file,"utf8"));}catch(e){if(e.code==="ENOENT"&&fallback!==undefined)return fallback;throw fault("无法读取本机账号或操作记录，请重新打开面板。");}
}
async function privateDir(dir){await mkdir(dir,{recursive:true,mode:0o700});if(!(await lstat(dir)).isDirectory())throw fault("操作记录目录不可用。");}
async function atomic(file,value){
  const temp=file+"."+randomUUID()+".tmp";const f=await open(temp,"wx",0o600);
  try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}
  try{await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}
}
async function lock(file){
  const owner=randomUUID();
  for(let i=0;i<2;i++){
    let f;
    try{f=await open(file,"wx",0o600);}catch(e){
      if(e.code!=="EEXIST")throw e;
      const old=await json(file,{});let alive=true;
      if(Number.isSafeInteger(old.pid)&&old.pid>0){try{process.kill(old.pid,0);}catch(e){alive=e.code!=="ESRCH";}}
      if(!alive&&i===0){await unlink(file);continue;}
      throw fault("这个账号有操作正在进行，请稍后刷新。");
    }
    try{await f.writeFile(JSON.stringify({owner,pid:process.pid}));await f.sync();}finally{await f.close();}
    return async()=>{if((await json(file,{})).owner===owner)await unlink(file);};
  }
}

// The panel runs outside Magpie's account scope. Honor the same saved
// account/provider proxy picks, and leave the global choice to the host.
export function panelProxy(providers,settings,label){
  const p=providers?.providers?.find(p=>p.id==="bps");
  let choice=(p?.accountProxies?.[label.trim().toLowerCase()]||p?.proxy||"").trim();
  if(!choice)return undefined;
  if(choice==="direct")return "";
  if(choice.startsWith("@")){
    const saved=settings?.proxies?.find(p=>p.id===choice.slice(1));
    if(!saved)throw fault("账号选择的代理已不存在，请在 Magpie 重新选择代理。");
    choice=saved.url?.trim()||"";
    let url;try{url=new URL(choice.includes("://")?choice:"http://"+choice);}catch{throw fault("账号的代理地址无效。");}
    if(saved.user||saved.pass){url.username=saved.user||"";url.password=saved.pass||"";}
    choice=url.href;
  }
  if(choice==="system"||choice==="auto")throw fault("请在 Magpie 将该账号代理改为跟随全局或明确的代理地址。");
  let url;try{url=new URL(choice.includes("://")?choice:"http://"+choice);}catch{throw fault("账号的代理地址无效。");}
  if(!["http:","https:","socks5:","socks5h:"].includes(url.protocol)||!url.hostname)throw fault("账号的代理地址无效。");
  return url.href;
}

export function createResetPanel({directory,options={},deps={}}){
  if(typeof directory!=="string"||!path.isAbsolute(directory))throw fault("请在 Magpie 内打开 BPS 供应商面板。");
  const root=path.join(directory,"bps-panel"),states=path.join(root,"states");
  const now=deps.now||Date.now;
  async function accounts(){
    const data=await json(path.join(directory,"plugin-auth.json"),{});
    const all=Object.entries(data).filter(([k,a])=>accountPattern.test(k)&&a?.type==="oauth"&&a.clientId===CLIENT_ID&&typeof a.workspaceId==="string"&&a.workspaceId);
    const names=all.map(([k,a])=>String(a.accountId||k));
    return all.map(([account,auth],i)=>({account,auth,label:(names.filter(n=>n.toLowerCase()===names[i].toLowerCase()).length>1?names[i]+" ("+(account.split("#")[1]||"default")+")":names[i]).slice(0,200)}));
  }
  async function selected(account){
    if(typeof account!=="string"||!accountPattern.test(account))throw fault("请选择有效的 BPS 账号。");
    const row=(await accounts()).find(a=>a.account===account);
    if(!row)throw fault("该账号已移除，请刷新列表。");
    // Only the host owns rotating-token renewal. Never race it from this
    // unscoped page action or write another account's credentials.
    if(!row.auth.access||!Number.isFinite(row.auth.expires)||row.auth.expires<=now()+60000)throw fault("凭据需要续期，请先在 Magpie 刷新该账号额度，再刷新此面板。");
    return row;
  }
  async function network(row){
    if(deps.fetchImpl)return deps;
    let inherited;
    if(!options.relayEnabled&&proxyOption(options)===undefined){
      const [providers,settings]=await Promise.all([json(path.join(directory,"providers.json"),{}),json(path.join(directory,"settings.json"),{})]);
      inherited=panelProxy(providers,settings,row.label);
    }
    return {fetchImpl:createFetch(options,{fetchImpl:(url,init)=>globalThis.fetch(url,{...(inherited===undefined?{}:{proxy:inherited}),...init})})};
  }
  function statePath(auth){return path.join(states,hash(auth.workspaceId)+".json");}
  async function record(auth){return json(statePath(auth),null);}
  function publicState(r){return r?{requestId:r.requestId,status:r.status,message:r.message||"",until:r.until||null}:null;}
  async function oldUnknown(auth){
    const dir=path.join(directory,"bps-resets");let names;try{names=await readdir(dir);}catch(e){if(e.code==="ENOENT")return;throw e;}
    for(const name of names){if(!uuid.test(name.replace(/\.json$/,"")))continue;const r=await json(path.join(dir,name),null);if(r?.status==="unknown"&&r.scope===hash(auth.workspaceId))throw fault("旧版仍有结果未确认的重置记录，请先核对该记录。");}
  }
  async function snapshot(row){
    const r=await record(row.auth);
    const out={account:row.account,label:row.label,operation:publicState(r),count:null,windows:[]};
    try{
      const current=await selected(row.account);const quota=await queryQuota(current.auth,await network(current));
      out.count=quota.resets?.count??null;out.windows=quota.windows.map(w=>({name:w.name,used:w.used}));out.observedAt=quota.observedAt;
      if(quota.warning)out.warning=quota.warning;
    }catch(e){out.error=publicError(e);}
    return out;
  }
  async function list(){
    const rows=await accounts(),out=[];
    for(let i=0;i<rows.length;i+=4)out.push(...await Promise.all(rows.slice(i,i+4).map(snapshot)));
    return {rows:out};
  }
  async function preview(account){
    const row=await selected(account);await privateDir(states);
    const release=await lock(statePath(row.auth)+".lock");
    try{
      await oldUnknown(row.auth);
      let r=await record(row.auth);
      if(r&&(r.status==="unknown"||(r.status==="prepared"&&now()-r.createdAt<600000))){
        if(r.account!==account||r.identity!==identity(row.auth))throw fault("同一工作区已有另一账号的待处理重置，请先处理原账号的操作。");
      }else{
        const net=await network(row);const quota=await queryQuota(row.auth,net);
        if(!Number.isSafeInteger(quota.resets?.count)||quota.resets.count<1)throw fault("没有可确认的可用重置次数，请先刷新。");
        const credit=await availableResetCredit(row.auth,net);
        r={requestId:randomUUID(),account,identity:identity(row.auth),createdAt:now(),status:"prepared",creditId:credit.id,until:credit.until};
        await atomic(statePath(row.auth),r);
      }
      return {account,label:row.label,operation:publicState(r)};
    }finally{await release();}
  }
  async function commit(account,requestId,confirm){
    if(confirm!==true||typeof requestId!=="string"||!uuid.test(requestId))throw fault("请先确认本次重置。");
    const row=await selected(account);await privateDir(states);
    const release=await lock(statePath(row.auth)+".lock");
    try{
      const r=await record(row.auth);
      if(!r||r.requestId!==requestId||r.account!==account||r.identity!==identity(row.auth))throw fault("账号或重置记录已改变，请重新确认。");
      if(["success","finished"].includes(r.status))return {row:await snapshot(row),message:r.message,replayed:true};
      if(!["prepared","unknown"].includes(r.status))throw fault("无效的重置记录。");
      if(r.status==="prepared"&&now()-r.createdAt>600000)throw fault("确认已过期，请重新点击重置。");
      const current=await selected(account);
      if(identity(current.auth)!==r.identity)throw fault("账号授权已改变，请刷新后重新确认。");
      const net=await network(current);
      r.status="unknown";r.message="结果尚未确认；不会自动重试，只能核对原操作。";r.attempts=(r.attempts||0)+1;
      await atomic(statePath(row.auth),r);
      try{
        const result=await consumeReset(current.auth,r,net);Object.assign(r,result);
      }catch(e){r.message="结果未确认。"+publicError(e)+" 核对时仅重试同一张重置卡。";}
      let warning;
      try{await atomic(statePath(row.auth),r);}catch{warning="回执保存失败，请核对原操作，勿重复消耗。";}
      const updated=await snapshot(row);updated.operation=publicState(r);
      if(updated.error&&r.status==="success")warning="重置已成功，但额度读取失败；请稍后刷新，不要再次重置。";
      return {row:updated,message:r.message,warning};
    }finally{await release();}
  }
  return {list,preview,commit};
}

async function publish(dir,id,result){
  await privateDir(dir);
  // Only JSON from public projections reaches the sandbox. No credentials,
  // proxy URLs, upstream bodies or executable user text are serialized.
  const source=`globalThis.bpsPanelResult?.(${JSON.stringify(id)},${JSON.stringify(result).replace(/</g,"\\u003c").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029")});\n`;
  const temp=path.join(dir,id+"."+randomUUID()+".tmp");const f=await open(temp,"wx",0o600);
  try{await f.writeFile(source);}finally{await f.close();}
  await rename(temp,path.join(dir,id+".js"));
}

export async function runPanelAction({directory,options={},results=defaultResults,deps={}}){
  const cmd=options.bpsPanelAction,now=deps.now||Date.now;
  if(!cmd||!actionPattern.test(cmd.id)||cmd.provider!=="bps"||!Number.isSafeInteger(cmd.at)||cmd.at>now()+2000||now()-cmd.at>120000||!["list","preview","commit"].includes(cmd.kind))return;
  const root=path.join(directory,"bps-panel","actions");await privateDir(root);
  const file=path.join(root,cmd.id+".json");
  const done=await json(file,null);
  if(done){if(done.result)await publish(results,cmd.id,done.result);return;}
  let claim;try{claim=await open(file,"wx",0o600);}catch(e){if(e.code==="EEXIST")return;throw e;}
  try{await claim.writeFile(JSON.stringify({at:now(),running:true}));await claim.sync();}finally{await claim.close();}
  let result;
  try{
    const panel=createResetPanel({directory,options,deps});
    const value=cmd.kind==="list"?await panel.list():cmd.kind==="preview"?await panel.preview(cmd.account):await panel.commit(cmd.account,cmd.requestId,cmd.confirm);
    result={ok:true,...value};
  }catch(e){result={ok:false,error:publicError(e)};}
  await atomic(file,{at:now(),result});await publish(results,cmd.id,result);
  // Action responses may contain account labels; keep only short-lived copies.
  for(const dir of [root,results])for(const name of await readdir(dir)){
    if(!/^[a-f0-9]{32}\.(?:json|js)$/.test(name))continue;
    const p=path.join(dir,name);if(await stat(p).then(s=>now()-s.mtimeMs>600000,()=>false))await unlink(p).catch(()=>{});
  }
}
