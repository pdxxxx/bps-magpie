(async()=>{
"use strict";
const $=id=>document.getElementById("reset-"+id),pending=new Map();
let rows=[],busy=false,lastSent=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function say(text,error=false){$("status").textContent=text;$("status").dataset.error=String(error);}
function node(tag,cls,text){const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function bounded(task){let timer;return Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Magpie 未及时确认，请刷新核对。")),10000);})]).finally(()=>clearTimeout(timer));}
globalThis.bpsPanelResult=(id,result)=>{const done=pending.get(id);if(done&&result&&typeof result.ok==="boolean")done(result);};
async function resultFor(id){
 let answer;pending.set(id,value=>{answer=value;});
 try{
  const until=Date.now()+90000;
  for(let i=0;!answer&&Date.now()<until;i++){
   await new Promise(resolve=>{
    const script=document.createElement("script");let timer;
    const finish=()=>{clearTimeout(timer);script.onload=script.onerror=null;script.remove();resolve();};
    script.onload=script.onerror=finish;timer=setTimeout(finish,2000);
    script.src="reset-results/"+id+".js?read="+i;document.head.append(script);
   });
   if(!answer)await sleep(700);
  }
  if(!answer)throw new Error("未收到操作结果，请刷新核对；不要重复确认新的重置。");
  if(!answer.ok)throw new Error(answer.error||"操作失败，请刷新核对。");
  return answer;
 }finally{pending.delete(id);}
}
async function request(kind,fields={}){
 if(Date.now()-lastSent<1100)await sleep(1100-(Date.now()-lastSent));
 const id=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
 const options=await bounded(magpie.options.get())||{};
 lastSent=Date.now();await bounded(magpie.options.set({...options,bpsPanelAction:{id,at:Date.now(),provider:"bps",kind,...fields}}));
 return resultFor(id);
}
async function work(message,fn){
 if(busy||globalThis.bpsSettingsBusy)return;busy=true;globalThis.bpsResetBusy=true;$("panel").querySelectorAll("button").forEach(b=>b.disabled=true);const controls=document.getElementById("controls");if(controls)controls.disabled=true;say(message);
 try{await fn();}catch(e){say(e.message||"操作失败，请刷新核对。",true);}
 finally{busy=false;globalThis.bpsResetBusy=false;if(controls)controls.disabled=false;$("refresh").disabled=false;render();}
}
let confirmation=null;
function render(){
 $("rows").replaceChildren();
 if(!rows.length){$("rows").append(node("p","details","尚无 BPS 账号，请先在 Magpie 登录。"));return;}
 for(const row of rows){
  const box=node("div","row"),line=node("div","line"),button=node("button","",row.operation?.status==="unknown"?"核对原操作":"重置");button.type="button";
  line.append(node("span","email",row.label),node("span","count",Number.isSafeInteger(row.count)?`剩余 ${row.count} 次`:"次数未知"),button);box.append(line);
  button.disabled=busy||!!row.error||(row.operation?.status!=="unknown"&&(!Number.isSafeInteger(row.count)||row.count<1));
  const windows=(row.windows||[]).filter(w=>Number.isFinite(w.used)).map(w=>`${w.name} ${w.used}%`).join(" · ");
  if(row.error||row.warning||windows)box.append(node("div","details",row.error||row.warning||windows));
  if(row.operation?.status==="unknown")box.append(node("div","details","上次结果未确认，不会另建重置。核对时只重试原操作。"));
  button.addEventListener("click",()=>work("正在核对重置次数…",async()=>{confirmation=await request("preview",{account:row.account});say("请确认下方账号和重置操作。");}));
  if(confirmation?.account===row.account){
   const card=node("div","confirm"),r=confirmation.operation,buttons=node("div","buttons");
   const text=r.status==="unknown"?`核对 ${row.label} 的原操作：仅重试原重置卡和原请求编号，不会另选一张卡。`:`将为 ${row.label} 使用 1 次 Codex 重置机会，重置当前额度窗口。${r.until?"优先使用到期时间为 "+new Date(r.until).toLocaleString()+" 的重置卡。":""}`;
   card.append(node("p","",text));
   const cancel=node("button","","取消"),confirm=node("button","primary",r.status==="unknown"?"确认核对原操作":"确认使用 1 次");cancel.type=confirm.type="button";cancel.disabled=confirm.disabled=busy;
   cancel.addEventListener("click",()=>{confirmation=null;render();say("已取消，未发送重置请求。");});
   confirm.addEventListener("click",()=>work("正在执行，请勿重复点击…",async()=>{
    const out=await request("commit",{account:row.account,requestId:r.requestId,confirm:true});
    confirmation=null;rows=rows.map(x=>x.account===out.row.account?out.row:x);say(out.warning||out.message,out.row.operation?.status==="unknown"||!!out.warning);
   }));
   buttons.append(cancel,confirm);card.append(buttons);box.append(card);
  }
  $("rows").append(box);
 }
}
async function refresh(){await work("正在读取 BPS 账号和重置次数…",async()=>{confirmation=null;const out=await request("list");rows=out.rows||[];say("已刷新。重置仅在确认后执行。");});}
$("refresh").addEventListener("click",refresh);
try{
 if(!globalThis.magpie?.options)throw new Error("请从 Magpie 的 BPS 供应商详情页打开此面板。");
 await bounded(magpie.ready);
 if(magpie.context?.provider?.id&&magpie.context.provider.id!=="bps"){$("panel").hidden=true;return;}
 const section=$("section"),tab=$("tab"),connectionTab=document.getElementById("connection-tab"),connection=document.getElementById("connection-section");let loaded=false;
 if(section&&tab&&connectionTab&&connection){
  function select(reset){
   section.hidden=!reset;connection.hidden=reset;tab.setAttribute("aria-selected",String(reset));connectionTab.setAttribute("aria-selected",String(!reset));tab.tabIndex=reset?0:-1;connectionTab.tabIndex=reset?-1:0;
   if(reset&&!loaded&&!globalThis.bpsSettingsBusy){loaded=true;void refresh();}
  }
  tab.addEventListener("click",()=>select(true));connectionTab.addEventListener("click",()=>select(false));
  for(const button of [tab,connectionTab])button.addEventListener("keydown",e=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();const reset=e.key==="End"||(e.key!=="Home"&&button===connectionTab);select(reset);(reset?tab:connectionTab).focus();}});
  $("refresh").disabled=false;
 }
 else await refresh();
}catch(e){say(e.message,true);}
})();
