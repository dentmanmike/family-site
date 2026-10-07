# Miller Family portal

Cloudflare Pages site with a responsive photo welcome page and family login/upload form.

## Cloudflare settings

- Production branch: `main`
- Framework preset: None
- Build command: leave blank
- Build output directory: `docs`
- Root directory: repository root (leave blank). The root `functions/` directory provides `/auth` and `/upload`.
- Keep existing `FAMILY_USER` and `FAMILY_PASS` secrets. Add a long random `SESSION_SECRET` secret if desired; otherwise session signing derives its key from the existing credentials. Never commit secret values.
- Keep the `FAMILY_BUCKET` R2 binding and keep that bucket private.
- Configure the same secrets/binding for Preview to test a branch deployment. Existing sessions will require a fresh sign-in after this update.

The public welcome photo is deliberately visible before login and is included in this public repository. Uploaded files stay in R2. This version supports uploads; album browsing and file downloads are not yet implemented. Do not expose the R2 bucket through a public URL.

Sessions have a signed seven-day expiration, secure HttpOnly cookies, same-origin POST checks, and no-cache auth responses. Use Cloudflare rate limiting for `/auth` before expanding access. Signing out clears this browser's cookie; it does not revoke copied tokens globally.

## Local checks

Run `npm test`.
