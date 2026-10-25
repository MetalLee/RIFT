import http, { type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tokenMatches, publicError, redact } from './security.js';
import { RiftError } from '../contracts/index.js';

export interface ApiHandler { handle(method: string, pathname: string, body: unknown, idempotencyKey?: string): Promise<unknown> }
async function readBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 256 * 1024) throw new RiftError('BODY_TOO_LARGE', 'Request exceeds 256 KiB.'); parts.push(chunk); }
  return size ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
}
export async function startLocalApi(handler: ApiHandler, options: { home: string; port: number }) {
  await mkdir(options.home, { recursive: true });
  const tokenPath = path.join(options.home, 'management.token');
  let token: string;
  try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 }); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new RiftError('INVALID_TOKEN_FILE', 'management.token must contain a 32-byte hexadecimal token.');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.headers.origin || !tokenMatches(req.headers.authorization, token)) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'A local management token is required.' } })); return; }
      const expectedHost = `127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      if (req.headers.host !== expectedHost) throw new RiftError('INVALID_HOST', 'Only the exact loopback endpoint is accepted.');
      const pathname = new URL(req.url ?? '/', `http://${expectedHost}`).pathname;
      const key = req.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 160)) throw new RiftError('INVALID_KEY', 'Invalid idempotency key.');
      if (req.method !== 'GET' && !key) throw new RiftError('IDEMPOTENCY_KEY_REQUIRED', 'Write requests require Idempotency-Key.');
      const value = await handler.handle(req.method ?? 'GET', pathname, await readBody(req), key);
      // Redact scalar values without truncating JSON or corrupting its wire format.
      res.end(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redact(item) : item));
    } catch (error) {
      const detail = publicError(error);
      res.statusCode = detail.code === 'NOT_FOUND' ? 404 : /STALE|CONFLICT|IN_USE|UNKNOWN|RUNNING/.test(detail.code) ? 409 : 400;
      res.end(JSON.stringify({ error: detail }));
    }
  });
  server.requestTimeout = 35000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  await writeFile(path.join(options.home, 'endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
  return { port, server, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
