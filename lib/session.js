const encoder = new TextEncoder();
const lifetime = 60 * 60 * 24 * 7;
export const cookieOptions = 'Path=/; HttpOnly; Secure; SameSite=Strict';
export function configured(env) { return typeof env.FAMILY_USER === 'string' && env.FAMILY_USER.length > 0 && typeof env.FAMILY_PASS === 'string' && env.FAMILY_PASS.length > 0; }
async function key(env) { return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET || `family-session-v2:${env.FAMILY_USER}:${env.FAMILY_PASS}`), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
export async function session(env) {
 const payload = `${Math.floor(Date.now()/1000)+lifetime}.${crypto.randomUUID()}`;
 const signature = await crypto.subtle.sign('HMAC', await key(env), encoder.encode(payload));
 return `${payload}.${Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2,'0')).join('')}`;
}
export async function authenticated(request, env) {
 if (!configured(env)) return false;
 const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('family_session='))?.slice(15);
 if (!token) return false;
 const parts = token.split('.');
 if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
 const expires = Number(parts[0]), now = Math.floor(Date.now()/1000);
 if (expires <= now || expires > now+lifetime) return false;
 try { return await crypto.subtle.verify('HMAC', await key(env), Uint8Array.from(parts[2].match(/../g), s => parseInt(s,16)), encoder.encode(parts.slice(0,2).join('.'))); } catch { return false; }
}
export function sameOrigin(request) { return request.headers.get('Origin') === new URL(request.url).origin; }
export function reply(text, status=200, extra={}) { return new Response(text,{status,headers:{'Cache-Control':'no-store',...extra}}); }
