import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const tick=async()=>{for(let i=0;i<20;i++) await Promise.resolve();};
function node(tag='div') {return {tagName:tag.toUpperCase(),children:[],style:{},attrs:{},handlers:{},width:0,height:0,textContent:'',setAttribute(k,v){this.attrs[k]=v;},append(...n){this.children.push(...n);},replaceChildren(...n){this.children=n;},addEventListener(k,v){this.handlers[k]=v;},getContext(){return {};}};}
async function setup({pages=2,load,render,width=10000,height=8000}={}) {
 const code=await readFile(new URL('../docs/pdf-preview.js',import.meta.url),'utf8').catch(()=> '');
 const context={document:{createElement:node},console,Uint8Array};vm.runInNewContext(code,context);
 assert.equal(typeof context.renderFamilyPdf,'function','classic helper must export renderFamilyPdf');
 const calls={pages:[],renders:[],canvases:[],destroyed:0,cancelled:0,taskDestroyed:0};
 const doc={numPages:pages,destroy(){calls.destroyed++;return Promise.resolve();},async getPage(n){calls.pages.push(n);return {getViewport({scale}){return {width:width*scale,height:height*scale};},render(opts){calls.renders.push(opts);return render?render(calls):{promise:Promise.resolve(),cancel(){calls.cancelled++;}};},cleanup(){}};}};
 const lib={GlobalWorkerOptions:{},AnnotationMode:{DISABLE:0},getDocument(opts){calls.options=opts;return {promise:load||Promise.resolve(doc),destroy(){calls.taskDestroyed++;return Promise.resolve();}};}};
 const container=node(),abort=new AbortController();
 const handle=context.renderFamilyPdf({data:new Uint8Array([37,80,68,70]),container,signal:abort.signal,isCurrent:()=>!abort.signal.aborted},{loadLibrary:async()=>lib,createCanvas:()=>{const c=node('canvas');calls.canvases.push(c);return c;}});
 return {calls,doc,lib,container,abort,handle};
}
test('PDF integration loads the same-origin classic helper before app and pins verified vendor bytes',async()=>{
 const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
 assert.match(html,/<script src="\/pdf-preview.js" defer><\/script>[\s\S]*<script src="\/app.js" defer>/);
 const helper=await readFile(new URL('../docs/pdf-preview.js',import.meta.url),'utf8');
 assert.match(helper,/import\('\/vendor\/pdfjs\/pdf.mjs'\)/);
 const {createHash}=await import('node:crypto');
 const manifest=JSON.parse(await readFile(new URL('../docs/vendor/pdfjs/provenance.json',import.meta.url),'utf8'));
 assert.equal(manifest.version,'6.5.438');assert.equal(manifest.integrity,'sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==');
 for(const [name,hash] of Object.entries(manifest.sha256)) assert.equal(createHash('sha256').update(await readFile(new URL('../docs/vendor/pdfjs/'+name,import.meta.url))).digest('hex'),hash);
 assert.ok(manifest.sha256['pdf.mjs']);assert.ok(manifest.sha256['pdf.worker.mjs']);assert.ok(manifest.sha256.LICENSE);assert.ok(Object.keys(manifest.sha256).some(n=>n.startsWith('standard_fonts/')));
});
test('PDF abort cancels rendering, destroys ownership and zeros pixels even after stale completion',async()=>{
 let finish;
 const s=await setup({render(calls){return {promise:new Promise(resolve=>{finish=resolve;}),cancel(){calls.cancelled++;}};}});
 await tick();assert.equal(s.calls.canvases.length,1);
 s.abort.abort();assert.equal(s.calls.cancelled,1);assert.equal(s.calls.destroyed,1);
 assert.equal(s.calls.canvases[0].width,0);assert.equal(s.container.children.length,0);
 finish();await s.handle.ready;s.handle.destroy();assert.equal(s.calls.destroyed,1);assert.equal(s.container.children.length,0);assert.equal(s.calls.canvases[0].height,0);
});
test('PDF abort during loading destroys task and rejects late private DOM, including detached controls',async()=>{
 let finish;
 const s=await setup({load:new Promise(resolve=>{finish=resolve;})});await tick();s.abort.abort();assert.equal(s.calls.taskDestroyed,1);
 finish(s.doc);await s.handle.ready;assert.equal(s.calls.destroyed,1);assert.deepEqual(s.calls.pages,[]);assert.equal(s.container.children.length,0);
 const loaded=await setup();await loaded.handle.ready;const next=loaded.container.children[1].children[2];loaded.abort.abort();await next.handlers.click();assert.deepEqual(loaded.calls.pages,[1]);assert.equal(loaded.container.children.length,0);
});
test('PDF navigation renders one page at a time with bounded Previous/Next controls',async()=>{
 const s=await setup();await s.handle.ready;
 const controls=s.container.children.find(n=>n.tagName==='DIV');assert.ok(controls,'page controls');
 const [previous,label,next]=controls.children;assert.equal(previous.textContent,'Previous');assert.equal(next.textContent,'Next');assert.equal(label.textContent,'Page 1 of 2');assert.equal(previous.disabled,true);
 await next.handlers.click();assert.deepEqual(s.calls.pages,[1,2]);assert.equal(label.textContent,'Page 2 of 2');assert.equal(next.disabled,true);
 assert.equal(s.calls.canvases[0].width,0);assert.equal(s.calls.canvases[0].height,0);
 await next.handlers.click();assert.deepEqual(s.calls.pages,[1,2]);
 await previous.handlers.click();assert.deepEqual(s.calls.pages,[1,2,1]);
});
test('extreme-width and extreme-height PDF pages scale the viewport before canvas limits',async()=>{
 for(const [width,height] of [[14000,10],[10,14000],[1000000,1],[1,1000000]]) {
  const s=await setup({width,height});await s.handle.ready;
  const canvas=s.calls.canvases[0],viewport=s.calls.renders[0].viewport;
  assert.ok(viewport.width<=16384 && viewport.height<=16384,'viewport must fit dimension limit');
  assert.ok(viewport.width<canvas.width+1 && viewport.height<canvas.height+1,'only subpixel rounding may be cropped');
  assert.ok(canvas.width*canvas.height<=4_000_000);
  s.handle.destroy();
 }
});
test('PDF canvas-only rendering is bounded and disables active PDF features',async()=>{
 const s=await setup();await s.handle.ready;
 assert.equal(s.calls.options.isEvalSupported,false);assert.equal(s.calls.options.enableXfa,false);assert.equal(s.calls.options.useSystemFonts,true);
 assert.equal(s.calls.options.standardFontDataUrl,'/vendor/pdfjs/standard_fonts/');assert.equal(s.lib.GlobalWorkerOptions.workerSrc,'/vendor/pdfjs/pdf.worker.mjs');
 assert.ok(s.calls.options.data instanceof Uint8Array);assert.equal(s.calls.renders[0].annotationMode,0);
 const canvas=s.calls.canvases[0];assert.ok(canvas.width*canvas.height<=4_000_000);assert.ok(canvas.width>0);
 assert.deepEqual(s.calls.pages,[1]);
 const tags=s.container.children.flatMap(n=>[n,...n.children]).map(n=>n.tagName);assert.ok(tags.includes('CANVAS'));assert.ok(!tags.some(t=>['IFRAME','A','SCRIPT'].includes(t)));
});
