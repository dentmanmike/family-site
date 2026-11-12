import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const mac = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
const idFor = name => Buffer.from(name).toString('base64url');
const fail = status => { throw Object.assign(new Error('Read unavailable'), { status }); };
const displayName = name => name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
const validName = name => name.length > 0 && idFor(name).length <= 1024
  && !name.startsWith('.') && !/[\\/:\x00-\x1f\x7f-\x9f<>"|?*]/u.test(name) && !/[. ]$/.test(name)
  && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
function decodeId(id) {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id)) fail(400);
  const name = Buffer.from(id, 'base64url').toString('utf8');
  if (idFor(name) !== id || !validName(name)) fail(400);
  return name;
}

export function createReadHandler(config, { storageReady }) {
  const seen = new Map();
  let active = 0;
  return async function handleRead(req, res) {
    const route = req.url.split('?')[0];
    if (req.method !== 'GET' || !['/v1/files', '/v1/file'].includes(route)) return false;
    let handle;
    let reservation;
    try {
      const header = name => {
        const key = `x-family-${name}`;
        if (req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === key).length !== 1
            || typeof req.headers[key] !== 'string') fail(400);
        return req.headers[key];
      };
      const requestId = header('id');
      const timestamp = header('timestamp');
      const signature = header('signature');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
          || !/^\d{1,16}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
          || !/^[0-9a-f]{64}$/.test(signature)) fail(400);
      const now = Date.now() / 1000;
      if (Math.abs(now - Number(timestamp)) > 120) fail(401);
      const expected = mac(config.secret, ['family-read-v1', 'GET', req.url, requestId, timestamp].join('\n'));
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) fail(401);
      for (const [id, entry] of seen) if (!entry.active && entry.expires < now) seen.delete(id);
      if (seen.has(requestId)) fail(409);
      if (active >= 8 || seen.size >= 4096) fail(429);
      reservation = { active: true, expires: Number(timestamp) + 120 };
      seen.set(requestId, reservation);
      active++;
      const params = new URL(req.url, 'http://localhost').searchParams;
      if (route === '/v1/file') {
        if ([...params.keys()].some(key => key !== 'id') || params.getAll('id').length !== 1) fail(400);
        const id = params.get('id');
        const basename = decodeId(id);
        await storageReady();
        const target = path.join(config.dataRoot, basename);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(404);
        handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) fail(404);
        const size = String(opened.size);
        const modified = opened.mtime.toISOString();
        const name = encodeURIComponent(displayName(basename));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'x-family-file-id': id, 'x-family-file-name': name, 'x-family-file-size': size,
          'x-family-file-modified': modified,
          'x-family-response-signature': mac(config.secret, ['family-file-v1', requestId, id, name, size, modified].join('\n')) });
        if (opened.size === 0) res.end();
        else await pipeline(handle.createReadStream({ start: 0, end: opened.size - 1 }), async function* (source) {
          let bytes = 0;
          for await (const chunk of source) { bytes += chunk.length; yield chunk; }
          if (bytes !== opened.size) fail(500);
        }, res);
        return true;
      }
      for (const key of params.keys()) if (!['cursor', 'limit'].includes(key) || params.getAll(key).length !== 1) fail(400);
      const limitText = params.get('limit') ?? '100';
      if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100) fail(400);
      const limit = Number(limitText);
      const cursor = params.get('cursor');
      if (cursor !== null) decodeId(cursor);
      await storageReady();
      const files = [];
      for (const name of await fs.readdir(config.dataRoot)) {
        if (!validName(name)) continue;
        const stat = await fs.lstat(path.join(config.dataRoot, name));
        if (stat.isFile() && !stat.isSymbolicLink()) files.push({ id: idFor(name), name: displayName(name), bytes: stat.size, modified: stat.mtime.toISOString(), basename: name });
      }
      files.sort((a, b) => b.modified.localeCompare(a.modified) || (a.basename < b.basename ? -1 : a.basename > b.basename ? 1 : 0));
      const position = cursor === null ? -1 : files.findIndex(file => file.id === cursor);
      if (cursor !== null && position === -1) fail(400);
      const page = files.slice(position + 1, position + 1 + limit);
      const nextCursor = position + 1 + limit < files.length ? page.at(-1).id : null;
      const body = Buffer.from(JSON.stringify({ files: page.map(({ basename, ...file }) => file), nextCursor }));
      const digest = createHash('sha256').update(body).digest('hex');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-family-response-signature': mac(config.secret, ['family-list-v1', req.headers['x-family-id'], digest].join('\n')) });
      res.end(body);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else { res.writeHead(error.status || (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) ? 404 : 500), { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"Read unavailable"}'); }
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (reservation) { reservation.active = false; active--; }
    }
    return true;
  };
}
