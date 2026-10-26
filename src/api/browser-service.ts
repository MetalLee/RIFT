import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { RiftError } from '../contracts/index.js';
import type { UiSession } from './ui-contracts.js';

interface Session { csrfToken: string; expires: number }
interface Bootstrap { code: string; expires: number; consumed: boolean }
export interface BrowserOptions { uiDist: string; bootstrapTtlMs?: number; sessionTtlMs?: number; now?: () => number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** In-memory capabilities intentionally disappear on Host restart. */
export class BrowserService {
  private readonly bootstraps = new Map<string, Bootstrap>();
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  constructor(private readonly options: BrowserOptions) { this.now = options.now ?? Date.now; }
  private prune(): void {
    for (const [key, item] of this.bootstraps) if (item.expires <= this.now()) this.bootstraps.delete(key);
    for (const [key, item] of this.sessions) if (item.expires <= this.now()) this.sessions.delete(key);
  }
  issue(origin: string, key: string): { url: string; expiresAt: string } {
    this.prune();
    let item = this.bootstraps.get(key);
    if (item?.consumed) throw new RiftError('BOOTSTRAP_CONSUMED', 'This launch request has already been exchanged. Run rift ui again with a new key.');
    if (!item) {
      if (this.bootstraps.size >= 128) throw new RiftError('CAPACITY', 'Too many outstanding browser launch requests. Wait for expiry.');
      item = { code: random(), expires: this.now() + (this.options.bootstrapTtlMs ?? 60_000), consumed: false };
      this.bootstraps.set(key, item);
    }
    return { url: `${origin}/#bootstrap=${item.code}`, expiresAt: new Date(item.expires).toISOString() };
  }
  private cookieName(host: string): string { return `rift_ui_${host.split(':')[1]}`; }
  private cookie(host: string, value: string, maxAge: number): string {
    return `${this.cookieName(host)}=${value}; HttpOnly; SameSite=Strict; Path=/ui-api/v1; Max-Age=${maxAge}`;
  }
  /** Cross-port loopback is same-site, but is deliberately not same-origin. */
  checkSource(req: IncomingMessage, origin: string, write: boolean, allowMissingFetchMetadata = false): void {
    // Browsers omit Fetch Metadata on HTTP tailnet IPs. Writes still require the
    // exact Origin, JSON, a session and CSRF; explicit cross-site metadata fails.
    if (req.headers['sec-fetch-site'] !== 'same-origin' && !(allowMissingFetchMetadata && req.headers['sec-fetch-site'] === undefined)) throw new RiftError('FORBIDDEN', 'Browser API requires same-origin Fetch Metadata.');
    if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new RiftError('FORBIDDEN', 'Origin does not match this Host.');
    if (req.headers['sec-fetch-mode'] === 'navigate' || req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'empty') throw new RiftError('FORBIDDEN', 'Browser API only accepts fetch requests.');
    if (write && req.headers.origin !== origin) throw new RiftError('FORBIDDEN', 'Write requests require an exact Origin.');
    if (write && req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new RiftError('INVALID_REQUEST', 'Use application/json.');
  }
  exchange(body: unknown, host: string, res: ServerResponse): UiSession {
    this.prune();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('code' in body) || typeof body.code !== 'string' || !/^[a-f0-9]{64}$/.test(body.code)) throw new RiftError('UNAUTHORIZED', 'Invalid or expired browser launch code.');
    const code = body.code;
    const item = [...this.bootstraps.values()].find(value => same(value.code, code));
    if (!item || item.consumed) throw new RiftError('UNAUTHORIZED', 'Invalid or expired browser launch code.');
    if (this.sessions.size >= 128) throw new RiftError('CAPACITY', 'Too many active browser sessions.');
    item.consumed = true;
    const token = random(), ttl = this.options.sessionTtlMs ?? 8 * 60 * 60_000;
    const session = { csrfToken: random(), expires: this.now() + ttl };
    this.sessions.set(hash(token), session);
    res.setHeader('Set-Cookie', this.cookie(host, token, Math.max(1, Math.floor(ttl / 1000))));
    return this.view(session);
  }
  private token(req: IncomingMessage, host: string): string {
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${this.cookieName(host)}=`));
    if (values.length !== 1) throw new RiftError('UNAUTHORIZED', 'Open a new session with rift ui.');
    const value = values[0]!.slice(this.cookieName(host).length + 1);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new RiftError('UNAUTHORIZED', 'Invalid browser session.');
    return value;
  }
  authenticate(req: IncomingMessage, host: string, write: boolean): UiSession {
    this.prune();
    const session = this.sessions.get(hash(this.token(req, host)));
    if (!session) throw new RiftError('UNAUTHORIZED', 'Browser session expired. Run rift ui again.');
    if (write) {
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) || !same(csrf, session.csrfToken)) throw new RiftError('FORBIDDEN', 'A valid CSRF token is required.');
    }
    return this.view(session);
  }
  logout(req: IncomingMessage, host: string, res: ServerResponse): void {
    this.sessions.delete(hash(this.token(req, host)));
    res.setHeader('Set-Cookie', this.cookie(host, '', 0));
  }
  private view(session: Session): UiSession { return { csrfToken: session.csrfToken, expiresAt: new Date(session.expires).toISOString() }; }
  async static(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new RiftError('NOT_FOUND', 'Unknown UI route.');
    // Validate the original request target before URL parsing can normalize traversal.
    const raw = (req.url ?? '/').split('?')[0]!;
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { throw new RiftError('NOT_FOUND', 'Unknown UI asset.'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) throw new RiftError('NOT_FOUND', 'Unknown UI asset.');
    const name = decoded === '/' ? 'index.html' : decoded.slice(1);
    if (!['index.html', 'favicon.ico'].includes(name) && !/^assets\/[A-Za-z0-9_./-]+$/.test(name) && !/^fonts\/stitch\/[A-Za-z0-9_-]+\.woff2$/.test(name)) throw new RiftError('NOT_FOUND', 'Unknown UI asset.');
    const types: Record<string,string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp' };
    const type = types[path.extname(name)];
    if (!type) throw new RiftError('NOT_FOUND', 'Unknown UI asset.');
    try {
      const root = await realpath(this.options.uiDist), file = await realpath(path.resolve(root, name));
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new RiftError('NOT_FOUND', 'Unknown UI asset.');
      if (!(await stat(file)).isFile()) throw new RiftError('NOT_FOUND', 'Unknown UI asset.');
      const content = await readFile(file);
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error instanceof RiftError) throw error;
      if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new RiftError('NOT_FOUND', 'UI assets are unavailable. Build ui/ or configure RIFT_UI_DIST.');
      throw error;
    }
  }
}
