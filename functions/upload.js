import {authenticated, reply, sameOrigin} from '../lib/session.js';
export async function onRequest({request,env}) {
 if (request.method !== 'POST') return reply('Method not allowed',405,{'Allow':'POST'});
 if (!sameOrigin(request)) return reply('Forbidden',403);
 if (!await authenticated(request,env)) return reply('Unauthorized',401);
 if (!env.FAMILY_BUCKET) return reply('Storage unavailable',503);
 if (Number(request.headers.get('Content-Length')) > 26*1024*1024) return reply('File too large',413);
 let form; try { form = await request.formData(); } catch { return reply('Invalid form',400); }
 const file = form.get('file');
 if (!file || typeof file.stream !== 'function' || !file.name) return reply('Choose a file',400);
 if (file.size > 25*1024*1024) return reply('File too large',413);
 const filename = `${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,150)}`;
 try { await env.FAMILY_BUCKET.put(filename,file.stream(),{httpMetadata:{contentType:'application/octet-stream'}}); } catch { return reply('Upload failed',503); }
 return reply('Uploaded');
}
