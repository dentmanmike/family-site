import {signature,sha256} from './home-protocol.js';
const encoder=new TextEncoder();
export function validFileId(id){
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,1024}$/.test(id))return false;
  try{
    const bytes=Uint8Array.from(atob(id.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const canonical=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return canonical===id&&name.length>0&&name.length<=255&&!name.startsWith('.')&&!/[\\/:\x00-\x1f\x7f]/.test(name)&&!/[. ]$/.test(name)&&!/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
  }catch{return false;}
}
export async function verifyHomeMac(secret,text,mac){
  if(!/^[0-9a-f]{64}$/.test(mac||''))return false;
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,Uint8Array.from(mac.match(/../g),x=>parseInt(x,16)),encoder.encode(text));
}
export async function homeRead(env,path,parameters={}){
  if(typeof env.HOME_UPLOAD_SECRET!=='string'||env.HOME_UPLOAD_SECRET.length<32)throw new Error('Home configuration unavailable');
  const url=new URL(env.HOME_UPLOAD_URL);
  if(url.protocol!=='https:'||url.pathname!=='/v1/upload'||url.search||url.hash||url.username||url.password)throw new Error('Invalid home endpoint');
  url.pathname=path;url.search='';
  for(const [key,value] of Object.entries(parameters))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
  const id=crypto.randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
  const mac=await signature(env.HOME_UPLOAD_SECRET,['family-read-v1','GET',url.pathname+url.search,id,timestamp].join('\n'));
  const response=await fetch(url,{method:'GET',redirect:'manual',cache:'no-store',headers:{'x-family-id':id,'x-family-timestamp':timestamp,'x-family-signature':mac,'User-Agent':'MillerFamilyPortal/1.0'},signal:AbortSignal.timeout(90_000)});
  return {id,response};
}
export async function verifiedList(env,requestId,response){
  if(!response.ok)throw new Error('Home unavailable');
  const reader=response.body.getReader();const chunks=[];let length=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>256*1024){await reader.cancel();throw new Error('Metadata limit');}chunks.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const canonical=['family-list-v1',requestId,await sha256(bytes)].join('\n');
  if(!await verifyHomeMac(env.HOME_UPLOAD_SECRET,canonical,response.headers.get('x-family-response-signature')))throw new Error('Invalid metadata signature');
  const data=JSON.parse(new TextDecoder().decode(bytes));
  if(!Array.isArray(data.files)||data.files.length>100||!(data.nextCursor===null||validFileId(data.nextCursor)))throw new Error('Invalid metadata');
  const files=data.files.map(item=>{
    if(!validFileId(item.id)||typeof item.name!=='string'||!item.name.length||item.name.length>255||!Number.isSafeInteger(item.bytes)||item.bytes<0||typeof item.modified!=='string'||!Number.isFinite(Date.parse(item.modified)))throw new Error('Invalid file metadata');
    return {id:item.id,name:item.name,bytes:item.bytes,modified:item.modified};
  });
  return {files,nextCursor:data.nextCursor};
}
