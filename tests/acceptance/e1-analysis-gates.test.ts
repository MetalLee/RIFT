import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { ProjectService } from '../../src/project/index.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { LocalGitService } from '../../src/git/integration.js';
import type { ActivationBridge } from '../../src/contracts/index.js';

const exec = promisify(execFile);

describe('E1.5 independent real Git mutation gate with controlled activation', () => {
  it.each(['clean', 'tracked', 'untracked', 'committed', 'empty-commit', 'ignored'] as const)('does not let %s analysis bypass write acceptance', async mode => {
    const folder = await mkdtemp(path.join(tmpdir(), 'rift E1 analysis ')), repo = path.join(folder, 'repository');
    const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim();
    await mkdir(repo); await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.name', 'E1 acceptance'); await git(repo, 'config', 'user.email', 'e1@example.invalid');
    await writeFile(path.join(repo, 'README.md'), 'baseline\n'); await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'baseline'); const base = await git(repo, 'rev-parse', 'HEAD');
    const store = new RiftStore(path.join(folder, 'ledger.db'));
    const projects = new ProjectService(store, new Set(['controlled']));
    projects.createWorkspace({ id: 'ws', name: 'Analysis gate', rootPath: path.join(folder, 'managed'), repositoryPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main' });
    projects.configureRoles('ws', [{ id: 'controlled', providerName: 'controlled', packageVersion: 'test-only', configRevision: 1, capabilities: {}, credentialRefs: [] }], [
      { name: 'lead', kind: 'dsh-lead', prompt: 'lead', revision: 1 },
      { name: 'reader', purpose: 'developer', kind: 'subagent', providerBindingId: 'controlled', prompt: 'Analyze read-only', revision: 1 },
      { name: 'reviewer', kind: 'subagent', providerBindingId: 'controlled', prompt: 'Review', revision: 1 },
    ]);
    let worktree = '';
    const bridge: ActivationBridge = { async start({ task, run, cwd }) {
      worktree = cwd;
      if (mode === 'tracked') await writeFile(path.join(cwd, 'README.md'), 'unreviewed change\n');
      if (mode === 'untracked' || mode === 'committed') await writeFile(path.join(cwd, 'new.txt'), 'unreviewed output\n');
      if (mode === 'committed') { await git(cwd, 'add', 'new.txt'); await git(cwd, 'commit', '-qm', 'unreviewed analysis commit'); }
      if (mode === 'empty-commit') await git(cwd, 'commit', '--allow-empty', '-qm', 'unreviewed empty commit');
      if (mode === 'ignored') await writeFile(path.join(cwd, 'ignored.txt'), 'unreviewed ignored output\n');
      return { childId: `controlled-${run.id}`, result: Promise.resolve({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: task.id, runId: run.id, outcome: 'completed', summary: 'Claims analysis is complete', changedPaths: [], checksClaimed: [], blockingReasons: [] }) }), async dispose() {} };
    } };
    const coordinator = new TaskCoordinator({ store, bridge, git: new LocalGitService({ managedRoot: path.join(folder, 'managed'), commands: [{ id: 'diff', executable: 'git', args: ['diff', '--check'] }] }) });
    try {
      const workflow = coordinator.createWorkflow({ workspaceId: 'ws', goal: 'Validate analysis side effects', integrationRef: 'refs/heads/rift/analysis', baseCommit: base });
      const [task] = coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'analysis', kind: 'analysis', title: 'Read-only batch', instructions: 'Analyze without mutations', expectedPaths: [], analysisItems: [{ id: 'one', prompt: 'Analyze' }] }] });
      coordinator.dispatch({ taskId: task!.id, expectedVersion: task!.version, idempotencyKey: 'dispatch' });
      await vi.waitFor(() => expect(['succeeded', 'blocked']).toContain(store.task(task!.id).status), { timeout: 10_000, interval: 20 });
      const status = coordinator.status(workflow.id);
      expect(status.tasks[0]!.status).toBe(mode === 'clean' ? 'succeeded' : 'blocked');
      expect(status.integrations).toHaveLength(0); expect(status.tasks[0]!.acceptedCommit).toBeNull();
      expect(status.runs[0]!.cleanupStatus).toBe('confirmed'); expect(status.slots.total).toBe(0);
      expect(await git(repo, 'rev-parse', 'main')).toBe(base); expect(await git(repo, 'rev-parse', workflow.integrationRef)).toBe(base);
      if (mode !== 'clean') { expect(() => coordinator.finish({ workflowId: workflow.id, summary: 'Must not finish' })).toThrow(); expect(status.tasks[0]!.blockingReason).toMatch(/ANALYSIS|MODIFIED|MUTAT|WRITE/i); }
      if (mode === 'committed' || mode === 'empty-commit') expect(await git(worktree, 'rev-parse', 'HEAD')).not.toBe(base);
    } finally { await coordinator.shutdown(); store.close(); await rm(folder, { recursive: true, force: true }); }
  });
});
