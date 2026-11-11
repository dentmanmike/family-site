import {authenticated, reply, sameOrigin} from '../lib/session.js';
import {MAX_FILE_BYTES, safeFilename, sha256, homeHeaders, validReceipt} from '../lib/home-protocol.js';
const unavailable = () => reply('The home computer could not confirm the save. No cloud copy was saved; retry when it is available.',503);

export async function onRequest({request,env}) {
  if (request.method !== 'POST') return reply('Method not allowed',405,{'Allow':'POST'});
  if (!sameOrigin(request)) return reply('Forbidden',403);
  if (!await authenticated(request,env)) return reply('Unauthorized',401);
  if (!env.HOME_UPLOAD_URL || typeof env.HOME_UPLOAD_SECRET !== 'string' || env.HOME_UPLOAD_SECRET.length < 32) return unavailable();
  let url;
  try {
    url=new URL(env.HOME_UPLOAD_URL);
    if (url.protocol !== 'https:' || url.pathname !== '/v1/upload' || url.search || url.hash || url.username || url.password) return unavailable();
  } catch { return unavailable(); }
  if (Number(request.headers.get('Content-Length')) > 26*1024*1024) return reply('File too large',413);
  let form, received=0, tooLarge=false;
  try {
    const bounded=request.body?.pipeThrough(new TransformStream({transform(chunk,controller){
      received+=chunk.byteLength;
      if(received > 26*1024*1024){tooLarge=true;throw new Error('Multipart size limit');}
      controller.enqueue(chunk);
    }}));
    form=await new Request(request,{body:bounded,duplex:'half'}).formData();
  } catch { return reply(tooLarge?'File too large':'Invalid form',tooLarge?413:400); }
  const file=form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || !file.name) return reply('Choose a file',400);
  if (file.size > MAX_FILE_BYTES) return reply('File too large',413);
  try {
    const bytes=await file.arrayBuffer();
    const metadata={id:crypto.randomUUID(),timestamp:String(Math.floor(Date.now()/1000)),filename:safeFilename(file.name),size:file.size,digest:await sha256(bytes)};
    const response=await fetch(url,{method:'POST',headers:await homeHeaders(env.HOME_UPLOAD_SECRET,metadata),body:bytes,
      redirect:'error',signal:AbortSignal.timeout(90_000)});
    if (!response.ok) return unavailable();
    const receipt=await response.json();
    if (!await validReceipt(receipt,env.HOME_UPLOAD_SECRET,metadata)) return unavailable();
    // Never return a success until the disk receiver supplies a signed persistence receipt.
    return Response.json({stored:true,id:receipt.id,name:receipt.name,bytes:receipt.bytes,sha256:receipt.sha256},{headers:{'Cache-Control':'no-store'}});
  } catch { return unavailable(); }
}
