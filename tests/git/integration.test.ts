import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitContext, Run, ReviewResult, Candidate } from '../../src/contracts/index.js';
import { LocalGitService } from '../../src/git/integration.js';
import { gitOk } from '../../src/git/process.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('rift-git-')) throw new Error('unsafe test cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rift-git-')); roots.push(root);
  const repositoryPath = path.join(root, '中文 仓库'); await mkdir(repositoryPath);
  await gitOk(repositoryPath, ['init', '-b', 'main']);
  await gitOk(repositoryPath, ['config', 'core.autocrlf', 'false']);
  await gitOk(repositoryPath, ['config', 'user.name', 'Test']); await gitOk(repositoryPath, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(repositoryPath, 'base.txt'), 'base\n');
  await writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.log\n');
  await gitOk(repositoryPath, ['add', '.']); await gitOk(repositoryPath, ['commit', '-m', 'base']);
  const baseCommit = await gitOk(repositoryPath, ['rev-parse', 'HEAD']);
  const service = new LocalGitService({ managedRoot: path.join(root, '管理 空间'), commands: [{ id: 'unit', executable: process.execPath, args: ['-e', 'process.stdout.write("verified")'] }] });
  const workspace: GitContext['workspace'] = { id: 'workspace', name: 'test', repositoryPath, rootPath: repositoryPath, commonGitDir: path.join(repositoryPath, '.git'), baseRef: 'main', status: 'active' };
  const workflow: GitContext['workflow'] = { id: 'workflow', workspaceId: workspace.id, goal: 'test', leadSessionId: null, planRevision: 1, version: 1, status: 'running', integrationRef: 'refs/heads/rift/integration/test', baseCommit, summary: null };
  const context = (id: string, expectedPaths: string[] = []): GitContext => ({ workspace, workflow, task: { id, workflowId: workflow.id, roleId: null, kind: 'change', title: id, instructions: id, expectedPaths, acceptanceCriteria: [], status: 'validating', attempt: 1, version: 1, acceptedCommit: null, sourceHead: null, blockingReason: null } });
  const run = (id: string): Run => ({ id: `run-${id}`, taskId: id, roleId: 'developer-a', purpose: 'develop', taskAttempt: 1, status: 'succeeded', providerSnapshot: {} as Run['providerSnapshot'], dshChildId: null, dshRunId: null, stopReason: 'end_turn', cleanupStatus: 'confirmed', slotReleasedAt: null, deadline: '', result: null, createdAt: '', startedAt: null, endedAt: null });
  const develop = async (id: string, file: string, value: string) => { const ctx = context(id); const execution = run(id); const worktree = await service.prepareTask({ ...ctx, run: execution }); await writeFile(path.join(worktree.path, file), value); const source = await service.collectSource({ ...ctx, run: execution, worktree }); return { ctx, execution, worktree, source }; };
  const approve = (ctx: GitContext, candidate: Candidate): ReviewResult => ({ schemaVersion: 1, taskId: ctx.task.id, runId: `review-${ctx.task.id}`, verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] });
  return { root, repositoryPath, baseCommit, service, workspace, workflow, context, run, develop, approve };
}
describe('real Git integration', () => {
  it('isolates Chinese/space paths and rebuilds the second candidate on latest accepted HEAD', async () => {
    const f = await fixture();
    const a = await f.develop('a', '甲.txt', 'A'); const b = await f.develop('b', '乙.txt', 'B');
    expect(a.worktree.path).not.toBe(b.worktree.path); expect(a.worktree.baseCommit).toBe(b.worktree.baseCommit);
    const ca = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'ia' });
    await f.service.publishCandidate({ ...a.ctx, candidate: ca, review: f.approve(a.ctx, ca) });
    const cb = await f.service.prepareCandidate({ ...b.ctx, sourceHead: b.source.sourceHead, integrationId: 'ib' });
    expect(cb.expectedTargetHead).toBe(ca.candidateHead);
    expect(await readFile(path.join(cb.cwd, '甲.txt'), 'utf8')).toBe('A'); expect(await readFile(path.join(cb.cwd, '乙.txt'), 'utf8')).toBe('B');
    await f.service.publishCandidate({ ...b.ctx, candidate: cb, review: f.approve(b.ctx, cb) });
    expect(await gitOk(f.repositoryPath, ['rev-parse', 'main'])).toBe(f.baseCommit);
    expect(await f.service.recoverPublication({ ...b.ctx, candidate: cb })).toBe('published');
    const op = await f.service.readOperation(f.workspace, 'ib'); expect(op.checks?.every(c => c.candidateHead === cb.candidateHead)).toBe(true);
  });
  it('rejects mismatched review and releases integration ownership', async () => {
    const f = await fixture(); const a = await f.develop('a', 'a.txt', 'A');
    const candidate = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'invalid-review' });
    await expect(f.service.publishCandidate({ ...a.ctx, candidate, review: { ...f.approve(a.ctx, candidate), reviewedCommit: f.baseCommit } })).rejects.toThrow('INVALID_RESULT');
    const next = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'next' });
    await f.service.abandonCandidate({ ...a.ctx, candidate: next, reason: 'test finished' });
  });
  it('uses CAS and rejects review checkout mutations', async () => {
    const f = await fixture(); const a = await f.develop('a', 'a.txt', 'A');
    const candidate = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'cas' });
    await gitOk(f.repositoryPath, ['update-ref', f.workflow.integrationRef, a.source.sourceHead, f.baseCommit]);
    await expect(f.service.publishCandidate({ ...a.ctx, candidate, review: f.approve(a.ctx, candidate) })).rejects.toThrow('STALE_TARGET');
    const c2 = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'mutation' });
    await writeFile(path.join(c2.cwd, 'ignored.log'), 'review touched ignored');
    await expect(f.service.publishCandidate({ ...a.ctx, candidate: c2, review: f.approve(a.ctx, c2) })).rejects.toThrow('REVIEW_MODIFIED');
  });
  it('preserves accepted work on conflict and allows another candidate afterwards', async () => {
    const f = await fixture(); const a = await f.develop('a', 'base.txt', 'A\n'); const b = await f.develop('b', 'base.txt', 'B\n'); const c = await f.develop('c', 'c.txt', 'C');
    const first = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'first' }); await f.service.publishCandidate({ ...a.ctx, candidate: first, review: f.approve(a.ctx, first) });
    await expect(f.service.prepareCandidate({ ...b.ctx, sourceHead: b.source.sourceHead, integrationId: 'conflict' })).rejects.toThrow('CONFLICT');
    expect((await f.service.readOperation(f.workspace, 'conflict')).reason).toContain('base.txt');
    expect(await gitOk(f.repositoryPath, ['rev-parse', f.workflow.integrationRef])).toBe(first.candidateHead);
    const third = await f.service.prepareCandidate({ ...c.ctx, sourceHead: c.source.sourceHead, integrationId: 'third' }); await f.service.publishCandidate({ ...c.ctx, candidate: third, review: f.approve(c.ctx, third) });
    expect(await readFile(path.join(third.cwd, 'base.txt'), 'utf8')).toBe('A\n');
  });
  it('blocks out-of-scope changes, unknown cleanup, ignored files and outside paths without removing data', async () => {
    const f = await fixture(); const ctx = f.context('scope', ['allowed']); const run = f.run('scope'); const worktree = await f.service.prepareTask({ ...ctx, run });
    await writeFile(path.join(worktree.path, 'outside.txt'), 'keep');
    await expect(f.service.collectSource({ ...ctx, run, worktree })).rejects.toThrow('PATH_SCOPE');
    const archive = { workspace: f.workspace, worktree, active: false, cleanupConfirmed: true, artifactsSaved: true };
    await expect(f.service.archiveWorktree(archive)).rejects.toThrow('ARCHIVE_BLOCKED');
    const a = await f.develop('a', 'a.txt', 'A'); await writeFile(path.join(a.worktree.path, 'ignored.log'), 'keep ignored');
    await expect(f.service.archiveWorktree({ ...archive, worktree: a.worktree })).rejects.toThrow('ARCHIVE_BLOCKED');
    await expect(f.service.archiveWorktree({ ...archive, cleanupConfirmed: false })).rejects.toThrow('ARCHIVE_BLOCKED');
    await expect(f.service.archiveWorktree({ ...archive, worktree: { ...worktree, path: f.repositoryPath } })).rejects.toThrow('UNSAFE_PATH');
    expect(await readFile(path.join(worktree.path, 'outside.txt'), 'utf8')).toBe('keep');
  });
  it('rejects out-of-scope staged content even when the working file was restored to the base', async () => {
    const f = await fixture(); const ctx = f.context('staged', ['allowed.txt']); const run = f.run('staged');
    const worktree = await f.service.prepareTask({ ...ctx, run });
    await writeFile(path.join(worktree.path, 'base.txt'), 'hidden staged change'); await gitOk(worktree.path, ['add', 'base.txt']);
    await writeFile(path.join(worktree.path, 'base.txt'), 'base\n'); await writeFile(path.join(worktree.path, 'allowed.txt'), 'allowed');
    await expect(f.service.collectSource({ ...ctx, run, worktree })).rejects.toThrow('PATH_SCOPE_VIOLATION');
    expect(await gitOk(worktree.path, ['show', ':base.txt'])).toBe('hidden staged change');
  });
  it('persists quarantine after a timed-out check and refuses default archive even after restart', async () => {
    const f = await fixture(); const a = await f.develop('timeout', 'a.txt', 'A');
    const options = { managedRoot: f.service.managedRoot, commands: [{ id: 'hang', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }] };
    const service = new LocalGitService(options);
    await expect(service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'timeout-check' })).rejects.toThrow('CHECK_FAILED');
    const operation = await service.readOperation(f.workspace, 'timeout-check');
    const restarted = new LocalGitService(options);
    await expect(restarted.archiveWorktree({ workspace: f.workspace, worktree: { ...a.worktree, kind: 'candidate', path: operation.candidatePath }, active: false, cleanupConfirmed: true, artifactsSaved: true })).rejects.toThrow('descendant cleanup is unconfirmed');
  });
});
