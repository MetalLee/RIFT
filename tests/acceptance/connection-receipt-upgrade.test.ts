import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { RiftHostService } from '../../src/api/host-service.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { DshChatRuntime } from '../../src/chat/dsh-runtime.js';

async function open(home: string, browser: boolean) {
  const ctx = new Context();
  const llm = await ctx.plugin(LlmRuntime);
  const secrets = await ctx.plugin(LocalCredentialProvider, { path: path.join(home, 'credentials.yaml'), watch: false });
  Object.defineProperty(ctx, 'subagents', { value: { list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true } }) } });
  const host = new RiftHostService(ctx, { home, port: 0, leadProvider: 'unused', leadModel: 'unused', checks: [], chatOrchestration: false });
  await host.initialize();
  const api = await startLocalApi(host, { home, port: 0 });
  const origin = `http://127.0.0.1:${api.port}`;
  const token = (await readFile(path.join(home, 'management.token'), 'utf8')).trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (browser) {
    const session = await fetch(origin + '/ui-api/v1/session/connect', { method: 'POST', headers: { ...headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: '{}' });
    Object.assign(headers, { Origin: origin, 'Sec-Fetch-Site': 'same-origin', Cookie: session.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': (await session.json() as { csrfToken: string }).csrfToken });
  } else headers.Authorization = `Bearer ${token}`;
  const request = async (method: string, route: string, body?: unknown, key = 'unused') => {
    const response = await fetch(origin + (browser ? '/ui-api/v1' : '/v1') + route, { method, headers: { ...headers, 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  return { host, ctx, request, close: async () => { await api.close(); await host.close(); await secrets.dispose(); await llm.dispose(); } };
}

describe('legacy connection receipt upgrade', () => {
  it.each([
    { browser: false, passed: true }, { browser: true, passed: true },
    { browser: false, passed: false }, { browser: true, passed: false },
  ])('projects create and verify history after restart: %j', async ({ browser, passed }) => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-receipt-upgrade-'));
    let runtime = await open(home, browser);
    const activation = vi.spyOn(DshChatRuntime.prototype, 'start').mockImplementation(async input => {
      if (passed) await input.tools![0]!.execute({}, input.signal);
      return { result: Promise.resolve({ text: 'Historical reply', finalText: 'Historical reply', stopReason: 'completed' }), dispose: async () => {} };
    });
    try {
      const input = { name: 'Historical name', protocol: 'openai-completions', endpoint: 'https://example.invalid/v1', model: 'test', apiKey: 'receipt-upgrade-test-key' };
      const created = await runtime.request('POST', '/connections', input, 'create');
      expect(created.status).toBe(200);
      const id = created.value.id;
      const verified = await runtime.request('POST', `/connections/${id}/verify`, {}, 'verify');
      expect(verified.status).toBe(200);
      expect(verified.value.passed).toBe(passed);
      expect(activation).toHaveBeenCalledOnce();
      const reference = runtime.host.store.require<{ credentialRef: string }>('SELECT credential_ref FROM api_connections WHERE id=?', id).credentialRef;
      const workspace = await runtime.host.commands.execute({ name: 'workspace.create', input: { name: 'Internal binding' } }) as { id: string };
      const bindingId = runtime.host.configuredExecutionBinding(workspace.id, { runtime: 'dsh', provider: created.value.provider, model: input.model });
      const binding = runtime.host.store.binding(bindingId);
      expect(binding.credentialRefs).toEqual([`env:${reference}`]);
      // Simulate old persisted responses without changing their original request fingerprints.
      const key = (value: string) => browser ? `browser:${value}` : value;
      runtime.host.store.exec('UPDATE management_requests SET response=? WHERE key=?', JSON.stringify({ ...created.value, credentialRef: reference, hostOnly: true }), key('create'));
      runtime.host.store.exec('UPDATE management_requests SET response=? WHERE key=?', JSON.stringify({ ...verified.value, connection: { ...verified.value.connection, credentialRef: reference, hostOnly: true, verification: { ...verified.value.connection.verification, hostOnly: true } } }), key('verify'));
      runtime.host.store.exec('UPDATE api_connections SET name=?,verification_status=?,verification_error=? WHERE id=?', 'Current name', passed ? 'failed' : 'passed', 'Current observation', id);
      const receipts = runtime.host.store.all('SELECT * FROM management_requests ORDER BY key');
      const connections = runtime.host.store.all('SELECT * FROM api_connections');
      const verifications = runtime.host.store.all('SELECT * FROM api_connection_verifications');
      await runtime.close();
      runtime = await open(home, browser);
      const create = vi.spyOn(runtime.host.connections, 'create');
      const verify = vi.spyOn(runtime.host.connections, 'verify');
      for (let replay = 0; replay < 2; replay++) {
        expect(await runtime.request('POST', '/connections', input, 'create')).toEqual(created);
        expect(await runtime.request('POST', `/connections/${id}/verify`, {}, 'verify')).toEqual(verified);
      }
      expect(create).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(activation).toHaveBeenCalledOnce();
      const current = (await runtime.request('GET', '/connections')).value.savedConnections[0];
      expect(current.name).toBe('Current name');
      expect(current.verificationStatus).toBe(passed ? 'failed' : 'passed');
      expect(current).not.toHaveProperty('credentialRef');
      expect((await runtime.request('POST', '/connections', { ...input, name: 'Changed input' }, 'create')).value.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(runtime.host.store.all('SELECT * FROM management_requests ORDER BY key')).toEqual(receipts);
      expect(runtime.host.store.all('SELECT * FROM api_connections')).toEqual(connections);
      expect(runtime.host.store.all('SELECT * FROM api_connection_verifications')).toEqual(verifications);
      expect(runtime.host.store.binding(bindingId)).toEqual(binding);
      expect((await runtime.ctx.credentials.resolve(credentialRef(reference)))?.value).toBe(input.apiKey);
      runtime.host.validateChatConnection({ runtime: 'dsh', provider: created.value.provider, model: input.model });
    } finally {
      activation.mockRestore();
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
