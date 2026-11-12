import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../docs/app.js', import.meta.url), 'utf8');
const settle = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const ok = data => ({ok:true,status:200,json:async()=>data});
const file = (id='YWJj',name='<img src=x onerror=alert(1)>.txt') => ({id,name,bytes:1234,modified:'2026-11-11T12:00:00.000Z'});
function setup(route) {
  const elements = new Map(), calls = [];
  function element(tag='div') {
    return {tagName:tag.toUpperCase(),textContent:'',children:[],hidden:false,disabled:false,value:'',files:[{size:4}],handlers:{},attrs:{},classList:{toggle(){}},
      addEventListener(event,fn){this.handlers[event]=fn;},setAttribute(key,value){this.attrs[key]=value;},focus(){},reset(){},querySelector(){return this;},
      appendChild(child){this.children.push(child);return child;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
      set innerHTML(value){throw new Error('Unsafe innerHTML: '+value);}};
  }
  const get = id => {if(!elements.has(id)) elements.set(id,element());return elements.get(id);};
  vm.runInNewContext(source,{document:{getElementById:get,createElement:element},FormData:class{},fetch:async(path,options)=>{calls.push({path,options});return route(path,options);},console,Date,Number,encodeURIComponent});
  const fire = async (id,event='click') => {await get(id).handlers[event]({preventDefault(){},target:get(id)});await settle();};
  return {get,calls,fire};
}
function descendants(node) {return [node,...node.children.flatMap(descendants)];}
test('refresh and pagination replace or append files, with recoverable errors',async()=>{
  let page=0, fail=false;
  const ui=setup(path=>{
    if(path==='/auth') return ok({});
    if(fail) return {ok:false,status:503};
    page++;
    return ok({files:[file(page===1?'YWJj':'ZGVm')],nextCursor:page===1?'cursor_1':null});
  });
  await settle();assert.equal(ui.get('files-more').hidden,false);
  await ui.fire('files-more');
  assert.equal(ui.calls.at(-1).path,'/files?cursor=cursor_1');
  assert.equal(ui.get('file-list').children.length,2);
  assert.equal(ui.get('files-more').hidden,true);
  fail=true;await ui.fire('files-refresh');
  assert.match(ui.get('files-status').textContent,/unavailable|offline/i);
  assert.doesNotMatch(ui.get('files-status').textContent,/no files/i);
  assert.equal(ui.get('files-refresh').disabled,false);
  fail=false;await ui.fire('files-refresh');
  assert.equal(ui.get('file-list').children.length,1);
});
test('logout clears filenames immediately and ignores an older list response',async()=>{
  let resolveList, pending=false;
  const ui=setup(path=>path.startsWith('/auth')?ok({}):pending?new Promise(resolve=>{resolveList=resolve;}):ok({files:[file()],nextCursor:null}));
  await settle();pending=true;
  const refresh=ui.fire('files-refresh');await settle();
  await ui.fire('sign-out');
  assert.equal(ui.get('file-list').children.length,0);
  resolveList(ok({files:[file()],nextCursor:null}));await refresh;
  assert.equal(ui.get('file-list').children.length,0);
  assert.equal(ui.get('files-status').textContent,'');
  await ui.fire('files-refresh');assert.equal(ui.calls.filter(c=>c.path==='/files').length,2);
});
test('failed logout offers a login-view retry until website sign-out is confirmed',async()=>{
  const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/id="login-view"[\s\S]*<button[^>]*id="retry-sign-out"[^>]*type="button"[^>]*hidden[\s\S]*id="member-view"/);
  for(const failure of [()=>({ok:false,status:503}),()=>{throw new Error('offline');}]) {
    let attempts=0, finish;
    const ui=setup(path=>path==='/auth?logout=1'?(++attempts===1?failure():new Promise(resolve=>{finish=resolve;})):path==='/auth'?ok({}):ok({files:[file()],nextCursor:null}));
    await settle();await ui.fire('sign-out');
    assert.equal(ui.get('file-list').children.length,0);
    assert.equal(ui.get('member-view').hidden,true);
    assert.equal(ui.get('login-view').hidden,false);
    assert.equal(ui.get('retry-sign-out').hidden,false);
    assert.equal(ui.get('retry-sign-out').disabled,false);
    assert.match(ui.get('login-status').textContent,/website.*sign.out|sign.out.*website/i);
    const retry=ui.fire('retry-sign-out');await settle();
    assert.equal(attempts,2);
    assert.equal(ui.get('retry-sign-out').hidden,false);
    assert.equal(ui.get('retry-sign-out').disabled,true);
    assert.equal(ui.get('file-list').children.length,0);
    finish(ok({}));await retry;
    assert.equal(ui.get('retry-sign-out').hidden,true);
    assert.equal(ui.get('login-status').textContent,'');
    assert.equal(ui.get('member-view').hidden,true);
  }
});
test('pending logout disables sign-in until either success or failure settles',async()=>{
  for(const result of [ok({}),{ok:false,status:503}]) {
    let finish;
    const ui=setup(path=>path==='/auth?logout=1'?new Promise(resolve=>{finish=resolve;}):path==='/auth'?ok({}):ok({files:[file()],nextCursor:null}));
    await settle();const logout=ui.fire('sign-out');await settle();
    assert.equal(ui.get('sign-in').disabled,true);
    assert.equal(ui.get('file-list').children.length,0);
    finish(result);await logout;
    assert.equal(ui.get('sign-in').disabled,false);
  }
});
test('pending logout guards login submits and duplicate logout or retry handlers',async()=>{
  let finish;
  const ui=setup(path=>path==='/auth?logout=1'?new Promise(resolve=>{finish=resolve;}):path==='/auth'?ok({}):ok({files:[file()],nextCursor:null}));
  await settle();const logout=ui.fire('sign-out');await settle();
  await ui.fire('login-form','submit');
  assert.equal(ui.calls.filter(c=>c.path==='/auth' && c.options?.method==='POST').length,0);
  await ui.fire('sign-out');await ui.fire('retry-sign-out');
  assert.equal(ui.calls.filter(c=>c.path==='/auth?logout=1').length,1);
  finish(ok({}));await logout;
  assert.equal(ui.get('member-view').hidden,true);
  assert.equal(ui.get('file-list').children.length,0);
  await ui.fire('login-form','submit');
  assert.equal(ui.calls.filter(c=>c.path==='/auth' && c.options?.method==='POST').length,1);
  assert.equal(ui.get('member-view').hidden,false);
});
test('pending login guards logout and duplicate login until the request settles',async()=>{
  let finish;
  const ui=setup((path,options)=>path==='/auth'?(options?new Promise(resolve=>{finish=resolve;}):{ok:false,status:401}):ok({files:[],nextCursor:null}));
  await settle();const login=ui.fire('login-form','submit');await settle();
  assert.equal(ui.get('sign-out').disabled,true);
  assert.equal(ui.get('retry-sign-out').disabled,true);
  await ui.fire('sign-out');await ui.fire('retry-sign-out');
  assert.equal(ui.calls.filter(c=>c.path==='/auth?logout=1').length,0);
  await ui.fire('login-form','submit');
  assert.equal(ui.calls.filter(c=>c.path==='/auth' && c.options?.method==='POST').length,1);
  finish(ok({}));await login;
  assert.equal(ui.get('sign-in').disabled,false);
  assert.equal(ui.get('sign-out').disabled,false);
  assert.equal(ui.get('retry-sign-out').disabled,false);
  assert.equal(ui.get('member-view').hidden,false);
});
test('list 401 expires the session and clears private files',async()=>{
  let expired=false;
  const ui=setup(path=>path==='/auth'?ok({}):expired?{ok:false,status:401}:ok({files:[file()],nextCursor:null}));
  await settle();expired=true;await ui.fire('files-refresh');
  assert.equal(ui.get('member-view').hidden,true);
  assert.equal(ui.get('file-list').children.length,0);
  assert.match(ui.get('login-status').textContent,/session.*ended/i);
});
test('confirmed upload refreshes files but an unconfirmed receipt does not',async()=>{
  let confirmed=false;
  const ui=setup(path=>path==='/upload'?ok({stored:confirmed,bytes:4,sha256:'a'.repeat(64)}):path==='/auth'?ok({}):ok({files:[],nextCursor:null}));
  await settle();await ui.fire('upload-form','submit');
  assert.equal(ui.calls.filter(c=>c.path==='/files').length,1);
  confirmed=true;await ui.fire('upload-form','submit');
  assert.equal(ui.calls.filter(c=>c.path==='/files').length,2);
});
test('upload 401 clears previously listed filenames',async()=>{
  const ui=setup(path=>path==='/upload'?{ok:false,status:401}:path==='/auth'?ok({}):ok({files:[file()],nextCursor:null}));
  await settle();await ui.fire('upload-form','submit');
  assert.equal(ui.get('file-list').children.length,0);
  assert.equal(ui.get('member-view').hidden,true);
});
test('restored session lists private files as text with sizes, dates and attachment links',async()=>{
  const ui=setup(path=>path==='/auth'?ok({}):ok({files:[file()],nextCursor:null}));
  await settle();
  assert.equal(ui.calls.filter(c=>c.path==='/files').length,1);
  const nodes=descendants(ui.get('file-list'));
  assert.ok(nodes.some(n=>n.textContent===file().name));
  assert.ok(nodes.some(n=>/1[,.]2|1234/.test(n.textContent)));
  assert.ok(nodes.some(n=>n.tagName==='TIME' && n.dateTime===file().modified));
  assert.ok(nodes.some(n=>n.tagName==='A' && n.href==='/file?id=YWJj' && n.textContent==='Download'));
});
test('malformed IDs, oversized pages/cursors and unsafe metadata never create links',async()=>{
  const invalidPages=[
    {files:[file('../secret')],nextCursor:null},
    {files:[file('x'.repeat(1025))],nextCursor:null},
    {files:[{...file(),bytes:Number.MAX_SAFE_INTEGER+1}],nextCursor:null},
    {files:[{...file(),modified:'not-a-date'}],nextCursor:null},
    {files:[file()],nextCursor:'x'.repeat(1025)},
    {files:Array.from({length:101},()=>file()),nextCursor:null}
  ];
  for(const page of invalidPages) {
    const ui=setup(path=>path==='/auth'?ok({}):ok(page));await settle();
    assert.equal(descendants(ui.get('file-list')).filter(n=>n.tagName==='A').length,0);
    assert.match(ui.get('files-status').textContent,/unavailable/i);
    assert.equal(ui.get('files-refresh').disabled,false);
  }
});
test('logout removes private content before its network request completes',async()=>{
  let finish;
  const ui=setup(path=>path==='/auth?logout=1'?new Promise(resolve=>{finish=resolve;}):path==='/auth'?ok({}):ok({files:[file()],nextCursor:null}));
  await settle();const logout=ui.fire('sign-out');await settle();
  assert.equal(ui.get('file-list').children.length,0);
  assert.equal(ui.get('member-view').hidden,true);
  finish(ok({}));await logout;
});
test('opaque cursors are encoded without interpreting their contents',async()=>{
  const cursor='page /?&=+#';
  const ui=setup(path=>path==='/auth'?ok({}):ok({files:[file()],nextCursor:cursor}));
  await settle();await ui.fire('files-more');
  assert.equal(ui.calls.at(-1).path,'/files?cursor='+encodeURIComponent(cursor));
});
test('network and malformed JSON errors do not claim an empty folder',async()=>{
  for(const result of [()=>{throw new Error('offline');},()=>({ok:true,status:200,json:async()=>{throw new Error('bad json');}})]) {
    const ui=setup(path=>path==='/auth'?ok({}):result());await settle();
    assert.match(ui.get('files-status').textContent,/unavailable/i);
    assert.doesNotMatch(ui.get('files-status').textContent,/no files/i);
    assert.equal(ui.get('files-refresh').disabled,false);
  }
});
test('member-only Files section follows upload, with accessible controls and responsive styles',async()=>{
  const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../docs/style.css',import.meta.url),'utf8');
  assert.match(html,/<div[^>]*id="member-view"[^>]*hidden>[\s\S]*id="upload-form"[\s\S]*<section[^>]*aria-labelledby="files-heading"/);
  for(const id of ['files-refresh','files-more']) assert.match(html,new RegExp(`<button[^>]*id="${id}"[^>]*type="button"`));
  assert.match(html,/id="files-status"[^>]*role="status"/);
  assert.match(html,/id="files-more"[^>]*hidden/);
  assert.match(css,/\.file-list/);assert.match(css,/overflow-wrap:anywhere/);
});
test('anonymous startup never lists files; successful login does',async()=>{
  const ui=setup((path,options)=>path==='/auth'?options?ok({}):{ok:false,status:401}:ok({files:[],nextCursor:null}));
  await settle();assert.equal(ui.calls.filter(c=>c.path.startsWith('/files')).length,0);
  await ui.fire('login-form','submit');
  assert.equal(ui.calls.filter(c=>c.path==='/files').length,1);
  assert.match(ui.get('files-status').textContent,/no files/i);
});
