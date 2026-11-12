const $ = id => document.getElementById(id);
function status(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
let authenticated = false, generation = 0, nextCursor = null, authPending = false;
function setAuthPending(pending) {
 authPending = pending;
 $('sign-in').disabled = pending; $('sign-out').disabled = pending; $('retry-sign-out').disabled = pending;
}

// Extension allowlist determines the decoder, never the attachment's octet-stream MIME.
const PREVIEW_LIMIT = 25 * 1024 * 1024;
const rasterTypes = Object.assign(Object.create(null), {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif'});
const audioTypes = Object.assign(Object.create(null), {wav:'audio/wav',mp3:'audio/mpeg',ogg:'audio/ogg',oga:'audio/ogg',m4a:'audio/mp4',flac:'audio/flac'});
const videoTypes = Object.assign(Object.create(null), {mp4:'video/mp4',webm:'video/webm',ogv:'video/ogg'});
function fileType(file) {
 const extension = file.name.split('.').pop().toLowerCase();
 if (extension === 'pdf') return {kind:'pdf',mime:'application/pdf',label:'PDF'};
 if (['txt','md','csv','log','json'].includes(extension)) return {kind:'text',mime:'text/plain',label:'Text'};
 if (audioTypes[extension]) return {kind:'audio',mime:audioTypes[extension],label:'Audio'};
 if (videoTypes[extension]) return {kind:'video',mime:videoTypes[extension],label:'Video'};
 return {kind:rasterTypes[extension] ? 'image' : 'file', mime:rasterTypes[extension], label:rasterTypes[extension] ? 'Photo' : 'File'};
}
let galleryEpoch = 0, listController = null;
const privateUrls = new Set(), privateImages = new Set(), fileRequests = new Set();
function privateUrl(blob) { const url = URL.createObjectURL(blob); privateUrls.add(url); return url; }
function releaseUrl(url) { if (privateUrls.delete(url)) URL.revokeObjectURL(url); }
function clearGallery() {
 galleryEpoch++;
 if (listController) listController.abort();
 listController = null;
 closePreview(false);
 thumbnailQueue.length = 0;
 if (thumbnailObserver) thumbnailObserver.disconnect();
 for (const controller of fileRequests) controller.abort();
 fileRequests.clear();
 for (const image of privateImages) image.removeAttribute('src');
 privateImages.clear();
 for (const url of privateUrls) URL.revokeObjectURL(url);
 privateUrls.clear();
}
function expireSession() { view(false); status('login-status', 'Your session has ended. Please sign in again.', true); }
async function attachment(file, mime, epoch, controller = new AbortController()) {
 const limit = mime === 'text/plain' ? 1024 * 1024 : PREVIEW_LIMIT;
 if (file.bytes > limit) throw new Error('Download only above 25 MiB');
 fileRequests.add(controller);
 let reader;
 const current = () => authenticated && epoch === galleryEpoch && !controller.signal.aborted;
 try {
 const response = await fetch(`/file?id=${encodeURIComponent(file.id)}`, {signal:controller.signal});
 if (!current()) { if (response.body) await response.body.cancel(); throw new Error('Stale file'); }
 if (response.status === 401) { expireSession(); throw new Error('Session ended'); }
 if (!response.ok) throw new Error('File unavailable');
 reader = response.body.getReader();
 const chunks = []; let bytes = 0;
  while (true) {
   const {done,value} = await reader.read();
   if (!current()) throw new Error('Stale file');
   if (done) break;
   bytes += value.byteLength;
   if (bytes > limit || bytes > file.bytes) throw new Error('File exceeds preview size');
   chunks.push(value);
  }
  if (bytes !== file.bytes) throw new Error('File size changed. Refresh to try again.');
  return new Blob(chunks, {type:mime});
 } catch (error) { if (reader) await reader.cancel().catch(() => {}); throw error; }
 finally { if (reader) reader.releaseLock(); fileRequests.delete(controller); }
}
let thumbnailActive = 0;
const thumbnailQueue = [];
function pumpThumbnails() {
 while (thumbnailActive < 2 && thumbnailQueue.length) {
  const task = thumbnailQueue.shift(); thumbnailActive++;
  task().finally(() => { thumbnailActive--; pumpThumbnails(); });
 }
}
const thumbnailObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
 for (const entry of entries) if (entry.isIntersecting) {
  thumbnailObserver.unobserve(entry.target);
  entry.target.loadThumbnail();
 }
}, {rootMargin:'200px'}) : null;
function scheduleThumbnail(visual, task) {
 let queued = false;
 visual.loadThumbnail = () => { if (queued) return; queued = true; thumbnailQueue.push(task); pumpThumbnails(); };
 if (thumbnailObserver) thumbnailObserver.observe(visual); else visual.loadThumbnail();
}
let previewVersion = 0, previewController = null, previewNode = null, previewUrl = null, previewTrigger = null, pdfPreview = null;
function closePreview(restoreFocus = true) {
 previewVersion++;
 if (previewController) previewController.abort();
 previewController = null;
 if (pdfPreview) pdfPreview.destroy();
 pdfPreview = null;
 if (previewNode) {
  if (previewNode.tagName === 'AUDIO' || previewNode.tagName === 'VIDEO') { previewNode.pause(); previewNode.removeAttribute('src'); previewNode.load(); }
  else previewNode.removeAttribute('src');
  privateImages.delete(previewNode);
 }
 previewNode = null;
 if (previewUrl) releaseUrl(previewUrl);
 previewUrl = null;
 $('preview-body').replaceChildren(); $('preview-name').textContent = ''; $('preview-status').textContent = '';
 $('preview-download').removeAttribute('href');
 if ($('file-dialog').open) $('file-dialog').close();
 if (restoreFocus && previewTrigger) previewTrigger.focus();
 previewTrigger = null;
}
async function openPreview(file, trigger) {
 closePreview(false);
 previewTrigger = trigger;
 const version = previewVersion, epoch = galleryEpoch, type = fileType(file);
 const current = () => authenticated && epoch === galleryEpoch && version === previewVersion;
 $('preview-name').textContent = file.name;
 $('preview-download').href = `/file?id=${encodeURIComponent(file.id)}`;
 $('file-dialog').showModal();
 if (type.kind === 'file' || file.bytes > (type.kind === 'text' ? 1024 * 1024 : PREVIEW_LIMIT)) { status('preview-status','Download only: this file type or size cannot be safely previewed.'); return; }
 status('preview-status','Loading preview…');
 previewController = new AbortController();
 try {
  const blob = await attachment(file,type.mime,epoch,previewController);
  if (!current()) return;
  if (type.kind === 'text') {
   const text = new TextDecoder('utf-8', {fatal:true}).decode(await blob.arrayBuffer());
   if (!current()) return;
   const pre = document.createElement('pre'); pre.textContent = text;
   $('preview-body').appendChild(pre); status('preview-status',''); return;
  }
  if (type.kind === 'pdf') {
   if (await blob.slice(0,5).text() !== '%PDF-') throw new Error('Not a PDF');
   const data = new Uint8Array(await blob.arrayBuffer());
   if (!current()) return;
   pdfPreview = renderFamilyPdf({data, container:$('preview-body'), signal:previewController.signal, isCurrent:current});
   await pdfPreview.ready;
   if (current()) status('preview-status','');
   return;
  }
  const node = document.createElement(type.kind === 'image' ? 'img' : type.kind);
  if (type.kind === 'image') { node.alt = file.name; privateImages.add(node); }
  else { node.controls = true; node.autoplay = false; node.preload = 'metadata'; node.setAttribute('aria-label',file.name); }
  previewUrl = privateUrl(blob); node.src = previewUrl; previewNode = node;
  node.addEventListener('error', () => {
   if (!current()) return;
   if (type.kind === 'audio' || type.kind === 'video') node.pause();
   node.removeAttribute('src');
   if (type.kind === 'audio' || type.kind === 'video') node.load();
   privateImages.delete(node); releaseUrl(previewUrl); previewUrl = null; previewNode = null;
   $('preview-body').replaceChildren(); status('preview-status','Preview unavailable. Close and try again, or Download a copy.',true);
  });
  $('preview-body').appendChild(node);
  status('preview-status','');
 } catch { if (current()) status('preview-status','Preview unavailable. Close and try again, or Download a copy.',true); }
}
$('preview-close').addEventListener('click', () => closePreview());
$('file-dialog').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
function fileTile(file) {
 const epoch = galleryEpoch;
 const type = fileType(file), row = document.createElement('li');
 const button = document.createElement('button'); button.type = 'button'; button.className = 'file-preview';
 const visual = document.createElement('span'); visual.className = 'file-visual'; visual.textContent = `▧ ${type.label}`;
 const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name;
 button.append(visual,name);
 button.addEventListener('click', () => { if (authenticated && epoch === galleryEpoch) return openPreview(file,button); });
 const size = document.createElement('span'); size.textContent = `${type.label} · ${file.bytes.toLocaleString()} bytes`;
 const date = document.createElement('time'); date.dateTime = file.modified; date.textContent = new Date(file.modified).toLocaleString();
 const link = document.createElement('a'); link.href = `/file?id=${encodeURIComponent(file.id)}`; link.textContent = 'Download';
 row.append(button,size,date,link);
 if (type.kind === 'image' && file.bytes <= PREVIEW_LIMIT) scheduleThumbnail(visual, async () => {
  if (!authenticated || epoch !== galleryEpoch) return;
  try {
   const blob = await attachment(file,type.mime,epoch);
   if (!authenticated || epoch !== galleryEpoch) return;
   const image = document.createElement('img'), url = privateUrl(blob); image.alt = file.name;
   image.addEventListener('error', () => {
    image.removeAttribute('src'); privateImages.delete(image); releaseUrl(url);
    if (authenticated && epoch === galleryEpoch) visual.textContent = '▧ Photo unavailable. Try Refresh or open to retry.';
   });
   image.src = url; privateImages.add(image); visual.replaceChildren(image);
  } catch { if (authenticated && epoch === galleryEpoch) visual.textContent = '▧ Photo unavailable. Try Refresh or open to retry.'; }
 });
 return row;
}

function view(member) {
 clearGallery();
 authenticated = member; generation++;
 document.body.classList.toggle('signed-in',member);
 $('login-view').hidden = member; $('member-view').hidden = !member;
 if (member) loadFiles();
 else {
  nextCursor = null; $('file-list').replaceChildren(); status('files-status', '');
  $('files-more').hidden = true; $('files-more').disabled = false; $('files-refresh').disabled = false;
 }
}
$('files-refresh').addEventListener('click', () => loadFiles());
$('files-more').addEventListener('click', () => loadFiles(true));
async function loadFiles(more = false) {
 if (!authenticated) return;
 if (!more) { clearGallery(); nextCursor = null; $('files-more').hidden = true; $('file-list').replaceChildren(); }
 if (listController) listController.abort();
 const controller = new AbortController(); listController = controller;
 const requestGeneration = ++generation;
 const current = () => authenticated && generation === requestGeneration;
 $('files-refresh').disabled = true; $('files-more').disabled = true;
 status('files-status', 'Loading files…');
 try {
 const response = await fetch('/files' + (more && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''), {signal:controller.signal});
 if (!current()) return;
 if (response.status === 401) { view(false); status('login-status', 'Your session has ended. Please sign in again.', true); return; }
 if (!response.ok) throw new Error();
 const page = await response.json();
 if (!current()) return;
 const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value);
 if (!page || !Array.isArray(page.files) || page.files.length > 100 ||
     !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 1024)) ||
     !page.files.every(file => file && validToken(file.id) && typeof file.name === 'string' &&
       Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.modified === 'string' &&
       /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(file.modified) && Number.isFinite(Date.parse(file.modified)))) throw new Error();
 if (!more) $('file-list').replaceChildren();
 for (const file of page.files) $('file-list').appendChild(fileTile(file));
 nextCursor = page.nextCursor; $('files-more').hidden = !nextCursor;
 status('files-status', $('file-list').children.length ? '' : 'No files yet. Share a memory below.');
 } catch { if (current()) status('files-status', 'Files are unavailable. Check your connection, home computer and External1 drive, then Refresh.', true); }
 finally { if (listController === controller) listController = null; if (current()) { $('files-refresh').disabled = false; $('files-more').disabled = false; } }
}
$('show-password').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('show-password').textContent = show ? 'Hide' : 'Show'; $('show-password').setAttribute('aria-pressed', String(show)); $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
$('login-form').addEventListener('submit', async event => {
 event.preventDefault(); if (authPending) return; setAuthPending(true); status('login-status', 'Signing you in…');
 try { const response = await fetch('/auth', {method:'POST', body:new FormData(event.target)});
 if (!response.ok) { status('login-status', response.status === 401 ? 'That username or password wasn’t recognized. Please try again.' : 'Sign-in is unavailable right now. Please try again later.', true); return; }
 $('password').value = ''; status('login-status', ''); view(true); $('member-view').querySelector('h1').setAttribute('tabindex','-1'); $('member-view').querySelector('h1').focus();
 } catch { status('login-status', 'Could not connect. Check your connection and try again.', true); } finally { setAuthPending(false); }
});
async function signOut() {
 if (authPending) return; setAuthPending(true); view(false); $('upload-form').reset(); status('upload-status','');
 try { const r = await fetch('/auth?logout=1', {method:'POST'}); if (!r.ok) throw new Error(); $('retry-sign-out').hidden = true; status('login-status',''); $('username').focus(); }
 catch { $('retry-sign-out').hidden = false; status('login-status','Could not confirm sign-out from the website. Please reconnect and retry sign out.',true); }
 finally { setAuthPending(false); }
}
$('sign-out').addEventListener('click', signOut);
$('retry-sign-out').addEventListener('click', signOut);
$('upload-form').addEventListener('submit', async event => {
 event.preventDefault(); const file = $('file').files[0]; if (!file || file.size > 25 * 1024 * 1024) { status('upload-status','Please choose a file smaller than 25 MB.',true); return; }
 $('upload-button').disabled = true; status('upload-status','Uploading your memory…');
 try { const r = await fetch('/upload', {method:'POST',body:new FormData(event.target)}); if (r.status === 401) { view(false); status('login-status','Your session has ended. Please sign in again.',true); return; } if (!r.ok) throw new Error(); const receipt = await r.json(); if (receipt.stored !== true || receipt.bytes !== file.size || !/^[0-9a-f]{64}$/.test(receipt.sha256 || '')) throw new Error(); status('upload-status','Saved on our home computer.'); event.target.reset(); loadFiles(); } catch { status('upload-status',"The save wasn't confirmed. Check the home PC, External1 drive, and upload folder before retrying. No cloud copy is kept.",true); } finally { $('upload-button').disabled = false; }
});
(async () => { $('sign-in').disabled = true; try { const r = await fetch('/auth'); if (r.ok) view(true); else if (r.status !== 401) status('login-status','Sign-in is unavailable right now. Please try again later.',true); } catch { status('login-status','Could not connect. Please try again.',true); } finally { $('sign-in').disabled = false; } })();
