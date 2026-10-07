import {authenticated, configured, cookieOptions, reply, sameOrigin, session} from '../lib/session.js';
export async function onRequest({request, env}) {
 if (request.method === 'GET') return await authenticated(request,env) ? reply('OK') : reply('Unauthorized',401);
 if (request.method !== 'POST') return reply('Method not allowed',405,{'Allow':'GET, POST'});
 if (!sameOrigin(request)) return reply('Forbidden',403);
 if (new URL(request.url).searchParams.has('logout')) return reply('Logged out',200,{'Set-Cookie':`family_session=; ${cookieOptions}; Max-Age=0`});
 if (!configured(env)) return reply('Sign-in is not configured',503);
 let form; try { form = await request.formData(); } catch { return reply('Invalid form',400); }
 if (form.get('username') !== env.FAMILY_USER || form.get('password') !== env.FAMILY_PASS) return reply('Unauthorized',401);
 return reply('OK',200,{'Set-Cookie':`family_session=${await session(env)}; ${cookieOptions}; Max-Age=604800`});
}
