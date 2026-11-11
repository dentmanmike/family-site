import { readFile } from 'node:fs/promises';
import { createUploadServer } from './server.mjs';

// Keep this JSON outside the checkout and restrict it with Windows ACLs.
// Its secret must be generated randomly, not chosen as a password.
try {
  if (!process.argv[2]) throw new Error('Missing configuration');
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const port = config.port ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = createUploadServer(config);
  server.on('error', () => {
    console.error('Family receiver could not listen. Check private configuration and port availability.');
    process.exitCode = 1;
  });
  // Never use a configurable host, an unspecified host, or 0.0.0.0.
  server.listen(port, '127.0.0.1', () => {
    console.log(`Family receiver listening on 127.0.0.1:${port}`);
  });
} catch {
  // Do not print exceptions: they may contain configuration or filesystem paths.
  console.error('Family receiver could not start. Supply a valid private configuration JSON file.');
  process.exitCode = 1;
}
