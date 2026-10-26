import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Workflow, Workspace } from '../../src/contracts/index.js';
import { RiftHostService } from '../../src/api/host-service.js';
import { planSchema, rolesSchema } from '../../src/api/schemas.js';

vi.mock('../../src/agent/repository-shell.js',()=>({createRepositoryShell:vi.fn(async()=>({tool:{name:'exec_command',description:'Controlled repository shell',inputSchema:{},execute:vi.fn(async()=>({exitCode:0}))},dispose:vi.fn(async()=>{})}))}));

const exec = promisify(execFile);

describe('E1 public management entry points', () => {
  it('releases the Host database lease when incompatible quota configuration prevents startup', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift E1 limits '));
    const ctx = { subagents: { list: () => [] } } as unknown as Context;
    const config = { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] };
    try {
      expect(() => new RiftHostService(ctx, { ...config, limits: { developers: 4, total: 3 } })).toThrow('Global total');
      const host = new RiftHostService(ctx, { ...config, limits: { developers: 4, total: 5 } });
      await host.close();
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('creates configurable Codex roles, keeps two live Leads isolated, and replans queued work through the API', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'rift E1 管理 '));
    const repo = path.join(folder, 'repository');
    await mkdir(repo);
    await exec('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, 'README.md'), 'fixture\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, '-c', 'user.name=E1', '-c', 'user.email=e1@example.invalid', 'commit', '-qm', 'base']);
    const handles: { agent: { id: string; cancel: ReturnType<typeof vi.fn>; followup: ReturnType<typeof vi.fn> }; dispose: ReturnType<typeof vi.fn> }[] = [];
    const ctx = {
      subagents: { list: () => ['codex-dev', 'codex-review'], getProvider: () => ({ capabilities: {} }) },
      llm: { listProviders: () => [{ id: 'test' }] },
      agents: {
        create: vi.fn(async () => {
          const handle = { agent: { id: `lead-${handles.length}`, cancel: vi.fn(async () => undefined), followup: vi.fn() }, dispose: vi.fn(async () => undefined) };
          handles.push(handle); return handle;
        }),
      },
    } as unknown as Context;
    const host = new RiftHostService(ctx, { home: path.join(folder, 'home'), port: 0, leadProvider: 'test', leadModel: 'test', developerProvider: 'codex-dev', reviewerProvider: 'codex-review', limits: { developers: 4, total: 5 }, checks: [] });
    try {
      const create = async (name: string) => {
        const workspace = await host.handle('POST', '/v1/workspaces', { name, repositoryPath: repo, baseRef: 'main' }, `${name}-workspace`) as Workspace;
        const workflow = await host.handle('POST', '/v1/workflows', { workspaceId: workspace.id, goal: name, startLead: false }, `${name}-workflow`) as Workflow;
        await host.ensureLead(workflow.id);
        return { workspace, workflow };
      };
      const a = await create('first'), b = await create('second');
      expect(host.coordinator.status(a.workflow.id).roles.map(role => role.purpose).sort()).toEqual(['developer', 'lead', 'reviewer']);
      expect(host.doctor().limits).toMatchObject({ developers: 4, total: 5, reviewers: 1, workflowsPerWorkspace: 1 });
      expect(handles).toHaveLength(2);
      expect(host.store.workflow(a.workflow.id).leadSessionId).not.toBe(host.store.workflow(b.workflow.id).leadSessionId);
      const task = (id: string) => ({ id, kind: 'analysis', title: id, instructions: 'Inspect', expectedPaths: [id], roleName: 'developer-a' });
      await host.handle('POST', `/v1/workflows/${a.workflow.id}/plan`, { expectedRevision: 0, tasks: [task('first-task'), task('future-task')] }, 'plan');
      host.coordinator.pause(a.workflow.id);
      host.coordinator.dispatch({ taskId: 'future-task', expectedVersion: 0, idempotencyKey: 'queued' });
      const input = { expectedRevision: 1, updates: [{ taskId: 'future-task', expectedVersion: 0, dependsOn: ['first-task'], priority: 9 }] };
      const result = await host.handle('POST', `/v1/workflows/${a.workflow.id}/replan`, input, 'replan');
      expect(await host.handle('POST', `/v1/workflows/${a.workflow.id}/replan`, input, 'replan')).toEqual(result);
      expect(host.store.task('future-task').priority).toBe(9);
      const request = host.coordinator.status(a.workflow.id).operations.find(op => op.dedupeKey === 'queued')!;
      expect(request).toMatchObject({ phase: 'queued', payload: { planRevision: 2, expectedVersion: 1 } });
      await expect(host.handle('POST', `/v1/workflows/${a.workflow.id}/replan`, input, 'stale')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await host.handle('POST', `/v1/workflows/${a.workflow.id}/cancel`, {}, 'cancel');
      expect(handles[0]!.agent.cancel).toHaveBeenCalledOnce();
      expect(handles[1]!.agent.cancel).not.toHaveBeenCalled();
      expect(host.store.workflow(b.workflow.id).status).toBe('planning');
    } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('validates reusable analysis and custom role bindings at the public schema boundary', () => {
    const task = { kind: 'analysis', title: 'Batch', instructions: 'Inspect', expectedPaths: [], roleName: 'security-auditor', analysisItems: [{ id: 'first', prompt: 'Inspect architecture' }] };
    expect(planSchema.parse({ expectedRevision: 0, tasks: [task] }).tasks[0]!.analysisItems).toHaveLength(1);
    expect(() => planSchema.parse({ expectedRevision: 0, tasks: [{ ...task, kind: 'change' }] })).toThrow();
    const binding = { id: 'spawn', providerName: 'spawn', packageVersion: '0.2.1-rc.3', configRevision: 1, capabilities: {}, credentialRefs: ['env:DEEPSEEK_API_KEY'], runtime: 'dsh', spawn: { provider: 'deepseek-official', model: 'deepseek-flash' } };
    expect(rolesSchema.parse({ bindings: [binding], roles: [
      { name: 'coordinator', purpose: 'lead', kind: 'dsh-lead', prompt: 'Lead', revision: 1 },
      { name: 'security-auditor', purpose: 'developer', kind: 'subagent', providerBindingId: 'spawn', prompt: 'Analyze', revision: 1 },
      { name: 'quality', purpose: 'reviewer', kind: 'subagent', providerBindingId: 'spawn', prompt: 'Review', revision: 1 },
    ] }).roles.map(role => role.name)).toEqual(['coordinator', 'security-auditor', 'quality']);
  });
});
