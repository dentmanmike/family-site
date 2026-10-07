const $ = id => document.getElementById(id);
function status(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function view(member) { $('login-view').hidden = member; $('member-view').hidden = !member; }
$('show-password').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('show-password').textContent = show ? 'Hide' : 'Show'; $('show-password').setAttribute('aria-pressed', String(show)); $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
$('login-form').addEventListener('submit', async event => {
 event.preventDefault(); $('sign-in').disabled = true; status('login-status', 'Signing you in…');
 try { const response = await fetch('/auth', {method:'POST', body:new FormData(event.target)});
 if (!response.ok) { status('login-status', response.status === 401 ? 'That username or password wasn’t recognized. Please try again.' : 'Sign-in is unavailable right now. Please try again later.', true); return; }
 $('password').value = ''; status('login-status', ''); view(true); $('member-view').querySelector('h1').setAttribute('tabindex','-1'); $('member-view').querySelector('h1').focus();
 } catch { status('login-status', 'Could not connect. Check your connection and try again.', true); } finally { $('sign-in').disabled = false; }
});
$('sign-out').addEventListener('click', async () => { $('sign-out').disabled = true; try { const r = await fetch('/auth?logout=1', {method:'POST'}); if (!r.ok) throw new Error(); view(false); $('upload-form').reset(); status('upload-status',''); $('username').focus(); } catch { status('upload-status','Could not sign out. Please try again.',true); } finally { $('sign-out').disabled = false; } });
$('upload-form').addEventListener('submit', async event => {
 event.preventDefault(); const file = $('file').files[0]; if (!file || file.size > 25 * 1024 * 1024) { status('upload-status','Please choose a file smaller than 25 MB.',true); return; }
 $('upload-button').disabled = true; status('upload-status','Uploading your memory…');
 try { const r = await fetch('/upload', {method:'POST',body:new FormData(event.target)}); if (r.status === 401) { view(false); status('login-status','Your session has ended. Please sign in again.',true); return; } if (!r.ok) throw new Error(); status('upload-status','Saved to our family collection.'); event.target.reset(); } catch { status('upload-status','Upload did not finish. Please try again.',true); } finally { $('upload-button').disabled = false; }
});
(async () => { $('sign-in').disabled = true; try { const r = await fetch('/auth'); if (r.ok) view(true); else if (r.status !== 401) status('login-status','Sign-in is unavailable right now. Please try again later.',true); } catch { status('login-status','Could not connect. Please try again.',true); } finally { $('sign-in').disabled = false; } })();
