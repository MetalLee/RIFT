import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { ProjectService } from '../../src/project/index.js';
import { TaskCoordinator, type CoordinatorOptions } from '../../src/task/coordinator.js';
import { RiftHostService } from '../../src/api/host-service.js';
import { withMetadataLock } from '../../src/git/worktree-binding.js';
import type { Context } from '@deepseek-ai/cordis';
import type { ActivationBridge, ActivationResult, GitService, PlanTask, ProviderBinding } from '../../src/contracts/index.js';

// This suite controls the model/Host lifecycle. Native command capabilities are
// independently exercised by repository-permissions-review and the real probe.
vi.mock('../../src/agent/repository-shell.js',()=>({createRepositoryShell:vi.fn(async()=>({tool:{name:'exec_command',description:'Controlled repository shell',inputSchema:{},execute:vi.fn(async()=>({exitCode:0}))},dispose:vi.fn(async()=>{})}))}));

const sha = 'a'.repeat(40);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000, interval: 10 }); }

/** Real SQLite reservation/state engine. Provider and Git facts are controlled doubles. */
function harness(limits: CoordinatorOptions['limits'] = { developers: 3, total: 4 }, roleCount = 6) {
  const store = new RiftStore();
  const project = new ProjectService(store, new Set(['codex-a', 'codex-review']));
  const starts: { input: Parameters<ActivationBridge['start']>[0]; result: ReturnType<typeof deferred<ActivationResult>>; disposed: boolean; failCleanup: boolean }[] = [];
  const bridge: ActivationBridge = { async start(input) {
    const entry = { input, result: deferred<ActivationResult>(), disposed: false, failCleanup: false }; starts.push(entry);
    return { childId: `fake-${input.run.id}`, result: entry.result.promise, async dispose() { if (entry.failCleanup) throw new Error('independent cleanup failure'); entry.disposed = true; } };
  } };
  const git: GitService = {
    async prepareTask({ task, run }) { return { id: `wt-${run.id}`, taskId: task.id, attempt: task.attempt, kind: 'task', path: path.resolve('fake-only', run.id), baseCommit: sha, writerRunId: run.id }; },
    async collectSource() { return { sourceHead: sha, diff: '', changedPaths: [] }; },
    async prepareCandidate({ integrationId, sourceHead }) { return { integrationId, sourceHead, expectedTargetHead: sha, candidateHead: sha, cwd: process.cwd(), checkIds: [] }; },
    async publishCandidate() { return { acceptedCommit: sha }; },
  };
  const coordinator = new TaskCoordinator({ store, bridge, git, limits });
  cleanup.push(async () => { await coordinator.shutdown(); store.close(); });
  const seed = (workspaceId: string, repository = workspaceId) => {
    project.createWorkspace({ id: workspaceId, name: workspaceId, rootPath: path.resolve('fake-only', workspaceId), repositoryPath: path.resolve('fake-only', repository), commonGitDir: path.resolve('fake-only', repository, '.git'), baseRef: 'main' });
    const bindings: ProviderBinding[] = [{ id: `${workspaceId}-provider`, providerName: 'codex-a', packageVersion: 'fake', configRevision: 1, capabilities: {}, credentialRefs: ['native:codex'], runtime: 'codex', model: 'model-a' }];
    const roles = [{ name: 'lead', purpose: 'lead' as const, kind: 'dsh-lead' as const, prompt: 'lead', revision: 1 }, ...Array.from({ length: roleCount }, (_, i) => ({ name: `engineer-${i}`, purpose: 'developer' as const, kind: 'subagent' as const, providerBindingId: bindings[0]!.id, prompt: `role-${i}`, revision: 1 })), { name: 'auditor', purpose: 'reviewer' as const, kind: 'subagent' as const, providerBindingId: bindings[0]!.id, prompt: 'review', revision: 1 }];
    project.configureRoles(workspaceId, bindings, roles);
    const workflow = coordinator.createWorkflow({ id: `wf-${workspaceId}`, workspaceId, goal: 'Independent E1 acceptance', integrationRef: `refs/heads/rift/${workspaceId}`, baseCommit: sha });
    return { workflow, bindings, roles };
  };
  const plan = (workflowId: string, tasks: Partial<PlanTask>[]) => coordinator.submitPlan({ workflowId, expectedRevision: store.workflow(workflowId).planRevision, tasks: tasks.map((task, i) => ({ id: `${workflowId}-${i}`, kind: 'analysis', title: `Task ${i}`, instructions: 'Inspect only', expectedPaths: [`scope-${workflowId}-${i}.txt`], ...task })) });
  const dispatch = (taskId: string) => coordinator.dispatch({ taskId, idempotencyKey: taskId, expectedVersion: store.task(taskId).version });
  const complete = (entry: typeof starts[number]) => entry.result.resolve({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: entry.input.task.id, runId: entry.input.run.id, outcome: 'completed', summary: 'Inspected', changedPaths: [], checksClaimed: [], blockingReasons: [] }) });
  return { store, project, starts, coordinator, seed, plan, dispatch, complete };
}

describe('E1 independent SQLite and controlled-activation acceptance', () => {
  it('E1.1 sustains forty queued tasks at six developers with atomic unique role reservations', async () => {
    const f = harness({ developers: 6, total: 7 }, 8), { workflow } = f.seed('scale');
    const tasks = f.plan(workflow.id, Array.from({ length: 40 }, () => ({})));
    await Promise.all(tasks.map(async task => f.dispatch(task.id)));
    await until(() => f.starts.length === 6);
    let completed = 0, max = 0;
    while (completed < tasks.length) {
      const occupied = f.store.all<{ roleId: string }>('SELECT role_id FROM runs WHERE slot_released_at IS NULL');
      max = Math.max(max, occupied.length); expect(occupied.length).toBeLessThanOrEqual(6); expect(new Set(occupied.map(run => run.roleId)).size).toBe(occupied.length);
      const batch = f.starts.slice(completed); expect(batch.length).toBeGreaterThan(0); batch.reverse().forEach(f.complete); completed += batch.length;
      await until(() => f.store.all('SELECT id FROM tasks WHERE status=?', 'succeeded').length === completed);
      if (completed < tasks.length) await until(() => f.starts.length > completed);
    }
    expect(max).toBe(6); expect(f.starts).toHaveLength(40); expect(f.coordinator.status(workflow.id).slots.total).toBe(0);
  });

  it('E1.2 shares the global budget across workspaces and cancels only the selected workflow', async () => {
    const f = harness(), a = f.seed('a'), b = f.seed('b');
    const tasksA = f.plan(a.workflow.id, [{ expectedPaths: ['shared.ts'] }, { expectedPaths: ['other.ts'] }]);
    const tasksB = f.plan(b.workflow.id, [{ expectedPaths: ['shared.ts'] }, { expectedPaths: ['last.ts'] }]);
    [...tasksA, ...tasksB].forEach(task => f.dispatch(task.id)); await until(() => f.starts.length === 3);
    expect(f.starts.some(entry => entry.input.task.workflowId === b.workflow.id)).toBe(true);
    const sibling = f.starts.find(entry => entry.input.task.workflowId === b.workflow.id)!;
    await f.coordinator.cancelWorkflow(a.workflow.id); await until(() => f.starts.length === 4);
    expect(sibling.disposed).toBe(false); expect(f.store.workflow(b.workflow.id).status).toBe('running');
    f.starts.filter(entry => entry.input.task.workflowId === b.workflow.id).forEach(f.complete);
    await until(() => tasksB.every(task => f.store.task(task.id).status === 'succeeded'));
  });

  it('E1.2 retains unknown cleanup budget without treating shared-repository path metadata as ownership', async () => {
    const f = harness({ developers: 2, total: 3 }), a = f.seed('unknown', 'shared-repo'), b = f.seed('peer', 'shared-repo'), c = f.seed('separate');
    const [first] = f.plan(a.workflow.id, [{ expectedPaths: ['src/shared.ts'] }]);
    const [conflict] = f.plan(b.workflow.id, [{ expectedPaths: ['src/shared.ts'] }]);
    const [independent] = f.plan(c.workflow.id, [{ expectedPaths: ['src/shared.ts'] }]);
    f.dispatch(first!.id); await until(() => f.starts.length === 1); f.starts[0]!.failCleanup = true; f.complete(f.starts[0]!);
    await until(() => f.store.run(f.starts[0]!.input.run.id).cleanupStatus === 'failed');
    f.dispatch(conflict!.id); f.dispatch(independent!.id); await until(() => f.starts.length === 2);
    expect(f.starts[1]!.input.task.id).toBe(conflict!.id); expect(f.store.run(f.starts[0]!.input.run.id).slotReleasedAt).toBeNull();
    expect(() => f.project.configureRoles('unknown', a.bindings, a.roles)).toThrow(/in use|cleanup|executions/i);
    f.complete(f.starts[1]!); await until(() => f.store.task(conflict!.id).status === 'succeeded');
    await until(() => f.starts.length === 3); expect(f.starts[2]!.input.task.id).toBe(independent!.id);
    expect(f.store.run(f.starts[0]!.input.run.id).slotReleasedAt).toBeNull();
    f.complete(f.starts[2]!); await until(() => f.store.task(independent!.id).status === 'succeeded');
  });

  it('E1.4 atomically rejects cycles and stale edits, then preserves queued work through dependency replan', async () => {
    const f = harness({ developers: 1, total: 2 }), { workflow } = f.seed('dag');
    const [a, b, c] = f.plan(workflow.id, [{}, {}, {}]); f.coordinator.pause(workflow.id); [a!, b!, c!].forEach(task => f.dispatch(task.id));
    const revision = f.store.workflow(workflow.id).planRevision;
    expect(() => f.coordinator.replan({ workflowId: workflow.id, expectedRevision: revision, updates: [{ taskId: a!.id, expectedVersion: a!.version, dependsOn: [b!.id] }, { taskId: b!.id, expectedVersion: b!.version, dependsOn: [a!.id] }] })).toThrow(/cycle/i);
    expect(f.store.workflow(workflow.id).planRevision).toBe(revision); expect(f.store.all('SELECT * FROM task_dependencies')).toHaveLength(0);
    expect(() => f.coordinator.replan({ workflowId: workflow.id, expectedRevision: revision, updates: [{ taskId: c!.id, expectedVersion: 999, priority: 20 }] })).toThrow(/version/i);
    f.coordinator.replan({ workflowId: workflow.id, expectedRevision: revision, updates: [{ taskId: a!.id, expectedVersion: a!.version, dependsOn: [b!.id] }, { taskId: b!.id, expectedVersion: b!.version, priority: 80 }, { taskId: c!.id, expectedVersion: c!.version, priority: -20 }] });
    f.coordinator.resume(workflow.id); await until(() => f.starts.length === 1); expect(f.starts[0]!.input.task.id).toBe(b!.id);
    f.complete(f.starts[0]!); await until(() => f.starts.length === 2); expect(f.starts[1]!.input.task.id).toBe(a!.id);
    expect(() => f.coordinator.replan({ workflowId: workflow.id, expectedRevision: f.store.workflow(workflow.id).planRevision, updates: [{ taskId: a!.id, expectedVersion: f.store.task(a!.id).version, dependsOn: [c!.id] }] })).toThrow();
    f.complete(f.starts[1]!); await until(() => f.starts.length === 3); f.complete(f.starts[2]!); await until(() => f.store.task(c!.id).status === 'succeeded');
  });

  it('E1.4 prevents a high-priority busy workspace from starving another workspace', async () => {
    const f = harness({ developers: 1, total: 2 }), a = f.seed('busy'), b = f.seed('small');
    const tasks = f.plan(a.workflow.id, [{ priority: 100 }, { priority: 100 }, { priority: 100 }]); const [small] = f.plan(b.workflow.id, [{ priority: -100 }]);
    tasks.forEach(task => f.dispatch(task.id)); f.dispatch(small!.id); await until(() => f.starts.length === 1); f.complete(f.starts[0]!);
    await until(() => f.starts.length === 2); expect(f.starts[1]!.input.task.id).toBe(small!.id);
  });

  it('E1.3 dispatches arbitrary named roles and preserves the completed Run snapshot across revisions', async () => {
    const f = harness(), config = f.seed('roles'), [task] = f.plan(config.workflow.id, [{ roleName: 'engineer-4' }]);
    f.dispatch(task!.id); await until(() => f.starts.length === 1); const run = f.starts[0]!.input.run;
    expect(run.providerSnapshot.role.name).toBe('engineer-4'); expect(run.providerSnapshot.binding!.model).toBe('model-a');
    f.complete(f.starts[0]!); await until(() => f.store.task(task!.id).status === 'succeeded');
    f.project.configureRoles('roles', config.bindings.map(binding => ({ ...binding, configRevision: 2, model: 'model-b' })), config.roles.map(role => ({ ...role, prompt: `changed-${role.name}`, revision: 2 })));
    expect(f.store.run(run.id).providerSnapshot).toEqual(run.providerSnapshot); expect(f.store.binding(config.bindings[0]!.id).model).toBe('model-b');
  });

  it('E1.3 rejects retiring a role pinned by queued tasks so the queue cannot become permanently unschedulable', async () => {
    const f = harness(), config = f.seed('pinned-role');
    const [planned, explicit] = f.plan(config.workflow.id, [{ roleName: 'engineer-4' }, {}]); f.coordinator.pause(config.workflow.id);
    f.dispatch(planned!.id);
    f.coordinator.dispatch({ taskId: explicit!.id, roleName: 'engineer-5', idempotencyKey: explicit!.id, expectedVersion: explicit!.version });
    for (const name of ['engineer-4', 'engineer-5']) {
      expect(() => f.project.configureRoles('pinned-role', config.bindings, config.roles.filter(role => role.name !== name))).toThrow();
      expect(f.store.role(`pinned-role:${name}`)).toMatchObject({ enabled: 1, purpose: 'developer' });
    }
    f.coordinator.resume(config.workflow.id); await until(() => f.starts.length === 2);
    expect(new Set(f.starts.map(entry => entry.input.role.name))).toEqual(new Set(['engineer-4', 'engineer-5']));
  });
});

describe('E1.2 independent real filesystem lock and host identity acceptance', () => {
  it('serializes metadata mutations through normalized aliases while allowing another repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rift-e1-lock-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const common = path.join(root, 'repo', '.git'); const other = path.join(root, 'other', '.git'); await mkdir(common, { recursive: true }); await mkdir(other, { recursive: true });
    const entered = deferred<void>(), release = deferred<void>(); const order: string[] = [];
    const first = withMetadataLock(common, async () => { order.push('first'); entered.resolve(); await release.promise; order.push('released'); }); await entered.promise;
    const alias = path.join(common, '..', '.git') + path.sep;
    const second = withMetadataLock(alias, async () => { order.push('second'); });
    await withMetadataLock(other, async () => { order.push('other'); });
    try { expect(order).toEqual(['first', 'other']); } finally { release.resolve(); await Promise.all([first, second]); }
    expect(order).toEqual(['first', 'other', 'released', 'second']);
  });

  it('assigns distinct live Leads to simultaneous workspaces and isolates cancellation', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-e1-leads-')); const handles: { agent: { id: string; cancel: ReturnType<typeof vi.fn>; followup: ReturnType<typeof vi.fn> }; dispose: ReturnType<typeof vi.fn> }[] = [];
    const ctx = { agents: { async create() { const handle = { agent: { id: `lead-${handles.length}`, cancel: vi.fn(async () => undefined), followup: vi.fn() }, dispose: vi.fn(async () => undefined) }; handles.push(handle); return handle; } }, subagents: { list: () => [] }, llm: { listProviders: () => [{ id: 'fake' }] } } as unknown as Context;
    const host = new RiftHostService(ctx, { home, port: 0, leadProvider: 'fake', leadModel: 'fake', checks: [] });
    cleanup.push(async () => { await host.close(); await rm(home, { recursive: true, force: true }); });
    const { seedWorkspace } = await import('./fixtures.js'); seedWorkspace(host.store, 'a'); seedWorkspace(host.store, 'b');
    const workflows = ['a', 'b'].map(workspaceId => host.coordinator.createWorkflow({ workspaceId, goal: 'independent', integrationRef: `refs/heads/rift/${workspaceId}`, baseCommit: sha }));
    const leads = await Promise.all(workflows.map(workflow => host.ensureLead(workflow.id))); expect(new Set(leads.map(lead => lead.leadSessionId)).size).toBe(2);
    await host.handle('POST', `/v1/workflows/${workflows[0]!.id}/cancel`, {}, 'cancel-a');
    expect(handles.find(handle=>handle.agent.id===leads[0]!.leadSessionId)!.agent.cancel).toHaveBeenCalledTimes(1); expect(handles.find(handle=>handle.agent.id===leads[1]!.leadSessionId)!.agent.cancel).not.toHaveBeenCalled(); expect(host.store.workflow(workflows[1]!.id).status).toBe('planning');
    expect(host.store.workflow(workflows[1]!.id).leadSessionId).toBe(leads[1]!.leadSessionId);
  });
});
