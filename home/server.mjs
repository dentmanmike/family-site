import http from 'node:http';
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createReadHandler } from './read-files.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const mac = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
const unavailable = () => Object.assign(new Error('Storage unavailable'), { status: 503 });

// Reject reparse points/junctions as well as symlinks at every component.
// The containing tree must also be protected by OS ACLs against local mutation.
async function directoryChain(target) {
  const root = path.parse(target).root;
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    const actual = await fs.realpath(current);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(actual) !== normalize(current)) throw unavailable();
  }
}

async function storageReady(config, create = false) {
  try {
    await directoryChain(config.storageRoot);
    const marker = path.join(config.storageRoot, '.storage-id');
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw unavailable();
    const handle = await fs.open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 256 || opened.ino !== stat.ino || opened.dev !== stat.dev
          || (await handle.readFile('utf8')).trim() !== config.storageId) throw unavailable();
    } finally { await handle.close(); }
    let current = config.storageRoot;
    for (const part of [...path.relative(config.storageRoot, config.dataRoot).split(path.sep), '.incoming']) {
      current = path.join(current, part);
      if (create) {
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      } else {
        try { await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      }
      await directoryChain(current);
    }
  } catch { throw unavailable(); }
}

export function createUploadServer(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 32
      || typeof config.storageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.storageId)
      || typeof config.storageRoot !== 'string' || !path.isAbsolute(config.storageRoot)
      || typeof config.dataRoot !== 'string' || !path.isAbsolute(config.dataRoot)) throw new TypeError('Invalid receiver configuration');
  config = { ...config, storageRoot: path.resolve(config.storageRoot), dataRoot: path.resolve(config.dataRoot) };
  const relative = path.relative(config.storageRoot, config.dataRoot);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new TypeError('Data directory must be below storage root');
  const handleRead = createReadHandler(config, { storageReady: async () => storageReady(config, false) });
  const seen = new Map();
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 60000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    let temp;
    let file;
    let reservation;
    try {
      if (req.method === 'GET' && req.url === '/v1/health') {
        let ready = true;
        try { await storageReady(config); } catch { ready = false; }
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: ready, storageReady: ready }));
        return;
      }
      if (await handleRead(req, res)) return;
      if (req.method !== 'POST' || req.url !== '/v1/upload') throw Object.assign(new Error(), { status: 404 });
      const header = name => {
        const key = `x-family-${name}`;
        if (req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === key).length !== 1) throw Object.assign(new Error(), { status: 400 });
        const value = req.headers[key];
        if (typeof value !== 'string') throw Object.assign(new Error(), { status: 400 });
        return value;
      };
      const id = header('id');
      const timestamp = header('timestamp');
      const filename = header('filename');
      const sizeText = header('size');
      const size = Number(sizeText);
      const sha256 = header('sha256');
      const signatureText = header('signature');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
          || !/^[A-Za-z0-9._-]{1,150}$/.test(filename) || filename === '.' || filename === '..'
          || !/^\d{1,16}$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0
          || !/^\d{1,16}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
          || !/^[0-9a-f]{64}$/.test(sha256) || !/^[0-9a-f]{64}$/.test(signatureText)) throw Object.assign(new Error(), { status: 400 });
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 120) throw Object.assign(new Error(), { status: 401 });
      const canonical = ['family-upload-v1', 'POST', '/v1/upload', id, timestamp, filename, String(size), sha256].join('\n');
      if (!timingSafeEqual(Buffer.from(signatureText, 'hex'), Buffer.from(mac(config.secret, canonical), 'hex'))) throw Object.assign(new Error(), { status: 401 });
      if (size > MAX_BYTES) throw Object.assign(new Error(), { status: 413 });
      const now = Date.now() / 1000;
      for (const [key, entry] of seen) if (!entry.active && entry.expires < now) seen.delete(key);
      if (seen.has(id)) throw Object.assign(new Error(), { status: 409 });
      if (active >= 2 || seen.size >= 4096) throw Object.assign(new Error(), { status: 429 });
      reservation = { active: true, expires: Number(timestamp) + 120 };
      seen.set(id, reservation);
      active++;
      await storageReady(config, true);
      const incoming = path.join(config.dataRoot, '.incoming');
      temp = path.join(incoming, randomUUID() + '.part');
      file = await fs.open(temp, 'wx', 0o600);
      let bytes = 0;
      const hash = createHash('sha256');
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > size || bytes > MAX_BYTES) throw Object.assign(new Error(), { status: 400 });
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (bytes !== size || hash.digest('hex') !== sha256) throw Object.assign(new Error(), { status: 400 });
      await file.sync();
      await file.close(); file = undefined;
      await storageReady(config, true);
      const name = `${id}-${filename}`;
      try { await fs.link(temp, path.join(config.dataRoot, name)); }
      catch (error) { if (error.code === 'EEXIST') error.status = 409; throw error; }
      await fs.unlink(temp); temp = undefined;
      const signature = mac(config.secret, ['family-receipt-v1', id, name, String(size), sha256].join('\n'));
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ stored: true, id, name, bytes: size, sha256, signature }));
    } catch (error) {
      if (file) await file.close().catch(() => {});
      if (temp) await fs.unlink(temp).catch(() => {});
      res.writeHead(error.status || 500, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ stored: false }));
    } finally {
      if (reservation) { reservation.active = false; active--; }
    }
  });
  server.timeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;
  return server;
}
