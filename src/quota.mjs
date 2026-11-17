// the upstream gateway v2.21.5 openai_quota_service.go and reset_credits.go contracts.
import { readJSON } from "./network.mjs";
export const USAGE_URL="https://chatgpt.com/backend-api/wham/usage";
export const CREDITS_URL="https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CONSUME_URL=CREDITS_URL+"/consume";

function integer(value){
  if(typeof value==="string" && /^\d+$/.test(value.trim()))value=Number(value);
  return Number.isSafeInteger(value)&&value>=0?value:undefined;
}
function instant(value){
  if(typeof value==="number" && (!Number.isFinite(value)||value<=0))return undefined;
  if(typeof value==="number" && Number.isFinite(value)&&value>0)value=value<1e12?value*1000:value;
  if(typeof value!=="number" && typeof value!=="string")return undefined;
  const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():undefined;
}
export function resetDetails(value){
  let count,list;
  if(Array.isArray(value))list=value;
  else if(value && typeof value==="object"){
    count=integer(value.available_count)??integer(value.availableCount);
    for(const field of ["credits","rate_limit_reset_credits","items","data"]){if(value[field]!=null){if(Array.isArray(value[field]))list=value[field];break;}}
  }
  const records=list?.filter(c=>c&&typeof c==="object"&&(!c.reset_type&&!c.resetType || String(c.reset_type||c.resetType).trim().toLowerCase()==="codex_rate_limits")&&(!c.status||String(c.status).trim().toLowerCase()==="available"));
  return {count:count??records?.length,each:records?.map(c=>({until:instant(c.expires_at||c.expiresAt)})).filter(c=>c.until)};
}
export function projectUsage(usage,details,{now=Date.now(),detailsError}={}){
  if(!usage || typeof usage!=="object" || Array.isArray(usage))throw new Error("Invalid quota response");
  const windows=[];
  function addWindow(w,name){
    if(!w || typeof w!=="object")return;
    const out={name};
    if(typeof w.used_percent==="number"&&Number.isFinite(w.used_percent)&&w.used_percent>=0)out.used=w.used_percent;
    if(Number.isSafeInteger(w.limit_window_seconds)&&w.limit_window_seconds>0)out.span=w.limit_window_seconds;
    const reset=instant(w.reset_at)||(Number.isFinite(w.reset_after_seconds)&&w.reset_after_seconds>=0?instant(now+w.reset_after_seconds*1000):undefined);
    if(reset)out.resetsAt=reset;
    // These are ChatGPT/Codex account windows. They are display-only for this
    // BPS provider: no claim that Codex exhaustion blocks BPS inference.
    out.aside=true;
    windows.push(out);
  }
  addWindow(usage.rate_limit?.primary_window,"Codex 主窗口");
  addWindow(usage.rate_limit?.secondary_window,"Codex 次窗口");
  for(const limit of Array.isArray(usage.additional_rate_limits)?usage.additional_rate_limits:[]){
    const name=String(limit.limit_name||limit.metered_feature||"附加窗口").slice(0,80);
    addWindow(limit.rate_limit?.primary_window,name+" · 主窗口");
    addWindow(limit.rate_limit?.secondary_window,name+" · 次窗口");
  }
  const original=resetDetails(usage.rate_limit_reset_credits);
  const authoritative=resetDetails(details);
  const count=authoritative.count??original.count;
  const each=authoritative.each??original.each;
  const output={windows,signIn:"kept"};
  if(typeof usage.plan_type==="string")output.plan=usage.plan_type;
  if(typeof usage.email==="string")output.user=usage.email;
  const credits=usage.credits;
  if(credits?.unlimited===true)output.balance="无限 Codex 点数";
  else if(typeof credits?.balance==="string"&&/^\d+(\.\d+)?$/.test(credits.balance))output.balance=credits.balance+" Codex 点数";
  if(count!==undefined){
    output.resets={count,byWindow:false};
    if(each?.length){output.resets.each=each;output.resets.until=each.map(x=>x.until).sort()[0];}
  }
  if(detailsError)output.warning="重置次数明细查询失败；未推算缺失次数。";
  return output;
}

export function quotaHeaders(auth){return new Headers({authorization:"Bearer "+auth.access,"chatgpt-account-id":auth.workspaceId,"openai-beta":"codex-1","oai-language":"zh-CN",originator:"Codex Desktop",accept:"application/json","sec-fetch-site":"none","sec-fetch-mode":"no-cors","sec-fetch-dest":"empty",priority:"u=4, i"});}

async function request(auth,url,{fetchImpl=globalThis.fetch,signal,body}={}){
  const timeout=AbortSignal.timeout(20000);const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const headers=quotaHeaders(auth);
  if(body)headers.set("content-type","application/json");
  const response=await fetchImpl(url,{method:body?"POST":"GET",headers,body:body?JSON.stringify(body):undefined,redirect:"error",signal:combined});
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error("ChatGPT/Codex 额度接口返回 HTTP "+response.status),{status:response.status});}
  return readJSON(response,1024*1024,"quota");
}

// Credit IDs stay in the private operation receipt, never in the panel result.
export async function availableResetCredit(auth,deps={}){
  const data=await request(auth,CREDITS_URL,deps);
  const list=Array.isArray(data)?data:data?.credits??data?.rate_limit_reset_credits??data?.items??data?.data;
  if(!Array.isArray(list))throw new Error("无法确认可用重置卡，请稍后刷新。");
  const cards=list.filter(c=>c&&c.status==="available"&&c.reset_type==="codex_rate_limits"&&typeof c.id==="string"&&c.id.length>0&&c.id.length<=256&&!/[\s\p{Cc}\p{Cf}]/u.test(c.id))
    .map(c=>({id:c.id,until:c.expires_at==null?null:instant(c.expires_at)}))
    .filter(c=>c.until===null||new Date(c.until).getTime()>Date.now());
  cards.sort((a,b)=>(a.until?new Date(a.until).getTime():Infinity)-(b.until?new Date(b.until).getTime():Infinity));
  if(!cards.length)throw new Error("没有可用的重置次数。");
  return cards[0];
}

export async function consumeReset(auth,{requestId,creditId},deps={}){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||typeof creditId!=="string"||!creditId||creditId.length>256||/[\s\p{Cc}\p{Cf}]/u.test(creditId))throw new Error("无效的重置操作记录。");
  const result=await request(auth,CONSUME_URL,{...deps,body:{redeem_request_id:requestId,credit_id:creditId}});
  if(["success","reset"].includes(result?.code)&&Number.isSafeInteger(result.windows_reset)&&result.windows_reset>0)return {status:"success",message:`已重置 ${result.windows_reset} 个额度窗口。`};
  const messages={nothing_to_reset:"当前没有需要重置的额度窗口，未消耗次数。",no_credit:"该重置卡已不可用，请刷新次数。",already_redeemed:"原重置卡已被使用，请查看更新后的额度。",already_used:"原重置卡已被使用，请查看更新后的额度。"};
  if(Object.hasOwn(messages,result?.code))return {status:"finished",message:messages[result.code]};
  throw new Error("上游未明确确认重置结果，请核对原操作。");
}

export async function queryQuota(auth,deps={}){
  const [usage,details]=await Promise.allSettled([request(auth,USAGE_URL,deps),request(auth,CREDITS_URL,deps)]);
  if(usage.status==="rejected")throw usage.reason;
  if(!usage.value||typeof usage.value!=="object"||Array.isArray(usage.value))throw new Error("Invalid quota response");
  if(usage.value.account_id && usage.value.account_id!==auth.workspaceId)throw new Error("Quota response belongs to another workspace");
  const result=projectUsage(usage.value,details.status==="fulfilled"?details.value:undefined,{detailsError:details.status==="rejected"});
  return {...result,observedAt:new Date().toISOString()};
}
