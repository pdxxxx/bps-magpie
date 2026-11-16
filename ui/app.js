import {fieldsFromOptions,optionsFromFields} from "./settings.mjs";
const element=id=>document.getElementById(id);
let saved={};
function bounded(request){
 let timer;
 return Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Magpie 未在限时内确认。请点“重新读取”核对结果。")),10000);})]).finally(()=>clearTimeout(timer));
}
const fieldIds=["mode","proxy","seconds","relayUrl","relayToken"];
function currentFields(){return {...Object.fromEntries(fieldIds.map(key=>[key,element(key).value])),cache:element("cache").checked,relayEnabled:element('relayEnabled').checked};}
function networkNote(){
 const mode=element("mode").value;element("proxy-row").hidden=mode!=="proxy";
 element("network-note").textContent=element("relayEnabled").checked?"启用 WSS 后，插件直接连接中继，不使用 HTTP 代理。":mode==="inherit"?"使用 Magpie 各入口的代理设置。":mode==="direct"?"API 请求直接连接。":"用于授权换票、推理与额度请求。";
}
function announce(message,error=false,state=error?"error":"idle"){
 const status=element("status");
 status.textContent=message;
 status.dataset.error=String(error);
 status.dataset.state=state;
 status.setAttribute("aria-busy",state==="saving"?"true":"false");
}
function relayNote(){element('relay-fields').hidden=!element('relayEnabled').checked;networkNote();}
async function load(){
 try{
  saved=await bounded(magpie.options.get())||{};
  const fields=fieldsFromOptions(saved);
  for(const [key,value]of Object.entries(fields)){if(key==="cache"||key==='relayEnabled')element(key).checked=value;else element(key).value=value;}
  relayNote();announce("已读取当前设置。修改后请点击“保存”。",false,"loaded");
 }catch(error){announce("读取设置失败："+(error.message||"Magpie 未返回配置。"),true);throw error;}
}
element("mode").addEventListener("change",networkNote);
element('relayEnabled').addEventListener('change',relayNote);
for(const id of ["mode","proxy","seconds","relayUrl","relayToken","cache","relayEnabled"]){
 element(id).addEventListener("input",()=>announce("有未保存的修改。",false,"dirty"));
 element(id).addEventListener("change",()=>announce("有未保存的修改。",false,"dirty"));
}
async function testRelay(){
 const fields=currentFields(),next=optionsFromFields(fields,saved);
 if(!next.relayEnabled)throw new Error("请先勾选“手动启用 WSS 中继”并保存。");
 const expected=fieldsFromOptions(next),actual=fieldsFromOptions(saved);
 for(const key of ["relayEnabled","relayUrl","relayToken"]){if(actual[key]!==expected[key])throw new Error("请先保存当前中继配置，再开始测试。");}
 if(!/^[a-f0-9]{32}$/.test(saved.relayProbeId||""))throw new Error("请先用新版保存一次，再测试。");
 const local=["localhost","wails.localhost","127.0.0.1","[::1]"].includes(location.hostname)||location.protocol==="wails:";
 if(!magpie.service&&!local)throw new Error("无法打开此电脑的插件服务，请在 Magpie 桌面端测试。");
 const service=new URL(magpie.service||"http://127.0.0.1:39846/",location.href);
 if(!service.pathname.endsWith("/"))service.pathname+="/";
 const result=new URL("probe/"+saved.relayProbeId,service);
 announce("正在连接中继。握手完成后测量三次通信往返…",false,"testing");
 location.assign(result.href);
}
element("testRelay").addEventListener("click",()=>testRelay().catch(error=>announce("WSS 测试失败："+(error.message||"未能完成测试。"),true,"error")));
element("reload").addEventListener("click",()=>load().catch(e=>announce(e.message,true)));
element("save").addEventListener("click",async ()=>{
 try{
  const fields=currentFields(),next=optionsFromFields(fields,saved);
  if(next.relayEnabled){
   const same=saved.relayEnabled===true&&next.relayUrl===saved.relayUrl&&next.relayToken===saved.relayToken&&/^[a-f0-9]{32}$/.test(saved.relayProbeId||"");
   next.relayProbeId=same?saved.relayProbeId:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
  }else delete next.relayProbeId;
  element("controls").disabled=true;announce("正在保存设置…",false,"saving");
  await bounded(magpie.options.set(next));
  const confirmed=await bounded(magpie.options.get())||{};
  if(!Object.keys(next).every(key=>Object.hasOwn(confirmed,key))||confirmed.relayProbeId!==next.relayProbeId)throw new Error("Magpie 未确认保存，请重新读取设置。");
  const expected=fieldsFromOptions(next),actual=fieldsFromOptions(confirmed);
  for(const key of ["mode","proxy","seconds","cache","relayEnabled","relayUrl","relayToken"]){
   if(actual[key]!==expected[key])throw new Error("Magpie 未确认保存，请重试。");
  }
  saved=confirmed;
  for(const key of fieldIds)element(key).value=actual[key];
  const reloadHint=expected.relayEnabled?"已保存并确认。请在插件列表关闭后重新启用 BPS，新的 WSS 路由才会生效。":"已保存并确认。请在插件列表关闭后重新启用 BPS，使网络设置生效。";
  announce(reloadHint,false,"saved");
 }catch(error){announce("保存失败："+(error.message||"Magpie 未接受配置。"),true,"error");}finally{element("controls").disabled=false;}
});
let readyTimer;
try{
 if(!globalThis.magpie?.options)throw new Error("未能连接 Magpie，请从插件设置页打开或重新载入页面。");
 await Promise.race([magpie.ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error("连接 Magpie 超时，请重新打开 BPS 设置；仍失败时关闭后重新启用此插件。")),10000);})]);
 await load();element("controls").disabled=false;
}catch(error){announce(error.message||"无法连接 Magpie，请从插件设置页打开。",true);}finally{clearTimeout(readyTimer);}
