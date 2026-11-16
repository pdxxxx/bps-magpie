import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFetch} from '../src/provider.mjs';
import {promptRoutingKey} from '../src/state.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,sse} from './helpers.mjs';

test('explicit prompt routing is stable without a session, while history stays isolated',async()=>{
 const wire=[];const fetch=makeFetch(async()=>auth(),{current:async f=>f()},{},{fetchImpl:async(_u,i)=>{wire.push(JSON.parse(i.body));return sse();}});
 const send=extra=>fetch(BASE_URL+'/responses',{body:JSON.stringify({model:'gpt-6-astra',input:'probe',prompt_cache_key:'stable',...extra})});
 assert.equal((await send({})).status,200);assert.equal((await send({})).status,200);
 assert.equal(wire[0].prompt_cache_key,wire[1].prompt_cache_key);assert.notEqual(wire[0].metadata.task_id,wire[1].metadata.task_id);
 assert.equal((await send({previous_response_id:'resp_test'})).status,400);assert.equal(wire.length,2);
});

test('routing keys bind to account, workspace, model and caller key without exposing identity',()=>{
 const source={model:'a',prompt_cache_key:'PRIVATE_KEY'};const key=promptRoutingKey(auth(),source);
 assert.match(key,/^bps-[a-f0-9]{32}$/);assert.doesNotMatch(key,/PRIVATE|workspace/);
 assert.notEqual(key,promptRoutingKey({...auth(),workspaceId:'b'},source));assert.notEqual(key,promptRoutingKey({...auth(),uid:'b'},source));
 assert.notEqual(key,promptRoutingKey(auth(),{...source,model:'b'}));assert.notEqual(key,promptRoutingKey(auth(),{...source,prompt_cache_key:'b'}));
 assert.equal(promptRoutingKey(auth(),{model:'a'}),undefined);
});
