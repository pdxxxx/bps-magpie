import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,sse,completed,tool,toolDeclaration} from './helpers.mjs';

test('a selected-tool presentation never narrows the catalog saved for a later auto turn',async()=>{
 const wires=[];const other={type:'function',name:'other',parameters:{type:'object',properties:{}}};
 const fetch=makeFetch(async()=>auth(),{current:async f=>f()},{},{fetchImpl:async(_url,init)=>{wires.push(JSON.parse(init.body));return wires.length===1?sse([completed([tool()])]):sse();}});
 const send=body=>fetch(BASE_URL+'/responses',{headers:{'x-bps-session':'catalog-continuation'},body:JSON.stringify({model:'gpt-6-astra',...body})});
 const first=await send({input:'Use echo',tools:[toolDeclaration,other],tool_choice:{type:'function',name:'echo'}});
 assert.equal(first.status,200);const reply=await first.json();
 const next=await send({input:[{type:'function_call_output',call_id:reply.output[0].call_id,output:'done'}],previous_response_id:reply.id,tool_choice:'auto'});
 assert.equal(next.status,200);
 const prompt=wire=>wire.input.filter(x=>x.role==='developer').flatMap(x=>x.content).map(x=>x.text).join('\n');
 assert.match(prompt(wires[0]),/Client tool "echo"/);assert.doesNotMatch(prompt(wires[0]),/Client tool "other"/);
 assert.match(prompt(wires[1]),/Client tool "echo"/);assert.match(prompt(wires[1]),/Client tool "other"/);
});
