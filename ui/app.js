import {fieldsFromOptions,optionsFromFields} from "./settings.mjs";
const element=id=>document.getElementById(id);
let saved={};
function networkNote(){
 const mode=element("mode").value;element("proxy-row").hidden=mode!=="proxy";
 element("network-note").textContent=mode==="inherit"?"使用 Magpie 各入口的代理设置。":mode==="direct"?"API 请求直接连接。":"用于授权换票、推理与额度请求。";
}
function announce(message,error=false){element("status").textContent=message;element("status").dataset.error=String(error);}
function relayNote(){element('relay-fields').hidden=!element('relayEnabled').checked;}
async function load(){saved=await magpie.options.get()||{};const fields=fieldsFromOptions(saved);for(const [key,value]of Object.entries(fields)){if(key==="cache"||key==='relayEnabled')element(key).checked=value;else element(key).value=value;}networkNote();relayNote();announce("设置已读取。");}
element("mode").addEventListener("change",networkNote);
element('relayEnabled').addEventListener('change',relayNote);
element("reload").addEventListener("click",()=>load().catch(e=>announce(e.message,true)));
element("settings").addEventListener("submit",async e=>{
 e.preventDefault();try{
  const fields={...Object.fromEntries(["mode","proxy","seconds","relayUrl","relayToken"].map(key=>[key,element(key).value])),cache:element("cache").checked,relayEnabled:element('relayEnabled').checked};const next=optionsFromFields(fields,saved);
  element("controls").disabled=true;await magpie.options.set(next);saved=next;announce("已保存。请在插件列表关闭后重新启用插件，使新配置生效。");
 }catch(error){announce(error.message||"保存失败。",true);}finally{element("controls").disabled=false;}
});
let readyTimer;
try{
 if(!globalThis.magpie?.options)throw new Error("未能连接 Magpie，请从插件设置页打开或重新载入页面。");
 await Promise.race([magpie.ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error("连接 Magpie 超时，请重新打开 BPS 设置；仍失败时关闭后重新启用此插件。")),10000);})]);
 await load();element("controls").disabled=false;
}catch(error){announce(error.message||"无法连接 Magpie，请从插件设置页打开。",true);}finally{clearTimeout(readyTimer);}
