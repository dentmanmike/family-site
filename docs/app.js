const $ = id => document.getElementById(id);
function status(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
let authenticated = false, generation = 0, nextCursor = null, authPending = false;
function setAuthPending(pending) {
 authPending = pending;
 $('sign-in').disabled = pending; $('sign-out').disabled = pending; $('retry-sign-out').disabled = pending;
}
function view(member) {
 authenticated = member; generation++;
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
 const requestGeneration = ++generation;
 const current = () => authenticated && generation === requestGeneration;
 $('files-refresh').disabled = true; $('files-more').disabled = true;
 status('files-status', 'Loading files…');
 try {
 const response = await fetch('/files' + (more && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''));
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
 for (const file of page.files) {
  const row = document.createElement('li');
  const name = document.createElement('span'); name.textContent = file.name;
  const size = document.createElement('span'); size.textContent = `${file.bytes.toLocaleString()} bytes`;
  const date = document.createElement('time'); date.dateTime = file.modified; date.textContent = new Date(file.modified).toLocaleString();
  const link = document.createElement('a'); link.href = `/file?id=${encodeURIComponent(file.id)}`; link.textContent = 'Download';
  row.append(name, size, date, link); $('file-list').appendChild(row);
 }
 nextCursor = page.nextCursor; $('files-more').hidden = !nextCursor;
 status('files-status', $('file-list').children.length ? '' : 'No files yet. Share a memory above.');
 } catch { if (current()) status('files-status', 'Files are unavailable. Check your connection, home computer and External1 drive, then Refresh.', true); }
 finally { if (current()) { $('files-refresh').disabled = false; $('files-more').disabled = false; } }
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
