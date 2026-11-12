import {test} from 'node:test';
import assert from 'node:assert/strict';
import {session} from '../lib/session.js';
import {createHash,createHmac} from 'node:crypto';
const env={FAMILY_USER:'test-family',FAMILY_PASS:'test-password',HOME_UPLOAD_URL:'https://home.example/v1/upload',HOME_UPLOAD_SECRET:'test-home-secret-with-more-than-32-characters'};
async function handler(name){
  let module;try{module=await import(`../functions/${name}.js`);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
  assert.equal(typeof module?.onRequest,'function',`Private ${name} endpoint is not implemented`);
  return module.onRequest;
}
async function request(path,authenticated=true){return new Request('https://family.example'+path,{headers:authenticated?{Cookie:`family_session=${await session(env)}`}:{}});}
test('file listing requires login before contacting the home computer',async(t)=>{
  const list=await handler('files');let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Unexpected backend call');});
  assert.equal((await list({env,request:await request('/files',false)})).status,401);
  assert.equal(calls,0);
});

test('signed home metadata is verified and returned only to a logged-in browser',async(t)=>{
  const list=await handler('files');let calls=0;
  const payload={files:[{id:Buffer.from('notes.txt').toString('base64url'),name:'notes.txt',bytes:5,modified:'2026-11-11T15:00:00.000Z'}],nextCursor:null};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
    const u=new URL(url);assert.equal(u.origin,'https://home.example');assert.equal(u.pathname,'/v1/files');
    const h=new Headers(options.headers),id=h.get('x-family-id'),stamp=h.get('x-family-timestamp');
    const expected=createHmac('sha256',env.HOME_UPLOAD_SECRET).update(['family-read-v1','GET',u.pathname+u.search,id,stamp].join('\n')).digest('hex');
    assert.equal(h.get('x-family-signature'),expected);
    const body=JSON.stringify(payload),digest=createHash('sha256').update(body).digest('hex');
    const signature=createHmac('sha256',env.HOME_UPLOAD_SECRET).update(['family-list-v1',id,digest].join('\n')).digest('hex');
    return new Response(body,{headers:{'Content-Type':'application/json','x-family-response-signature':signature}});
  });
  const response=await list({env,request:await request('/files')});
  assert.equal(response.status,200);assert.equal(calls,1);
  assert.deepEqual(await response.json(),payload);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('download requires a signed matching home response and returns attachment bytes',async(t)=>{
  const download=await handler('file'),fileId=Buffer.from('clip.wav').toString('base64url');
  const data=Buffer.from('file bytes'),name=encodeURIComponent('clip.wav'),modified='2026-11-11T15:00:00.000Z';
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const u=new URL(url);assert.equal(u.pathname,'/v1/file');assert.equal(u.searchParams.get('id'),fileId);assert.equal(options.redirect,'manual');
    const h=new Headers(options.headers),id=h.get('x-family-id');
    const signature=createHmac('sha256',env.HOME_UPLOAD_SECRET).update(['family-file-v1',id,fileId,name,String(data.length),modified].join('\n')).digest('hex');
    return new Response(data,{headers:{'Content-Length':String(data.length),'x-family-file-id':fileId,'x-family-file-name':name,'x-family-file-size':String(data.length),'x-family-file-modified':modified,'x-family-response-signature':signature}});
  });
  const response=await download({env,request:await request('/file?id='+fileId)});
  assert.equal(response.status,200);assert.equal(await response.text(),data.toString());
  assert.match(response.headers.get('Content-Disposition'),/^attachment;/);
  assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('private download rejects missing login and unsafe IDs before contacting home',async(t)=>{
  const download=await handler('file');let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Unexpected request');});
  const safeId=Buffer.from('notes.txt').toString('base64url');
  assert.equal((await download({env,request:await request('/file?id='+safeId,false)})).status,401);
  for(const name of ['../outside.txt','sub/file.txt','sub\\file.txt','C:secret.txt','.storage-id','CON','trailing.']){
    const id=Buffer.from(name).toString('base64url');
    assert.equal((await download({env,request:await request('/file?id='+id)})).status,400,name);
  }
  assert.equal(calls,0);
});

test('forged or oversized home metadata never reaches the browser',async(t)=>{
  const list=await handler('files');
  const forged={files:[{id:Buffer.from('private.txt').toString('base64url'),name:'private-name-must-not-leak',bytes:1,modified:'2026-11-11T15:00:00Z'}],nextCursor:null};
  t.mock.method(globalThis,'fetch',async()=>Response.json(forged,{headers:{'x-family-response-signature':'0'.repeat(64)}}));
  let response=await list({env,request:await request('/files')});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-name-must-not-leak/);
  t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(256*1024+1)));
  response=await list({env,request:await request('/files')});assert.equal(response.status,503);
});

test('home offline returns an error rather than an empty collection',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Simulated offline');});
  const list=await handler('files'),download=await handler('file');
  const listing=await list({env,request:await request('/files')});
  assert.equal(listing.status,503);assert.match(await listing.text(),/unavailable/);
  assert.equal((await download({env,request:await request('/file?id='+Buffer.from('notes.txt').toString('base64url'))})).status,503);
});

test('private home reads explicitly bypass Cloudflare caching',async(t)=>{
  const list=await handler('files');let cache;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{cache=options.cache;return new Response('',{status:503});});
  await list({env,request:await request('/files')});assert.equal(cache,'no-store');
});
