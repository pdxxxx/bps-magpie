import {terminalObserver} from './events.mjs';

// Opt-in, request-local observation. Only numeric timings/counts and fixed
// outcomes leave this module; no request/response contents or identifiers do.
export function createRequestMetrics(onMetrics,now=()=>performance.now()) {
  if(typeof onMetrics!=='function')return null;
  const began=now(),active=new Map(),data={upload_ms:0,upload_count:0,repair_ms:0,repair_count:0};
  let finished=false,terminalOutcome;
  const elapsed=()=>Math.max(0,now()-began);
  function mark(name){if(data[name]===undefined)data[name]=elapsed();}
  function start(name){active.set(name,now());}
  function end(name){if(active.has(name)){data[name]=(data[name]||0)+Math.max(0,now()-active.get(name));active.delete(name);}}
  function count(name){data[name]=(data[name]||0)+1;}
  function event(side,e){
    count(side+'_events');data[side+'_last_event_ms']=elapsed();
    if(side==='upstream'&&e.type==='response.created'&&typeof e.response?.parallel_tool_calls==='boolean')data.upstream_parallel_enabled=Number(e.response.parallel_tool_calls);
    mark(side==='upstream'?'first_upstream_event_ms':'first_client_event_ms');
    if(e.type==='response.reasoning_summary_text.delta')mark(side+'_first_reasoning_ms');
    if(e.type==='response.output_text.delta')mark(side+'_first_text_ms');
    if(e.type==='response.function_call_arguments.delta'||e.type==='response.custom_tool_call_input.delta')mark(side+'_first_tool_ms');
    if(side==='client'&&['response.completed','response.incomplete','response.failed','response.cancelled','error'].includes(e.type)){
      mark('validated_terminal_ms');
      terminalOutcome=e.type==='error'?'failed':e.type.slice(9);
      const usage=e.response?.usage||e.usage;
      const values={input_tokens:usage?.input_tokens,cached_tokens:usage?.input_tokens_details?.cached_tokens,output_tokens:usage?.output_tokens,reasoning_tokens:usage?.output_tokens_details?.reasoning_tokens};
      for(const [key,value] of Object.entries(values))if(Number.isFinite(value)&&value>=0)data[key]=value;
      if(Array.isArray(e.response?.output))data.tool_calls=e.response.output.filter(i=>i?.type==='function_call'||i?.type==='custom_tool_call').length;
    }
    if(side==='upstream'&&e.type==='response.completed')mark('upstream_terminal_ms');
  }
  function observer(side){
    let disabled=false;
    const parser=terminalObserver(()=>{},e=>event(side,e));
    return {push(bytes){data[side+'_bytes']=(data[side+'_bytes']||0)+bytes.byteLength;if(disabled)return;try{parser.push(bytes);}catch{disabled=true;count('observer_errors');}}};
  }
  function finish(outcome){
    if(finished)return;finished=true;
    for(const key of active.keys())end(key);
    data.total_ms=elapsed();data.outcome=outcome||terminalOutcome||'incomplete';
    if(data.prepare_ms!==undefined)data.prepare_local_ms=Math.max(0,data.prepare_ms-data.upload_ms);
    const result=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,typeof v==='number'?Math.round(v*100)/100:v]));
    try{Promise.resolve(onMetrics(Object.freeze(result))).catch(()=>{});}catch{}
  }
  return {mark,start,end,count,observer,finish};
}
