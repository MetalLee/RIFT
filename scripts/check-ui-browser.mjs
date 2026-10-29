// Run the existing fixture regression against this candidate's production build, not a live Host.
import { preview } from 'vite';
import { createRequire } from 'node:module';

// An operator-supplied module path must also be visible inside the Host sandbox.
if (process.argv[2]) process.env.RIFT_PLAYWRIGHT_MODULE = process.argv[2];
if (process.argv[3]) process.env.PLAYWRIGHT_BROWSERS_PATH = process.argv[3];
createRequire(import.meta.url).resolve(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const server = await preview({
  configFile: 'ui/vite.config.ts', root: 'ui',
  preview: { host: '127.0.0.1', port: 0, open: false },
});
try {
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Preview did not bind a TCP port');
  process.env.RIFT_UI_URL = `http://127.0.0.1:${address.port}`;
  await import('./ui-secondary-reuse-check.mjs');
} finally {
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
