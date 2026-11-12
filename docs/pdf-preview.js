// Canvas-only PDF preview: never instantiate viewer, text, annotation or scripting layers.
(() => {
 const MAX_PIXELS = 4_000_000;
 let library;
 const loadLibrary = () => library ||= import('/vendor/pdfjs/pdf.mjs');
 globalThis.renderFamilyPdf = ({data, container, signal, isCurrent}, injected = {}) => {
  let pdf, lib, loadingTask, renderTask, canvas, pageNumber = 1, busy = false, destroyed = false, pdfDestroyed = false;
  const current = () => !destroyed && !signal.aborted && isCurrent();
  const controls = document.createElement('div'), previous = document.createElement('button'), label = document.createElement('span'), next = document.createElement('button');
  previous.type = next.type = 'button'; previous.textContent = 'Previous'; next.textContent = 'Next';
  label.setAttribute('role','status'); controls.className = 'pdf-controls'; controls.append(previous,label,next);
  const wipe = () => { if (canvas) canvas.width = canvas.height = 0; };
  // Teardown promises must never leak rejected worker shutdowns into the page.
  const dispose = target => { try { Promise.resolve(target.destroy()).catch(() => {}); } catch {} };
  const disposePdf = () => { if (pdf && !pdfDestroyed) { pdfDestroyed = true; dispose(pdf); } };
  function destroy() {
   if (destroyed) return;
   destroyed = true; signal.removeEventListener('abort',destroy);
   if (renderTask) { try { renderTask.cancel(); } catch {} }
   wipe(); previous.disabled = next.disabled = true;
   container.replaceChildren();
   if (pdf) disposePdf(); else if (loadingTask) dispose(loadingTask);
  }
  signal.addEventListener('abort',destroy,{once:true});
  const update = () => { label.textContent = `Page ${pageNumber} of ${pdf.numPages}`; previous.disabled = busy || pageNumber <= 1; next.disabled = busy || pageNumber >= pdf.numPages; };
  async function show(number) {
   if (!current()) return;
   busy = true; update(); wipe();
   const page = await pdf.getPage(number);
   if (!current()) { page.cleanup(); return; }
   const base = page.getViewport({scale:1});
   if (!(Number.isFinite(base.width) && Number.isFinite(base.height) && base.width > 0 && base.height > 0)) throw new Error('Invalid PDF page');
   const scale = Math.min(1.5, Math.sqrt(MAX_PIXELS / (base.width * base.height)), 16384 / base.width, 16384 / base.height);
   const viewport = page.getViewport({scale});
   canvas = (injected.createCanvas || (() => document.createElement('canvas')))();
   canvas.width = Math.max(1,Math.floor(viewport.width)); canvas.height = Math.max(1,Math.floor(viewport.height));
   // Also bound extreme page aspect ratios, not just their area.
   canvas.width = Math.min(canvas.width,16384); canvas.height = Math.min(canvas.height,16384);
   if (canvas.width * canvas.height > MAX_PIXELS) canvas.height = Math.max(1,Math.floor(MAX_PIXELS / canvas.width));
   canvas.style.maxWidth = '100%'; canvas.style.height = 'auto';
   canvas.setAttribute('aria-label',`PDF page ${number}`);
   renderTask = page.render({canvasContext:canvas.getContext('2d'), viewport, annotationMode:lib.AnnotationMode.DISABLE});
   try { await renderTask.promise; } finally { renderTask = null; page.cleanup(); }
   if (!current()) { wipe(); return; }
   pageNumber = number; busy = false; update();
   container.replaceChildren(canvas,controls);
  }
  async function navigate(number) {
   try { await show(number); }
   catch { if (current()) { destroy(); const message = document.createElement('p'); message.textContent = 'Preview unavailable. Close and try again, or Download a copy.'; container.replaceChildren(message); } }
  }
  previous.addEventListener('click', () => { if (current() && !busy && pageNumber > 1) return navigate(pageNumber - 1); });
  next.addEventListener('click', () => { if (current() && !busy && pageNumber < pdf.numPages) return navigate(pageNumber + 1); });
  const ready = (async () => {
   try {
    if (!current()) { destroy(); return; }
    lib = await (injected.loadLibrary || loadLibrary)();
    if (!current()) { destroy(); return; }
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
    loadingTask = lib.getDocument({data, isEvalSupported:false, enableXfa:false, useSystemFonts:true,
     standardFontDataUrl:'/vendor/pdfjs/standard_fonts/'});
    pdf = await loadingTask.promise;
    if (!current()) { disposePdf(); destroy(); return; }
    await show(1);
   } catch (error) { const active = current(); destroy(); if (active) throw error; }
  })();
  return {ready, destroy};
 };
})();
