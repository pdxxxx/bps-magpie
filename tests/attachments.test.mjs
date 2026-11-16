import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttachmentStore} from '../src/attachments.mjs';
import {makeFetch} from '../src/provider.mjs';
import {BASE_URL} from '../src/constants.mjs';
import {auth,sse} from './helpers.mjs';
const digest='a'.repeat(64),other='b'.repeat(64);
const manager={current:async f=>f()};
const tick=()=>new Promise(r=>setImmediate(r));
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=';
const body={model:'gpt-6-astra',input:[{role:'user',content:[{type:'input_text',text:'probe'},{type:'input_image',image_url:'data:image/png;base64,'+image}]}]};

test('attachment IDs are bounded, expire, and remain account isolated',async()=>{
 let now=0,calls=0;const store=createAttachmentStore({maxEntries:2,ttlMs:10,now:()=>now});const upload=async()=>`file-${++calls}`;
 assert.equal(await store.use('a',digest,undefined,upload),'file-1');
 assert.equal(await store.use('a',digest,undefined,upload),'file-1');
 assert.equal(await store.use('b',digest,undefined,upload),'file-2');
 assert.equal(await store.use('a',other,undefined,upload),'file-3');
 assert.equal(store.diagnostics().entries,2);assert.equal(await store.use('a',digest,undefined,upload),'file-4');
 now=11;assert.equal(await store.use('a',digest,undefined,upload),'file-5');
 store.forgetOwner('a');assert.equal(store.diagnostics().entries,0);
});

test('shared upload survives one waiter cancellation and aborts when all leave',async()=>{
 const store=createAttachmentStore();let release,uploadSignal,calls=0;
 const upload=signal=>{calls++;uploadSignal=signal;return new Promise(r=>{release=r;});};
 const a=new AbortController(),b=new AbortController();
 const first=store.use('same',digest,a.signal,upload);const second=store.use('same',digest,b.signal,upload);await tick();
 a.abort(new Error('cancel first'));await assert.rejects(first,/cancel first/);assert.equal(uploadSignal.aborted,false);release('file-shared');assert.equal(await second,'file-shared');assert.equal(calls,1);
 const c=new AbortController();const pending=store.use('same',other,c.signal,upload);await tick();c.abort(new Error('cancel all'));await assert.rejects(pending,/cancel all/);assert.equal(uploadSignal.aborted,true);release('file-late');await tick();assert.equal(store.diagnostics().entries,1);assert.equal(store.diagnostics().active,0);
});

test('failures, invalid IDs and invalidation never populate the cache',async()=>{
 const store=createAttachmentStore();let calls=0;
 const fail=async()=>{calls++;throw Error('upload failed');};await assert.rejects(store.use('a',digest,undefined,fail));await assert.rejects(store.use('a',digest,undefined,fail));assert.equal(calls,2);
 await assert.rejects(store.use('a',digest,undefined,async()=>'invalid'),/invalid attachment/);
 let release;const pending=store.use('a',digest,undefined,()=>new Promise(r=>{release=r;}));await tick();store.forgetOwner('a');release('file-completed');assert.equal(await pending,'file-completed');assert.equal(store.diagnostics().entries,0);
});

test('abandoned network work continues to count against admission until it ends',async()=>{
 const store=createAttachmentStore({maxPending:1});let release;const c=new AbortController();
 const first=store.use('a',digest,c.signal,()=>new Promise(r=>{release=r;}));await tick();c.abort();await assert.rejects(first);
 await assert.rejects(store.use('a',other,undefined,async()=>'file-next'),/capacity/);
 release('file-discarded');await tick();assert.equal(await store.use('a',other,undefined,async()=>'file-next'),'file-next');
});

test('same image across Go processes is uploaded once; rejection evicts without replay',async()=>{
 let uploads=0,inferences=0,rejectNext=false;const store=createAttachmentStore();
 const fetch=makeFetch(async()=>auth(),manager,{}, {attachments:store,fetchImpl:async url=>{
  if(url.endsWith('/attachments'))return Response.json({openai_file_id:'file-'+(++uploads)});
  inferences++;if(rejectNext){rejectNext=false;return new Response('denied',{status:403});}return sse();
 }});
 const send=thread=>fetch(BASE_URL+'/responses',{headers:{'x-bps-session':thread},body:JSON.stringify(body)});
 assert.equal((await send('a')).status,200);assert.equal((await send('b')).status,200);assert.equal(uploads,1);
 rejectNext=true;assert.equal((await send('c')).status,403);assert.equal(inferences,3);assert.equal(uploads,1);
 assert.equal((await send('d')).status,200);assert.equal(uploads,2);
});

test('shared host store never reuses file IDs across accounts or workspaces',async()=>{
 const store=createAttachmentStore();let uploads=0;
 for(const current of [auth(),{...auth(),workspaceId:'workspace-b'},{...auth(),uid:'other-user'},auth()]){
  const fetch=makeFetch(async()=>current,manager,{}, {attachments:store,fetchImpl:async url=>url.endsWith('/attachments')?Response.json({openai_file_id:'file-'+(++uploads)}):sse()});
  assert.equal((await fetch(BASE_URL+'/responses',{body:JSON.stringify(body)})).status,200);
 }
 assert.equal(uploads,3);
});
