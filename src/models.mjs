import {BASE_URL,CLIENT_ID} from "./constants.mjs";
import {bpsHeaders} from "./provider.mjs";
import {readJSON} from "./network.mjs";

export const MODELS_URL=BASE_URL+"/responses/access?include_models=true";
const modelID=/^gpt-[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const levels=new Set(["low","medium","high","xhigh"]);

// Mirrors the official access-catalog filtering used by the source adapter.
export function accessModelCatalog(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||typeof value.allowed!=="boolean")throw new Error("BPS 模型权限响应无效");
  if(!value.allowed)return {};
  const catalog=value.model_catalog;
  if(!catalog||!Array.isArray(catalog.models))throw new Error("BPS 未返回有效的模型目录");
  if(catalog.restricted_models!=null&&(!Array.isArray(catalog.restricted_models)||catalog.restricted_models.some(id=>typeof id!=="string")))throw new Error("BPS 模型限制列表无效");
  const restricted=new Set(catalog.restricted_models||[]),seen=new Set(),models=[];
  for(const item of catalog.models){
    if(!item||typeof item!=="object"||Array.isArray(item)||typeof item.id!=="string"||!modelID.test(item.id)||restricted.has(item.id)||seen.has(item.id))continue;
    if(["available","enabled","model_picker_enabled"].some(key=>item[key]!=null&&(typeof item[key]!=="boolean"||item[key]===false)))continue;
    if(item.label!=null&&typeof item.label!=="string")continue;
    if(item.policy!=null&&(typeof item.policy!=="object"||Array.isArray(item.policy)||(item.policy.state!=null&&typeof item.policy.state!=="string")||["disabled","unconfigured"].includes(item.policy.state)))continue;
    if(item.efforts!=null&&(!Array.isArray(item.efforts)||item.efforts.some(e=>e!==null&&(typeof e!=="object"||Array.isArray(e)||(e.value!=null&&typeof e.value!=="string")))))continue;
    // provider.models returns normalized Model objects, not config-schema entries.
    const model={id:item.id,name:item.label?.trim()||item.id,api:{id:item.id,url:BASE_URL,npm:"@ai-sdk/openai"},capabilities:{toolcall:true,attachment:true,input:{text:true,image:true},output:{text:true}}};
    if(Array.isArray(item.efforts)){
      const efforts=[...new Set(item.efforts.map(e=>e?.value).filter(level=>levels.has(level)))];
      model.capabilities.reasoning=efforts.length>0;model.variants=Object.fromEntries(efforts.map(level=>[level,{}]));
    }
    models.push([item.id,model]);seen.add(item.id);
  }
  return Object.fromEntries(models);
}

export async function fetchModelCatalog(auth,{fetchImpl=globalThis.fetch,signal}={}){
  if(auth?.type!=="oauth"||auth.clientId!==CLIENT_ID||!auth.access||!auth.workspaceId)throw new Error("请先登录 BPS，再刷新模型列表");
  const timeout=AbortSignal.timeout(5000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  combined.throwIfAborted();
  const response=await fetchImpl(MODELS_URL,{method:"GET",redirect:"error",headers:bpsHeaders(auth,{accept:"application/json"}),signal:combined});
  if(response.status!==200){await response.body?.cancel();throw Object.assign(new Error("BPS 模型同步失败（HTTP "+response.status+"）"),{status:response.status});}
  const result=accessModelCatalog(await readJSON(response,8*1024*1024,"BPS model catalog"));
  combined.throwIfAborted();return result;
}
