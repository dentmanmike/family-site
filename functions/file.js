import {authenticated,reply} from '../lib/session.js';
import {homeRead,verifyHomeMac,validFileId} from '../lib/home-reader.js';
export async function onRequest({request,env}){
  if(request.method!=='GET')return reply('Method not allowed',405,{Allow:'GET'});
  if(!await authenticated(request,env))return reply('Unauthorized',401);
  const fileId=new URL(request.url).searchParams.get('id');
  if(!validFileId(fileId))return reply('Invalid file',400);
  let response;
  try{
    const home=await homeRead(env,'/v1/file',{id:fileId});response=home.response;
    if(response.status===404)return reply('File not found',404);
    if(response.status!==200)throw new Error('Home unavailable');
    const h=response.headers,name=h.get('x-family-file-name'),size=h.get('x-family-file-size'),modified=h.get('x-family-file-modified');
    if(h.get('x-family-file-id')!==fileId||typeof name!=='string'||name.length>3072||!/^\d{1,16}$/.test(size||'')||!Number.isSafeInteger(Number(size))||Number(size)<0||!Number.isFinite(Date.parse(modified||'')))throw new Error('Invalid file metadata');
    const canonical=['family-file-v1',home.id,fileId,name,size,modified].join('\n');
    if(!await verifyHomeMac(env.HOME_UPLOAD_SECRET,canonical,h.get('x-family-response-signature')))throw new Error('Invalid file signature');
    const decoded=decodeURIComponent(name);
    if(!decoded||decoded.length>255||/[\x00-\x1f\x7f\\/]/.test(decoded))throw new Error('Invalid filename');
    const encoded=encodeURIComponent(decoded).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
    return new Response(response.body,{headers:{'Cache-Control':'no-store','Content-Type':'application/octet-stream','Content-Length':size,
      'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encoded}`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Accept-Ranges':'none'}});
  }catch{
    if(response?.body)await response.body.cancel().catch(()=>{});
    return reply('The home file is unavailable. Check the home computer and External1 drive.',503);
  }
}
