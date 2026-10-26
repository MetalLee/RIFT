import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Loopback-only adapter for Tailscale Serve. The management API is never proxied. */
export function createTailnetProxy({ origin, upstream = 'http://127.0.0.1:47831' }) {
  const external = new URL(origin), backend = new URL(upstream);
  if (external.protocol !== 'https:' || !external.hostname.endsWith('.ts.net') || external.origin !== origin || external.username || external.password) throw new Error('Use the exact HTTPS ts.net origin');
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1' || backend.pathname !== '/' || backend.username || backend.password || backend.search || backend.hash) throw new Error('Upstream must be an HTTP loopback origin');
  return http.createServer((req, res) => {
    const deny = (status) => { res.writeHead(status, {'Content-Type':'text/plain','Cache-Control':'no-store'}); res.end('Request rejected'); };
    if (req.headers.host !== external.host || req.headers['tailscale-funnel-request']) return deny(403);
    if (req.headers.origin !== undefined && req.headers.origin !== external.origin) return deny(403);
    let pathname;
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return deny(400); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p=>p.startsWith('.'))) return deny(404);
    if (!(pathname === '/' || pathname === '/favicon.ico' || pathname.startsWith('/assets/') || pathname.startsWith('/fonts/stitch/') || pathname.startsWith('/ui-api/v1/'))) return deny(404);
    const headers = {host:backend.host};
    for (const name of ['content-type','content-length','accept','cookie','x-csrf-token','idempotency-key','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','last-event-id']) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    // Check the real external Origin first. Preserve Fetch Metadata and CSRF checks.
    if (req.headers.origin) headers.origin = backend.origin;
    const proxy = http.request({hostname:backend.hostname,port:backend.port,method:req.method,path:req.url,headers}, incoming=>{
      const responseHeaders = {...incoming.headers};
      delete responseHeaders.connection; delete responseHeaders['keep-alive'];
      if (responseHeaders['set-cookie']) responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(c=>`${c}; Secure`);
      res.writeHead(incoming.statusCode || 502,responseHeaders);
      incoming.pipe(res);
    });
    proxy.on('error',()=>{ if (!res.headersSent) deny(502); else res.destroy(); });
    req.on('aborted',()=>proxy.destroy());
    res.on('close',()=>proxy.destroy());
    req.pipe(proxy);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, port='47832', upstream] = process.argv.slice(2);
  const server = createTailnetProxy({origin,upstream});
  server.listen(Number(port),'127.0.0.1',()=>console.log(`Tailnet browser proxy: ${origin} -> 127.0.0.1:${port}`));
}
