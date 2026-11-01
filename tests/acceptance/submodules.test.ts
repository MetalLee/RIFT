import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { LocalGitService } from '../../src/git/integration.js';
import { inspectRepository, sourceCheckoutClean, checkoutClean, assertSafeFiles } from '../../src/git/worktree-binding.js';
import { git as guardedGit } from '../../src/git/process.js';
import type { GitContext, Run, Workspace, Workflow } from '../../src/contracts/index.js';
// Exercise real Git and checks on every platform; sandbox isolation has its own suite.
vi.mock('../../src/agent/filesystem-sandbox.js', () => ({
  sandboxCommand: async (_roots: string[], _cwd: string, cmd: string) => process.platform === 'win32' ? ['cmd.exe', '/c', cmd] : ['/bin/sh', '-c', cmd],
}));
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
const commit = (cwd: string) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'fixture');
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rift 子模块 '));
  const repo = path.join(root, 'parent'), dependency = path.join(root, 'dependency');
  for (const cwd of [repo, dependency]) {
    await mkdir(cwd); await git(cwd, 'init', '-q');
    await writeFile(path.join(cwd, 'file.txt'), 'original'); await git(cwd, 'add', '.'); await commit(cwd);
  }
  await git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'third party/sdk'); await commit(repo);
  const baseCommit = await git(repo, 'rev-parse', 'HEAD');
  const workspace: Workspace = { id: 'submodules', name: 'submodules', rootPath: root, repositoryPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'HEAD', status: 'active' };
  const workflow: Workflow = { id: 'workflow', workspaceId: workspace.id, goal: 'submodules', leadSessionId: null, planRevision: 1, version: 0, status: 'running', integrationRef: 'refs/heads/rift/submodules', baseCommit, summary: null };
  const ctx: GitContext = { workspace, workflow, task: { id: 'task', workflowId: workflow.id, roleId: null, kind: 'change', title: 'task', instructions: 'task', expectedPaths: [], acceptanceCriteria: [], status: 'running', attempt: 1, version: 0, acceptedCommit: null, sourceHead: null, blockingReason: null } };
  const run = { id: 'run', taskId: 'task', taskAttempt: 1, cleanupStatus: 'confirmed' } as Run;
  const service = new LocalGitService({ managedRoot: path.join(root, 'managed'), commands: [{ id: 'check', executable: process.execPath, args: ['-e', "require('node:fs').readFileSync('third party/sdk/file.txt')"] }] });
  return { root, repo, dependency, ctx, run, service, dispose: () => rm(root, { recursive: true, force: true }) };
}
describe('submodule lifecycle', () => {
  it('hydrates isolated task, candidate and review checkouts, publishes and removes the worktree', async () => {
    const f = await fixture();
    try {
      await expect(inspectRepository(f.repo, 'HEAD')).resolves.toMatchObject({ baseCommit: f.ctx.workflow.baseCommit });
      const tree = await f.service.prepareTask({ ...f.ctx, run: f.run });
      expect(await readFile(path.join(tree.path, 'third party/sdk/file.txt'), 'utf8')).toBe('original');
      await writeFile(path.join(tree.path, 'file.txt'), 'parent change');
      const source = await f.service.collectSource({ ...f.ctx, run: f.run, worktree: tree });
      const candidate = await f.service.prepareCandidate({ ...f.ctx, sourceHead: source.sourceHead, integrationId: 'integration' });
      expect(await readFile(path.join(candidate.cwd, 'third party/sdk/file.txt'), 'utf8')).toBe('original');
      await f.service.publishCandidate({ ...f.ctx, candidate, review: { schemaVersion: 1, taskId: 'task', runId: 'review', verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] } });
      await f.service.archiveWorktree({ workspace: f.ctx.workspace, worktree: tree, active: false, cleanupConfirmed: true, artifactsSaved: true });
      expect(await readFile(path.join(f.repo, 'third party/sdk/file.txt'), 'utf8')).toBe('original');
    } finally { await f.dispose(); }
  });
  it('collects a committed dependency pointer update and checks the pinned new version', async () => {
    const f = await fixture();
    try {
      const dep = path.join(f.repo, 'third party/sdk');
      await writeFile(path.join(dep, 'file.txt'), 'updated'); await commit(dep);
      const expected = await git(dep, 'rev-parse', 'HEAD');
      const tree = await f.service.prepareTask({ ...f.ctx, run: f.run });
      expect(await readFile(path.join(tree.path, 'third party/sdk/file.txt'), 'utf8')).toBe('original');
      await git(path.join(tree.path, 'third party/sdk'), 'checkout', '--detach', expected);
      const source = await f.service.collectSource({ ...f.ctx, run: f.run, worktree: tree });
      expect(source.changedPaths).toEqual(['third party/sdk']);
      const candidate = await f.service.prepareCandidate({ ...f.ctx, sourceHead: source.sourceHead, integrationId: 'pointer' });
      expect(await readFile(path.join(candidate.cwd, 'third party/sdk/file.txt'), 'utf8')).toBe('updated');
    } finally { await f.dispose(); }
  });
  it('rejects dirty dependencies even if Git ignore configuration hides them', async () => {
    const f = await fixture();
    try {
      const tree = await f.service.prepareTask({ ...f.ctx, run: f.run });
      await writeFile(path.join(tree.path, 'third party/sdk/file.txt'), 'uncommitted');
      await git(tree.path, 'config', 'submodule.third party/sdk.ignore', 'all');
      expect(await sourceCheckoutClean(tree.path)).toBe(false);
      await expect(f.service.collectSource({ ...f.ctx, run: f.run, worktree: tree })).rejects.toThrow('SUBMODULE_DIRTY');
      await expect(assertSafeFiles(tree.path, ['third party/sdk/file.txt'])).rejects.toThrow('nested repository');
    } finally { await f.dispose(); }
  });
  it('recursively clones nested modules and detects missing or ignored dependency content', async () => {
    const f = await fixture();
    try {
      const dep = path.join(f.repo, 'third party/sdk');
      await git(dep, '-c', 'protocol.file.allow=always', 'submodule', 'add', f.dependency, 'nested sdk');
      await writeFile(path.join(dep, '.gitignore'), 'cache.log\n'); await git(dep, 'add', '.'); await commit(dep);
      await git(f.repo, 'add', '.'); await commit(f.repo);
      f.ctx.workflow.baseCommit = await git(f.repo, 'rev-parse', 'HEAD');
      const tree = await f.service.prepareTask({ ...f.ctx, run: f.run });
      const target = path.join(tree.path, 'third party/sdk');
      expect(await readFile(path.join(target, 'nested sdk/file.txt'), 'utf8')).toBe('original');
      await writeFile(path.join(target, 'cache.log'), 'cache');
      expect(await sourceCheckoutClean(tree.path)).toBe(true);
      expect(await checkoutClean(tree.path)).toBe(false);
      await git(target, 'config', 'submodule.nested sdk.ignore', 'all');
      await writeFile(path.join(target, 'nested sdk/file.txt'), 'dirty nested');
      expect(await sourceCheckoutClean(tree.path)).toBe(false);
      await rm(path.join(target, 'nested sdk'), { recursive: true });
      expect(await sourceCheckoutClean(tree.path)).toBe(false);
    } finally { await f.dispose(); }
  });
  it('rejects submodule helpers before parent status can execute them', async () => {
    const f = await fixture();
    try {
      const dep = path.join(f.repo, 'third party/sdk');
      await git(dep, 'config', 'core.fsmonitor', 'unsafe-helper');
      await expect(inspectRepository(f.repo, 'HEAD')).rejects.toThrow('UNSAFE_GIT_CONFIG');
      await expect(sourceCheckoutClean(f.repo)).rejects.toThrow('UNSAFE_GIT_CONFIG');
    } finally { await f.dispose(); }
  });
  it('fails explicitly when dependencies are not prepared and rejects redirected metadata', async () => {
    const f = await fixture();
    try {
      await git(f.repo, 'submodule', 'deinit', '-f', '--all');
      await expect(inspectRepository(f.repo, 'HEAD')).resolves.toBeDefined();
      await expect(f.service.prepareTask({ ...f.ctx, run: f.run })).rejects.toThrow('SUBMODULE_NOT_PREPARED');
      await git(f.repo, 'config', 'core.worktree', f.dependency);
      await expect(guardedGit(f.repo, ['status', '--porcelain'])).rejects.toThrow('UNSAFE_GIT_CONFIG');
    } finally { await f.dispose(); }
  });
});
