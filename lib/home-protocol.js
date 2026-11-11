const encoder = new TextEncoder();
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
async function key(secret) {
  return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256',bytes)); }
export async function signature(secret,text) {
  return hex(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(text)));
}
export function safeFilename(name) {
  const safe = name.normalize('NFKC').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,150).replace(/\.+$/,'');
  return safe && safe !== '.' && safe !== '..' ? safe : 'upload';
}
export async function homeHeaders(secret,{id,timestamp,filename,size,digest}) {
  const canonical=['family-upload-v1','POST','/v1/upload',id,timestamp,filename,String(size),digest].join('\n');
  return {'Content-Type':'application/octet-stream','x-family-id':id,'x-family-timestamp':timestamp,
    'x-family-filename':filename,'x-family-size':String(size),'x-family-sha256':digest,
    'x-family-signature':await signature(secret,canonical)};
}
export async function validReceipt(receipt,secret,{id,filename,size,digest}) {
  if (!receipt || receipt.stored !== true || receipt.id !== id || receipt.name !== `${id}-${filename}` ||
      receipt.bytes !== size || receipt.sha256 !== digest || !/^[0-9a-f]{64}$/.test(receipt.signature || '')) return false;
  const canonical=['family-receipt-v1',receipt.id,receipt.name,String(receipt.bytes),receipt.sha256].join('\n');
  return crypto.subtle.verify('HMAC',await key(secret),Uint8Array.from(receipt.signature.match(/../g),s=>parseInt(s,16)),encoder.encode(canonical));
}
