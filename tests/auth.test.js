import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {onRequest as auth} from '../functions/auth.js';
import {onRequest as upload} from '../functions/upload.js';
import {authenticated} from '../lib/session.js';
globalThis.crypto ||= webcrypto;
const env = {FAMILY_USER:'test-family',FAMILY_PASS:'test-password'};
const request = (cookie) => new Request('https://family.example/auth',{headers:{Cookie:cookie}});
test('login signs a verifiable cookie; forgery and changed credentials fail',async()=>{
 const form = new FormData(); form.set('username',env.FAMILY_USER);form.set('password',env.FAMILY_PASS);
 const r = await auth({env,request:new Request('https://family.example/auth',{method:'POST',headers:{Origin:'https://family.example'},body:form})});
 assert.equal(r.status,200); const cookie = r.headers.get('Set-Cookie').split(';')[0];
 assert.equal(await authenticated(request(cookie),env),true);
 assert.equal(await authenticated(request('family_session=1'),env),false);
 assert.equal(await authenticated(request(cookie.slice(0,-1)+'x'),env),false);
 assert.equal(await authenticated(request(cookie),{...env,FAMILY_PASS:'changed'}),false);
 assert.equal(await authenticated(request('family_session=1'),{}),false);
});
test('cross-origin login and forged uploads fail before storage',async()=>{
 assert.equal((await auth({env,request:new Request('https://family.example/auth',{method:'POST',headers:{Origin:'https://evil.example'}})})).status,403);
 assert.equal((await upload({env,request:new Request('https://family.example/upload',{method:'POST',headers:{Origin:'https://family.example',Cookie:'family_session=1'}})})).status,401);
});
test('missing settings fail closed and logout removes the session',async()=>{
 assert.equal((await auth({env:{},request:new Request('https://family.example/auth',{method:'POST',headers:{Origin:'https://family.example'}})})).status,503);
 const r = await auth({env,request:new Request('https://family.example/auth?logout=1',{method:'POST',headers:{Origin:'https://family.example'}})});
 assert.match(r.headers.get('Set-Cookie'),/Max-Age=0/);
});
