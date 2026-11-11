# Miller Family portal — home-only uploads

Cloudflare Pages serves the existing family portal and business page. Authenticated uploads are forwarded through a Cloudflare Tunnel to a loopback-only Node.js receiver on the home Windows computer. Uploaded file contents are NOT written to R2 or another cloud object store. Cloudflare processes the HTTPS request in transit; this is not end-to-end encryption that hides file contents from Cloudflare.

## Cloudflare Pages

- Production branch: `main`; framework: None; build command: blank; output directory: `docs`; root: repository root.
- Root `functions/` provides `/auth` and `/upload`.
- Set production `FAMILY_USER`, `FAMILY_PASS`, and a strong random `SESSION_SECRET`. Password and signing keys must be encrypted secrets, never committed.
- Set production `HOME_UPLOAD_URL` to the dedicated tunnel hostname with path `/v1/upload` and `HOME_UPLOAD_SECRET` to an independent, random 256-bit secret shared only with the home receiver.
- Do NOT give untrusted preview deployments production credentials, tunnel credentials, or the home upload secret.
- No `FAMILY_BUCKET` binding is needed. Existing cloud objects are not migrated or deleted by this change.

## Home receiver

`home/run.mjs <private-config.json>` runs using a supported Node.js LTS runtime and binds only `127.0.0.1`. The config contains `secret`, `storageRoot`, `storageId`, `dataRoot`, and `port` (8787). Keep it outside the repository with restricted Windows ACLs. The storage marker `.storage-id` under `storageRoot` must match the configured identity: an offline or reassigned drive must fail closed, never fall back to C:.

The tunnel routes only `/v1/upload` and `/v1/health` to the receiver. All other paths return 404. No incoming router/firewall ports are opened. Request signatures cover the file ID, timestamp, safe filename, size, and SHA256. The receiver checks authentication before writing, limits file size to 25 MiB, writes an exclusive temporary file, checks size/hash, flushes it, and publishes without overwriting another file. The website accepts only a matching HMAC-signed persistence receipt before reporting success. This is not an independent backup or a guarantee against later drive failure.

On Windows, run uploader and tunnel as separate startup tasks under LOCAL SERVICE, not Administrator. Grant that identity read/execute access to program/config files and modify access only to upload/log directories. Keep the tunnel credential in a protected token file, not command-line arguments. Disable automatic binary replacement; verify official release checksums before updating. Test tasks without restarting the desktop.

The home PC, tunnel tasks, and correct external drive must be online. Offline uploads fail rather than being retained in the cloud. If confirmation is lost, check the upload folder before retrying. Browsing/downloads and multi-user accounts are not implemented. Uploaded files are untrusted data; do not execute them automatically. Keep Windows Defender enabled.

## Authentication

Signed seven-day sessions use Secure, HttpOnly, SameSite=Strict cookies; POSTs require same-origin requests and responses are non-cacheable. Rotating SESSION_SECRET revokes current sessions. Signing out clears only that browser's cookie. Use a strong generated password and Cloudflare rate limiting for `/auth` before expanding access.

## Checks

Run `npm test`. Tests include real loopback/filesystem receiver integration plus Pages signing, cloud-write prohibition, request size limits, receipt validation, UI confirmation, and preservation of the existing business page. Deployment acceptance also requires a real authenticated website upload and a SHA256 readback from the Windows destination, plus a home-offline failure check.
