import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../docs/app.js',import.meta.url),'utf8');
async function uploadUI(response){
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,files:[{size:4}],handlers:{},classList:{toggle(){}},
      addEventListener(event,fn){this.handlers[event]=fn;},setAttribute(){},focus(){},replaceChildren(){},children:[],querySelector(){return this;}});
    return elements.get(id);
  };
  const context={document:{getElementById:element},FormData:class{},fetch:async path=>{
    if(path==='/auth') return {ok:true,status:200};
    if(path==='/files') return {ok:true,status:200,json:async()=>({files:[],nextCursor:null})};
    assert.equal(path,'/upload'); return response;
  },console};
  vm.runInNewContext(source,context);
  for(let i=0;i<12;i++) await Promise.resolve();
  await element('upload-form').handlers.submit({preventDefault(){},target:{reset(){}}});
  return element('upload-status').textContent;
}
test('UI does not claim a save for a non-confirming success response',async()=>{
  const text=await uploadUI({ok:true,status:200,json:async()=>({stored:false})});
  assert.match(text,/not confirmed|wasn.t confirmed/i);
  assert.doesNotMatch(text,/Saved to our family collection/);
});
test('UI reports a confirmed home save',async()=>{
  const text=await uploadUI({ok:true,status:200,json:async()=>({stored:true,bytes:4,sha256:'a'.repeat(64)})});
  assert.equal(text,'Saved on our home computer.');
});
test('UI warns when the home connection is offline',async()=>{
  const text=await uploadUI({ok:false,status:503});
  assert.match(text,/not confirmed|wasn.t confirmed/i);
  assert.match(text,/No cloud copy is kept/);
});
test('member page explains the home computer must be online',async()=>{
  const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/home computer.*online/i);
});
