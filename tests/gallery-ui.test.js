import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const helperSource = await readFile(new URL('../docs/pdf-preview.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../docs/app.js', import.meta.url), 'utf8');
const settle = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const ok = data => ({ok:true,status:200,json:async()=>data});
const file = (id='YWJj',name='<img src=x onerror=alert(1)>.txt') => ({id,name,bytes:1234,modified:'2026-11-11T12:00:00.000Z'});
function setup(route, extras = {}) {
  const elements = new Map(), calls = [];
  function element(tag='div') {
    return {tagName:tag.toUpperCase(),_text:'',get textContent(){return this._text+this.children.map(n=>n.textContent).join('');},set textContent(value){this._text=String(value);this.children=[];},children:[],hidden:false,disabled:false,value:'',files:[{size:4}],handlers:{},attrs:{},classList:{toggle(){}},
      addEventListener(event,fn){this.handlers[event]=fn;},setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];delete this[key];},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},pause(){this.paused=true;},load(){this.loaded=true;},reset(){},querySelector(){return this;},
      appendChild(child){this.children.push(child);return child;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
      set innerHTML(value){throw new Error('Unsafe innerHTML: '+value);}};
  }
  const get = id => {if(!elements.has(id)) elements.set(id,element());return elements.get(id);};
  const blobs = new Map(), revoked = [];
  const context=vm.createContext({document:{getElementById:get,createElement:element,body:element('body')},Blob,TextDecoder,AbortController,URL:{createObjectURL(blob){const url='blob:private-'+blobs.size;blobs.set(url,blob);return url;},revokeObjectURL(url){revoked.push(url);}},FormData:class{},fetch:async(path,options)=>{calls.push({path,options});return route(path,options);},console,Date,Number,encodeURIComponent});
  vm.runInContext(helperSource,context);Object.assign(context,extras);vm.runInContext(source,context);
  const fire = async (id,event='click') => {await get(id).handlers[event]({preventDefault(){},target:get(id)});await settle();};
  return {get,calls,fire,blobs,revoked};
}
function descendants(node) {return [node,...node.children.flatMap(descendants)];}
test('failed Refresh clears stale pagination so Load more cannot skip the first page',async()=>{
 let failed=false;
 const ui=setup(path=>path==='/auth'?ok({}):failed?{ok:false,status:503}:ok({files:[file()],nextCursor:'old_page_2'}));
 await settle();assert.equal(ui.get('files-more').hidden,false);
 failed=true;await ui.fire('files-refresh');assert.equal(ui.get('files-more').hidden,true);
 await ui.fire('files-more');assert.equal(ui.calls.some(c=>c.path==='/files?cursor=old_page_2'),false);
});
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
test('member collection precedes upload and uses a full-width signed-in responsive gallery',async()=>{
  const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../docs/style.css',import.meta.url),'utf8');
  assert.match(html,/<div[^>]*id="member-view"[^>]*hidden>[\s\S]*<section[^>]*aria-labelledby="files-heading"[\s\S]*id="upload-form"/);
  assert.match(css,/\.signed-in \.memories\s*\{display:none/);
  assert.match(css,/\.signed-in \.welcome\s*\{grid-template-columns:1fr/);
  assert.match(css,/#member-view\s*\{max-width:none/);
  assert.match(css,/grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,/);
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

const picture = (id='a', name='memory.png', bytes=4) => ({...file(id,name),bytes});
const bytesResponse = (bytes=4) => new Response(new Uint8Array(bytes), {headers:{'Content-Type':'application/octet-stream'}});
const tileButton = ui => descendants(ui.get('file-list')).find(n=>n.tagName==='BUTTON');
test('logout aborts pending authenticated listings instead of only ignoring their data',async()=>{
 let finish;
 const ui=setup(path=>path.startsWith('/auth')?ok({}):new Promise(resolve=>{finish=resolve;}));
 await settle();const request=ui.calls.find(c=>c.path==='/files');
 await ui.fire('sign-out');assert.equal(request.options?.signal.aborted,true);
 finish(ok({files:[picture()],nextCursor:null}));await settle();assert.equal(ui.get('file-list').children.length,0);
});
test('detached tile actions after logout or refresh cannot recreate private dialogs',async()=>{
 for(const action of ['sign-out','files-refresh']) {
  const ui=setup(path=>path.startsWith('/auth')?ok({}):ok({files:[picture('a','notes.txt')],nextCursor:null}));
  await settle();const old=tileButton(ui);await ui.fire(action);await old.handlers.click();await settle();
  assert.ok(!ui.get('file-dialog').open);assert.equal(ui.get('preview-name').textContent,'');
 }
});
test('restored session automatically displays typed safe raster thumbnails, never active file types',async()=>{
  for(const [ext,type] of [['png','image/png'],['JPG','image/jpeg'],['jpeg','image/jpeg'],['gif','image/gif'],['webp','image/webp'],['avif','image/avif']]) {
    const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture('a','photo.'+ext)],nextCursor:null}):bytesResponse());
    await settle();await settle();
    assert.equal(ui.calls.filter(c=>c.path==='/file?id=a').length,1);
    const image=descendants(ui.get('file-list')).find(n=>n.tagName==='IMG');
    assert.ok(image?.src.startsWith('blob:private-'));
    assert.equal(ui.blobs.get(image.src).type,type);
  }
  for(const ext of ['svg','html','pdf','wav','mp4','txt','zip']) {
    const ui=setup(path=>path==='/auth'?ok({}):ok({files:[picture('a','file.'+ext)],nextCursor:null}));
    await settle();assert.equal(ui.calls.filter(c=>c.path.startsWith('/file?')).length,0);
    assert.ok(tileButton(ui));
  }
});

test('thumbnails enforce metadata and streamed byte bounds without unbounded blob buffering',async()=>{
 const limit=25*1024*1024;
 const oversized=setup(path=>path==='/auth'?ok({}):ok({files:[picture('a','large.png',limit+1)],nextCursor:null}));
 await settle();assert.equal(oversized.calls.filter(c=>c.path.startsWith('/file?')).length,0);
 for(const [expected,chunks] of [[4,[new Uint8Array(5)]],[4,[new Uint8Array(3)]],[limit,[new Uint8Array(limit),new Uint8Array(1)]]]) {
  let cancelled=false, reads=0;
  const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture('a','bad.png',expected)],nextCursor:null}):{
   ok:true,status:200,blob(){throw Error('Unbounded blob() prohibited');},body:{getReader(){return {async read(){reads++;return chunks.length?{value:chunks.shift(),done:false}:{done:true};},async cancel(){cancelled=true;},releaseLock(){}};}}
  });
  await settle();await settle();assert.equal(ui.blobs.size,0);
  assert.match(descendants(ui.get('file-list')).map(n=>n.textContent).join(' '),/unavailable|download|refresh/i);
  assert.ok(cancelled,'invalid stream is cancelled');assert.ok(reads<=3);
 }
});

test('visible thumbnails use IntersectionObserver and at most two active requests',async()=>{
 let callback, observed=[], waiting=[], active=0, peak=0;
 const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:['a','b','c','d'].map(id=>picture(id)),nextCursor:null}):new Promise(resolve=>{
  active++;peak=Math.max(peak,active);waiting.push(()=>{active--;resolve(bytesResponse());});
 }),{IntersectionObserver:class {constructor(fn){callback=fn;}observe(node){observed.push(node);}unobserve(){}disconnect(){}}});
 await settle();assert.equal(ui.calls.filter(c=>c.path.startsWith('/file?')).length,0);
 assert.equal(observed.length,4);callback(observed.map(target=>({target,isIntersecting:true})));
 await settle();assert.equal(active,2);assert.equal(waiting.length,2);
 waiting.shift()();await settle();await settle();assert.equal(active,2);
 while(waiting.length) {waiting.shift()();await settle();await settle();}
 assert.equal(peak,2);assert.equal(ui.blobs.size,4);
});

test('logout and refresh revoke private blobs and abort stale thumbnail results',async()=>{
 for(const action of ['sign-out','files-refresh']) {
  let finish, pending=false, oldImage;
  const ui=setup(path=>path.startsWith('/auth')?ok({}):path==='/files'?ok({files:[picture()],nextCursor:null}):pending?new Promise(resolve=>{finish=resolve;}):bytesResponse());
  await settle();await settle();oldImage=descendants(ui.get('file-list')).find(n=>n.tagName==='IMG');
  const oldUrl=oldImage.src;pending=true;await ui.fire('files-refresh');await settle();
  const request=ui.calls.filter(c=>c.path.startsWith('/file?')).at(-1);
  const finishStale=finish;
  await ui.fire(action);assert.ok(ui.revoked.includes(oldUrl));assert.ok(!oldImage.src);
  assert.equal(request.options.signal.aborted,true);
  const count=ui.blobs.size;finishStale(bytesResponse());await settle();await settle();assert.equal(ui.blobs.size,count);
 }
});
test('thumbnail 401 returns to sign-in and clears private content',async()=>{
 const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture()],nextCursor:null}):{ok:false,status:401});
 await settle();await settle();assert.equal(ui.get('member-view').hidden,true);
 assert.equal(ui.get('file-list').children.length,0);assert.match(ui.get('login-status').textContent,/session.*ended/i);
});

test('photo tile opens an accessible in-page image dialog with attachment download and close cleanup',async()=>{
 const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
 assert.match(html,/<dialog[^>]*id="file-dialog"[^>]*aria-labelledby="preview-name"/);
 assert.match(html,/<button[^>]*id="preview-close"[^>]*type="button"/);
 const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture('a','family.png')],nextCursor:null}):bytesResponse());
 await settle();await settle();const button=tileButton(ui);await button.handlers.click();await settle();await settle();
 assert.equal(ui.get('file-dialog').open,true);assert.equal(ui.get('preview-name').textContent,'family.png');
 assert.equal(ui.get('preview-download').href,'/file?id=a');
 const image=descendants(ui.get('preview-body')).find(n=>n.tagName==='IMG');assert.ok(image?.src.startsWith('blob:'));
 const url=image.src;await ui.fire('preview-close');assert.equal(ui.get('file-dialog').open,false);
 assert.equal(ui.get('preview-body').children.length,0);assert.ok(ui.revoked.includes(url));assert.ok(!image.src);assert.equal(button.focused,true);
});

test('audio and video fetch only on click, expose controls without autoplay, and release media on close/logout',async()=>{
 for(const [ext,tag,mime,action] of [['wav','AUDIO','audio/wav','preview-close'],['mp3','AUDIO','audio/mpeg','sign-out'],['mp4','VIDEO','video/mp4','preview-close'],['webm','VIDEO','video/webm','sign-out']]) {
  const ui=setup(path=>path.startsWith('/auth')?ok({}):path==='/files'?ok({files:[picture('a','file.'+ext)],nextCursor:null}):bytesResponse());
  await settle();assert.equal(ui.calls.filter(c=>c.path.startsWith('/file?')).length,0);
  await tileButton(ui).handlers.click();await settle();
  const media=descendants(ui.get('preview-body')).find(n=>n.tagName===tag);assert.ok(media);
  assert.equal(media.controls,true);assert.ok(!media.autoplay);assert.equal(ui.blobs.get(media.src).type,mime);
  const url=media.src;await ui.fire(action);assert.equal(media.paused,true);assert.equal(media.loaded,true);assert.ok(!media.src);assert.ok(ui.revoked.includes(url));
 }
});

test('UTF-8 text is literal textContent and bounded to one MiB, with invalid UTF-8 rejected',async()=>{
 const text='<script>alert("private")</script> café', encoded=new TextEncoder().encode(text);
 for(const [bytes,size,valid] of [[encoded,encoded.length,true],[new Uint8Array([255]),1,false],[null,1024*1024+1,false]]) {
  const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture('a','notes.txt',size)],nextCursor:null}):new Response(bytes));
  await settle();await tileButton(ui).handlers.click();await settle();
  if(valid) {const pre=descendants(ui.get('preview-body')).find(n=>n.tagName==='PRE');assert.equal(pre?.textContent,text);}
  else {assert.equal(ui.get('preview-body').children.length,0);assert.match(ui.get('preview-status').textContent,/download|unavailable/i);}
  if(!bytes) assert.equal(ui.calls.filter(c=>c.path.startsWith('/file?')).length,0);
 }
});

test('PDF uses the canvas helper only after magic validation, never a native iframe or blob URL',async()=>{
 for(const valid of [true,false]) {
  const bytes=new TextEncoder().encode(valid?'%PDF-1.7\nfixture':'<html>not a PDF');
  let options, destroyed=0;
  const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture('a','document.pdf',bytes.length)],nextCursor:null}):new Response(bytes),{
   renderFamilyPdf(value){options=value;return {ready:Promise.resolve(),destroy(){destroyed++;}};}
  });
  await settle();assert.equal(options,undefined);
  await tileButton(ui).handlers.click();await settle();
  assert.equal(descendants(ui.get('preview-body')).some(n=>n.tagName==='IFRAME'),false);
  assert.equal(ui.blobs.size,0);
  if(valid) {assert.deepEqual([...options.data],[...bytes]);assert.equal(options.container,ui.get('preview-body'));await ui.fire('preview-close');assert.equal(destroyed,1);assert.equal(options.signal.aborted,true);assert.equal(options.isCurrent(),false);}
  else {assert.equal(options,undefined);assert.match(ui.get('preview-status').textContent,/unavailable.*download/i);}
 }
});
test('PDF close, logout and refresh destroy a pending helper before any late completion',async()=>{
 for(const action of ['preview-close','sign-out','files-refresh']) {
  const bytes=new TextEncoder().encode('%PDF-1.7\nfixture');let finish,options,destroyed=0;
  const ui=setup(path=>path.startsWith('/auth')?ok({}):path==='/files'?ok({files:[picture('a','private.pdf',bytes.length)],nextCursor:null}):new Response(bytes),{
   renderFamilyPdf(value){options=value;return {ready:new Promise(resolve=>{finish=resolve;}),destroy(){destroyed++;}};}
  });
  await settle();const opening=tileButton(ui).handlers.click();await settle();await settle();
  assert.ok(options);await ui.fire(action);assert.equal(destroyed,1);assert.equal(options.signal.aborted,true);assert.equal(options.isCurrent(),false);
  finish();await opening;assert.equal(ui.get('preview-body').children.length,0);assert.equal(ui.get('preview-status').textContent,'');assert.equal(ui.get('file-dialog').open,false);
 }
});
test('unsafe, unknown, and oversized files remain attachment-only even on preview click',async()=>{
 for(const [name,size] of [['x.svg',4],['x.html',4],['x.exe',4],['x.png.exe',4],['x.constructor',4],['x.__proto__',4],['x.toString',4],['x.png',25*1024*1024+1]]) {
  const ui=setup(path=>path==='/auth'?ok({}):ok({files:[picture('a',name,size)],nextCursor:null}));
  await settle();await tileButton(ui).handlers.click();await settle();
  assert.equal(ui.calls.filter(c=>c.path.startsWith('/file?')).length,0);assert.equal(ui.blobs.size,0);
  assert.match(ui.get('preview-status').textContent,/download only/i);assert.equal(ui.get('preview-download').href,'/file?id=a');
 }
});

test('image decoder errors replace thumbnails with a recoverable icon and previews with download guidance',async()=>{
 const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture()],nextCursor:null}):bytesResponse());
 await settle();await settle();let image=descendants(ui.get('file-list')).find(n=>n.tagName==='IMG'), url=image.src;
 assert.ok(image.handlers.error);image.handlers.error();
 assert.ok(!image.src);assert.ok(ui.revoked.includes(url));
 assert.equal(descendants(ui.get('file-list')).some(n=>n.tagName==='IMG'),false);
 assert.match(descendants(ui.get('file-list')).map(n=>n.textContent).join(' '),/Photo.*unavailable.*Refresh/i);
 await tileButton(ui).handlers.click();await settle();image=descendants(ui.get('preview-body')).find(n=>n.tagName==='IMG');url=image.src;
 image.handlers.error();assert.ok(!image.src);assert.ok(ui.revoked.includes(url));
 assert.equal(ui.get('preview-body').children.length,0);assert.match(ui.get('preview-status').textContent,/unavailable.*Download/i);
});
test('closing or expiring a pending preview aborts it and late bytes cannot reopen private content',async()=>{
 for(const action of ['preview-close','sign-out','files-refresh']) {
  let finish;
  const ui=setup(path=>path.startsWith('/auth')?ok({}):path==='/files'?ok({files:[picture('a','voice.wav')],nextCursor:null}):new Promise(resolve=>{finish=resolve;}));
  await settle();const opening=tileButton(ui).handlers.click();await settle();const request=ui.calls.at(-1);
  await ui.fire(action);assert.equal(request.options.signal.aborted,true);
  finish(bytesResponse());await opening;await settle();assert.equal(ui.blobs.size,0);assert.equal(ui.get('file-dialog').open,false);assert.equal(ui.get('preview-name').textContent,'');
 }
 const ui=setup(path=>path==='/auth'?ok({}):path==='/files'?ok({files:[picture('a','voice.wav')],nextCursor:null}):{ok:false,status:401});
 await settle();await tileButton(ui).handlers.click();assert.equal(ui.get('member-view').hidden,true);assert.equal(ui.get('file-dialog').open,false);assert.equal(ui.get('file-list').children.length,0);
});
