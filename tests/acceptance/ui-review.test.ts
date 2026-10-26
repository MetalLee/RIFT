import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { startLocalApi } from '../../src/api/local-api.js';
import { RiftHostService } from '../../src/api/host-service.js';
import { ChatService } from '../../src/chat/service.js';
import { ApiConnectionService } from '../../src/agent/connections.js';
import { redact } from '../../src/api/security.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { updateBrowserAgent } from '../../src/project/browser-agents.js';
import { SkillService } from '../../src/skill/service.js';
import { readWorkspaceEvents } from '../../src/events/workspace-events.js';
import { RepositoryService } from '../../src/project/repositories.js';
import { LocalGitService } from '../../src/git/integration.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { RiftStore } from '../../src/storage/database.js';
import { workspaceDetail, workspaceList } from '../../src/api/workspace-views.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { RiftError, type ActivationBridge, type GitService } from '../../src/contracts/index.js';
import { seedWorkspace } from './fixtures.js';

const providers = new Set(['claude-code-dev', 'codex-review']);
const lead = { provider: 'test-provider', model: 'test-model' };
const exec = promisify(execFile);

describe('Independent saved API connection lifecycle', () => {
  it('adds immutable API revisions without withdrawing existing official DSH routes and protects nonstandard credential references', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-api-registry-review-')); const store = new RiftStore();
    const ctx = new Context(); const llm = await ctx.plugin(LlmRuntime); const connections = new ApiConnectionService(ctx, store, home);
    const variable = 'RIFT_REVIEW_AUTH'; const previous = process.env[variable]; process.env[variable] = 'review-auth-original-unique';
    try {
      await connections.initialize();
      const first = await connections.create({ name: 'First API', protocol: 'openai-completions', endpoint: 'https://example.invalid/one', model: 'test-model-one', credentialRef: variable });
      const snapshots: string[][] = [];
      const disposeObserver = ctx.on('llm/adapters-updated', () => { snapshots.push(ctx.llm.listProviders().map(item => item.id)); });
      const second = await connections.create({ name: 'Revised API', protocol: 'openai-completions', endpoint: 'https://example.invalid/two', model: 'test-model-two', credentialRef: variable, parentId: first.id });
      disposeObserver();
      expect(second).toMatchObject({ revision: 2, parentId: first.id }); expect(second.provider).not.toBe(first.provider);
      expect(connections.get(first.id)).toMatchObject({ endpoint: 'https://example.invalid/one', model: 'test-model-one', revision: 1 });
      expect(snapshots.length).toBeGreaterThan(0); expect(snapshots.every(snapshot => snapshot.includes(first.provider))).toBe(true);
      expect(redact('Plain echo review-auth-original-unique')).not.toContain('review-auth-original-unique');
      process.env[variable] = 'review-auth-rotated-unique'; expect(redact('Plain echo review-auth-rotated-unique')).not.toContain('review-auth-rotated-unique');
      expect(JSON.stringify(connections.list())).not.toContain('review-auth-original-unique');
    } finally { await connections.close(); await llm.dispose(); store.close(); if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; await rm(home, { recursive: true, force: true }); }
  });

  it('disposes a verification handle arriving after close without accessing the closed database', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-verify-late-review-')); const store = new RiftStore();
    let started = false, disposed = false, release!: (handle: unknown) => void;
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    const ctx = { llm: { listProviders: () => [{ id: 'controlled-late-api' }] }, agents: { async create() { started = true; return pending; } } } as unknown as Context;
    const connections = new ApiConnectionService(ctx, store, home);
    store.exec('INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'late-controlled', 'Controlled', 'openai-completions', 'http://127.0.0.1', 'test', 'RIFT_TEST_API_KEY', 'controlled-late-api', 1, new Date().toISOString());
    const verification = connections.verify('late-controlled');
    try {
      await expect.poll(() => started, { timeout: 500, interval: 10 }).toBe(true); await connections.close(); await expect(verification).rejects.toMatchObject({ code: 'HOST_CLOSING' });
      store.close();
      release({ agent: { id: 'late-verification', followup() {}, cancel() {}, whenIdle: () => Promise.resolve(), session: { snapshotEvents: () => [] } }, async dispose() { disposed = true; } });
      await expect.poll(() => disposed, { timeout: 500, interval: 10 }).toBe(true);
    } finally { await connections.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('cancels and settles an owned verification before closing its provider scopes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-verify-close-review-')); const store = new RiftStore();
    let signal: AbortSignal | undefined, disposed = false, finish!: () => void;
    const idle = new Promise<void>(resolve => { finish = resolve; });
    const ctx = { llm: { listProviders: () => [{ id: 'controlled-api' }] }, agents: { async create(options: { signal: AbortSignal }) {
      signal = options.signal;
      return { agent: { id: 'controlled-verification', followup() {}, cancel() { finish(); }, whenIdle: () => idle, session: { snapshotEvents: () => [] } }, async dispose() { disposed = true; finish(); } };
    } } } as unknown as Context;
    const connections = new ApiConnectionService(ctx, store, home);
    store.exec('INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'controlled', 'Controlled', 'openai-completions', 'http://127.0.0.1', 'test', 'RIFT_TEST_API_KEY', 'controlled-api', 1, new Date().toISOString());
    const verification = connections.verify('controlled');
    try {
      await expect.poll(() => Boolean(signal), { timeout: 500, interval: 10 }).toBe(true);
      await connections.close();
      expect(signal!.aborted).toBe(true); expect(disposed).toBe(true);
      await expect(verification).rejects.toMatchObject({ code: 'HOST_CLOSING' });
    } finally { finish(); await verification.catch(() => undefined); await connections.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });
});

describe('Independent real-Git multi-repository boundaries', () => {
  it('requires clean exclusive external worktree ownership before moving into the managed root', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-takeover-review-'));
    const store = new RiftStore(); const { workspace, roles } = seedWorkspace(store, 'takeover-review');
    const git = new LocalGitService({ managedRoot: path.join(home, 'managed'), commands: [] }); const service = new RepositoryService(store, git);
    const repositoryPath = path.join(home, 'repository'), externalPath = path.join(home, 'linked');
    try {
      await mkdir(repositoryPath); await exec('git', ['init', '-q', '-b', 'main', repositoryPath]);
      await writeFile(path.join(repositoryPath, 'README.md'), 'Preserve content'); await writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.tmp\n');
      await exec('git', ['-C', repositoryPath, 'add', '.']); await exec('git', ['-C', repositoryPath, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'base']);
      const repo = service.list(workspace.id)[0]!, inspected = await git.inspectRepository(repositoryPath, 'main');
      store.exec('UPDATE repositories SET canonical_path=?,common_git_dir=?,base_ref=? WHERE id=?', inspected.rootPath, inspected.commonGitDir, 'main', repo.id);
      const primary = await service.createWorktree(workspace.id, repo.id, { origin: 'external', path: repositoryPath });
      await expect(service.takeover(workspace.id, primary.id, { expectedVersion: primary.version, confirmExclusiveOwnership: true })).rejects.toMatchObject({ code: 'WORKTREE_OWNERSHIP' });
      await exec('git', ['-C', repositoryPath, 'worktree', 'add', '--detach', externalPath, 'HEAD']);
      const linked = await service.createWorktree(workspace.id, repo.id, { origin: 'external', path: externalPath });
      store.exec("UPDATE workspace_worktrees SET status='move_unknown' WHERE id=?", linked.id);
      expect(() => service.detach(workspace.id, linked.id, linked.version)).toThrow();
      store.exec("UPDATE workspace_worktrees SET status='active' WHERE id=?", linked.id);
      const take = (destinationPath?: string) => service.takeover(workspace.id, linked.id, { expectedVersion: linked.version, confirmExclusiveOwnership: true, ...(destinationPath ? { destinationPath } : {}) });
      const inspectRepository = git.inspectRepository.bind(git); let inspecting = false, resumeInspect!: () => void;
      const inspectGate = new Promise<void>(resolve => { resumeInspect = resolve; });
      // The service stores canonical paths; macOS temporary paths may use /var aliases.
      git.inspectRepository = async (directory, ref) => { if (directory === linked.path) { inspecting = true; await inspectGate; } return inspectRepository(directory, ref); };
      const racingTakeover = take(path.join(git.managedRoot, 'racing-destination'));
      await expect.poll(() => inspecting, { timeout: 1_000, interval: 10 }).toBe(true);
      service.detach(workspace.id, linked.id, linked.version); resumeInspect();
      await expect(racingTakeover).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      git.inspectRepository = inspectRepository;
      Object.assign(linked, await service.createWorktree(workspace.id, repo.id, { origin: 'external', path: externalPath }));
      await expect(take(path.join(home, 'outside-managed'))).rejects.toThrow();
      await writeFile(path.join(externalPath, 'ignored.tmp'), 'Must preserve ignored content');
      await expect(take()).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
      expect(await readFile(path.join(externalPath, 'ignored.tmp'), 'utf8')).toBe('Must preserve ignored content'); await rm(path.join(externalPath, 'ignored.tmp'));
      store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,cleanup_status,acquired_at) VALUES(?,?,?,?,?,?,?,?)", 'lease-takeover', 'turn', 'unknown-owner', workspace.id, roles.find(role => role.name === 'developer-a')!.id, 'developer', 'unknown', new Date().toISOString());
      await expect(take()).rejects.toMatchObject({ code: 'WORKTREE_IN_USE' });
      store.exec("UPDATE execution_leases SET cleanup_status='confirmed',released_at=? WHERE id='lease-takeover'", new Date().toISOString());
      const target = path.join(git.managedRoot, 'chosen-destination'); const owned = await take(target);
      expect(owned).toMatchObject({ origin: 'managed', status: 'active', path: await realpath(target) });
      expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('Preserve content');
      expect((await git.inspectRepository(target, 'HEAD')).commonGitDir).toBe(inspected.commonGitDir);
      await expect(readFile(path.join(externalPath, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(service.createWorktree(workspace.id, repo.id, { origin: 'managed', branch: 'main' })).rejects.toThrow();
      const archiveWorktree = git.archiveWorktree.bind(git); let archiving = false, resumeArchive!: () => void;
      const archiveGate = new Promise<void>(resolve => { resumeArchive = resolve; });
      git.archiveWorktree = async input => { archiving = true; await archiveGate; return archiveWorktree(input); };
      const firstArchive = service.archive(workspace.id, owned.id, owned.version);
      await expect.poll(() => archiving, { timeout: 1_000, interval: 10 }).toBe(true);
      await expect(service.archive(workspace.id, owned.id, owned.version)).rejects.toMatchObject({ code: 'WORKTREE_IN_USE' });
      resumeArchive(); await expect(firstArchive).resolves.toMatchObject({ status: 'archived' });
    } finally { store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('integrates two real repositories through dependency, rejected review, repair and added plan tasks without mixing commits', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-repo-flow-review-'));
    const store = new RiftStore(); const seeded = seedWorkspace(store, 'multi-flow');
    const git = new LocalGitService({ managedRoot: path.join(home, 'managed'), commands: [{ id: 'content', executable: process.execPath, args: ['-e', "const f=require('node:fs').readFileSync('README.md','utf8'); if(!/^repository-[ab]\\r?\\n/.test(f)||!f.includes('TASK:')) process.exit(1)"] }] });
    const repos = new RepositoryService(store, git); const paths = [path.join(home, 'a'), path.join(home, 'b')];
    const observations: { task: string; purpose: string; common: string; candidate?: string }[] = [];
    const bridge: ActivationBridge = { async start(input) {
      const prompt = JSON.parse(input.prompt); const common = (await git.inspectRepository(input.cwd, 'HEAD')).commonGitDir;
      observations.push({ task: input.task.id, purpose: input.run.purpose, common, candidate: prompt.candidate?.candidateHead });
      let result: object;
      if (input.run.purpose === 'review') result = { schemaVersion: 1, taskId: input.task.id, runId: input.run.id, verdict: input.task.id === 'repo-task-a' && input.task.attempt === 1 ? 'changes_requested' : 'approve', reviewedCommit: prompt.candidate.candidateHead, findings: [] };
      else {
        const file = path.join(input.cwd, 'README.md'); await writeFile(file, `${await readFile(file, 'utf8')}TASK:${input.task.id}:${input.task.attempt}\n`);
        result = { schemaVersion: 1, taskId: input.task.id, runId: input.run.id, outcome: 'completed', summary: 'Controlled test wrote assigned README', changedPaths: ['README.md'], checksClaimed: [], blockingReasons: [] };
      }
      return { childId: `controlled-${input.run.id}`, result: Promise.resolve({ text: JSON.stringify(result), stopReason: 'completed' }), async dispose() {} };
    } };
    const coordinator = new TaskCoordinator({ store, bridge, git });
    try {
      for (const [index, directory] of paths.entries()) {
        await mkdir(directory); await exec('git', ['init', '-q', '-b', 'main', directory]); await writeFile(path.join(directory, 'README.md'), `repository-${index === 0 ? 'a' : 'b'}\n`);
        await exec('git', ['-C', directory, 'add', '.']); await exec('git', ['-C', directory, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'base']);
      }
      const first = repos.list(seeded.workspace.id)[0]!, inspected = await git.inspectRepository(paths[0]!, 'main');
      store.exec('UPDATE repositories SET canonical_path=?,common_git_dir=?,base_ref=? WHERE id=?', inspected.rootPath, inspected.commonGitDir, 'main', first.id);
      const workspace = store.workspace(seeded.workspace.id) as typeof seeded.workspace & { version: number };
      const second = await repos.connect(workspace.id, { repositoryPath: paths[1]!, baseRef: 'main', expectedVersion: workspace.version });
      const secondInfo = await git.inspectRepository(paths[1]!, 'main');
      const refs = ['refs/heads/rift/review/a', 'refs/heads/rift/review/b'];
      const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Cross repository change', integrationRef: refs[0]!, baseCommit: inspected.baseCommit, repositorySnapshots: [{ repositoryId: first.id, baseCommit: inspected.baseCommit, integrationRef: refs[0]! }, { repositoryId: second.id, baseCommit: secondInfo.baseCommit, integrationRef: refs[1]! }] });
      const task = (id: string, repositoryId: string, dependsOn: string[] = []) => ({ id, repositoryId, kind: 'change' as const, title: id, instructions: 'Append the assigned marker', expectedPaths: ['README.md'], dependsOn });
      coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [task('repo-task-a', first.id), task('repo-task-b', second.id, ['repo-task-a'])] });
      coordinator.dispatch({ taskId: 'repo-task-a', expectedVersion: 0, idempotencyKey: 'a1' });
      coordinator.dispatch({ taskId: 'repo-task-b', expectedVersion: 0, idempotencyKey: 'b1' });
      await expect.poll(() => store.task('repo-task-a').status, { timeout: 10000, interval: 30 }).toBe('blocked');
      expect(store.task('repo-task-a').blockingReason).toContain('Review must approve');
      expect(store.task('repo-task-a').acceptedCommit).toBeNull();
      expect(() => coordinator.finish({ workflowId: workflow.id, summary: 'Premature' })).toThrow();
      const repair = coordinator.retry({ taskId: 'repo-task-a', expectedVersion: store.task('repo-task-a').version, reason: 'Address controlled review' });
      coordinator.dispatch({ taskId: repair.id, expectedVersion: repair.version, idempotencyKey: 'a2' });
      await expect.poll(() => ['succeeded','blocked'].includes(store.task('repo-task-a').status), { timeout: 10000, interval: 30 }).toBe(true);
      expect(store.task('repo-task-a').status, store.task('repo-task-a').blockingReason ?? '').toBe('succeeded');
      const b = store.task('repo-task-b');
      coordinator.replan({ workflowId: workflow.id, expectedRevision: store.workflow(workflow.id).planRevision, updates: [{ taskId: b.id, expectedVersion: b.version, dependsOn: ['repo-task-a'] }], tasks: [task('repo-task-c', first.id, ['repo-task-b'])] });
      coordinator.dispatch({ taskId: b.id, expectedVersion: store.task(b.id).version, idempotencyKey: 'b2' });
      coordinator.dispatch({ taskId: 'repo-task-c', expectedVersion: 0, idempotencyKey: 'c1' });
      await expect.poll(() => store.task('repo-task-c').status, { timeout: 10000, interval: 30 }).toBe('succeeded');
      expect(store.workflow(workflow.id).planRevision).toBe(2);
      expect(coordinator.finish({ workflowId: workflow.id, summary: 'Both repositories accepted' }).status).toBe('completed');
      for (const observation of observations) expect(observation.common).toBe(observation.task === 'repo-task-b' ? secondInfo.commonGitDir : inspected.commonGitDir);
      const aText = (await exec('git', ['-C', paths[0]!, 'show', `${refs[0]}:README.md`])).stdout;
      const bText = (await exec('git', ['-C', paths[1]!, 'show', `${refs[1]}:README.md`])).stdout;
      expect(aText).toContain('repo-task-a:2'); expect(aText).toContain('repo-task-c:1'); expect(aText).not.toContain('repo-task-b');
      expect(bText).toContain('repo-task-b:1'); expect(bText).not.toContain('repo-task-a'); expect(bText).not.toContain('repo-task-c');
      for (const taskId of ['repo-task-a','repo-task-b','repo-task-c']) expect(observations.some(item => item.task === taskId && item.purpose === 'review' && item.candidate === store.task(taskId).acceptedCommit)).toBe(true);
      expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally { await coordinator.shutdown(); store.close(); await rm(home, { recursive: true, force: true }); }
  }, 40000);

  it('preserves repository ownership and refuses dirty or external worktree deletion', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-repository-review-'));
    const store = new RiftStore();
    const git = new LocalGitService({ managedRoot: path.join(home, 'managed'), commands: [] });
    const service = new RepositoryService(store, git);
    const paths = [path.join(home, 'repo-a'), path.join(home, 'repo-b')];
    try {
      for (const repository of paths) {
        await mkdir(repository); await exec('git', ['init', '-q', '-b', 'main', repository]);
        await writeFile(path.join(repository, 'README.md'), repository);
        await exec('git', ['-C', repository, 'add', '.']);
        await exec('git', ['-C', repository, '-c', 'user.name=Independent review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'base']);
      }
      const inspected = await git.inspectRepository(paths[0]!, 'main');
      const workspace = createWorkspace(store, { id: 'repo-workspace', name: 'Repositories', rootPath: home, repositoryPath: inspected.rootPath, commonGitDir: inspected.commonGitDir, baseRef: 'main' });
      const first = service.list(workspace.id)[0]!;
      const before = store.workspace(workspace.id) as typeof workspace & { version: number };
      const second = await service.connect(workspace.id, { repositoryPath: paths[1]!, baseRef: 'main', expectedVersion: before.version });
      expect(service.list(workspace.id)).toHaveLength(2);
      expect(store.workspace(workspace.id).repositoryPath).toBe(inspected.rootPath);
      const current = store.workspace(workspace.id) as typeof before;
      await expect(service.connect(workspace.id, { repositoryPath: paths[1]!, baseRef: 'main', expectedVersion: current.version })).rejects.toMatchObject({ code: 'REPOSITORY_EXISTS' });
      seedWorkspace(store, 'foreign-repo-workspace');
      expect(() => service.get('foreign-repo-workspace', first.id)).toThrow();
      const managed = await service.createWorktree(workspace.id, second.id, { origin: 'managed', baseRef: 'main' });
      expect((await git.inspectRepository(managed.path, 'HEAD')).commonGitDir).toBe(second.commonGitDir);
      await writeFile(path.join(managed.path, 'untracked.txt'), 'Must preserve');
      await expect(service.archive(workspace.id, managed.id, managed.version)).rejects.toThrow(/dirty|untracked|ignored/);
      expect(await readFile(path.join(managed.path, 'untracked.txt'), 'utf8')).toBe('Must preserve');
      await rm(path.join(managed.path, 'untracked.txt'));
      await expect(service.archive(workspace.id, managed.id, managed.version)).resolves.toMatchObject({ status: 'archived' });
      const externalPath = path.join(home, 'external-checkout');
      await exec('git', ['-C', paths[0]!, 'worktree', 'add', '--detach', externalPath, 'HEAD']);
      const external = await service.createWorktree(workspace.id, first.id, { origin: 'external', path: externalPath });
      await expect(service.archive(workspace.id, external.id, external.version)).rejects.toMatchObject({ code: 'WORKTREE_OWNERSHIP' });
      expect(service.detach(workspace.id, external.id, external.version).status).toBe('detached');
      expect(await readFile(path.join(externalPath, 'README.md'), 'utf8')).toBe(paths[0]);
      const reattached = await service.createWorktree(workspace.id, first.id, { origin: 'external', path: externalPath });
      expect(reattached).toMatchObject({ id: external.id, origin: 'external', status: 'active' });
      expect(reattached.version).toBeGreaterThan(external.version);
      await expect(service.createWorktree(workspace.id, second.id, { origin: 'external', path: paths[0] })).rejects.toMatchObject({ code: 'WORKTREE_OWNERSHIP' });
      expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally { store.close(); await rm(home, { recursive: true, force: true }); }
  });
});

describe('Independent domain migration and Skill boundaries', () => {
  it('does not release an interrupted candidate preparation merely because no review Run was recorded', async () => {
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const coordinator = new TaskCoordinator({ store, bridge: {} as ActivationBridge, git: {} as GitService });
    try {
      const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Unknown check descendants', baseCommit: 'a'.repeat(40), integrationRef: 'refs/heads/rift/orphan-candidate' });
      coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'orphan-candidate-task', kind: 'change', title: 'Change', instructions: 'Write', expectedPaths: ['file.txt'] }] });
      store.exec("UPDATE tasks SET status='blocked',source_head=?,blocking_reason='RECOVERY_REQUIRES_INSPECTION' WHERE id='orphan-candidate-task'", 'b'.repeat(40));
      store.exec("INSERT INTO integrations(id,task_id,source_head,status,error) VALUES(?,?,?,?,?)", 'orphan-candidate', 'orphan-candidate-task', 'b'.repeat(40), 'cleanup_unknown', 'Host interrupted during check preparation');
      await expect(coordinator.reconcileIntegration('orphan-candidate', 0)).rejects.toMatchObject({ code: 'CLEANUP_UNKNOWN' });
      expect(store.require('SELECT status FROM integrations WHERE id=?', 'orphan-candidate')).toEqual({ status: 'cleanup_unknown' });
    } finally { await coordinator.shutdown(); store.close(); }
  });

  it('reconciles retained Task Run cleanup only with matching-machine reboot proof and current version', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-run-proof-review-')); const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const machine = '1'.repeat(64), foreign = '2'.repeat(64), boot = '3'.repeat(64), next = '4'.repeat(64);
    const bridge: ActivationBridge = { async start(input) { return { childId: 'orphan-review', result: Promise.resolve({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: input.task.id, runId: input.run.id, outcome: 'completed', summary: 'Saved result', changedPaths: [], checksClaimed: [], blockingReasons: [] }) }), async dispose() { throw new Error('Cleanup unconfirmed'); } }; } };
    const git = { async prepareTask(input: Parameters<GitService['prepareTask']>[0]) { return { id: 'proof-tree', taskId: input.task.id, attempt: 1, kind: 'task' as const, path: home, baseCommit: 'a'.repeat(40) }; } } as GitService;
    const coordinator = new TaskCoordinator({ store, bridge, git }); coordinator.setBootIdentity(`v1:${machine}:${boot}`);
    try {
      const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Cleanup proof', baseCommit: 'a'.repeat(40), integrationRef: 'refs/heads/rift/proof' });
      coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'proof-task', kind: 'analysis', title: 'Read', instructions: 'Read', expectedPaths: [] }] });
      coordinator.dispatch({ taskId: 'proof-task', expectedVersion: 0, idempotencyKey: 'proof-dispatch' });
      await expect.poll(() => store.task('proof-task').status, { timeout: 500, interval: 10 }).toBe('blocked');
      const run = store.require<{id:string;version:number}>('SELECT * FROM runs WHERE task_id=?', 'proof-task');
      expect(() => coordinator.reconcileRun(run.id, run.version)).toThrow(/No owned cleanup/);
      coordinator.setBootIdentity(`v1:${foreign}:${next}`); expect(() => coordinator.reconcileRun(run.id, run.version)).toThrow(/No owned cleanup/);
      coordinator.setBootIdentity(`v1:${machine}:${next}`); expect(() => coordinator.reconcileRun(run.id, run.version - 1)).toThrow(/changed/);
      expect(coordinator.reconcileRun(run.id, run.version)).toMatchObject({ cleanupStatus: 'confirmed', slotReleasedAt: expect.any(String) });
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', run.id)).toMatchObject({ cleanupStatus: 'confirmed', releasedAt: expect.any(String) });
      expect(store.require('SELECT writer_run_id FROM worktrees WHERE id=?', 'proof-tree')).toEqual({ writerRunId: null });
      expect(store.task('proof-task').status).toBe('blocked');
    } finally { await coordinator.shutdown(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('blocks filesystem mutation in repository-free analysis and accepts a clean repair without Git records', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-text-mutation-review-'));
    const host = new RiftHostService({ subagents: { list: () => [] }, llm: { listProviders: () => [] } } as unknown as Context, { home, port: 0, leadProvider: 'unused', leadModel: 'unused', checks: [] });
    const inputs: RuntimeTurnInput[] = []; let mutate = true;
    host.registerChatRuntime('codex', { async start(input) { inputs.push(input); if (mutate) await writeFile(path.join(input.cwd, 'forbidden.txt'), 'preserve evidence'); return { result: Promise.resolve({ text: 'Analysis response', stopReason: 'completed' }), async dispose() {} }; } }, ['analysis-test']);
    try {
      const workspace = await host.handleBrowser('POST', '/ui-api/v1/workspaces', { name: 'Text analysis review' }, 'text-ws') as { id: string };
      await host.handleBrowser('POST', `/ui-api/v1/workspaces/${workspace.id}/agents`, { name: 'analyst', displayName: '分析员', purpose: 'developer', prompt: 'Only supplied prose', chatConnection: { runtime: 'codex', model: 'analysis-test' } }, 'analyst');
      const workflow = await host.handle('POST', '/v1/workflows', { workspaceId: workspace.id, goal: 'Analyze supplied prose', mode: 'analysis', startLead: false }, 'analysis') as { id: string };
      host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'text-mutation', kind: 'analysis', title: 'Read', instructions: 'Compare supplied text', expectedPaths: [], roleName: 'analyst' }] });
      host.coordinator.dispatch({ taskId: 'text-mutation', expectedVersion: 0, idempotencyKey: 'text-first' });
      await expect.poll(() => host.store.task('text-mutation').status, { timeout: 800, interval: 10 }).toBe('blocked');
      expect(host.store.task('text-mutation').blockingReason).toContain('staging');
      expect(await readFile(path.join(inputs[0]!.cwd, 'forbidden.txt'), 'utf8')).toBe('preserve evidence');
      expect(() => host.coordinator.finish({ workflowId: workflow.id, summary: 'Not accepted' })).toThrow();
      mutate = false; const repair = host.coordinator.retry({ taskId: 'text-mutation', expectedVersion: host.store.task('text-mutation').version, reason: 'Use the restricted text path' });
      host.coordinator.dispatch({ taskId: repair.id, expectedVersion: repair.version, idempotencyKey: 'text-repair' });
      await expect.poll(() => host.store.task('text-mutation').status, { timeout: 800, interval: 10 }).toBe('succeeded');
      expect(inputs).toHaveLength(2); expect(inputs.every(input => input.tools.length === 1 && input.tools[0]!.name === 'rift_send_message')).toBe(true); expect(inputs[0]!.cwd).not.toBe(inputs[1]!.cwd);
      expect(host.store.all('SELECT * FROM worktrees')).toEqual([]); expect(host.store.all('SELECT * FROM workflow_repositories')).toEqual([]);
      expect(host.store.task('text-mutation')).toMatchObject({ repositoryId: null, acceptedCommit: null });
      expect(host.coordinator.finish({ workflowId: workflow.id, summary: 'Restricted text verified' }).status).toBe('completed');
    } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('times out repository-free Run startup and releases its lease only after late disposal evidence', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-run-start-review-'));
    const host = new RiftHostService({ subagents: { list: () => [] }, llm: { listProviders: () => [] } } as unknown as Context, { home, port: 0, leadProvider: 'unused', leadModel: 'unused', checks: [], runTimeoutMs: 25 });
    let release!: (value: {result:Promise<RuntimeTurnResult>;dispose():Promise<void>}) => void, disposed = false;
    const started = new Promise<{result:Promise<RuntimeTurnResult>;dispose():Promise<void>}>(resolve => { release = resolve; });
    host.registerChatRuntime('codex', { start: () => started }, ['analysis-test']);
    try {
      const workspace = await host.handleBrowser('POST', '/ui-api/v1/workspaces', { name: 'Run timeout review' }, 'timeout-ws') as {id:string};
      await host.handleBrowser('POST', `/ui-api/v1/workspaces/${workspace.id}/agents`, { name: 'analyst', displayName: '分析员', purpose: 'developer', prompt: 'Only supplied prose', chatConnection: { runtime: 'codex', model: 'analysis-test' } }, 'timeout-agent');
      const workflow = await host.handle('POST', '/v1/workflows', { workspaceId: workspace.id, goal: 'Timeout safely', mode: 'analysis', startLead: false }, 'timeout-workflow') as {id:string};
      host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'timeout-analysis', kind: 'analysis', title: 'Read', instructions: 'Read only', expectedPaths: [], roleName: 'analyst' }] });
      host.coordinator.dispatch({ taskId: 'timeout-analysis', expectedVersion: 0, idempotencyKey: 'timeout-dispatch' });
      await expect.poll(() => host.store.task('timeout-analysis').status, { timeout: 800, interval: 10 }).toBe('blocked');
      const run = host.store.require<{id:string;cleanupStatus:string}>('SELECT * FROM runs WHERE task_id=?', 'timeout-analysis');
      expect(run.cleanupStatus).toBe('unknown'); expect(host.store.require('SELECT * FROM execution_leases WHERE owner_id=?', run.id)).toMatchObject({releasedAt:null});
      release({ result: Promise.resolve({text:'Too late',stopReason:'completed'}), async dispose() { disposed = true; } });
      await expect.poll(() => host.store.run(run.id).cleanupStatus, { timeout: 800, interval: 10 }).toBe('confirmed');
      expect(disposed).toBe(true); expect(host.store.run(run.id).status).toBe('cancelled');
    } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('injects immutable Skill instructions into a real Host discussion path and blocks archive while its Turn is active', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-host-skill-review-'));
    const ctx = { subagents: { list: () => [...providers], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const service = new RiftHostService(ctx, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    const inputs: RuntimeTurnInput[] = []; const finishes: ((value: RuntimeTurnResult) => void)[] = [];
    service.registerChatRuntime('codex', { async start(input) { inputs.push(input); return { result: new Promise<RuntimeTurnResult>(resolve => finishes.push(resolve)), async dispose() {} }; } }, ['test-model']);
    try {
      const workspace = await service.handleBrowser('POST', '/ui-api/v1/workspaces', { name: 'Discussion without repository', leadConnection: { runtime: 'codex', model: 'test-model' } }, 'no-repo') as { id: string; repositoryPath: string | null };
      expect(workspace.repositoryPath).toBeFalsy();
      const roles = service.store.all<{id:string}>('SELECT id FROM roles WHERE workspace_id=?', workspace.id); expect(roles).toHaveLength(3);
      const conversation = service.chat.createConversation(workspace.id, 'Skill snapshot verification');
      const directory = path.join(home, 'skill-source'); await mkdir(directory); await writeFile(path.join(directory, 'SKILL.md'), 'HOST_SKILL_VERSION_ONE');
      const preview = service.skills.previewImport({ workspaceId: workspace.id, directory });
      const first = service.skills.saveImport({ workspaceId: workspace.id, previewId: preview.previewId });
      service.skills.setShared(workspace.id, first.skill.id, { versionId: first.version.id, enabled: true, expectedRevision: 0 });
      const turn = service.chat.send(workspace.id, conversation.id, { clientMessageId: 'host-skill', content: 'Use the configured instructions' }).turn;
      await expect.poll(() => inputs.length, { timeout: 500, interval: 10 }).toBe(1);
      expect(inputs[0]!.instructions).toContain('HOST_SKILL_VERSION_ONE');
      await expect(service.handle('POST', `/v1/workspaces/${workspace.id}/archive`, {}, 'archive-active')).rejects.toMatchObject({ code: 'WORKSPACE_ACTIVE' });
      await writeFile(path.join(directory, 'SKILL.md'), 'HOST_SKILL_VERSION_TWO');
      const nextPreview = service.skills.previewImport({ workspaceId: workspace.id, directory, skillId: first.skill.id, expectedRevision: first.skill.revision });
      const next = service.skills.saveImport({ workspaceId: workspace.id, previewId: nextPreview.previewId });
      service.skills.setShared(workspace.id, first.skill.id, { versionId: next.version.id, enabled: true, expectedRevision: 1 });
      expect(service.chat.turn(workspace.id, turn.id).configuration.skillInstructions).toContain('HOST_SKILL_VERSION_ONE');
      const snapshot = service.store.require<{snapshotJson:string}>('SELECT snapshot_json FROM skill_execution_snapshots WHERE owner_type=? AND owner_id=?', 'turn', turn.id);
      expect(JSON.parse(snapshot.snapshotJson).versions[0].versionId).toBe(first.version.id);
      finishes[0]!({ text: 'Done', stopReason: 'completed' });
      await expect.poll(() => service.chat.turn(workspace.id, turn.id).cleanupStatus, { timeout: 500, interval: 10 }).toBe('confirmed');
      const second = service.chat.send(workspace.id, conversation.id, { clientMessageId: 'host-skill-two', content: 'Next version' }).turn;
      await expect.poll(() => inputs.length, { timeout: 500, interval: 10 }).toBe(2);
      expect(inputs[1]!.instructions).toContain('HOST_SKILL_VERSION_TWO');
      finishes[1]!({ text: 'Done again', stopReason: 'completed' });
      await expect.poll(() => service.chat.turn(workspace.id, second.id).cleanupStatus, { timeout: 500, interval: 10 }).toBe('confirmed');
      expect(service.browserEvents(workspace.id, 0).events.some(event => event.type === 'skill.shared')).toBe(true);
      await expect(service.handle('POST', `/v1/workspaces/${workspace.id}/archive`, {}, 'archive-clean')).resolves.toMatchObject({ status: 'archived' });
    } finally { for (const finish of finishes) finish({ text: '', stopReason: 'cancelled' }); await service.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('passes the fixed Run Skill snapshot to the activation bridge', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-run-skill-review-'));
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const skills = new SkillService(store); const directory = path.join(home, 'skill'); await mkdir(directory); await writeFile(path.join(directory, 'SKILL.md'), 'RUN_SKILL_FIXED');
    const preview = skills.previewImport({ workspaceId: workspace.id, directory }); const imported = skills.saveImport({ workspaceId: workspace.id, previewId: preview.previewId });
    skills.setShared(workspace.id, imported.skill.id, { versionId: imported.version.id, enabled: true, expectedRevision: 0 });
    let captured: Parameters<ActivationBridge['start']>[0] | undefined;
    const bridge: ActivationBridge = { async start(input) { captured = input; return { childId: 'review-child', result: Promise.resolve({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: input.task.id, runId: input.run.id, outcome: 'completed', summary: 'Controlled acceptance', changedPaths: [], checksClaimed: [], blockingReasons: [] }) }), async dispose() {} }; } };
    const git: GitService = { async prepareTask(input) { return { id: 'review-tree', taskId: input.task.id, attempt: 1, kind: 'task', path: home, baseCommit: 'a'.repeat(40) }; }, async verifyAnalysis() { return { headCommit: 'a'.repeat(40) }; }, async collectSource() { throw new Error('Analysis must not collect a code source'); }, async prepareCandidate() { throw new Error('Analysis must not prepare a code candidate'); }, async publishCandidate() { throw new Error('Analysis must not publish code'); } };
    const coordinator = new TaskCoordinator({ store, bridge, git, skillSnapshot: (workspaceId, agentId, runtime, runId) => skills.snapshotExecution(workspaceId, agentId, 'run', runId, skills.resolveEffective(workspaceId, agentId, runtime)) });
    try {
      const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Verify actual injection', integrationRef: 'refs/heads/rift/run-skill-review', baseCommit: 'a'.repeat(40) });
      coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'run-skill-task', kind: 'analysis', title: 'Inspect', instructions: 'Read', expectedPaths: [] }] });
      coordinator.dispatch({ taskId: 'run-skill-task', expectedVersion: 0, idempotencyKey: 'run-skill' });
      await expect.poll(() => store.task('run-skill-task').status, { timeout: 500, interval: 10 }).toBe('succeeded');
      expect(JSON.parse(captured!.prompt).skillInstructions).toContain('RUN_SKILL_FIXED');
      expect(JSON.parse(captured!.prompt).skillVersions[0].versionId).toBe(imported.version.id);
      expect(store.require<{snapshotJson:string}>('SELECT snapshot_json FROM skill_execution_snapshots WHERE owner_type=? AND owner_id=?', 'run', captured!.run.id).snapshotJson).toContain(imported.version.id);
    } finally { await coordinator.shutdown(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('blocks a task with incompatible effective Skills instead of leaving a poison queue request', async () => {
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const coordinator = new TaskCoordinator({ store, bridge: {} as ActivationBridge, git: {} as GitService, skillSnapshot: () => { throw new RiftError('SKILL_INCOMPATIBLE', 'Selected Skill requires unavailable runtime resources.'); } });
    try {
      const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Reject incompatible Skill', integrationRef: 'refs/heads/rift/skill-review', baseCommit: 'a'.repeat(40) });
      coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'skill-poison-task', kind: 'analysis', title: 'Needs resources', instructions: 'Read', expectedPaths: [] }] });
      expect(() => coordinator.dispatch({ taskId: 'skill-poison-task', expectedVersion: 0, idempotencyKey: 'skill-poison' })).not.toThrow();
      expect(store.require('SELECT * FROM operations WHERE dedupe_key=?', 'skill-poison')).toMatchObject({ phase: 'blocked' });
      expect(store.task('skill-poison-task')).toMatchObject({ status: 'blocked', blockingReason: expect.stringContaining('unavailable runtime resources') });
      expect(() => coordinator.wake()).not.toThrow();
      expect(store.all('SELECT id FROM runs')).toHaveLength(0);
    } finally { await coordinator.shutdown(); store.close(); }
  });

  it('upgrades a real v3 database without releasing unknown Run cleanup or changing historical identity', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-migration-review-'));
    const database = path.join(home, 'legacy.db');
    const old = new DatabaseSync(database);
    try {
      old.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
      for (const name of ['0001_initial.sql', '0002_result_artifact.sql', '0003_scalable_scheduler.sql']) old.exec(await readFile(path.join(process.cwd(), 'migrations', name), 'utf8'));
      old.exec("INSERT INTO workspaces(id,name,root_path) VALUES('old-w','Old','C:/old'); INSERT INTO repositories VALUES('old-repo','old-w','C:/old','C:/old/.git','main'); INSERT INTO provider_bindings(id,provider_name,package_version,config_revision,capabilities,credential_refs) VALUES('old-binding','test','test',1,'{}','[]'); INSERT INTO roles(id,workspace_id,name,enabled,purpose,kind,provider_binding_id,prompt,revision) VALUES('old-agent','old-w','developer-a',1,'developer','subagent','old-binding','Preserve',1); INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('old-flow','old-w','Old goal','paused','refs/heads/rift/old','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('old-task','old-flow','old-agent','analysis','Old task','Read','[]','[]','blocked'); INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,cleanup_status,deadline,created_at) VALUES('old-run','old-task','old-agent','develop',1,'interrupted','{}','unknown','2026-01-01','2026-01-01');");
    } finally { old.close(); }
    const store = new RiftStore(database, { lock: false });
    try {
      expect(store.run('old-run')).toMatchObject({ status: 'interrupted', cleanupStatus: 'unknown', slotReleasedAt: null });
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', 'old-run')).toMatchObject({ ownerType: 'run', workspaceId: 'old-w', agentId: 'old-agent', capacity: 'developer', cleanupStatus: 'unknown', releasedAt: null });
      expect(store.task('old-task')).toMatchObject({ repositoryId: 'old-repo' });
      expect(store.require('SELECT * FROM workflow_repositories WHERE workflow_id=?', 'old-flow')).toMatchObject({ repositoryId: 'old-repo', integrationRef: 'refs/heads/rift/old' });
      expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(() => store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('duplicate','turn','new','old-w','old-agent','developer','2026-01-01')")).toThrow();
    } finally { store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps shared and per-Agent Skill versions immutable, isolated and explicit about incompatible resources', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-skill-review-'));
    const store = new RiftStore(); const alpha = seedWorkspace(store, 'skill-alpha'), beta = seedWorkspace(store, 'skill-beta');
    const skills = new SkillService(store); const source = path.join(home, 'skill'); await mkdir(source);
    try {
      await writeFile(path.join(source, 'SKILL.md'), 'Version one instructions');
      const preview = skills.previewImport({ workspaceId: alpha.workspace.id, directory: source, name: 'Review method' });
      expect(() => skills.saveImport({ workspaceId: beta.workspace.id, previewId: preview.previewId })).toThrow();
      const first = skills.saveImport({ workspaceId: alpha.workspace.id, previewId: preview.previewId });
      skills.setShared(alpha.workspace.id, first.skill.id, { versionId: first.version.id, enabled: true, expectedRevision: 0 });
      const agentA = alpha.roles.find(role => role.name === 'developer-a')!, agentB = alpha.roles.find(role => role.name === 'developer-b')!;
      const captured = skills.resolveEffective(alpha.workspace.id, agentA.id, 'dsh');
      expect(captured.instructions).toContain('Version one instructions');
      expect(skills.resolveEffective(alpha.workspace.id, agentB.id, 'dsh').versions[0]?.versionId).toBe(first.version.id);
      await writeFile(path.join(source, 'SKILL.md'), 'Version two instructions');
      const secondPreview = skills.previewImport({ workspaceId: alpha.workspace.id, directory: source, skillId: first.skill.id, expectedRevision: first.skill.revision });
      const second = skills.saveImport({ workspaceId: alpha.workspace.id, previewId: secondPreview.previewId });
      skills.setAgent(alpha.workspace.id, agentA.id, first.skill.id, { mode: 'include', versionId: second.version.id, expectedRevision: 0 });
      expect(skills.resolveEffective(alpha.workspace.id, agentA.id, 'dsh').instructions).toContain('Version two instructions');
      expect(skills.resolveEffective(alpha.workspace.id, agentB.id, 'dsh').instructions).toContain('Version one instructions');
      expect(captured.instructions).toContain('Version one instructions');
      expect(() => skills.version(beta.workspace.id, first.version.id)).toThrow();
      expect(() => skills.setAgent(alpha.workspace.id, beta.roles[0]!.id, first.skill.id, { mode: 'include', versionId: first.version.id, expectedRevision: 0 })).toThrow();
      expect(() => store.exec('UPDATE skill_versions SET instructions=? WHERE id=?', 'Changed', first.version.id)).toThrow();
      expect(() => store.exec('DELETE FROM skill_versions WHERE id=?', first.version.id)).toThrow();
      skills.setAgent(alpha.workspace.id, agentB.id, first.skill.id, { mode: 'exclude', expectedRevision: 0 });
      expect(skills.resolveEffective(alpha.workspace.id, agentB.id, 'dsh').versions).toEqual([]);
      await writeFile(path.join(source, 'resource.txt'), 'Resource bytes');
      const resourcePreview = skills.previewImport({ workspaceId: alpha.workspace.id, directory: source, name: 'Resource skill' });
      const resource = skills.saveImport({ workspaceId: alpha.workspace.id, previewId: resourcePreview.previewId });
      skills.setShared(alpha.workspace.id, resource.skill.id, { versionId: resource.version.id, enabled: true, expectedRevision: 0 });
      expect(() => skills.resolveEffective(alpha.workspace.id, agentA.id, 'dsh')).toThrowError(/resource loading/);
      await writeFile(path.join(source, '.env'), 'PRIVATE_IMPORT_DATA');
      expect(() => skills.previewImport({ workspaceId: alpha.workspace.id, directory: source })).toThrowError(/credential files/);
    } finally { store.close(); await rm(home, { recursive: true, force: true }); }
  });
});

describe('Independent durable chat boundaries', () => {
  it('releases timed-out startup only after its late owned runtime cleanup is confirmed', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-start-receipt-review-')); const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    let release!: (handle: { result: Promise<RuntimeTurnResult>; dispose(): Promise<void> }) => void, started = false, disposed = false;
    const starting = new Promise<{ result: Promise<RuntimeTurnResult>; dispose(): Promise<void> }>(resolve => { release = resolve; });
    const chat = new ChatService({ store, home, timeoutMs: 15, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start() { started = true; return starting; } }) });
    try {
      const conversation = chat.createConversation(workspace.id); const turn = chat.send(workspace.id, conversation.id, { clientMessageId: 'late-start', content: 'Wait for owned startup' }).turn;
      await expect.poll(() => started, { timeout: 500, interval: 5 }).toBe(true);
      await expect.poll(() => chat.turn(workspace.id, turn.id).cleanupStatus, { timeout: 500, interval: 5 }).toBe('unknown');
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', turn.id)).toMatchObject({ releasedAt: null });
      release({ result: Promise.resolve({ text: 'Too late', stopReason: 'completed' }), async dispose() { disposed = true; } });
      await expect.poll(() => chat.turn(workspace.id, turn.id).cleanupStatus, { timeout: 500, interval: 5 }).toBe('confirmed');
      expect(disposed).toBe(true); expect(chat.turn(workspace.id, turn.id).status).toBe('cancelled');
      expect(chat.page(workspace.id, conversation.id).messages.some(message => message.content === 'Too late')).toBe(false);
    } finally { await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('rejects foreign structured context and fixes selected context independently of later repository metadata', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-context-scope-review-'));
    const ctx = { subagents: { list: () => [...providers], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const host = new RiftHostService(ctx, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    const starts: RuntimeTurnInput[] = []; const finishes: ((value: RuntimeTurnResult) => void)[] = [];
    host.registerChatRuntime('codex', { async start(input) { starts.push(input); return { result: new Promise<RuntimeTurnResult>(resolve => finishes.push(resolve)), async dispose() {} }; } }, ['test']);
    try {
      const alpha = seedWorkspace(host.store, 'context-alpha'), beta = seedWorkspace(host.store, 'context-beta');
      host.store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?', JSON.stringify({ runtime: 'codex', model: 'test' }), alpha.workspace.id);
      const conversation = host.chat.createConversation(alpha.workspace.id);
      const ownRepo = host.repositories.list(alpha.workspace.id)[0]!, foreignRepo = host.repositories.list(beta.workspace.id)[0]!;
      expect(() => host.chat.send(alpha.workspace.id, conversation.id, { clientMessageId: 'foreign-repository', content: 'Read', contextRefs: [{ type: 'repository', id: foreignRepo.id }] })).toThrow();
      expect(() => host.chat.send(alpha.workspace.id, conversation.id, { clientMessageId: 'foreign-mention', content: 'Read', mentions: [{ agentId: beta.roles[0]!.id, label: 'Forged' }] })).toThrow(/mention/);
      const input = { clientMessageId: 'fixed-context', content: 'Read context', contextRefs: [{ type: 'repository' as const, id: ownRepo.id }] };
      const turn = host.chat.send(alpha.workspace.id, conversation.id, input).turn;
      expect(() => host.chat.send(alpha.workspace.id, conversation.id, { ...input, contextRefs: [] })).toThrow(/different context/);
      host.store.exec('UPDATE repositories SET base_ref=? WHERE id=?', 'changed-after-send', ownRepo.id);
      await expect.poll(() => starts.length, { timeout: 500, interval: 10 }).toBe(1);
      expect(starts[0]!.instructions).not.toContain('changed-after-send');
      expect(starts[0]!.instructions).toContain(ownRepo.id);
      expect(host.chat.turn(alpha.workspace.id, turn.id).configuration.contextData![0]!.content).toContain('HEAD');
    } finally { for (const finish of finishes) finish({ text: '', stopReason: 'completed' }); await host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('persists bounded history provenance and excludes a later concurrent message from an earlier Turn', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-history-review-'));
    const store = new RiftStore(); const { workspace, roles } = seedWorkspace(store); const developers = roles.filter(role => role.name.startsWith('developer-'));
    for (const role of developers) store.exec('UPDATE roles SET chat_connection=? WHERE id=?', JSON.stringify({ runtime: 'dsh', provider: 'test', model: 'test' }), role.id);
    const starts: RuntimeTurnInput[] = []; const finishes: ((value: RuntimeTurnResult) => void)[] = [];
    const chat = new ChatService({ store, home, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start(input) { starts.push(input); return { result: new Promise<RuntimeTurnResult>(resolve => finishes.push(resolve)), async dispose() {} }; } }) });
    try {
      const conversation = chat.createConversation(workspace.id);
      for (let index = 0; index < 50; index++) store.exec('INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)', `history-${index}`, workspace.id, conversation.id, developers[0]!.id, 'user', `${index}: ${'Retained history '.repeat(100)}`, 'completed', index, new Date().toISOString());
      const first = chat.send(workspace.id, conversation.id, { clientMessageId: 'earlier-turn', recipientAgentId: developers[0]!.id, content: 'Earlier question' }).turn;
      chat.send(workspace.id, conversation.id, { clientMessageId: 'later-turn', recipientAgentId: developers[1]!.id, content: 'LATER_MESSAGE_MUST_NOT_ENTER_EARLIER_TURN' });
      await expect.poll(() => starts.length, { timeout: 500, interval: 10 }).toBe(2);
      const earlier = starts.find(input => input.turnId === first.id)!;
      expect(JSON.stringify(earlier.messages)).not.toContain('LATER_MESSAGE');
      const context = chat.turn(workspace.id, first.id).configuration.context!;
      expect(context.summary).toContain('Extractive context summary'); expect(context.summarySources.length).toBeGreaterThan(0);
      for (const source of [...context.sources, ...context.summarySources]) expect(store.require<{version:number}>('SELECT version FROM messages WHERE id=?', source.messageId).version).toBe(source.version);
      expect(context.messages).toEqual(earlier.messages); expect(earlier.instructions).toContain(context.summary!);
    } finally { for (const finish of finishes) finish({ text: 'Saved response', stopReason: 'completed' }); await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('only releases an orphan Turn after verified same-machine reboot evidence', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-reconcile-review-'));
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const machine = 'a'.repeat(64), other = 'b'.repeat(64), boot = 'c'.repeat(64), next = 'd'.repeat(64);
    const chat = new ChatService({ store, home, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start() { return { result: Promise.resolve({ text: 'Saved reply', stopReason: 'completed' as const }), async dispose() { throw new Error('Unknown process cleanup'); } }; } }) });
    try {
      chat.setBootIdentity(`v1:${machine}:${boot}`);
      const conversation = chat.createConversation(workspace.id);
      const turn = chat.send(workspace.id, conversation.id, { clientMessageId: 'orphan', content: 'Keep history' }).turn;
      await expect.poll(() => chat.turn(workspace.id, turn.id).cleanupStatus, { timeout: 500, interval: 10 }).toBe('unknown');
      const current = chat.turn(workspace.id, turn.id);
      expect(() => chat.reconcile(workspace.id, turn.id, current.version)).toThrow(/not verified/);
      chat.setBootIdentity(`v1:${other}:${next}`);
      expect(() => chat.reconcile(workspace.id, turn.id, current.version)).toThrow(/not verified/);
      chat.setBootIdentity(`v1:${machine}:${next}`);
      expect(() => chat.reconcile(workspace.id, turn.id, current.version - 1)).toThrow(/changed/);
      expect(chat.reconcile(workspace.id, turn.id, current.version)).toMatchObject({ status: 'completed', cleanupStatus: 'confirmed' });
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', turn.id)).toMatchObject({ cleanupStatus: 'confirmed', releasedAt: expect.any(String) });
      expect(chat.page(workspace.id, conversation.id).messages.some(message => message.content === 'Saved reply')).toBe(true);
    } finally { await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('retains a timed-out cleanup lease until its owned disposer actually resolves', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-receipt-review-'));
    const store = new RiftStore(); const { workspace } = seedWorkspace(store); let disposed!: () => void;
    const cleanup = new Promise<void>(resolve => { disposed = resolve; });
    const chat = new ChatService({ store, home, cleanupTimeoutMs: 10, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start() { return { result: Promise.resolve({ text: 'Final response', stopReason: 'completed' as const }), dispose: () => cleanup }; } }) });
    try {
      const conversation = chat.createConversation(workspace.id);
      const turn = chat.send(workspace.id, conversation.id, { clientMessageId: 'late-cleanup', content: 'Finish' }).turn;
      await expect.poll(() => chat.turn(workspace.id, turn.id).cleanupStatus, { timeout: 500, interval: 10 }).toBe('unknown');
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', turn.id)).toMatchObject({ releasedAt: null });
      disposed();
      await expect.poll(() => chat.turn(workspace.id, turn.id).cleanupStatus, { timeout: 500, interval: 10 }).toBe('confirmed');
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', turn.id)).toMatchObject({ releasedAt: expect.any(String) });
    } finally { disposed(); await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('retains unknown cleanup across restart and does not replay the affected Agent queue', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-chat-recovery-review-'));
    const store = new RiftStore(); const { workspace } = seedWorkspace(store); let starts = 0;
    const options = { store, home, defaultConnection: () => ({ runtime: 'dsh' as const, provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], cleanupTimeoutMs: 20, runtime: () => ({ async start() { starts++; return { result: new Promise<RuntimeTurnResult>(() => {}), async dispose() { throw new Error('Cleanup is not confirmed'); } }; } }) };
    const chat = new ChatService(options); let recovered: ChatService | undefined;
    try {
      const conversation = chat.createConversation(workspace.id);
      const first = chat.send(workspace.id, conversation.id, { clientMessageId: 'recovery-first', content: 'In flight' }).turn;
      const second = chat.send(workspace.id, conversation.id, { clientMessageId: 'recovery-second', content: 'Queued' }).turn;
      await expect.poll(() => starts, { timeout: 500, interval: 10 }).toBe(1);
      await chat.close();
      expect(chat.turn(workspace.id, first.id).cleanupStatus).toBe('unknown');
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', first.id)).toMatchObject({ releasedAt: null, cleanupStatus: 'unknown' });
      // Model the durable record a crashed Host leaves, without a live runtime.
      store.exec("UPDATE agent_turns SET status='running' WHERE id=?", first.id);
      recovered = new ChatService(options); recovered.initialize();
      expect(recovered.turn(workspace.id, first.id)).toMatchObject({ status: 'interrupted', cleanupStatus: 'unknown' });
      expect(recovered.turn(workspace.id, second.id).status).toBe('queued');
      recovered.pump(); expect(starts).toBe(1);
      expect(store.require('SELECT * FROM execution_leases WHERE owner_id=?', first.id)).toMatchObject({ releasedAt: null, cleanupStatus: 'unknown' });
    } finally { await recovered?.close(); await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('queues one Agent serially, deduplicates delivery, fixes configuration snapshots and rejects foreign recipients', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-chat-scope-review-'));
    const store = new RiftStore(); const alpha = seedWorkspace(store, 'chat-alpha'), beta = seedWorkspace(store, 'chat-beta');
    const role = alpha.roles.find(item => item.name === 'developer-a')!;
    store.exec('UPDATE roles SET chat_connection=? WHERE id=?', JSON.stringify({ runtime: 'dsh', provider: 'test', model: 'model-before' }), role.id);
    const starts: RuntimeTurnInput[] = []; const finishes: ((value: RuntimeTurnResult) => void)[] = [];
    const chat = new ChatService({ store, home, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start(input) { starts.push(input); return { result: new Promise<RuntimeTurnResult>(resolve => finishes.push(resolve)), async dispose() {} }; } }) });
    try {
      const conversation = chat.createConversation(alpha.workspace.id, 'Agent queue verification'), other = chat.createConversation(beta.workspace.id);
      const input = { clientMessageId: 'one', recipientAgentId: role.id, content: 'First' };
      const first = chat.send(alpha.workspace.id, conversation.id, input);
      expect(chat.send(alpha.workspace.id, conversation.id, input).turn.id).toBe(first.turn.id);
      expect(() => chat.send(alpha.workspace.id, conversation.id, { ...input, content: 'Changed' })).toThrow();
      expect(() => chat.send(alpha.workspace.id, other.id, { ...input, clientMessageId: 'cross-conversation' })).toThrow();
      expect(() => chat.send(alpha.workspace.id, conversation.id, { ...input, clientMessageId: 'cross-agent', recipientAgentId: beta.roles[0]!.id })).toThrow();
      const second = chat.send(alpha.workspace.id, conversation.id, { ...input, clientMessageId: 'two', content: 'Second' });
      expect(second.turn.status).toBe('queued');
      expect(() => updateBrowserAgent(store, alpha.workspace.id, role.id, { expectedVersion: 0, enabled: false })).toThrow();
      updateBrowserAgent(store, alpha.workspace.id, role.id, { expectedVersion: 0, displayName: '新的名字', prompt: 'New prompt', chatConnection: { runtime: 'dsh', provider: 'test', model: 'model-after' } });
      expect(second.turn.configuration.connection.model).toBe('model-before');
      await expect.poll(() => starts.length, { timeout: 500, interval: 10 }).toBe(1);
      finishes[0]!({ text: 'First result', stopReason: 'completed' });
      await expect.poll(() => starts.length, { timeout: 500, interval: 10 }).toBe(2);
      expect(starts[1]?.model).toBe('model-before');
      expect(starts[1]?.instructions).not.toContain('New prompt');
      expect(starts[1]?.messages.some(message => message.role==='assistant' && message.content.includes('First result') && message.content.includes('Quoted conversation data'))).toBe(true);
      finishes[1]!({ text: 'Second result', stopReason: 'completed' });
      await expect.poll(() => chat.turn(alpha.workspace.id, second.turn.id).status, { timeout: 500, interval: 10 }).toBe('completed');
      expect(chat.page(alpha.workspace.id, conversation.id).messages).toHaveLength(4);
      expect(() => chat.stop(beta.workspace.id, first.turn.id)).toThrow();
      expect(chat.page(beta.workspace.id, other.id).messages).toHaveLength(0);
    } finally { for (const finish of finishes) finish({ text: '', stopReason: 'cancelled' }); await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps task dispatch queued while discussion turns occupy the shared developer budget', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-chat-quota-review-'));
    const store = new RiftStore(); const { workspace, roles } = seedWorkspace(store);
    const coordinator = new TaskCoordinator({ store, bridge: {} as ActivationBridge, git: {} as GitService });
    const chat = new ChatService({ store, home, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start() { return { result: new Promise<RuntimeTurnResult>(() => {}), async dispose() {} }; } }) });
    let workflowId: string | undefined;
    try {
      const conversation = chat.createConversation(workspace.id);
      for (const role of roles.filter(item => item.name.startsWith('developer-'))) {
        store.exec('UPDATE roles SET chat_connection=? WHERE id=?', JSON.stringify({ runtime: 'dsh', provider: 'test', model: 'test' }), role.id);
        chat.send(workspace.id, conversation.id, { clientMessageId: role.id, recipientAgentId: role.id, content: 'Hold discussion' });
      }
      const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Shared capacity', integrationRef: 'refs/heads/rift/shared-review', baseCommit: 'a'.repeat(40) }); workflowId = workflow.id;
      coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'queued-during-chat', kind: 'analysis', title: 'Wait for capacity', instructions: 'Read', expectedPaths: [] }] });
      const task = store.task('queued-during-chat');
      const operation = coordinator.dispatch({ taskId: task.id, expectedVersion: task.version, idempotencyKey: 'quota-review' });
      expect(operation.phase).toBe('queued');
      expect(store.all('SELECT id FROM runs')).toHaveLength(0);
      expect(store.all("SELECT id FROM execution_leases WHERE released_at IS NULL AND capacity='developer'")).toHaveLength(2);
    } finally { if (workflowId) await coordinator.cancelWorkflow(workflowId); await chat.close(); await coordinator.shutdown(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('times out an unresponsive runtime and reaches bounded cleanup without waiting for its result', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-chat-timeout-review-'));
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    let finish!: (result: RuntimeTurnResult) => void, started = false, disposed = false;
    const result = new Promise<RuntimeTurnResult>(resolve => { finish = resolve; });
    const chat = new ChatService({ store, home, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], timeoutMs: 25, cleanupTimeoutMs: 25, runtime: () => ({ async start() { started = true; return { result, async dispose() { disposed = true; } }; } }) });
    try {
      const conversation = chat.createConversation(workspace.id);
      const { turn } = chat.send(workspace.id, conversation.id, { clientMessageId: 'timeout', content: 'Discuss' });
      await expect.poll(() => started, { timeout: 500, interval: 10 }).toBe(true);
      await expect.poll(() => chat.turn(workspace.id, turn.id).status, { timeout: 500, interval: 10 }).toBe('cancelled');
      expect(disposed).toBe(true);
      expect(chat.turn(workspace.id, turn.id).cleanupStatus).toBe('confirmed');
      expect(store.get<{releasedAt:string | null}>('SELECT released_at FROM execution_leases WHERE owner_id=?', turn.id)?.releasedAt).not.toBeNull();
    } finally { finish({ text: '', stopReason: 'cancelled' }); await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('does not leak a sensitive value when the runtime splits it across output chunks', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-chat-redaction-review-'));
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const secret = 'opaque-stream-review-secret';
    const old = process.env.RIFT_REVIEW_STREAM_SECRET; process.env.RIFT_REVIEW_STREAM_SECRET = secret;
    const chat = new ChatService({ store, home, defaultConnection: () => ({ runtime: 'dsh', provider: 'test', model: 'test' }), validateConnection: () => {}, tools: () => [], runtime: () => ({ async start(input) { input.onText?.('opaque-stream-'); input.onText?.('review-secret'); return { result: Promise.resolve({ text: secret, stopReason: 'completed' as const }), async dispose() {} }; } }) });
    try {
      const conversation = chat.createConversation(workspace.id);
      const { turn } = chat.send(workspace.id, conversation.id, { clientMessageId: 'split-secret', content: 'Discuss' });
      await expect.poll(() => chat.turn(workspace.id, turn.id).status, { timeout: 500, interval: 10 }).toBe('completed');
      const page = chat.page(workspace.id, conversation.id);
      expect(page.messages.filter(message => message.role === 'assistant').map(message => message.content).join('')).not.toContain(secret);
      expect(page.chunks.map(chunk => chunk.text).join('')).not.toContain(secret);
    } finally { if (old === undefined) delete process.env.RIFT_REVIEW_STREAM_SECRET; else process.env.RIFT_REVIEW_STREAM_SECRET = old; await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); }
  });
});

async function send(port: number, pathname: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown; try { json = JSON.parse(text); } catch { /* Static response. */ }
        resolve({ status: response.statusCode!, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('Independent browser HTTP security acceptance', () => {
  it('disables browser assets and bootstrap while preserving management authentication', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-ui-disabled-review-'));
    const api = await startLocalApi({ handle: async () => ({ management: true }), handleBrowser: async () => ({ unexpected: true }) }, { home, port: 0, uiEnabled: false });
    try {
      const token = (await readFile(path.join(home, 'management.token'), 'utf8')).trim();
      expect((await send(api.port, '/', 'GET', {})).status).toBe(404);
      expect((await send(api.port, '/ui-api/v1/session', 'POST', {}, { code: 'ignored' })).status).toBe(404);
      expect((await send(api.port, '/v1/ui/bootstrap', 'POST', { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'disabled' }, {})).status).toBe(404);
      expect((await send(api.port, '/v1/doctor', 'GET', { Authorization: `Bearer ${token}` })).json).toEqual({ management: true });
      expect((await send(api.port, '/v1/doctor', 'GET', { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${api.port}` })).status).toBe(401);
    } finally { await api.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps event replay workspace-scoped, rejects stale cursors and closes live SSE when its session expires', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-events-review-'));
    const ctx = { subagents: { list: () => [...providers], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const service = new RiftHostService(ctx, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    let time = Date.now();
    const api = await startLocalApi(service, { home, port: 0, browser: { now: () => time, sessionTtlMs: 1000 } });
    try {
      const alpha = seedWorkspace(service.store, 'event-alpha'), beta = seedWorkspace(service.store, 'event-beta');
      const start = readWorkspaceEvents(service.store, alpha.workspace.id, 0).cursor;
      service.chat.createConversation(alpha.workspace.id, 'Alpha conversation');
      service.chat.createConversation(beta.workspace.id, 'Beta conversation');
      const replay = readWorkspaceEvents(service.store, alpha.workspace.id, start);
      expect(replay.events.length).toBeGreaterThan(0);
      expect(replay.events.every(event => event.workspaceId === alpha.workspace.id && event.seq > start)).toBe(true);
      expect(readWorkspaceEvents(service.store, alpha.workspace.id, replay.cursor).events).toEqual([]);
      expect(readWorkspaceEvents(service.store, alpha.workspace.id, replay.cursor + 1).resyncRequired).toBe(true);
      expect(() => readWorkspaceEvents(service.store, alpha.workspace.id, -1)).toThrow();
      const token = (await readFile(path.join(home, 'management.token'), 'utf8')).trim();
      const origin = `http://127.0.0.1:${api.port}`;
      const source = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
      const launch = await send(api.port, '/v1/ui/bootstrap', 'POST', { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'sse-launch' }, {});
      const code = new URLSearchParams(new URL(launch.json.url).hash.slice(1)).get('bootstrap');
      const session = await send(api.port, '/ui-api/v1/session', 'POST', source, { code });
      const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
      const target = `/ui-api/v1/workspaces/${alpha.workspace.id}/events?after=${start}`;
      expect((await send(api.port, target, 'GET', { ...source, Cookie: cookie, Origin: 'https://invalid.example' })).status).toBe(403);
      const stream = await new Promise<{ status: number; type: string | undefined; text: string }>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: api.port, path: target, headers: { ...source, Cookie: cookie } }, response => {
          let text = '';
          response.on('data', chunk => { text += String(chunk); if (text.includes('event: workspace')) time += 1001; });
          response.on('end', () => resolve({ status: response.statusCode!, type: response.headers['content-type'], text }));
        });
        request.setTimeout(2000, () => request.destroy(new Error('SSE did not close after expiry')));
        request.on('error', reject);
      });
      expect(stream.status).toBe(200); expect(stream.type).toContain('text/event-stream');
      expect(stream.text).toContain('event: session_expired');
      expect(stream.text).not.toContain(beta.workspace.id);
      service.store.transaction(() => {
        for (let index = 0; index < 10001; index++) service.store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,occurred_at) VALUES(?,'review','event',?)", beta.workspace.id, new Date().toISOString());
      });
      expect(readWorkspaceEvents(service.store, alpha.workspace.id, start)).toMatchObject({ events: [], resyncRequired: true });
    } finally { await api.close(); await service.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('serves real Host DTOs with scalar redaction and forgets browser capabilities on restart', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-ui-host-review-'));
    const ctx = { subagents: { list: () => [...providers], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const service = new RiftHostService(ctx, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    const priorSecret = process.env.RIFT_REVIEW_API_KEY;
    process.env.RIFT_REVIEW_API_KEY = 'opaque-review-environment-secret';
    let api = await startLocalApi(service, { home, port: 0 });
    try {
      const { workspace, roles } = seedWorkspace(service.store);
      service.store.exec('UPDATE roles SET prompt=? WHERE id=?', 'password=synthetic-review-password and opaque-review-environment-secret', roles[0]!.id);
      const token = (await readFile(path.join(home, 'management.token'), 'utf8')).trim();
      const origin = `http://127.0.0.1:${api.port}`;
      const source = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
      const launch = await send(api.port, '/v1/ui/bootstrap', 'POST', { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'host-launch' }, {});
      const code = new URLSearchParams(new URL(launch.json.url).hash.slice(1)).get('bootstrap');
      const session = await send(api.port, '/ui-api/v1/session', 'POST', source, { code });
      const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
      const headers = { ...source, Cookie: cookie };
      const detail = await send(api.port, `/ui-api/v1/workspaces/${workspace.id}`, 'GET', headers);
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('[REDACTED]');
      for (const secret of [token, 'synthetic-review-password', 'opaque-review-environment-secret']) expect(detail.text).not.toContain(secret);
      for (const suffix of ['/doctor', '/workspaces/missing', `/workspaces/${workspace.id}/../doctor`, '/runs/arbitrary', '/workspaces/%E0%A4%A']) {
        expect((await send(api.port, `/ui-api/v1${suffix}`, 'GET', headers)).status).toBeGreaterThanOrEqual(400);
      }
      const unused = await send(api.port, '/v1/ui/bootstrap', 'POST', { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'restart-launch' }, {});
      const unusedCode = new URLSearchParams(new URL(unused.json.url).hash.slice(1)).get('bootstrap');
      const port = api.port;
      await api.close();
      api = await startLocalApi(service, { home, port });
      expect((await send(api.port, '/ui-api/v1/session', 'GET', headers)).status).toBe(401);
      expect((await send(api.port, '/ui-api/v1/session', 'POST', source, { code: unusedCode })).status).toBe(401);
      expect((await send(api.port, '/v1/doctor', 'GET', { Authorization: `Bearer ${token}` })).status).toBe(200);
    } finally {
      if (priorSecret === undefined) delete process.env.RIFT_REVIEW_API_KEY; else process.env.RIFT_REVIEW_API_KEY = priorSecret;
      await api.close(); await service.close(); await rm(home, { recursive: true, force: true });
    }
  });

  it('separates authentication surfaces, enforces browser origin/CSRF, consumes launches once and invalidates sessions', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-ui-review-'));
    let time = Date.now(), writes = 0;
    const api = await startLocalApi({ handle: async () => ({ management: true }), handleBrowser: async method => { if (method !== 'GET') writes++; return { browser: true }; } }, { home, port: 0, browser: { now: () => time, bootstrapTtlMs: 1000, sessionTtlMs: 2000 } });
    try {
      const token = (await readFile(path.join(home, 'management.token'), 'utf8')).trim();
      const origin = `http://127.0.0.1:${api.port}`;
      const source = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Content-Type': 'application/json' };
      const launch = async (key: string) => send(api.port, '/v1/ui/bootstrap', 'POST', { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, {});
      const first = await launch('launch-one');
      expect(first.status).toBe(200);
      expect(first.text).not.toContain(token);
      expect(await launch('launch-one')).toMatchObject({ json: first.json });
      const code = new URLSearchParams(new URL(first.json.url).hash.slice(1)).get('bootstrap')!;
      expect(new URL(first.json.url).search).toBe('');
      expect((await send(api.port, '/ui-api/v1/session', 'POST', { ...source, Origin: 'http://127.0.0.1:1' }, { code })).status).toBe(403);
      const session = await send(api.port, '/ui-api/v1/session', 'POST', source, { code });
      expect(session.status).toBe(200);
      const setCookie = session.headers['set-cookie']![0]!;
      expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); expect(setCookie).toContain('Path=/ui-api/v1');
      expect(setCookie).not.toContain('Domain=');
      const cookie = setCookie.split(';')[0]!;
      const browser = { ...source, Cookie: cookie };
      expect((await send(api.port, '/ui-api/v1/session', 'POST', source, { code })).status).toBe(401);
      expect((await launch('launch-one')).status).toBe(400);
      expect((await send(api.port, '/v1/doctor', 'GET', { Cookie: cookie })).status).toBe(401);
      expect((await send(api.port, '/ui-api/v1/workspaces', 'GET', { ...source, Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await send(api.port, '/v1/doctor', 'GET', { Authorization: `Bearer ${token}`, Origin: origin })).status).toBe(401);
      expect((await send(api.port, '/ui-api/v1/workspaces', 'GET', browser)).status).toBe(200);
      for (const value of ['cross-site', 'same-site', 'none', '']) expect((await send(api.port, '/ui-api/v1/workspaces', 'GET', { ...browser, 'Sec-Fetch-Site': value })).status).toBe(403);
      expect((await send(api.port, '/ui-api/v1/workspaces', 'GET', { ...browser, Host: `localhost:${api.port}` })).status).toBe(400);
      expect((await send(api.port, '/ui-api/v1/workspaces', 'GET', { ...browser, 'Sec-Fetch-Mode': 'navigate' })).status).toBe(403);
      expect((await send(api.port, '/ui-api/v1/workspaces', 'GET', { ...browser, Cookie: `${cookie}; ${cookie}` })).status).toBe(401);
      const writeHeaders = { ...browser, 'Idempotency-Key': 'write-one' };
      expect((await send(api.port, '/ui-api/v1/workspaces', 'POST', writeHeaders, {})).status).toBe(403);
      expect((await send(api.port, '/ui-api/v1/workspaces', 'POST', { ...writeHeaders, 'X-CSRF-Token': 'a'.repeat(64) }, {})).status).toBe(403);
      expect(writes).toBe(0);
      const authorized = { ...writeHeaders, 'X-CSRF-Token': session.json.csrfToken };
      expect((await send(api.port, '/ui-api/v1/workspaces', 'POST', authorized, {})).status).toBe(200);
      expect(writes).toBe(1);
      expect((await send(api.port, '/ui-api/v1/logout', 'POST', authorized, {})).status).toBe(200);
      expect((await send(api.port, '/ui-api/v1/session', 'GET', browser)).status).toBe(401);
      const expiring = await launch('launch-expiring');
      const expiredCode = new URLSearchParams(new URL(expiring.json.url).hash.slice(1)).get('bootstrap');
      time += 1001;
      expect((await send(api.port, '/ui-api/v1/session', 'POST', source, { code: expiredCode })).status).toBe(401);
      const next = await launch('launch-next');
      const nextCode = new URLSearchParams(new URL(next.json.url).hash.slice(1)).get('bootstrap');
      const nextSession = await send(api.port, '/ui-api/v1/session', 'POST', source, { code: nextCode });
      const nextCookie = nextSession.headers['set-cookie']![0]!.split(';')[0]!;
      time += 2001;
      expect((await send(api.port, '/ui-api/v1/session', 'GET', { ...source, Cookie: nextCookie })).status).toBe(401);
    } finally { await api.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('rejects raw traversal and symlink escapes and serves assets with no-store and a restrictive CSP', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-ui-assets-'));
    const dist = path.join(home, 'dist'), outside = path.join(home, 'outside');
    await mkdir(path.join(dist, 'assets'), { recursive: true }); await mkdir(outside);
    await writeFile(path.join(dist, 'index.html'), '<html>review</html>');
    await writeFile(path.join(dist, 'assets', 'app.js'), 'window.review = true;');
    await writeFile(path.join(outside, 'secret.js'), 'OUTSIDE_SECRET');
    await symlink(outside, path.join(dist, 'assets', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const api = await startLocalApi({ handle: async () => null, handleBrowser: async () => null }, { home, port: 0, uiDist: dist });
    try {
      const root = await send(api.port, '/');
      expect(root.status).toBe(200); expect(root.headers['cache-control']).toBe('no-store');
      expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(root.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(root.headers['referrer-policy']).toBe('no-referrer');
      expect((await send(api.port, '/assets/app.js')).status).toBe(200);
      expect((await send(api.port, '/assets/app.js', 'HEAD')).text).toBe('');
      for (const target of ['/assets/../management.token', '/assets/%2e%2e/management.token', '/assets/%252e%252e/secret.js', '/assets/%5c..%5csecret.js', '/assets/escape/secret.js', '/assets/.hidden.js', '/unknown/deep/link', '/assets/app.js.map']) {
        const response = await send(api.port, target);
        expect(response.status, target).toBe(404); expect(response.text).not.toContain('OUTSIDE_SECRET');
      }
    } finally { await api.close(); await rm(home, { recursive: true, force: true }); }
  });
});

describe('Independent browser read-model acceptance', () => {
  it('isolates every projected entity by workspace and excludes arbitrary runtime payloads', async () => {
    const store = new RiftStore();
    const coordinator = new TaskCoordinator({ store, bridge: {} as ActivationBridge, git: {} as GitService });
    try {
      for (const suffix of ['alpha', 'beta']) {
        const { workspace, roles, bindings } = seedWorkspace(store, `workspace-${suffix}`);
        const role = roles.find(item => item.name === 'developer-a')!;
        const workflow = coordinator.createWorkflow({ id: `workflow-${suffix}`, workspaceId: workspace.id, goal: `${suffix} goal`, integrationRef: `refs/heads/rift/${suffix}`, baseCommit: 'a'.repeat(40) });
        coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: `task-${suffix}`, kind: 'analysis', title: suffix, instructions: 'Read', expectedPaths: [] }, { id: `later-${suffix}`, kind: 'analysis', title: 'Later', instructions: 'Read after first', expectedPaths: [], dependsOn: [`task-${suffix}`] }] });
        store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,result,cleanup_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)', `run-${suffix}`, `task-${suffix}`, role.id, 'develop', 1, 'failed', JSON.stringify({ role, binding: { ...bindings[0], secret: 'UNSAFE_SNAPSHOT_VALUE' } }), new Date().toISOString(), new Date().toISOString(), JSON.stringify({ arbitrary: 'UNSAFE_RESULT_VALUE' }), 'unknown');
        store.exec('INSERT INTO worktrees(id,task_id,attempt,kind,path,base_commit,writer_run_id) VALUES(?,?,?,?,?,?,?)', `tree-${suffix}`, `task-${suffix}`, 1, 'task', `C:/test/${suffix}`, 'a'.repeat(40), `run-${suffix}`);
        store.exec('INSERT INTO integrations(id,task_id,source_head,status,candidate) VALUES(?,?,?,?,?)', `integration-${suffix}`, `task-${suffix}`, 'a'.repeat(40), 'failed', JSON.stringify({ cwd: `C:/candidate/${suffix}`, arbitrary: 'UNSAFE_CANDIDATE_VALUE' }));
        store.exec('INSERT INTO operations(id,kind,dedupe_key,entity_id,phase,payload,created_at) VALUES(?,?,?,?,?,?,?)', `operation-${suffix}`, 'dispatch', `key-${suffix}`, `later-${suffix}`, 'queued', JSON.stringify({ roleId: role.id, secret: 'UNSAFE_OPERATION_VALUE' }), new Date().toISOString());
        store.event(workflow.id, 'private.event', { secret: 'UNSAFE_EVENT_VALUE' });
      }
      const detail = workspaceDetail(store, 'workspace-alpha', providers, lead);
      const wire = JSON.stringify(detail);
      expect(wire).not.toContain('beta');
      expect(wire).not.toContain('UNSAFE_');
      expect(wire).not.toContain('credentialRefs');
      expect(wire).not.toContain('providerSnapshot');
      expect(wire).not.toContain('management_requests');
      expect(detail.tasks.find(task => task.id === 'later-alpha')?.dependsOn).toEqual(['task-alpha']);
      expect(detail.integrations).toEqual([expect.objectContaining({ id: 'integration-alpha', candidatePath: 'C:/candidate/alpha' })]);
      expect(detail.presence.find(item => item.roleId.endsWith(':developer-a'))).toMatchObject({ state: 'cleanup_unknown', runIds: ['run-alpha'] });
      expect(detail.presence.find(item => item.roleId.endsWith(':lead'))).toMatchObject({ state: 'unknown', runIds: [] });
      expect(workspaceList(store).workspaces.map(item => ({ id: item.id, tasks: item.taskCount }))).toEqual([{ id: 'workspace-alpha', tasks: 2 }, { id: 'workspace-beta', tasks: 2 }]);
      expect(() => workspaceDetail(store, 'missing', providers, lead)).toThrowError('Requested business record does not exist.');
    } finally { await coordinator.shutdown(); store.close(); }
  });

  it('reports unregistered and disabled roles conservatively without inventing successful capabilities', () => {
    const store = new RiftStore();
    try {
      const { workspace, roles } = seedWorkspace(store);
      const disabled = roles.find(item => item.name === 'developer-b')!;
      store.exec('UPDATE roles SET enabled=0 WHERE id=?', disabled.id);
      const detail = workspaceDetail(store, workspace.id, new Set(), lead);
      expect(detail.presence.find(item => item.roleId === disabled.id)?.state).toBe('disabled');
      expect(detail.presence.find(item => item.roleId.endsWith(':developer-a'))?.state).toBe('unavailable');
      expect(detail.bindings.every(item => item.authentication === 'not-verified')).toBe(true);
      expect(detail.capabilities.chat.reason).toContain('registered connection');
      expect(detail.capabilities.skills.reason).toContain('verified runtime support');
      expect(detail.capabilities.events.reason).toContain('expired cursors');
    } finally { store.close(); }
  });
});
