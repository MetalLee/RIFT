import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Role, Run, Workflow, Workspace } from '../../src/contracts/index.js';
import { RiftHostService, type HostConfig } from '../../src/api/host-service.js';
import type { UiWorkspaceDetail } from '../../src/api/ui-contracts.js';
import { seedWorkspace } from './fixtures.js';

const purposes = ['developer', 'lead', 'reviewer'];
const head = 'a'.repeat(40);

async function fixture(options: Partial<HostConfig> = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'rift-default-members-'));
  const parent = { id: 'controlled-lead', followup: vi.fn(), cancel: vi.fn(async () => {}) };
  const startActivation = vi.fn(async (input: { request: { prompt: { text: string }[] } }) => {
    const envelope = JSON.parse(input.request.prompt[0]!.text) as { taskId: string; runId: string };
    return { childId: `child-${envelope.runId}`, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, taskId: envelope.taskId, runId: envelope.runId, outcome: 'completed', summary: 'Controlled analysis', changedPaths: [], checksClaimed: [], blockingReasons: [] }) }] }), dispose: vi.fn(async () => {}) };
  });
  const providers = ['claude-code-dev', 'codex-dev', 'codex-review', 'spawn'];
  const ctx = {
    subagents: { list: () => providers, getProvider: (name: string) => providers.includes(name) ? { capabilities: name === 'spawn' ? { agentOptions: true } : {} } : undefined, startActivation },
    agents: { create: vi.fn(async () => ({ agent: parent, dispose: vi.fn(async () => {}) })), get: () => parent },
    llm: { listProviders: () => [{ id: 'test' }] },
  } as unknown as Context;
  const config: HostConfig = { home, port: 0, leadProvider: 'test', leadModel: 'test-model', checks: [], ...options };
  const open = () => {
    const host = new RiftHostService(ctx, config);
    vi.spyOn(host.git, 'inspectRepository').mockResolvedValue({ rootPath: path.join(home, 'repo'), commonGitDir: path.join(home, 'repo', '.git'), baseCommit: head });
    return host;
  };
  return { home, open, startActivation };
}

describe('new workspace default members (controlled providers and Git)', () => {
  it.each([
    { label: 'Claude profile', options: {}, provider: 'claude-code-dev' },
    { label: 'Codex profile with four Host slots', options: { developerProvider: 'codex-dev', limits: { developers: 4, total: 5 } }, provider: 'codex-dev' },
    { label: 'shared DSH spawn with one Host slot', options: { developerProvider: 'spawn', reviewerProvider: 'spawn', limits: { developers: 1, total: 2 } }, provider: 'spawn' },
  ])('creates exactly three bound members for $label through both entry points', async ({ options, provider }) => {
    const f = await fixture(options), host = f.open();
    try {
      for (const repository of [true, false]) {
        const workspace = await host.handleBrowser('POST', '/ui-api/v1/workspaces', { name: `new-${repository}`, ...(repository ? { repositoryPath: path.join(f.home, 'repo'), baseRef: 'main' } : {}) }, `new-${repository}`) as Workspace;
        const detail = await host.handleBrowser('GET', `/ui-api/v1/workspaces/${workspace.id}`, {}) as UiWorkspaceDetail;
        expect(detail.roles.map(role => role.purpose).sort()).toEqual(purposes);
        expect(detail.roles.map(role => role.name).sort()).toEqual(['developer-a', 'lead', 'reviewer']);
        expect(detail.roles.every(role => role.enabled === 1)).toBe(true);
        expect(detail.roles.find(role => role.purpose === 'lead')).toMatchObject({ kind: 'dsh-lead', providerBindingId: null });
        expect(detail.leadConfiguration).toMatchObject({ runtime: 'dsh', provider: 'test', model: 'test-model' });
        for (const role of detail.roles.filter(role => role.purpose !== 'lead')) {
          const binding = host.store.binding(role.providerBindingId!);
          expect(binding.providerName).toBe(role.purpose === 'developer' ? provider : options.reviewerProvider ?? 'codex-review');
          expect(detail.bindings.find(item => item.id === binding.id)?.registered).toBe(true);
          if (binding.providerName === 'spawn') expect(binding).toMatchObject({ runtime: 'dsh', spawn: { provider: 'test', model: 'test-model' } });
        }
        if (repository) expect(detail.roles.find(role => role.name === 'developer-a')!.id).toBe(`${workspace.id}:developer-a`);
      }
    } finally { await host.close(); await rm(f.home, { recursive: true, force: true }); }
  });

  it('keeps repository-free creation available without execution providers', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-discussion-members-'));
    const host = new RiftHostService({ subagents: { list: () => [] } } as unknown as Context, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    try {
      const workspace = await host.handleBrowser('POST', '/ui-api/v1/workspaces', { name: 'Discussion' }, 'discussion') as Workspace;
      const detail = await host.handleBrowser('GET', `/ui-api/v1/workspaces/${workspace.id}`, {}) as UiWorkspaceDetail;
      expect(detail.roles.map(role => role.purpose).sort()).toEqual(purposes);
      expect(detail.bindings.every(binding => !binding.registered && binding.providerName === 'discussion-only')).toBe(true);
      expect(detail.presence.filter(item => item.state === 'unavailable')).toHaveLength(2);
    } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('preserves legacy and explicit configurations, including manually added developers, across restart and creation retries', async () => {
    const f = await fixture(); let host = f.open();
    try {
      const legacy = seedWorkspace(host.store, 'legacy');
      const custom = seedWorkspace(host.store, 'custom');
      await host.handle('PUT', '/v1/workspaces/custom/roles', { bindings: custom.bindings, roles: [
        { name: 'captain', purpose: 'lead', kind: 'dsh-lead', prompt: 'Custom lead', revision: 1 },
        ...['writer', 'second-writer'].map(name => ({ name, purpose: 'developer', kind: 'subagent', providerBindingId: custom.bindings[0]!.id, prompt: 'Custom developer', revision: 1 })),
        { name: 'quality', purpose: 'reviewer', kind: 'subagent', providerBindingId: custom.bindings[1]!.id, prompt: 'Custom reviewer', revision: 1 },
      ] }, 'explicit-roles');
      const added = await host.handleBrowser('POST', '/ui-api/v1/workspaces/custom/agents', { name: 'extra-writer', displayName: '额外开发', purpose: 'developer', prompt: 'Manual developer', chatConnection: null, executionProviderName: 'codex-dev' }, 'add-developer') as Role;
      expect(host.store.binding(added.providerBindingId!).providerName).toBe('codex-dev');
      const snapshots = () => ['legacy', 'custom'].map(id => ({ roles: host.store.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY id', id), bindings: host.store.all('SELECT DISTINCT b.* FROM provider_bindings b JOIN roles r ON r.provider_binding_id=b.id WHERE r.workspace_id=? ORDER BY b.id', id) }));
      const before = snapshots();
      expect(legacy.roles).toHaveLength(4);
      expect(host.store.all("SELECT id FROM roles WHERE workspace_id='custom' AND enabled=1 AND purpose='developer'")).toHaveLength(3);
      await host.close(); host = f.open(); await host.initialize();
      expect(snapshots()).toEqual(before);
      const body = { name: 'New workspace', repositoryPath: path.join(f.home, 'repo'), baseRef: 'main' };
      const workspace = await host.handle('POST', '/v1/workspaces', body, 'new-workspace') as Workspace;
      await host.handleBrowser('POST', `/ui-api/v1/workspaces/${workspace.id}/agents`, { name: 'developer-b', displayName: 'Developer B', purpose: 'developer', prompt: 'Additional developer', chatConnection: null, executionProviderName: 'claude-code-dev' }, 'add-to-new');
      const members = host.store.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY id', workspace.id);
      expect(members).toHaveLength(4);
      expect(await host.handle('POST', '/v1/workspaces', body, 'new-workspace')).toEqual(workspace);
      expect(host.store.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY id', workspace.id)).toEqual(members);
      expect(snapshots()).toEqual(before);
    } finally { await host.close(); await rm(f.home, { recursive: true, force: true }); }
  });

  it('dispatches sequential tasks on the sole default developer with the configured runtime snapshot', async () => {
    const f = await fixture({ developerProvider: 'spawn', limits: { developers: 4, total: 5 } }), host = f.open();
    vi.spyOn(host.git, 'prepareTask').mockImplementation(async ({ task, run }) => ({ id: `wt-${run.id}`, taskId: task.id, attempt: task.attempt, kind: 'task', path: path.join(f.home, run.id), baseCommit: head, writerRunId: run.id }));
    vi.spyOn(host.git, 'verifyAnalysis').mockResolvedValue({ headCommit: head });
    vi.spyOn(host.git, 'currentHead').mockResolvedValue(head);
    try {
      const workspace = await host.handle('POST', '/v1/workspaces', { name: 'Single developer', repositoryPath: path.join(f.home, 'repo'), baseRef: 'main' }, 'workspace') as Workspace;
      const workflow = await host.handle('POST', '/v1/workflows', { workspaceId: workspace.id, goal: 'Analyze twice', startLead: false }, 'workflow') as Workflow;
      await host.ensureLead(workflow.id);
      host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: ['first', 'second'].map(id => ({ id, kind: 'analysis' as const, title: id, instructions: 'Read only', expectedPaths: [] })) });
      for (const id of ['first', 'second']) {
        host.coordinator.dispatch({ taskId: id, expectedVersion: 0, idempotencyKey: `dispatch-${id}` });
        await expect.poll(() => host.store.task(id).status).toBe('succeeded');
      }
      const runs = host.store.all<Run>('SELECT * FROM runs ORDER BY rowid');
      expect(runs).toHaveLength(2);
      for (const run of runs) expect(run).toMatchObject({ roleId: `${workspace.id}:developer-a`, cleanupStatus: 'confirmed', providerSnapshot: { binding: { providerName: 'spawn', runtime: 'dsh', spawn: { provider: 'test', model: 'test-model' } } } });
      expect(f.startActivation).toHaveBeenCalledTimes(2);
      expect(host.coordinator.finish({ workflowId: workflow.id, summary: 'Both controlled tasks completed.' }).status).toBe('completed');
    } finally { await host.close(); await rm(f.home, { recursive: true, force: true }); }
  });
});
