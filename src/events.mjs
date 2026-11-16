const terminalTypes=new Set(["response.completed","response.failed","response.incomplete","response.cancelled","error"]);

// Observes only complete terminal frames. Original bytes pass through unchanged.
export function terminalObserver(onTerminal){
  const decoder=new TextDecoder();let buffer="";
  function consume(){
    buffer=buffer.replace(/\r\n/g,"\n");let end;
    while((end=buffer.indexOf("\n\n"))>=0){
      const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
      const raw=block.split("\n").filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trimStart()).join("\n");
      if(!raw||raw==="[DONE]")continue;
      let event;try{event=JSON.parse(raw);}catch{throw new Error("Malformed Responses event from BPS bridge");}
      if(terminalTypes.has(event.type))onTerminal(event,raw);
    }
    if(buffer.length>32*1024*1024)throw new Error("Responses event exceeds 32 MiB");
  }
  return {push(bytes){buffer+=decoder.decode(bytes,{stream:true});consume();},finish(){buffer+=decoder.decode();if(buffer.trim())buffer+="\n\n";consume();}};
}

export function observeResponseStream(stream,onTerminal){
  const reader=stream.getReader();const observer=terminalObserver(onTerminal);
  return new ReadableStream({
    async pull(controller){try{const part=await reader.read();if(part.done){observer.finish();controller.close();}else{observer.push(part.value);controller.enqueue(part.value);}}catch(error){controller.error(error);await reader.cancel().catch(()=>{});}},
    cancel(reason){return reader.cancel(reason);}
  });
}
