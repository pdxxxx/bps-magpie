import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,sse,completed,tool,toolDeclaration} from './helpers.mjs';

test('native instruction/catalog echoes are omitted without losing terminal state or usage',async()=>{
 for(const stream of [false,true]){
  const terminal=completed([tool()]);Object.assign(terminal.response,{instructions:'NATIVE_PRIVATE_RULES',tools:[{name:'NATIVE_ONLY_TOOL'}],opaque_extension:{safe:'preserved'}});
  const fetch=makeFetch(async()=>auth(),{current:async f=>f()},{},{fetchImpl:async()=>sse([{type:'response.created',response:{id:'resp_test',status:'in_progress',instructions:'NATIVE_PRIVATE_RULES',tools:[{name:'NATIVE_ONLY_TOOL'}]}},terminal])});
  const response=await fetch(BASE_URL+'/responses',{body:JSON.stringify({model:'gpt-6-astra',input:'probe',stream,tools:[toolDeclaration]})});const raw=await response.text();
  assert.doesNotMatch(raw,/NATIVE_PRIVATE_RULES|NATIVE_ONLY_TOOL/);assert.match(raw,/preserved/);assert.match(raw,/input_tokens/);assert.match(raw,/call_native/);assert.match(raw,/"name":"echo"/);
 }
});
