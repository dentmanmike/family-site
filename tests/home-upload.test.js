import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequest as upload} from '../functions/upload.js';
import {session} from '../lib/session.js';
import {createHmac, createHash} from 'node:crypto';

const env = {FAMILY_USER:'test-family',FAMILY_PASS:'test-password'};
async function uploadRequest(environment=env, data='home-only test') {
  const form = new FormData();
  form.set('file', new File([data], 'family-test.txt'));
  const cookie = `family_session=${await session(environment)}`;
  return new Request('https://family.example/upload', {method:'POST',headers:{Origin:'https://family.example',Cookie:cookie},body:form});
}

test('home-only uploads never fall back to cloud object storage', async () => {
  let cloudWrites=0;
  const settings={...env,FAMILY_BUCKET:{put:async()=>{cloudWrites++;}}};
  const response=await upload({env:settings,request:await uploadRequest(settings)});
  assert.equal(response.status,503,'missing home connection must fail closed');
  assert.equal(cloudWrites,0,'files must not be retained in Cloudflare');
});

test('authenticated upload forwards signed bytes and accepts only a persisted home receipt', async (t) => {
  const secret='testing-only-home-secret-with-32-characters';
  const settings={...env,HOME_UPLOAD_URL:'https://home-upload.family.example/v1/upload',HOME_UPLOAD_SECRET:secret};
  let forwards=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    forwards++;
    assert.equal(String(url),settings.HOME_UPLOAD_URL);
    assert.equal(options.method,'POST');
    const h=new Headers(options.headers);
    const id=h.get('x-family-id'), timestamp=h.get('x-family-timestamp');
    const filename=h.get('x-family-filename'), size=h.get('x-family-size'), sha=h.get('x-family-sha256');
    const data=Buffer.from(options.body);
    assert.equal(data.toString(),'home-only test');
    assert.equal(sha,createHash('sha256').update(data).digest('hex'));
    const canonical=['family-upload-v1','POST','/v1/upload',id,timestamp,filename,size,sha].join('\n');
    assert.equal(h.get('x-family-signature'),createHmac('sha256',secret).update(canonical).digest('hex'));
    const name=`${id}-${filename}`;
    const signature=createHmac('sha256',secret).update(['family-receipt-v1',id,name,size,sha].join('\n')).digest('hex');
    return Response.json({stored:true,id,name,bytes:Number(size),sha256:sha,signature});
  });
  const response=await upload({env:settings,request:await uploadRequest(settings)});
  assert.equal(response.status,200);
  assert.equal(forwards,1);
  assert.equal((await response.json()).stored,true);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('multipart bodies exceeding the limit are rejected even without Content-Length', async (t) => {
  const settings={...env,HOME_UPLOAD_URL:'https://home-upload.family.example/v1/upload',HOME_UPLOAD_SECRET:'testing-only-home-secret-with-32-characters'};
  let forwards=0;
  t.mock.method(globalThis,'fetch',async()=>{forwards++;return Response.json({});});
  const form=new FormData();form.set('file',new File(['tiny'],'small.txt'));
  form.set('padding','x'.repeat(26*1024*1024+1));
  const request=new Request('https://family.example/upload',{method:'POST',headers:{Origin:'https://family.example',Cookie:`family_session=${await session(settings)}`},body:form});
  assert.equal(request.headers.get('Content-Length'),null);
  const response=await upload({env:settings,request});
  assert.equal(response.status,413);
  assert.equal(forwards,0);
});

for (const failure of ['offline','forged receipt']) {
  test(`home ${failure} never produces success or a cloud write`,async(t)=>{
    const secret='testing-only-home-secret-with-32-characters';
    let cloudWrites=0;
    const settings={...env,HOME_UPLOAD_URL:'https://home-upload.family.example/v1/upload',HOME_UPLOAD_SECRET:secret,FAMILY_BUCKET:{put:async()=>cloudWrites++}};
    t.mock.method(globalThis,'fetch',async(_url,options)=>{
      if(failure==='offline')throw new Error('Simulated unreachable home computer');
      const h=new Headers(options.headers),id=h.get('x-family-id');
      return Response.json({stored:true,id,name:`${id}-${h.get('x-family-filename')}`,bytes:Number(h.get('x-family-size')),sha256:h.get('x-family-sha256'),signature:'0'.repeat(64)});
    });
    const response=await upload({env:settings,request:await uploadRequest(settings)});
    assert.equal(response.status,503);
    assert.equal(cloudWrites,0);
    assert.doesNotMatch(await response.text(),new RegExp(secret));
  });
}

test('authenticated failures expose only a safe upstream status code',async(t)=>{
  const settings={...env,HOME_UPLOAD_URL:'https://home-upload.family.example/v1/upload',HOME_UPLOAD_SECRET:'testing-only-home-secret-with-32-characters'};
  t.mock.method(globalThis,'fetch',async()=>new Response('upstream diagnostic details',{status:403}));
  const response=await upload({env:settings,request:await uploadRequest(settings)});
  assert.equal(response.status,503);
  assert.equal(response.headers.get('X-Home-Status'),'upstream-http-403');
  assert.doesNotMatch(await response.text(),/upstream diagnostic details/);
});
