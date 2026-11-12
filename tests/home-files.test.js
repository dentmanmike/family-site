import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUploadServer } from '../home/server.mjs';

const secret = 'read-tests-independent-secret-at-least-32-characters';
const mac = text => createHmac('sha256', secret).update(text).digest('hex');
const fileId = name => Buffer.from(name).toString('base64url');
function signed(url, overrides = {}) {
  const id = overrides.id ?? randomUUID();
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  return { 'x-family-id': id, 'x-family-timestamp': timestamp,
    'x-family-signature': mac(['family-read-v1', 'GET', url, id, timestamp].join('\n')) };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'family-files-'));
  const config = { secret, storageRoot: root, storageId: randomUUID(), dataRoot: path.join(root, 'Uploads') };
  await fs.mkdir(config.dataRoot);
  await fs.writeFile(path.join(root, '.storage-id'), config.storageId);
  const server = createUploadServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const request = (url, headers = signed(url), method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { root, config, server, request };
}

test('lists only Uploads regular files with exact metadata and independently signed JSON', async t => {
  const f = await fixture(t);
  const uploaded = `${randomUUID()}-photo.jpg`;
  const modified = '2025-01-02T03:04:05.000Z';
  for (const name of [uploaded, 'manual notes.txt']) {
    await fs.writeFile(path.join(f.config.dataRoot, name), 'abc');
    await fs.utimes(path.join(f.config.dataRoot, name), new Date(modified), new Date(modified));
  }
  await fs.writeFile(path.join(f.root, 'not-in-uploads.txt'), 'private');
  const url = '/v1/files?limit=100';
  const headers = signed(url);
  const res = await f.request(url, headers);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { files: [uploaded, 'manual notes.txt'].sort().map(name => ({
    id: fileId(name), name: name === uploaded ? 'photo.jpg' : name, bytes: 3, modified,
  })), nextCursor: null });
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['cache-control'], 'no-store');
  const digest = createHash('sha256').update(res.body).digest('hex');
  assert.equal(res.headers['x-family-response-signature'], mac(['family-list-v1', headers['x-family-id'], digest].join('\n')));
});

test('authenticates exact raw resources and rejects malformed, duplicate, expired and replayed headers before storage', async t => {
  const f = await fixture(t);
  const url = '/v1/files?limit=100';
  const good = signed(url);
  assert.equal((await f.request(url, good)).status, 200);
  assert.equal((await f.request(url, good)).status, 409);
  await fs.rm(path.join(f.root, '.storage-id'));
  const bad = [ {}, { ...signed(url), 'x-family-signature': '0'.repeat(64) },
    signed(url + '&cursor='), signed(url, { id: '00000000-0000-1000-8000-000000000000' }),
    signed(url, { timestamp: String(Math.floor(Date.now() / 1000) - 121) }),
    signed(url, { timestamp: String(Math.floor(Date.now() / 1000) + 130) }),
    signed(url, { timestamp: '1e10' }),
    ...['id', 'timestamp', 'signature'].map(key => { const h = signed(url); return { ...h, [`x-family-${key}`]: [h[`x-family-${key}`], h[`x-family-${key}`]] }; }),
    { ...signed(url), 'x-family-signature': 'A'.repeat(64) },
  ];
  for (const headers of bad) {
    const res = await f.request(url, headers);
    assert.ok([400, 401].includes(res.status), `unexpected status ${res.status}`);
    assert.equal(res.body.includes(f.root), false);
    assert.equal(res.body.includes(secret), false);
  }
  assert.equal((await f.request(url)).status, 503);
});

test('filters unsafe entries and paginates newest first with stable basename ties and stale cursor rejection', async t => {
  const f = await fixture(t);
  const names = ['a.txt', 'b.txt', 'new.txt'];
  for (const name of names) {
    await fs.writeFile(path.join(f.config.dataRoot, name), name);
    const time = new Date(name === 'new.txt' ? '2025-02-01Z' : '2025-01-01Z');
    await fs.utimes(path.join(f.config.dataRoot, name), time, time);
  }
  // Win32 rejects or normalizes these names; only create them on POSIX.
  // Invalid download IDs are still tested on every platform below.
  const unsafeNames = process.platform === 'win32' ? ['.hidden']
    : ['.hidden', 'CON.txt', 'LPT9.log', 'bad:stream', 'trailing.', 'space ', 'bad\u0001name'];
  for (const name of unsafeNames) {
    await fs.writeFile(path.join(f.config.dataRoot, name), 'hidden');
  }
  await fs.mkdir(path.join(f.config.dataRoot, '.incoming'));
  await fs.mkdir(path.join(f.config.dataRoot, 'directory'));
  await fs.writeFile(path.join(f.root, 'outside'), 'outside');
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.config.dataRoot, 'link.txt'));
  let res = JSON.parse((await f.request('/v1/files?limit=2')).body);
  assert.deepEqual(res.files.map(file => file.name), ['new.txt', 'a.txt']);
  assert.equal(res.nextCursor, fileId('a.txt'));
  res = JSON.parse((await f.request(`/v1/files?cursor=${res.nextCursor}&limit=2`)).body);
  assert.deepEqual(res.files.map(file => file.name), ['b.txt']);
  assert.equal(res.nextCursor, null);
  for (const query of ['limit=0', 'limit=101', 'limit=1e2', 'limit=2&limit=1', 'unknown=1', 'cursor=', 'cursor=bad!', `cursor=${fileId('missing.txt')}`]) {
    assert.equal((await f.request(`/v1/files?${query}`)).status, 400, query);
  }
  await fs.rm(path.join(f.config.dataRoot, 'a.txt'));
  assert.equal((await f.request(`/v1/files?cursor=${fileId('a.txt')}&limit=2`)).status, 400);
});

test('list defaults to 100 and never leaks more than a page', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 101 }, (_, i) => fs.writeFile(path.join(f.config.dataRoot, `file-${i}.txt`), '')));
  const res = JSON.parse((await f.request('/v1/files')).body);
  assert.equal(res.files.length, 100);
  assert.equal(res.nextCursor, res.files[99].id);
});

test('downloads exact binary bytes and zero bytes with independently signed metadata', async t => {
  const f = await fixture(t);
  for (const body of [Buffer.from([0, 255, 10, 1, 13]), Buffer.alloc(0)]) {
    const basename = `${randomUUID()}-family résumé 😀.bin`;
    const id = fileId(basename);
    await fs.writeFile(path.join(f.config.dataRoot, basename), body);
    const modified = (await fs.stat(path.join(f.config.dataRoot, basename))).mtime.toISOString();
    const url = `/v1/file?id=${id}`;
    const headers = signed(url);
    const res = await f.request(url, headers);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, body);
    const encoded = encodeURIComponent('family résumé 😀.bin');
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['content-length'], String(body.length));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-family-file-id'], id);
    assert.equal(res.headers['x-family-file-name'], encoded);
    assert.equal(res.headers['x-family-file-size'], String(body.length));
    assert.equal(res.headers['x-family-file-modified'], modified);
    assert.equal(res.headers['x-family-response-signature'], mac(['family-file-v1', headers['x-family-id'], id, encoded, String(body.length), modified].join('\n')));
    assert.equal((await f.request(url, headers)).status, 409);
    assert.equal((await f.request(url, {})).status, 400);
  }
});

test('rejects noncanonical IDs, Windows devices, traversal, directories and symlink escapes', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.config.dataRoot, 'directory'));
  await fs.writeFile(path.join(f.root, 'outside.txt'), 'private');
  await fs.symlink(path.join(f.root, 'outside.txt'), path.join(f.config.dataRoot, 'link.txt'));
  await fs.symlink(f.root, path.join(f.config.dataRoot, 'junction'), 'junction');
  const invalid = ['', '!', 'YQ==', 'YR', '_w', 'a'.repeat(1025),
    ...['.', '..', '../outside.txt', '..\\outside.txt', '/etc/passwd', 'C:secret', 'NUL', 'con.txt', 'COM1', 'LPT9.log', 'space ', 'dot.', '.incoming', '.hidden', 'a\u0000b', 'a\u007fb'].map(fileId)];
  for (const id of invalid) assert.equal((await f.request(`/v1/file?id=${id}`)).status, 400, id);
  for (const query of ['', 'id=YQ&id=Yg', `id=${fileId('a')}&extra=1`]) assert.equal((await f.request(`/v1/file?${query}`)).status, 400);
  for (const name of ['directory', 'link.txt', 'junction', 'missing.txt']) assert.equal((await f.request(`/v1/file?id=${fileId(name)}`)).status, 404, name);
});

test('read replay cache fails closed at 4096 IDs without evicting still-valid requests', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, '.storage-id'));
  const url = '/v1/files';
  const first = signed(url);
  assert.equal((await f.request(url, first)).status, 503);
  for (let i = 1; i < 4096; i++) assert.equal((await f.request(url)).status, 503);
  assert.equal((await f.request(url)).status, 429);
  assert.equal((await f.request(url, first)).status, 409);
});

test('limits active read requests to eight before touching storage and releases capacity', async t => {
  const f = await fixture(t);
  const { createReadHandler } = await import('../home/read-files.mjs');
  let entered = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createReadHandler(f.config, { storageReady: async () => { entered++; await gate; } });
  const server = http.createServer(async (req, res) => { await handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/v1/files`, { headers: signed('/v1/files') });
  const pending = Array.from({ length: 8 }, request);
  const deadline = Date.now() + 2000;
  while (entered !== 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(entered, 8);
  const ninth = request();
  const status = await Promise.race([ninth.then(res => res.status), new Promise(resolve => setTimeout(() => resolve('blocked instead of 429'), 200))]);
  release();
  await Promise.all([...pending, ninth]);
  assert.equal(status, 429);
  assert.equal(entered, 8);
  assert.equal((await request()).status, 200);
});

test('checks the storage marker and directory chain on every list and download without creating paths', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.config.dataRoot, 'safe.txt'), 'safe');
  const urls = ['/v1/files', `/v1/file?id=${fileId('safe.txt')}`];
  for (const url of urls) assert.equal((await f.request(url)).status, 200);
  await fs.writeFile(path.join(f.root, '.storage-id'), randomUUID());
  for (const url of urls) assert.equal((await f.request(url)).status, 503);
  await fs.writeFile(path.join(f.root, '.storage-id'), f.config.storageId);
  for (const url of urls) assert.equal((await f.request(url)).status, 200);
  await fs.rename(f.config.dataRoot, path.join(f.root, 'actual'));
  await fs.symlink(path.join(f.root, 'actual'), f.config.dataRoot, 'junction');
  for (const url of urls) assert.equal((await f.request(url)).status, 503);
  for (const [url, method] of [['/v1/files', 'POST'], ['/v1/file', 'HEAD'], ['/v1/files/else', 'GET']]) assert.equal((await f.request(url, signed(url), method)).status, 404);
});

test('aborted large downloads release read slots and leave the receiver healthy', async t => {
  const f = await fixture(t);
  const target = path.join(f.config.dataRoot, 'large.bin');
  const handle = await fs.open(target, 'w');
  await handle.truncate(64 * 1024 * 1024);
  await handle.close();
  const url = `/v1/file?id=${fileId('large.bin')}`;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: f.server.address().port, path: url, headers: signed(url) }, res => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => { res.destroy(); resolve(); });
        res.on('error', () => {});
      });
      req.on('error', reject);
    });
  }
  assert.equal((await f.request('/v1/files')).status, 200);
});

test('stream read errors close opened handles and never escape to the upload response writer', async t => {
  const f = await fixture(t);
  const target = path.join(f.config.dataRoot, 'broken.bin');
  await fs.writeFile(target, Buffer.alloc(1024 * 1024));
  const probe = await fs.open(target, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.createReadStream;
  await probe.close();
  const handles = [];
  const patch = t.mock.method(prototype, 'createReadStream', function(options) {
    handles.push(this);
    const stream = original.call(this, options);
    stream.once('data', () => stream.destroy(new Error('synthetic disk read error')));
    return stream;
  });
  await assert.rejects(f.request(`/v1/file?id=${fileId('broken.bin')}`), /aborted|socket hang up|reset/i);
  patch.mock.restore();
  const deadline = Date.now() + 2000;
  while (handles.some(handle => handle.fd !== -1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(handles.length, 1);
  assert.equal(handles[0].fd, -1);
  assert.equal((await f.request('/v1/files')).status, 200);
});

test('a file truncated during streaming aborts promptly rather than ending a short successful response', async t => {
  const f = await fixture(t);
  const target = path.join(f.config.dataRoot, 'truncate.bin');
  const file = await fs.open(target, 'w');
  await file.truncate(64 * 1024 * 1024);
  await file.close();
  const url = `/v1/file?id=${fileId('truncate.bin')}`;
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('hung'), 1000);
    const req = http.get({ host: '127.0.0.1', port: f.server.address().port, path: url, headers: signed(url) }, res => {
      res.once('data', async () => {
        res.pause();
        try { await fs.truncate(target, 0); } catch (error) { reject(error); }
        res.resume();
      });
      res.on('aborted', () => { clearTimeout(timer); resolve('aborted'); });
      res.on('end', () => { clearTimeout(timer); resolve('ended'); });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
  assert.equal(outcome, 'aborted');
  assert.equal((await f.request('/v1/files')).status, 200);
});
