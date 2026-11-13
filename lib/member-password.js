const encoder = new TextEncoder();
const iterations = 100000;
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), b => parseInt(b, 16));
async function passwordMessage(username, password, salt) {
 const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
 const derived = await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', iterations, salt:unhex(salt)}, key, 256);
 const prefix = encoder.encode(`family-member-password-v1\n${username}\n`);
 const message = new Uint8Array(prefix.length + 32);
 message.set(prefix); message.set(new Uint8Array(derived), prefix.length);
 return message;
}
async function pepperKey(pepper) {
 return crypto.subtle.importKey('raw', unhex(pepper), {name:'HMAC', hash:'SHA-256'}, false, ['sign', 'verify']);
}
const memberNames = ['Charlie', 'Abigail', 'Olivia', 'Katie'];
const validPepper = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function validRecord(record, username) {
 return record !== null && typeof record === 'object' && !Array.isArray(record) &&
  Object.keys(record).sort().join(',') === 'iterations,proof,salt,username,version' &&
  record.version === 1 && record.username === username && record.iterations === iterations &&
  typeof record.salt === 'string' && /^[0-9a-f]{32}$/.test(record.salt) &&
  typeof record.proof === 'string' && /^[0-9a-f]{64}$/.test(record.proof);
}
export function memberConfigurationValid(env) {
 if (env.FAMILY_USERS_JSON === undefined && env.FAMILY_PASSWORD_KEY === undefined) return true;
 if (!validPepper(env.FAMILY_PASSWORD_KEY) ||
  [env.SESSION_SECRET, env.HOME_UPLOAD_SECRET, env.FAMILY_PASS].includes(env.FAMILY_PASSWORD_KEY) ||
  typeof env.FAMILY_USERS_JSON !== 'string' || env.FAMILY_USERS_JSON.length > 8192) return false;
 try {
  const users = JSON.parse(env.FAMILY_USERS_JSON);
  return users !== null && typeof users === 'object' && !Array.isArray(users) &&
   Object.keys(users).length > 0 && Object.keys(users).every(username =>
    memberNames.includes(username) && username !== env.FAMILY_USER && validRecord(users[username], username));
 } catch { return false; }
}
export async function verifyMemberPassword(env, username, password) {
 if (typeof username !== 'string' || typeof password !== 'string') return false;
 try {
  const users = JSON.parse(env.FAMILY_USERS_JSON);
  if (!Object.hasOwn(users, username)) return false;
  const record = users[username];
  return await crypto.subtle.verify('HMAC', await pepperKey(env.FAMILY_PASSWORD_KEY), unhex(record.proof), await passwordMessage(username, password, record.salt));
 } catch { return false; }
}
export async function createMemberPassword(username, password, pepper) {
 const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
 const proof = hex(await crypto.subtle.sign('HMAC', await pepperKey(pepper), await passwordMessage(username, password, salt)));
 return {version:1, username, iterations, salt, proof};
}
