# Vendored PDF.js

Mozilla PDF.js `pdfjs-dist` **6.5.438**, from the official npm registry tarball.
`provenance.json` pins the upstream package URL, official GitHub release, npm
SHA-512 integrity and SHA-256 of every extracted asset. The tarball was downloaded
to the agent scratch directory and its SHA-512 matched the pinned integrity
**before** extracting any files. No npm install or package dependency changes.

Only `build/pdf.mjs`, `build/pdf.worker.mjs`, `standard_fonts/` (including its
license) and upstream `LICENSE` are copied. Browser import and worker/font URLs
are same-origin; there is no CDN or bundled viewer UI. Keep these files unmodified.

`/pdf-preview.js` is the only integration: bounded single-page canvas rendering,
annotation rendering disabled, XFA disabled, no text/annotation layers or PDF
scripting manager. It passes `isEvalSupported:false` defensively (this PDF.js
version no longer contains the older eval-based font path). No attachment-provided
DOM, links, actions or scripts are mounted. Preview is best-effort, with the
original attachment download retained for unsupported PDF features.

To upgrade, independently verify the official Mozilla release and npm integrity,
download the pinned tarball into scratch, verify SHA-512 before unpacking the
allowlisted assets, regenerate hashes, and run `npm test` plus a real-browser PDF
preview/close/logout check. Do not patch upstream code to fix application behavior.
