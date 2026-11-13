import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createMemberPassword} from '../lib/member-password.js';
import {onRequest as auth} from '../functions/auth.js';
import {authenticated, session} from '../lib/session.js';
globalThis.crypto ||= webcrypto;
const owner = {FAMILY_USER:'test-owner', FAMILY_PASS:'fixture-owner', SESSION_SECRET:'fixture-session-independent'};
const names = ['Charlie', 'Abigail', 'Olivia', 'Katie'];
const pepper = 'a7'.repeat(32);
async function fixture() {
 const users = Object.fromEntries(await Promise.all(names.map(async (name, i) => [name, await createMemberPassword(name, `fixture-member-${i}`, pepper)])));
 return {...owner, FAMILY_PASSWORD_KEY:pepper, FAMILY_USERS_JSON:JSON.stringify(users)};
}
function login(env, username, password, origin = 'https://family.example') {
 const form = new FormData(); form.set('username', username); form.set('password', password);
 return auth({env, request:new Request('https://family.example/auth', {method:'POST', headers:{Origin:origin}, body:form})});
}
test('malformed optional member configuration disables login and session authorization', async () => {
 const valid = await fixture();
 const users = JSON.parse(valid.FAMILY_USERS_JSON);
 const existing = `family_session=${await session(owner)}`;
 const malformed = [
  {...valid, FAMILY_USERS_JSON:'not-json'}, {...valid, FAMILY_USERS_JSON:'null'},
  {...valid, FAMILY_USERS_JSON:'[]'}, {...valid, FAMILY_USERS_JSON:'{}'},
  {...valid, FAMILY_USERS_JSON:undefined}, {...valid, FAMILY_PASSWORD_KEY:undefined},
  {...valid, FAMILY_PASSWORD_KEY:'short'}, {...valid, FAMILY_PASSWORD_KEY:'z'.repeat(64)},
  {...valid, SESSION_SECRET:pepper}, {...valid, HOME_UPLOAD_SECRET:pepper}, {...valid, FAMILY_PASS:pepper},
  {...valid, FAMILY_USER:'Charlie'},
  ...[
   {version:2}, {username:'Katie'}, {iterations:100001}, {salt:'00'}, {proof:'00'},
   {proof:'A'.repeat(64)}, {extra:true}, {iterations:'100000'},
  ].map(change => ({...valid, FAMILY_USERS_JSON:JSON.stringify({...users, Charlie:{...users.Charlie, ...change}})})),
  {...valid, FAMILY_USERS_JSON:JSON.stringify({...users, Eve:users.Charlie})},
 ];
 for (const [i, env] of malformed.entries()) {
  assert.equal((await login(env, env.FAMILY_USER, env.FAMILY_PASS)).status, 503, `config ${i}`);
  assert.equal((await login(env, 'Charlie', 'fixture-member-0')).status, 503, `member config ${i}`);
  assert.equal(await authenticated(cookieRequest(existing), env), false, `session config ${i}`);
 }
});
const cookieRequest = cookie => new Request('https://family.example/auth', {headers:{Cookie:cookie}});
test('all four members have separate passwords and unchanged shared sessions', async () => {
 const env = await fixture();
 for (const [i, name] of names.entries()) {
  const result = await login(env, name, `fixture-member-${i}`);
  assert.equal(result.status, 200, name);
  const cookie = result.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(await authenticated(cookieRequest(cookie), env), true);
  assert.equal((await auth({env, request:cookieRequest(cookie)})).status, 200);
  for (const j of names.keys()) if (i !== j) assert.equal((await login(env, name, `fixture-member-${j}`)).status, 401);
 }
 assert.equal((await login(env, 'charlie', 'fixture-member-0')).status, 401, 'Names are exact case');
 assert.equal((await login(env, 'Unknown', 'fixture-member-0')).status, 401);
 assert.equal((await login(env, 'Charlie', 'fixture-member-0', 'https://evil.example')).status, 403);
});
