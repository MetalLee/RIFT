import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent';
import { RiftHostService } from '../../src/api/host-service.js';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import { NativeCodexRuntime } from '../../src/agent/native-codex.js';
import type { BrowserAgent } from '../../src/project/browser-agents.js';
import type { UiWorkspaceDetail } from '../../src/api/ui-contracts.js';
import type { ActivationBridge } from '../../src/contracts/index.js';

afterEach(() => vi.restoreAllMocks());
function fixture(home: string, native = true) {
  const providers = new Map<string, SubagentProvider>();
  providers.set('spawn', { name: 'spawn', capabilities: { agentOptions: true }, prepareContinuable: async()=>({}) } as unknown as SubagentProvider);
  const parent = { id: 'parent' } as Agent;
  const agents=new Map<string,Agent>([[parent.id,parent]]),restrict=vi.fn();
  let onCreated:((payload:{agent:Agent})=>unknown)|undefined;
  const startActivation = vi.fn(async (input:{childId?:string}) => {
    const child={id:input.childId??'child',ctx:{tools:{restrict,register:vi.fn()}}} as unknown as Agent;
    agents.set(child.id,child);onCreated?.({agent:child});
    return{childId:child.id,result:Promise.resolve({stopReason:'completed',output:[]}),async dispose(){agents.delete(child.id);}};
  });
  const ctx = {
    get: (name: string) => native && name === 'subprocess' ? { spawn: vi.fn() } : undefined,
    llm: { listProviders: () => [{ id: 'test-api' }] }, agents: { get: (id:string) => agents.get(id) },
    on:(_event:string,listener:typeof onCreated)=>{onCreated=listener;return()=>{onCreated=undefined;};},
    subagents: {
      list: () => [...providers.keys()], getProvider: (name: string) => providers.get(name), startActivation,
      registerProvider(provider: SubagentProvider) { providers.set(provider.name, provider); return () => { providers.delete(provider.name); }; },
    },
  } as unknown as Context;
  const host = new RiftHostService(ctx, { home, port: 0, leadProvider: 'test-api', leadModel: 'lead-model', checks: [] });
  const call = (method: string, route: string, body: unknown = {}) => host.handleBrowser(method, `/ui-api/v1${route}`, body, randomUUID());
  return { host, ctx, parent, providers, startActivation, restrict, call };
}

describe('Agent execution connections without preconfigured instances', () => {
  it('saves API/model/effort separately from chat and dispatches the immutable selected options', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-execution-api-'));
    const f = fixture(home);
    try {
      const workspace = await f.call('POST', '/workspaces', { name: 'API execution' }) as { id: string };
      const base = `/workspaces/${workspace.id}/agents`;
      const executionConnection = { runtime: 'dsh', provider: 'test-api', model: 'gpt-6-astra', reasoningEffort: 'high' };
      const chatConnection = { runtime: 'dsh', provider: 'test-api', model: 'chat-model' };
      const agent = await f.call('POST', base, { displayName: 'Developer', purpose: 'developer', prompt: '', chatConnection, executionConnection }) as BrowserAgent;
      const original = f.host.store.binding(agent.providerBindingId!);
      expect(original).toMatchObject({ runtime: 'dsh', model: 'gpt-6-astra', spawn: { provider: 'test-api', model: 'gpt-6-astra', reasoningEffort: 'high' } });
      expect(agent.chatConnection).toEqual(chatConnection);
      const detail = await f.call('GET', `/workspaces/${workspace.id}`) as UiWorkspaceDetail;
      expect(detail.bindings.find(b => b.id === original.id)?.executionConnection).toEqual(executionConnection);
      const updated = await f.call('PATCH', `${base}/${agent.id}`, { expectedVersion: agent.version, executionConnection: { ...executionConnection, model: 'next-model' } }) as BrowserAgent;
      expect(updated.providerBindingId).not.toBe(original.id);
      expect(f.host.store.binding(original.id)).toEqual(original);
      const input = { signal: new AbortController().signal, task: { id: 'task', title: 'Task' }, run: { id: 'run', providerSnapshot: { binding: original } }, cwd: home, prompt: 'work' } as Parameters<ActivationBridge['start']>[0];
      const handle = await new DshActivationBridge(f.ctx, () => f.parent).start(input);
      expect(f.startActivation).toHaveBeenCalledWith(expect.objectContaining({ provider: 'spawn', request: expect.objectContaining({ agentOptions: { provider: 'test-api', model: 'gpt-6-astra', reasoningEffort: 'high' } }) }));
      expect(f.restrict).toHaveBeenCalledWith({allow:[]});
      await handle.dispose();
      const count = f.host.store.all('SELECT id FROM provider_bindings').length;
      await expect(f.call('PATCH', `${base}/${agent.id}`, { expectedVersion: agent.version, executionConnection })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(f.host.store.all('SELECT id FROM provider_bindings')).toHaveLength(count);
      f.host.store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,cleanup_status,acquired_at) VALUES('held','turn','held',?,?,'developer','unknown','now')", workspace.id, agent.id);
      await expect(f.call('PATCH', `${base}/${agent.id}`, { expectedVersion: updated.version, executionConnection })).rejects.toMatchObject({ code: 'CONFIG_IN_USE' });
      expect(f.host.store.all('SELECT id FROM provider_bindings')).toHaveLength(count);
    } finally { await f.host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('creates Astra native execution automatically, restores it on restart, and forwards its reasoning effort', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-execution-native-'));
    let f = fixture(home);
    try {
      const catalogue = await f.call('GET', '/connections') as { connections: { id: string; models: string[]; executionAvailable: boolean }[] };
      expect(catalogue.connections.find(c => c.id === 'codex')).toMatchObject({ executionAvailable: true, models: ['gpt-6.1-sol', 'gpt-6-astra'] });
      const workspace = await f.call('POST', '/workspaces', { name: 'Native execution' }) as { id: string };
      const connection = { runtime: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
      const agent = await f.call('POST', `/workspaces/${workspace.id}/agents`, { displayName: 'Astra', purpose: 'reviewer', prompt: '', chatConnection: connection, executionConnection: connection }) as BrowserAgent;
      const binding = f.host.store.binding(agent.providerBindingId!);
      expect(binding).toMatchObject({ runtime: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' });
      await f.host.close();
      f = fixture(home);
      expect(f.providers.has(binding.providerName)).toBe(true);
      const detail = await f.call('GET', `/workspaces/${workspace.id}`) as UiWorkspaceDetail;
      expect(detail.bindings.find(b => b.id === binding.id)).toMatchObject({ registered: true, executionConnection: connection });
      f.host.store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'goal','running','ref','commit')", workspace.id);
      f.host.store.exec("INSERT INTO tasks(id,workflow_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('task','workflow','change','title','work','[]','[]','running')");
      f.host.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('run','task',?,'review',1,'running',?,'later','now')", agent.id, JSON.stringify({ role: agent, binding }));
      const start = vi.spyOn(NativeCodexRuntime.prototype, 'start').mockResolvedValue({ result: Promise.resolve({ text: '{}', stopReason: 'completed' }), async dispose() {} });
      const handle = await new DshActivationBridge(f.ctx, () => f.parent, f.host.store).start({ run: f.host.store.run('run'), task: f.host.store.task('task'), role: agent, cwd: home, prompt: 'Review', signal: new AbortController().signal });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', reasoningEffort: 'high' }));
      await handle.result; await handle.dispose();
      f.host.store.exec("UPDATE runs SET status='succeeded',cleanup_status='confirmed',slot_released_at='now' WHERE id='run'");
    } finally { await f.host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('rejects unsupported or ambiguous connections without creating bindings', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-execution-invalid-'));
    const f = fixture(home, false);
    try {
      const workspace = await f.call('POST', '/workspaces', { name: 'Validation' }) as { id: string };
      const initialBindings = f.host.store.all('SELECT * FROM provider_bindings ORDER BY id');
      const create = (extra: object) => f.call('POST', `/workspaces/${workspace.id}/agents`, { displayName: 'Developer', purpose: 'developer', prompt: '', chatConnection: null, ...extra });
      await expect(create({ executionConnection: { runtime: 'dsh', provider: 'missing', model: 'model' } })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await expect(create({ executionConnection: { runtime: 'codex', model: 'gpt-6-astra' } })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await expect(create({ executionProviderName: 'spawn', executionConnection: { runtime: 'dsh', provider: 'test-api', model: 'model' } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(f.host.store.all('SELECT * FROM provider_bindings ORDER BY id')).toEqual(initialBindings);
    } finally { await f.host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it.each([null, { runtime: 'dsh', provider: 'test-api', model: 'chat-model' }])('uses native execution for text analysis independently of chat: %j', async chatConnection => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-execution-text-'));
    const f = fixture(home);
    const start = vi.fn(async () => ({ result: Promise.resolve({ text: 'Analysis complete', stopReason: 'completed' as const }), async dispose() {} }));
    f.host.registerChatRuntime('codex', { start }, ['gpt-6.1-sol', 'gpt-6-astra']);
    try {
      const workspace = await f.call('POST', '/workspaces', { name: 'Text execution' }) as { id: string };
      await f.call('POST', `/workspaces/${workspace.id}/agents`, { displayName: 'Analyst', purpose: 'developer', prompt: '', chatConnection, executionConnection: { runtime: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' } });
      f.host.coordinator.createWorkflow({ id: 'workflow', workspaceId: workspace.id, goal: 'Analyze supplied text', baseCommit: '', integrationRef: '', repositoryFree: true });
      f.host.coordinator.submitPlan({ workflowId: 'workflow', expectedRevision: 0, tasks: [{ id: 'task', title: 'Analyze', kind: 'analysis', instructions: 'Analyze supplied text', expectedPaths: [] }] });
      f.host.coordinator.dispatch({ taskId: 'task', expectedVersion: 0, idempotencyKey: 'dispatch' });
      await expect.poll(() => f.host.store.task('task').status).toBe('succeeded');
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', reasoningEffort: 'high', tools: [expect.objectContaining({name:'rift_send_message'})] }));
    } finally { await f.host.close(); await rm(home, { recursive: true, force: true }); }
  });
});
