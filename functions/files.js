import {authenticated,reply} from '../lib/session.js';
import {homeRead,verifiedList,validFileId} from '../lib/home-reader.js';
export async function onRequest({request,env}) {
  if(request.method!=='GET')return reply('Method not allowed',405,{Allow:'GET'});
  if(!await authenticated(request,env))return reply('Unauthorized',401);
  const url=new URL(request.url),cursor=url.searchParams.get('cursor');
  if(cursor!==null&&!validFileId(cursor))return reply('Invalid cursor',400);
  try{
    const {id,response}=await homeRead(env,'/v1/files',{cursor,limit:100});
    if(response.status===400)return reply('The file list changed. Refresh it and try again.',400);
    const data=await verifiedList(env,id,response);
    return Response.json(data,{headers:{'Cache-Control':'no-store'}});
  }catch{return reply('The home file list is unavailable. Check the home computer and External1 drive.',503);}
}
