import http, { type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenMatches, publicError, redact } from './security.js';
import { RiftError } from '../contracts/index.js';
import { BrowserService, type BrowserOptions } from './browser-service.js';
import type { WorkspaceEventPage } from '../events/workspace-events.js';
import { isIPv4 } from 'node:net';

export interface ApiHandler {
  handle(method: string, pathname: string, body: unknown, idempotencyKey?: string): Promise<unknown>;
  handleBrowser?(method: string, pathname: string, body: unknown, idempotencyKey?: string): Promise<unknown>;
  browserEvents?(workspaceId: string, after: number): WorkspaceEventPage;
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 256 * 1024) throw new RiftError('BODY_TOO_LARGE', 'Request exceeds 256 KiB.'); parts.push(chunk); }
  if (!size) return {};
  // JSON.parse can include raw request fragments in its SyntaxError. This
  // boundary runs before credential registration, so never forward that text.
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new RiftError('INVALID_JSON', 'Request body must be valid JSON.'); }
}
export async function startLocalApi(handler: ApiHandler, options: { home: string; port: number; uiDist?: string; uiEnabled?: boolean; tailnetAddress?: string; browser?: Omit<BrowserOptions, 'uiDist'> }) {
  const tailnetAddress = options.tailnetAddress ?? process.env.RIFT_TAILSCALE_IP;
  if (tailnetAddress && (!isIPv4(tailnetAddress) || Number(tailnetAddress.split('.')[0]) !== 100 || Number(tailnetAddress.split('.')[1]) < 64 || Number(tailnetAddress.split('.')[1]) > 127)) throw new RiftError('INVALID_HOST', 'Use an assigned Tailscale IPv4 address in 100.64.0.0/10.');
  await mkdir(options.home, { recursive: true });
  const tokenPath = path.join(options.home, 'management.token');
  let token: string;
  try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 }); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new RiftError('INVALID_TOKEN_FILE', 'management.token must contain a 32-byte hexadecimal token.');
  const browser = handler.handleBrowser && (options.uiEnabled ?? process.env.RIFT_UI_ENABLED !== 'false') ? new BrowserService({ ...options.browser, uiDist: options.uiDist ?? process.env.RIFT_UI_DIST ?? fileURLToPath(new URL('../../dist/ui', import.meta.url)) }) : undefined;
  let eventConnections = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const isTailnet = !!tailnetAddress && req.socket.localAddress === tailnetAddress;
      const expectedHost = `${isTailnet ? tailnetAddress : '127.0.0.1'}:${(server.address() as import('node:net').AddressInfo).port}`;
      const origin = `http://${expectedHost}`;
      const requestUrl = new URL(req.url ?? '/', origin), pathname = requestUrl.pathname;
      if(handler.handleBrowser&&!browser&&(!pathname.startsWith('/v1/')||pathname==='/v1/ui/bootstrap'))throw new RiftError('NOT_FOUND','Browser UI is disabled by this Host configuration.');
      const isBrowser = browser && !pathname.startsWith('/v1/') && pathname !== '/v1';
      if (isTailnet && !isBrowser) throw new RiftError('FORBIDDEN', 'Management API is only available on loopback.');
      // The management surface retains its Bearer + no-Origin boundary.
      if (!isBrowser && (req.headers.origin || !tokenMatches(req.headers.authorization, token))) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'A local management token is required.' } })); return; }
      if (req.headers.host !== expectedHost) throw new RiftError('INVALID_HOST', 'Only the exact listener endpoint is accepted.');
      if (isBrowser && !pathname.startsWith('/ui-api/')) {
        if (req.headers.origin && req.headers.origin !== origin) throw new RiftError('FORBIDDEN', 'Origin does not match this Host.');
        await browser.static(req, res); return;
      }
      const streamEvents = (workspaceId: string, authenticate: () => void): void => {
        if (eventConnections >= 16) throw new RiftError('CAPACITY', 'Too many event connections.');
        const rawCursor = req.headers['last-event-id'] ?? requestUrl.searchParams.get('after') ?? '0';
        if (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor)) throw new RiftError('INVALID_CURSOR', 'Use a numeric event cursor.');
        let cursor = Number(rawCursor), heartbeatAt = Date.now();
        const initial = handler.browserEvents!(workspaceId, cursor);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('X-Accel-Buffering','no'); res.setHeader('Connection', 'keep-alive');
        res.flushHeaders(); eventConnections++;
        const emit = (page: WorkspaceEventPage): void => {
          if (page.resyncRequired || res.writableLength > 256 * 1024) { res.end(`event: resync_required\ndata: ${JSON.stringify({ cursor: page.cursor })}\n\n`); return; }
          for (const event of page.events) {
            if (!res.write(`id: ${event.seq}\nevent: workspace\ndata: ${JSON.stringify(event)}\n\n`)) { res.end('event: resync_required\ndata: {}\n\n'); return; }
            cursor = event.seq;
          }
          // Global gaps are legal; a sparse workspace still advances with
          // the server cursor once this page has fully drained.
          cursor = page.nextAfter;
          if (Date.now() - heartbeatAt >= 15000) { res.write(`id: ${cursor}\nevent: heartbeat\ndata: ${JSON.stringify({ cursor })}\n\n`); heartbeatAt = Date.now(); }
        };
        const timer = setInterval(() => {
          try { authenticate(); emit(handler.browserEvents!(workspaceId, cursor)); }
          catch { res.end('event: session_expired\ndata: {}\n\n'); }
        }, 50); timer.unref();
        res.once('close', () => { clearInterval(timer); eventConnections--; });
        emit(initial); return;
      };
      const managementEvents = /^\/v1\/workspaces\/([^/]+)\/events$/.exec(pathname);
      if (!isBrowser && req.method === 'GET' && managementEvents && handler.browserEvents) {
        streamEvents(decodeURIComponent(managementEvents[1]!), () => {
          if (!tokenMatches(req.headers.authorization, token)) throw new RiftError('UNAUTHORIZED','Management authentication expired.');
        });
        return;
      }
      const key = req.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 160)) throw new RiftError('INVALID_KEY', 'Invalid idempotency key.');
      let value: unknown;
      if (isBrowser) {
        const write = req.method !== 'GET';
        browser.checkSource(req, origin, write, isTailnet);
        if (req.method === 'POST' && (pathname === '/ui-api/v1/session/connect' || pathname === '/ui-api/v1/session/local')) {
          const input = await readBody(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new RiftError('INVALID_REQUEST', 'Use an empty JSON object.');
          value = browser.connect(req, expectedHost, res);
        }
        else if (req.method === 'POST' && pathname === '/ui-api/v1/session') value = browser.exchange(await readBody(req), expectedHost, res);
        else {
          const session = browser.authenticate(req, expectedHost, write);
          if (write && !key) throw new RiftError('IDEMPOTENCY_KEY_REQUIRED', 'Write requests require Idempotency-Key.');
          const eventRoute = /^\/ui-api\/v1\/workspaces\/([^/]+)\/events$/.exec(pathname);
          if (!write && eventRoute && handler.browserEvents) { streamEvents(decodeURIComponent(eventRoute[1]!), () => { browser.authenticate(req, expectedHost, false); }); return; }
          if (req.method === 'GET' && pathname === '/ui-api/v1/session') value = session;
          else if (req.method === 'POST' && pathname === '/ui-api/v1/logout') { browser.logout(req, expectedHost, res); value = { loggedOut: true }; }
          else value = await handler.handleBrowser!(req.method ?? 'GET', pathname + requestUrl.search, await readBody(req), key);
        }
      } else {
        if (req.method !== 'GET' && !key) throw new RiftError('IDEMPOTENCY_KEY_REQUIRED', 'Write requests require Idempotency-Key.');
        if (browser && req.method === 'POST' && pathname === '/v1/ui/bootstrap') {
          const input = await readBody(req) as { remote?: boolean };
          if (input?.remote && !tailnetAddress) throw new RiftError('INVALID_HOST', 'No Tailscale listener is configured.');
          value = browser.issue(input?.remote ? `http://${tailnetAddress}:${(server.address() as import('node:net').AddressInfo).port}` : origin, key!);
        }
        else value = await handler.handle(req.method ?? 'GET', /^\/v1\/workspaces\/[^/]+\/conversations\/[^/]+\/messages$/.test(pathname) ? pathname+requestUrl.search : pathname, await readBody(req), key);
      }
      // Redact scalar values without truncating JSON or corrupting its wire format.
      res.end(JSON.stringify(value, (key, item: unknown) => typeof item === 'string' ? redact(item, key==='text'||key==='content'?256_000:128*1024) : item));
    } catch (error) {
      const detail = publicError(error);
      res.statusCode = detail.code === 'UNAUTHORIZED' ? 401 : detail.code === 'FORBIDDEN' ? 403 : detail.code === 'NOT_FOUND' ? 404 : /STALE|CONFLICT|IN_USE|UNKNOWN|RUNNING/.test(detail.code) ? 409 : 400;
      res.end(JSON.stringify({ error: detail }));
    }
  });
  server.requestTimeout = 35000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const tailnetServer = tailnetAddress ? http.createServer(server.listeners('request')[0] as http.RequestListener) : undefined;
  if (tailnetServer) {
    tailnetServer.requestTimeout = 35000;
    try { await new Promise<void>((resolve, reject) => { tailnetServer.once('error', reject); tailnetServer.listen(port, tailnetAddress, () => { tailnetServer.off('error', reject); resolve(); }); }); }
    catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  }
  await writeFile(path.join(options.home, 'endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, ...(tailnetAddress ? { browserUrl: `http://${tailnetAddress}:${port}` } : {}), pid: process.pid }));
  return { port, server, close: async () => { await Promise.all([server, ...(tailnetServer ? [tailnetServer] : [])].map(listener => new Promise<void>((resolve, reject) => { listener.closeAllConnections(); listener.close(error => error ? reject(error) : resolve()); }))); } };
}
