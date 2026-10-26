import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import { startLocalApi } from '../../src/api/local-api.js';
import { RiftHostService } from '../../src/api/host-service.js';
import type { UiSession, UiWorkspaceDetail, UiWorkspaceList } from '../../src/api/ui-contracts.js';
import { seedWorkspace } from './fixtures.js';
import { BrowserService } from '../../src/api/browser-service.js';

const exec = promisify(execFile);
const source = (origin: string) => ({ Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' });

describe('U0/U2 browser bootstrap and same-Host read model', () => {
  it('connects directly on loopback, reuses valid sessions and reconnects after expiry with strict source checks', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'rift-local-connect-'));
    let now = Date.now();
    const api = await startLocalApi({ handle: vi.fn(), handleBrowser: vi.fn(async () => ({})) }, { home: folder, port: 0, browser: { now: () => now, sessionTtlMs: 1000 } });
    const origin = `http://127.0.0.1:${api.port}`;
    const connect = (headers: Record<string, string>, body = '{}') => fetch(`${origin}/ui-api/v1/session/connect`, { method: 'POST', headers, body });
    try {
      expect((await connect({ 'Content-Type': 'application/json' })).status).toBe(403);
      expect((await connect({ ...source(origin), Origin: 'http://evil.invalid' })).status).toBe(403);
      expect((await connect({ ...source(origin), 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
      expect((await connect({ ...source(origin), 'Sec-Fetch-Dest': 'iframe' })).status).toBe(403);
      expect((await connect(source(origin), '{"unexpected":true}')).status).toBe(400);
      const first = await connect(source(origin)); expect(first.status).toBe(200);
      const session = await first.json() as UiSession;
      const headers = { ...source(origin), Cookie: first.headers.get('set-cookie')!.split(';')[0]! };
      const reused = await connect(headers); expect(await reused.json()).toEqual(session); expect(reused.headers.get('set-cookie')).toBeNull();
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
      now += 1001;
      const renewed = await connect(headers); expect(renewed.status).toBe(200);
      expect((await renewed.json() as UiSession).csrfToken).not.toBe(session.csrfToken);
      expect(renewed.headers.get('set-cookie')).toContain('HttpOnly');
    } finally { await api.close(); await rm(folder, { recursive: true, force: true }); }
  });
  it('allows absent Fetch Metadata only for explicitly selected HTTP tailnet requests, never cross-origin writes', () => {
    const browser = new BrowserService({ uiDist: '.' });
    const origin = 'http://100.64.0.10:48080';
    const req = (headers: Record<string,string>) => ({ headers }) as http.IncomingMessage;
    expect(() => browser.checkSource(req({}), origin, false)).toThrow();
    expect(() => browser.checkSource(req({}), origin, false, true)).not.toThrow();
    expect(() => browser.checkSource(req({origin,'content-type':'application/json'}), origin, true, true)).not.toThrow();
    expect(() => browser.checkSource(req({'content-type':'application/json'}), origin, true, true)).toThrow();
    expect(() => browser.checkSource(req({origin:'http://evil.invalid','content-type':'application/json'}), origin, true, true)).toThrow();
    expect(() => browser.checkSource(req({origin,'content-type':'application/json','sec-fetch-site':'cross-site'}), origin, true, true)).toThrow();
    const remoteRequest = req({ origin, 'content-type': 'application/json' });
    const setHeader = vi.fn();
    browser.checkSource(remoteRequest, origin, true, true);
    const session = browser.connect(remoteRequest, '100.64.0.10:48080', { setHeader } as unknown as http.ServerResponse);
    expect(session.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    const cookie = String(setHeader.mock.calls[0]![1]).split(';')[0]!;
    expect(browser.authenticate(req({ cookie }), '100.64.0.10:48080', false)).toEqual(session);
    expect(() => browser.authenticate(req({ cookie }), '100.64.0.10:48080', true)).toThrow();
  });
  it('exchanges once, isolates management authentication, enforces CSRF/metadata/expiry/logout and serves bounded static assets', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'rift-browser-security-'));
    const assets = path.join(folder, 'ui'); await mkdir(path.join(assets, 'assets'), { recursive: true });
    await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>RIFT</title>');
    await writeFile(path.join(assets, 'assets', 'app.js'), 'export const app = true;');
    await mkdir(path.join(assets, 'fonts', 'stitch'), { recursive: true });
    const fontBytes = Buffer.from('wOF2-test-font');
    await writeFile(path.join(assets, 'fonts', 'stitch', 'material-symbols.woff2'), fontBytes);
    await writeFile(path.join(assets, 'assets', 'workspace-studio-stitch.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(path.join(assets, 'fonts', 'stitch', 'private.json'), '{}');
    let now = Date.now();
    const handle = vi.fn(async () => ({ management: true }));
    const handleBrowser = vi.fn(async () => ({ browser: true }));
    const api = await startLocalApi({ handle, handleBrowser }, { home: folder, port: 0, uiDist: assets, browser: { now: () => now, bootstrapTtlMs: 1000, sessionTtlMs: 10_000 } });
    const origin = `http://127.0.0.1:${api.port}`;
    try {
      const token = (await readFile(path.join(folder, 'management.token'), 'utf8')).trim();
      const management = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'launch' };
      const issue = async (key: string) => {
        const response = await fetch(`${origin}/v1/ui/bootstrap`, { method: 'POST', headers: { ...management, 'Idempotency-Key': key }, body: '{}' });
        expect(response.status).toBe(200);
        return await response.json() as { url: string; expiresAt: string };
      };
      const launch = await issue('launch');
      expect(launch.url).not.toContain(token);
      expect(await issue('launch')).toEqual(launch);
      const code = new URLSearchParams(new URL(launch.url).hash.slice(1)).get('bootstrap');
      const exchange = () => fetch(`${origin}/ui-api/v1/session`, { method: 'POST', headers: source(origin), body: JSON.stringify({ code }) });
      const response = await exchange(); expect(response.status).toBe(200);
      const session = await response.json() as UiSession;
      const setCookie = response.headers.get('set-cookie')!;
      expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); expect(setCookie).not.toContain('Domain=');
      const cookie = setCookie.split(';')[0]!;
      const headers = { ...source(origin), Cookie: cookie };
      expect((await exchange()).status).toBe(401);
      expect((await fetch(`${origin}/v1/doctor`, { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await fetch(`${origin}/v1/doctor`, { headers: { ...management, Origin: origin } })).status).toBe(401);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { headers: { ...source(origin), Authorization: `Bearer ${token}` } })).status).toBe(401);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { headers: { Cookie: cookie } })).status).toBe(403);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status).toBe(403);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { headers: { ...headers, 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'create' }, body: '{}' })).status).toBe(403);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken }, body: '{}' })).status).toBe(400);
      expect((await fetch(`${origin}/ui-api/v1/workspaces`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'create' }, body: '{}' })).status).toBe(200);
      const page = await fetch(origin); expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'"); expect(page.headers.get('access-control-allow-origin')).toBeNull();
      expect((await fetch(`${origin}/assets/app.js`)).headers.get('content-type')).toContain('javascript');
      const font = await fetch(`${origin}/fonts/stitch/material-symbols.woff2`);
      expect(font.status).toBe(200); expect(font.headers.get('content-type')).toBe('font/woff2');
      expect(Buffer.from(await font.arrayBuffer())).toEqual(fontBytes);
      const photo = await fetch(`${origin}/assets/workspace-studio-stitch.jpg`);
      expect(photo.status).toBe(200); expect(photo.headers.get('content-type')).toBe('image/jpeg');
      expect((await fetch(`${origin}/fonts/stitch/private.json`)).status).toBe(404);
      const headFont = await fetch(`${origin}/fonts/stitch/material-symbols.woff2`, { method: 'HEAD' });
      expect(headFont.status).toBe(200); expect(await headFont.text()).toBe('');
      expect((await fetch(`${origin}/management.token`)).status).toBe(404);
      const raw = (requestPath: string, host = `127.0.0.1:${api.port}`) => new Promise<number | undefined>((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: api.port, path: requestPath, headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
      });
      expect(await raw('/assets/%2e%2e/management.token')).toBe(404);
      expect(await raw('/assets/..%5cmanagement.token')).toBe(404);
      expect(await raw('/fonts/stitch/%2e%2e/%2e%2e/management.token')).toBe(404);
      expect(await raw('/', 'localhost:' + api.port)).toBe(400);
      const logout = await fetch(`${origin}/ui-api/v1/logout`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'logout' }, body: '{}' });
      expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
      expect((await fetch(`${origin}/ui-api/v1/session`, { headers })).status).toBe(401);
      const expired = await issue('expires'); now += 1001;
      expect((await fetch(`${origin}/ui-api/v1/session`, { method: 'POST', headers: source(origin), body: JSON.stringify({ code: new URLSearchParams(new URL(expired.url).hash.slice(1)).get('bootstrap') }) })).status).toBe(401);
      expect(handle).not.toHaveBeenCalled();
    } finally { await api.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('reads isolated durable data, conservative presence and genuine provider capability without invoking any model', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'rift-browser-views-'));
    const createAgent = vi.fn();
    const ctx = { agents: { create: createAgent }, subagents: { list: () => ['claude-code-dev'], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const host = new RiftHostService(ctx, { home: folder, port: 0, leadProvider: 'test-provider', leadModel: 'test-model', checks: [] });
    try {
      const a = seedWorkspace(host.store, 'first'), b = seedWorkspace(host.store, 'second');
      const workflow = host.coordinator.createWorkflow({ workspaceId: a.workspace.id, goal: 'Inspect', baseCommit: 'a'.repeat(40), integrationRef: 'refs/heads/rift/test' });
      host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [
        { id: 'first-task', kind: 'analysis', title: 'First', instructions: 'Inspect', expectedPaths: [] },
        { id: 'second-task', kind: 'analysis', title: 'Second', instructions: 'Inspect later', expectedPaths: [], dependsOn: ['first-task'] },
      ] });
      const listing = await host.handleBrowser('GET', '/ui-api/v1/workspaces', {}) as UiWorkspaceList;
      expect(listing.workspaces).toHaveLength(2);
      const detail = await host.handleBrowser('GET', '/ui-api/v1/workspaces/first', {}) as UiWorkspaceDetail;
      expect(detail.workspace).toMatchObject({ taskCount: 2, workflowCount: 1, activeWorkflowId: workflow.id });
      expect(detail.tasks.find(task => task.id === 'second-task')?.dependsOn).toEqual(['first-task']);
      expect(detail.bindings.every(binding => !('credentialRefs' in binding))).toBe(true);
      expect(detail.presence.find(item => item.roleId.endsWith(':lead'))?.state ?? detail.presence.find(item => item.roleId === a.roles.find(role => role.name === 'lead')!.id)?.state).toBe('unknown');
      expect(detail.presence.find(item => item.roleId === a.roles.find(role => role.name === 'reviewer')!.id)?.state).toBe('unavailable');
      expect(detail.leadConfiguration).toEqual({ source: 'host', runtime: 'dsh', provider: 'test-provider', model: 'test-model' });
      expect(detail.capabilities.chat.available).toBe(true);
      expect((await host.handleBrowser('GET', `/ui-api/v1/workspaces/${b.workspace.id}`, {}) as UiWorkspaceDetail).tasks).toHaveLength(0);
      await expect(host.handleBrowser('GET', '/ui-api/v1/workspaces/missing', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(host.handleBrowser('POST', `/ui-api/v1/workflows/${workflow.id}/lead`, {}, 'denied')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(createAgent).not.toHaveBeenCalled();
    } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('offers a CLI launch URL and creates existing-repository workspaces once through CSRF-protected business logic', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'rift-browser-create-'));
    const repo = path.join(folder, 'repo'); await mkdir(repo);
    await exec('git', ['init', '-q', '-b', 'main', repo]); await writeFile(path.join(repo, 'README.md'), 'base');
    await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    const ctx = { subagents: { list: () => ['claude-code-dev', 'codex-review'], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const host = new RiftHostService(ctx, { home: path.join(folder, 'home'), port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    const api = await startLocalApi(host, host.config), origin = `http://127.0.0.1:${api.port}`;
    try {
      const command = await exec(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'ui', '--home', host.config.home, '--json'], { cwd: process.cwd() });
      const launch = JSON.parse(command.stdout) as { url: string };
      const code = new URLSearchParams(new URL(launch.url).hash.slice(1)).get('bootstrap');
      const exchanged = await fetch(`${origin}/ui-api/v1/session`, { method: 'POST', headers: source(origin), body: JSON.stringify({ code }) });
      expect(exchanged.status).toBe(200);
      const session = await exchanged.json() as UiSession;
      const headers = { ...source(origin), Cookie: exchanged.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'new-workspace' };
      const body = { name: 'Browser-created', repositoryPath: repo, baseRef: 'main' };
      const create = (input: unknown) => fetch(`${origin}/ui-api/v1/workspaces`, { method: 'POST', headers, body: JSON.stringify(input) });
      const first = await create(body); expect(first.status).toBe(200); const workspace = await first.json();
      expect(await (await create(body)).json()).toEqual(workspace);
      expect(host.store.all('SELECT id FROM workspaces')).toHaveLength(1);
      expect((await create({ ...body, name: 'conflict' })).status).toBe(409);
      const detail = await fetch(`${origin}/ui-api/v1/workspaces/${(workspace as {id:string}).id}`, { headers });
      expect((await detail.json() as UiWorkspaceDetail).roles.map(role => role.purpose).sort()).toEqual(['developer', 'lead', 'reviewer']);
    } finally { await api.close(); await host.close(); await rm(folder, { recursive: true, force: true }); }
  });
});
