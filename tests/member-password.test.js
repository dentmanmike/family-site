import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto, pbkdf2Sync, createHmac} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const pepper = 'a7'.repeat(32); // Public test fixture, not a deployment credential.
async function implementation() {
 let module;
 try { module = await import('../lib/member-password.js'); }
 catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
 assert.equal(typeof module?.createMemberPassword, 'function', 'Member password builder is not implemented');
 return module;
}
test('builder creates independently salted username-bound PBKDF2/HMAC proofs', async () => {
 const {createMemberPassword} = await implementation();
 const a = await createMemberPassword('Charlie', 'fixture-password', pepper);
 const b = await createMemberPassword('Charlie', 'fixture-password', pepper);
 assert.equal(a.version, 1);
 assert.equal(a.username, 'Charlie');
 assert.equal(a.iterations, 100000);
 assert.match(a.salt, /^[0-9a-f]{32}$/);
 assert.match(a.proof, /^[0-9a-f]{64}$/);
 assert.notEqual(a.salt, b.salt);
 assert.notEqual(a.proof, b.proof);
 const derived = pbkdf2Sync('fixture-password', Buffer.from(a.salt, 'hex'), 100000, 32, 'sha256');
 const expected = createHmac('sha256', Buffer.from(pepper, 'hex')).update('family-member-password-v1\nCharlie\n').update(derived).digest('hex');
 assert.equal(a.proof, expected);
 assert.equal(JSON.stringify(a).includes('fixture-password'), false);
});
