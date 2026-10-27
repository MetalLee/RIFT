import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { LocalGitService } from '../../src/git/integration.js';
import type { Candidate, GitContext, ReviewResult, Run, Task, Workflow, Workspace } from '../../src/contracts/index.js';

const exec = promisify(execFile);
async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 git '));
  const repositoryPath = path.join(temporary, '用户 仓库'); await mkdir(repositoryPath);
  const git = async (...args: string[]) => (await exec('git', ['-C', repositoryPath, ...args])).stdout.trim();
  await git('init', '-q');
  await writeFile(path.join(repositoryPath, 'base.txt'), 'base\n');
  await git('add', '.');
  await git('-c', 'user.name=Acceptance', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const baseCommit = await git('rev-parse', 'HEAD');
  const workspace: Workspace = { id: 'acceptance', name: 'acceptance', rootPath: temporary, repositoryPath, commonGitDir: path.join(repositoryPath, '.git'), baseRef: 'HEAD', status: 'active' };
  const workflow: Workflow = { id: 'workflow', workspaceId: workspace.id, goal: 'Independent Git acceptance', leadSessionId: null, planRevision: 1, version: 0, status: 'running', integrationRef: 'refs/heads/rift/acceptance', baseCommit, summary: null };
  const service = new LocalGitService({ managedRoot: path.join(temporary, 'managed'), commands: [{ id: 'check', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] });
  const context = (id: string, expectedPaths = [`${id}.txt`]): GitContext => ({ workspace, workflow, task: { id, workflowId: workflow.id, roleId: null, kind: 'change', title: id, instructions: id, expectedPaths, acceptanceCriteria: [], status: 'running', attempt: 1, version: 0, acceptedCommit: null, sourceHead: null, blockingReason: null } });
  const run = (task: Task): Run => ({ id: `run-${task.id}`, taskId: task.id, roleId: 'developer-a', purpose: 'develop', taskAttempt: 1, status: 'succeeded', providerSnapshot: { role: {} as Run['providerSnapshot']['role'], binding: null }, dshChildId: 'fake-only', dshRunId: null, stopReason: 'completed', cleanupStatus: 'confirmed', slotReleasedAt: null, deadline: new Date().toISOString(), result: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null });
  const approve = (ctx: GitContext, candidate: Candidate): ReviewResult => ({ schemaVersion: 1, taskId: ctx.task.id, runId: `review-${ctx.task.id}`, verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] });
  const source = async (ctx: GitContext, content: string) => {
    const execution = run(ctx.task); const worktree = await service.prepareTask({ ...ctx, run: execution });
    await writeFile(path.join(worktree.path, `${ctx.task.id}.txt`), content);
    const evidence = await service.collectSource({ ...ctx, run: execution, worktree });
    return { execution, worktree, evidence };
  };
  return { temporary, repositoryPath, git, baseCommit, workspace, workflow, service, context, run, approve, source, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

describe('A06/A09/A12/A17 independent real Git acceptance', () => {
  it('can prepare the first two task worktrees concurrently from a new workflow', async () => {
    const f = await fixture();
    try {
      const a = f.context('a'), b = f.context('b');
      const outputs = await Promise.allSettled([f.service.prepareTask({ ...a, run: f.run(a.task) }), f.service.prepareTask({ ...b, run: f.run(b.task) })]);
      expect(outputs.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally { await f.dispose(); }
  });

  it('rebases the second candidate on the accepted first result and preserves the user branch', async () => {
    const f = await fixture();
    try {
      const a = f.context('a'), b = f.context('b');
      const sa = await f.source(a, 'result A'), sb = await f.source(b, 'result B');
      expect(sa.worktree.baseCommit).toBe(sb.worktree.baseCommit);
      const ca = await f.service.prepareCandidate({ ...a, sourceHead: sa.evidence.sourceHead, integrationId: 'integration-a' });
      await f.service.publishCandidate({ ...a, candidate: ca, review: f.approve(a, ca) });
      const cb = await f.service.prepareCandidate({ ...b, sourceHead: sb.evidence.sourceHead, integrationId: 'integration-b' });
      expect(cb.expectedTargetHead).toBe(ca.candidateHead);
      expect(await readFile(path.join(cb.cwd, 'a.txt'), 'utf8')).toBe('result A');
      expect(await readFile(path.join(cb.cwd, 'b.txt'), 'utf8')).toBe('result B');
      expect(cb.checkIds).not.toEqual(ca.checkIds);
      await f.service.publishCandidate({ ...b, candidate: cb, review: f.approve(b, cb) });
      expect(await f.git('show', `${f.workflow.integrationRef}:a.txt`)).toBe('result A');
      expect(await f.git('show', `${f.workflow.integrationRef}:b.txt`)).toBe('result B');
      expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseCommit);
      expect(await f.service.recoverPublication({ ...b, candidate: cb })).toBe('published');
      expect((await f.service.readOperation(f.workspace, 'integration-b')).checks?.every(check => check.candidateHead === cb.candidateHead)).toBe(true);
    } finally { await f.dispose(); }
  });

  it('rejects stale target publication and rejects a modified review checkout', async () => {
    const f = await fixture();
    try {
      const a = f.context('a'); const s = await f.source(a, 'A');
      const c = await f.service.prepareCandidate({ ...a, sourceHead: s.evidence.sourceHead, integrationId: 'stale' });
      await f.git('update-ref', f.workflow.integrationRef, s.evidence.sourceHead, f.baseCommit);
      await expect(f.service.publishCandidate({ ...a, candidate: c, review: f.approve(a, c) })).rejects.toThrow(/STALE_TARGET/);
      expect(await f.git('rev-parse', f.workflow.integrationRef)).toBe(s.evidence.sourceHead);
      const fresh = await f.service.prepareCandidate({ ...a, sourceHead: s.evidence.sourceHead, integrationId: 'modified' });
      await writeFile(path.join(fresh.cwd, 'reviewer.txt'), 'unauthorized reviewer change');
      await expect(f.service.publishCandidate({ ...a, candidate: fresh, review: f.approve(a, fresh) })).rejects.toThrow(/MODIFIED_CHECKOUT/);
      expect(await f.git('rev-parse', f.workflow.integrationRef)).toBe(s.evidence.sourceHead);
    } finally { await f.dispose(); }
  });

  it('collects unlisted files and preserves subsequent unsaved files instead of deleting them', async () => {
    const f = await fixture();
    try {
      const ctx = f.context('scoped'); const run = f.run(ctx.task); const worktree = await f.service.prepareTask({ ...ctx, run });
      await writeFile(path.join(worktree.path, 'outside.txt'), 'preserve me');
      const source = await f.service.collectSource({ ...ctx, run, worktree });
      expect(source.changedPaths).toContain('outside.txt');
      await writeFile(path.join(worktree.path, 'unsaved.txt'), 'unsaved');
      await expect(f.service.archiveWorktree({ workspace: f.workspace, worktree, active: false, cleanupConfirmed: true, artifactsSaved: true })).rejects.toThrow(/ARCHIVE_BLOCKED/);
      expect(await readFile(path.join(worktree.path, 'outside.txt'), 'utf8')).toBe('preserve me');
    } finally { await f.dispose(); }
  });

  it('rejects a staged change that is restored to the baseline before collection', async () => {
    const f = await fixture();
    try {
      const ctx = f.context('empty', ['base.txt']), run = f.run(ctx.task);
      const worktree = await f.service.prepareTask({ ...ctx, run });
      await writeFile(path.join(worktree.path, 'base.txt'), 'temporary staged content\n');
      await exec('git', ['-C', worktree.path, 'add', '--', 'base.txt']);
      await writeFile(path.join(worktree.path, 'base.txt'), 'base\n');
      await expect(f.service.collectSource({ ...ctx, run, worktree })).rejects.toThrow(/EMPTY_CHANGE/);
    } finally { await f.dispose(); }
  });

  it('redacts credential values before persisting deterministic check logs', async () => {
    const f = await fixture();
    const oldSecret = process.env.RIFT_ACCEPTANCE_SECRET;
    const secret = 'acceptance-only-not-a-real-credential-987654321';
    process.env.RIFT_ACCEPTANCE_SECRET = secret;
    try {
      const ctx = f.context('secret'); const source = await f.source(ctx, 'safe code');
      const service = new LocalGitService({ managedRoot: path.join(f.temporary, 'managed'), commands: [{ id: 'log-check', executable: process.execPath, args: ['-e', 'console.log(process.env.RIFT_ACCEPTANCE_SECRET)'] }] });
      const candidate = await service.prepareCandidate({ ...ctx, sourceHead: source.evidence.sourceHead, integrationId: 'secret-log' });
      const recorded = JSON.stringify(await service.readOperation(f.workspace, candidate.integrationId));
      expect(recorded).not.toContain(secret);
      expect(recorded).toContain('undefined');
      await service.abandonCandidate({ ...ctx, candidate, reason: 'test completed' });
    } finally {
      if (oldSecret === undefined) delete process.env.RIFT_ACCEPTANCE_SECRET; else process.env.RIFT_ACCEPTANCE_SECRET = oldSecret;
      await f.dispose();
    }
  });
});
