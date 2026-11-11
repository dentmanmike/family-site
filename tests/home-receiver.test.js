import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const MAX = 25 * 1024 * 1024;
const secret = 'independent-test-secret-at-least-32-characters';
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for filesystem state');
}

function startPartial(f, t, body) {
  const headers = signed(body);
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const req = http.request({ host: '127.0.0.1', port: f.server.address().port, path: '/v1/upload', method: 'POST', headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', () => resolve({ status: 0 }));
  req.write(body.subarray(0, 1));
  t.after(() => req.destroy());
  return { req, response, headers };
}
function signed(body, overrides = {}) {
  const m = { id: randomUUID(), timestamp: String(Math.floor(Date.now() / 1000)), filename: 'photo.jpg', size: String(body.length), sha256: createHash('sha256').update(body).digest('hex'), ...overrides };
  const canonical = ['family-upload-v1', 'POST', '/v1/upload', m.id, m.timestamp, m.filename, String(Number(m.size)), m.sha256].join('\n');
  return Object.fromEntries(Object.entries({ ...m, signature: createHmac('sha256', secret).update(canonical).digest('hex') }).map(([k,v]) => [`x-family-${k}`, v]));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'family-receiver-'));
  const storageRoot = path.join(root, 'disk');
  await mkdir(storageRoot);
  const config = { secret, storageRoot, storageId: randomUUID(), dataRoot: path.join(storageRoot, 'Uploads') };
  await writeFile(path.join(storageRoot, '.storage-id'), config.storageId + '\n');
  const { createUploadServer } = await import('../home/server.mjs');
  const server = createUploadServer(config);
  assert.equal(server.listening, false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = (headers = {}, body = Buffer.alloc(0), route = '/v1/upload', method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
  return { root, config, server, request };
}

test('rejects unauthorized, expired, tampered and malformed metadata before disk writes', async t => {
  const f = await fixture(t);
  const body = Buffer.from('private photo');
  const cases = [
    {},
    { ...signed(body), 'x-family-signature': '0'.repeat(64) },
    signed(body, { timestamp: String(Math.floor(Date.now() / 1000) - 121) }),
    signed(body, { timestamp: String(Math.floor(Date.now() / 1000) + 130) }),
    { ...signed(body), 'x-family-filename': 'changed.jpg' },
    signed(body, { id: 'NOT-A-UUID' }),
    signed(body, { id: '00000000-0000-1000-8000-000000000000' }),
    signed(body, { filename: '../outside' }),
    signed(body, { filename: '..' }),
    signed(body, { filename: '.' }),
    signed(body, { filename: 'x'.repeat(151) }),
    signed(body, { size: '-1' }),
    signed(body, { size: '1e1' }),
    signed(body, { timestamp: '1e10' }),
    signed(body, { sha256: 'A'.repeat(64) }),
    { ...signed(body), 'x-family-id': [randomUUID(), randomUUID()] },
  ];
  for (const headers of cases) {
    const res = await f.request(headers, body);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(headers)}: ${res.status}`);
  }
  assert.deepEqual(await readdir(f.config.storageRoot), ['.storage-id']);
});

test('rejects oversized signed declaration before creating upload directories', async t => {
  const f = await fixture(t);
  const res = await f.request(signed(Buffer.alloc(0), { size: String(MAX + 1) }));
  assert.equal(res.status, 413);
  assert.deepEqual(await readdir(f.config.storageRoot), ['.storage-id']);
});

test('never publishes digest mismatches or streams with wrong signed size', async t => {
  const f = await fixture(t);
  const body = Buffer.from('actual data');
  for (const override of [{ sha256: '0'.repeat(64) }, { size: '2' }, { size: '100' }]) {
    const res = await f.request(signed(body, override), body);
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(await readdir(f.config.dataRoot), ['.incoming']);
    assert.deepEqual(await readdir(path.join(f.config.dataRoot, '.incoming')), []);
  }
});

test('checks marker for every upload and never recreates a missing storage root', async t => {
  const f = await fixture(t);
  const body = Buffer.from('disk check');
  await writeFile(path.join(f.config.storageRoot, '.storage-id'), randomUUID());
  assert.equal((await f.request(signed(body), body)).status, 503);
  assert.deepEqual(await readdir(f.config.storageRoot), ['.storage-id']);
  await writeFile(path.join(f.config.storageRoot, '.storage-id'), f.config.storageId);
  assert.equal((await f.request(signed(body), body)).status, 201);
  await rm(path.join(f.config.storageRoot, '.storage-id'));
  assert.equal((await f.request(signed(body), body)).status, 503);
  await rename(f.config.storageRoot, path.join(f.root, 'disconnected'));
  assert.equal((await f.request(signed(body), body)).status, 503);
  assert.deepEqual(await readdir(f.root), ['disconnected']);
});

test('rejects symlinked storage root, upload directory, incoming directory and marker', async t => {
  for (const component of ['root', 'data', 'incoming', 'marker']) {
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    if (component === 'root') {
      await rename(f.config.storageRoot, path.join(f.root, 'actual'));
      await symlink(path.join(f.root, 'actual'), f.config.storageRoot, 'junction');
    } else if (component === 'data') {
      await symlink(outside, f.config.dataRoot, 'junction');
    } else if (component === 'incoming') {
      await mkdir(f.config.dataRoot);
      await symlink(outside, path.join(f.config.dataRoot, '.incoming'), 'junction');
    } else {
      await writeFile(path.join(outside, 'marker'), f.config.storageId);
      await rm(path.join(f.config.storageRoot, '.storage-id'));
      await symlink(path.join(outside, 'marker'), path.join(f.config.storageRoot, '.storage-id'));
    }
    const body = Buffer.from('must stay private');
    assert.equal((await f.request(signed(body), body)).status, 503, component);
    assert.deepEqual(await readdir(outside), component === 'marker' ? ['marker'] : []);
    const health = await f.request({}, Buffer.alloc(0), '/v1/health', 'GET');
    assert.equal(health.status, 503, `${component}: unhealthy storage must not report ready`);
  }
});

test('rejects unsafe configuration synchronously', async t => {
  const f = await fixture(t);
  const { createUploadServer } = await import('../home/server.mjs');
  for (const override of [ { secret: 'short' }, { storageRoot: 'relative' }, { dataRoot: f.root }, { dataRoot: f.config.storageRoot }, { storageId: 'invalid' }, { dataRoot: 'relative' } ]) {
    assert.throws(() => createUploadServer({ ...f.config, ...override }));
  }
});

test('rejects replayed IDs even with a different filename', async t => {
  const f = await fixture(t);
  const body = Buffer.from('original');
  const headers = signed(body);
  assert.equal((await f.request(headers, body)).status, 201);
  assert.equal((await f.request(headers, body)).status, 409);
  assert.equal((await f.request(signed(body, { id: headers['x-family-id'], filename: 'different.jpg' }), body)).status, 409);
  assert.deepEqual(await readFile(path.join(f.config.dataRoot, `${headers['x-family-id']}-photo.jpg`)), body);
  assert.equal((await readdir(f.config.dataRoot)).length, 2);
});

test('atomic publish never overwrites an existing final file', async t => {
  const f = await fixture(t);
  const body = Buffer.from('new');
  const headers = signed(body);
  await mkdir(f.config.dataRoot);
  const final = path.join(f.config.dataRoot, `${headers['x-family-id']}-photo.jpg`);
  await writeFile(final, 'existing');
  assert.equal((await f.request(headers, body)).status, 409);
  assert.equal(await readFile(final, 'utf8'), 'existing');
  assert.deepEqual(await readdir(path.join(f.config.dataRoot, '.incoming')), []);
});

test('limits active uploads to two and reserves in-flight replay IDs', async t => {
  const f = await fixture(t);
  const body = Buffer.from('stream body');
  const a = startPartial(f, t, body);
  const b = startPartial(f, t, body);
  await until(async () => (await readdir(path.join(f.config.dataRoot, '.incoming')).catch(() => [])).length === 2);
  assert.equal((await f.request(a.headers, body)).status, 409);
  assert.equal((await f.request(signed(body), body)).status, 429);
  a.req.end(body.subarray(1)); b.req.end(body.subarray(1));
  assert.equal((await a.response).status, 201);
  assert.equal((await b.response).status, 201);
  assert.equal((await f.request(signed(body), body)).status, 201);
});

test('health reports storage readiness without paths or creating directories; other routes are 404', async t => {
  const f = await fixture(t);
  let res = await f.request({}, Buffer.alloc(0), '/v1/health', 'GET');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true, storageReady: true });
  assert.deepEqual(await readdir(f.config.storageRoot), ['.storage-id']);
  await rm(path.join(f.config.storageRoot, '.storage-id'));
  res = await f.request({}, Buffer.alloc(0), '/v1/health', 'GET');
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.text), { ok: false, storageReady: false });
  for (const [route, method] of [['/', 'GET'], ['/v1/upload', 'GET'], ['/v1/health', 'POST'], ['/v1/upload?x=1', 'POST'], ['/Uploads/', 'GET']]) {
    assert.equal((await f.request(signed(Buffer.alloc(0)), Buffer.alloc(0), route, method)).status, 404);
  }
});

test('bounds header, request, idle and keepalive timeouts', async t => {
  const { server } = await fixture(t);
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 10000);
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 60000);
  assert.ok(server.timeout > 0 && server.timeout <= 15000);
  assert.ok(server.keepAliveTimeout > 0 && server.keepAliveTimeout <= 5000);
  assert.ok(server.maxHeadersCount > 0 && server.maxHeadersCount <= 32);
});

test('run.mjs loads private JSON config and serves real loopback HTTP on configured port', async t => {
  const f = await fixture(t);
  const port = f.server.address().port;
  await new Promise(resolve => f.server.close(resolve));
  const configFile = path.join(f.root, 'private-config.json');
  await writeFile(configFile, JSON.stringify({ ...f.config, port, host: '0.0.0.0' }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../home/run.mjs', import.meta.url)), configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  await until(() => { assert.equal(child.exitCode, null, errors); return output.includes(`127.0.0.1:${port}`); });
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, storageReady: true });
  assert.equal(output.includes(secret), false);
  assert.equal(errors, '');
});

test('partial uploads publish nothing, aborted clients are cleaned up, and storage is rechecked before publish', async t => {
  const f = await fixture(t);
  const body = Buffer.from('streamed photo');
  const a = startPartial(f, t, body);
  await until(async () => (await readdir(path.join(f.config.dataRoot, '.incoming')).catch(() => [])).length === 1);
  assert.deepEqual(await readdir(f.config.dataRoot), ['.incoming']);
  a.req.destroy();
  await until(async () => (await readdir(path.join(f.config.dataRoot, '.incoming'))).length === 0);
  assert.deepEqual(await readdir(f.config.dataRoot), ['.incoming']);
  const b = startPartial(f, t, body);
  await until(async () => (await readdir(path.join(f.config.dataRoot, '.incoming'))).length === 1);
  await writeFile(path.join(f.config.storageRoot, '.storage-id'), randomUUID());
  b.req.end(body.subarray(1));
  assert.equal((await b.response).status, 503);
  assert.deepEqual(await readdir(f.config.dataRoot), ['.incoming']);
  assert.deepEqual(await readdir(path.join(f.config.dataRoot, '.incoming')), []);
});

test('replay cache is bounded and fails closed rather than evicting live IDs', async t => {
  const f = await fixture(t);
  await rm(path.join(f.config.storageRoot, '.storage-id'));
  const body = Buffer.alloc(0);
  const first = signed(body);
  assert.equal((await f.request(first, body)).status, 503);
  for (let i = 1; i < 4096; i++) assert.equal((await f.request(signed(body), body)).status, 503);
  assert.equal((await f.request(signed(body), body)).status, 429);
  assert.equal((await f.request(first, body)).status, 409);
  assert.deepEqual(await readdir(f.config.storageRoot), []);
});

test('accepts zero bytes and exactly 25 MiB', async t => {
  const f = await fixture(t);
  for (const body of [Buffer.alloc(0), Buffer.alloc(MAX, 0xa5)]) {
    const headers = signed(body);
    const res = await f.request(headers, body);
    assert.equal(res.status, 201, res.text);
    const receipt = JSON.parse(res.text);
    assert.equal(receipt.bytes, body.length);
    assert.deepEqual(await readFile(path.join(f.config.dataRoot, receipt.name)), body);
  }
});

test('persists exact bytes and returns independently verifiable receipt', async t => {
  const f = await fixture(t);
  const body = Buffer.from([0, 255, 1, 2, 3, 10]);
  const headers = signed(body);
  const res = await f.request(headers, body);
  assert.equal(res.status, 201, res.text);
  const receipt = JSON.parse(res.text);
  const name = `${headers['x-family-id']}-photo.jpg`;
  assert.deepEqual(receipt, { stored: true, id: headers['x-family-id'], name, bytes: body.length, sha256: headers['x-family-sha256'], signature: createHmac('sha256', secret).update(['family-receipt-v1', headers['x-family-id'], name, String(body.length), headers['x-family-sha256']].join('\n')).digest('hex') });
  assert.deepEqual(await readFile(path.join(f.config.dataRoot, name)), body);
  assert.deepEqual(await readdir(path.join(f.config.dataRoot, '.incoming')), []);
});
