import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { CheckEvidence, TaskEvidence } from '@rift/protocol';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftHostService } from '../../src/api/host-service.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { configureRoles } from '../../src/project/agent-roles.js';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import { gitOk } from '../../src/git/process.js';
import type { CheckCommand } from '../../src/git/types.js';
import type { ActivationBridge, ActivationResult, Candidate, Task } from '../../src/contracts/index.js';

type Started = Parameters<ActivationBridge['start']>[0] & { finish: (result: ActivationResult) => void };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function eventually(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 20_000, interval: 20 });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rift-combined-recovery-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await gitOk(repo, ['init', '-b', 'main']);
  await gitOk(repo, ['config', 'user.name', 'Test']); await gitOk(repo, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  await gitOk(repo, ['add', '.']); await gitOk(repo, ['commit', '-m', 'base']);
  const baseCommit = await gitOk(repo, ['rev-parse', 'HEAD']);
  // Only the external provider is substituted; Git, leases, artifacts, API/CLI and checks are real.
  const starts: Started[] = [];
  vi.spyOn(DshActivationBridge.prototype, 'start').mockImplementation(async input => {
    let finish!: Started['finish'];
    const result = new Promise<ActivationResult>(resolve => { finish = resolve; });
    starts.push({ ...input, finish });
    return { childId: input.run.id, result, dispose: async () => {} };
  });
  // Small real assertion fixture for the profile's serial/required contract, not the actual UI suite.
  const commands: CheckCommand[] = [
    { id: 'diff-check', executable: 'git', args: ['diff', '--check', 'HEAD^', 'HEAD'], required: true },
    { id: 'frontend-unit', executable: process.execPath, args: ['-e', 'process.exit(127)'], required: true, dependsOn: ['diff-check'] },
  ];
  const host = new RiftHostService({ subagents: { list: () => [] } } as unknown as Context, {
    home: path.join(root, 'host'), port: 0, leadProvider: 'test', leadModel: 'test', checks: commands,
    checkPlan: { mode: 'serial', maxConcurrency: 1, resourceSlots: 1 },
  });
  cleanups.push(() => host.close());
  createWorkspace(host.store, { id: 'own', name: 'Own', rootPath: repo, repositoryPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main' });
  configureRoles(host.store, 'own', [{ id: 'fake', providerName: 'fake', packageVersion: 'test', configRevision: 1, capabilities: {}, credentialRefs: [] }], [
    { name: 'lead', kind: 'dsh-lead', prompt: 'Lead', revision: 1 },
    { name: 'developer-a', kind: 'subagent', providerBindingId: 'fake', prompt: 'Develop', revision: 1 },
    { name: 'reviewer', purpose: 'reviewer', kind: 'subagent', providerBindingId: 'fake', prompt: 'Review', revision: 1 },
  ], new Set(['fake']));
  const workflow = host.coordinator.createWorkflow({ id: 'flow', workspaceId: 'own', goal: 'Combined recovery', integrationRef: 'refs/heads/rift/combined', baseCommit });
  host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'task', kind: 'change', title: 'Task', instructions: 'Task' }] });
  const cli = (action: string, input: Record<string, unknown>) => host.workspaceCli.execute('own', { argv: ['task', action, 'task'], input });
  const settled = (status: string) => eventually(() => host.store.task('task').status === status);
  const started = async (index: number) => { await eventually(() => starts.length > index); return starts[index]!; };
  const integration = () => host.store.require<{ id: string; status: string; candidate: Candidate }>('SELECT * FROM integrations ORDER BY rowid DESC LIMIT 1');
  return { root, repo, host, workflow, baseCommit, starts, cli, settled, started, integration };
}

it.each(['delete', 'rename', 'defect'] as const)('joins result/source/check/review recovery for committed %s without replaying development', async mode => {
  const f = await fixture(), { host } = f;
  host.coordinator.dispatch({ taskId: 'task', expectedVersion: host.store.task('task').version, idempotencyKey: 'develop' });
  const dev = await f.started(0);
  await gitOk(dev.cwd, mode === 'delete' ? ['rm', 'base.txt'] : ['mv', 'base.txt', 'renamed.txt']);
  await writeFile(path.join(dev.cwd, 'button.txt'), mode === 'defect' ? 'broken' : 'ready');
  await gitOk(dev.cwd, ['add', '.']);
  await gitOk(dev.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'committed implementation']);
  const sourceHead = await gitOk(dev.cwd, ['rev-parse', 'HEAD']);
  const resultText = JSON.stringify({ schemaVersion: 1, taskId: 'task', runId: dev.run.id, outcome: 'completed', summary: 'done', changedPaths: [], checksClaimed: ['diff-check passed'], blockingReasons: [] });
  dev.finish({ stopReason: 'completed', text: `Implementation ready.\n\x60\x60\x60json\n${resultText}\n\x60\x60\x60` });
  await f.settled('blocked'); host.coordinator.pause(f.workflow.id);
  const originalRun = host.store.run(dev.run.id);
  expect(originalRun).toMatchObject({ status: 'failed', stopReason: 'INVALID_RESULT', cleanupStatus: 'confirmed' });
  const artifact = host.store.require<{ relativePath: string }>('SELECT relative_path FROM artifacts WHERE id=?', originalRun.resultArtifactId!);
  const artifactPath = path.join(f.root, 'host', artifact.relativePath), artifactBytes = await readFile(artifactPath);
  const output = (originalRun.result as { output: string }).output;
  const supplement = { runId: dev.run.id, expectedVersion: host.store.task('task').version, resultText, outputSha256: createHash('sha256').update(output).digest('hex') };
  const recover = (key: string) => ({ expectedVersion: host.store.task('task').version, idempotencyKey: key });
  await expect(f.cli('recover', recover('need-result'))).rejects.toMatchObject({ code: 'RESULT_SUPPLEMENT_REQUIRED' });
  await expect(f.cli('supplement-result', { ...supplement, runId: 'foreign-run' })).rejects.toBeDefined();
  const result = await host.handle('POST', '/v1/tasks/task/supplement-result', supplement, 'result');
  expect(await f.cli('supplement-result', supplement)).toEqual(result);
  expect(f.starts).toHaveLength(1); expect(host.store.task('task').sourceHead).toBeNull();

  const collect = vi.spyOn(host.git, 'collectSource').mockRejectedValueOnce(new Error('collection infrastructure unavailable'));
  const failedSource = recover('source-unavailable');
  await expect(f.cli('recover', failedSource)).rejects.toThrow('collection infrastructure unavailable');
  await expect(f.cli('recover', failedSource)).rejects.toThrow('collection infrastructure unavailable');
  expect(collect).toHaveBeenCalledOnce(); collect.mockRestore();
  const sourceInput = recover('source-restored');
  const recovered = await f.cli('recover', sourceInput);
  expect(recovered).toMatchObject({ stage: 'source', runId: dev.run.id, sourceHead, task: { attempt: 1, status: 'validating', acceptedCommit: null } });
  expect(await host.handle('POST', '/v1/tasks/task/recover', sourceInput, 'source-replay')).toEqual(recovered);
  expect(host.store.all('SELECT * FROM runs')).toHaveLength(1);
  expect(await gitOk(dev.cwd, ['rev-parse', 'HEAD'])).toBe(sourceHead); // No empty collection commit.
  const collected = host.store.events(f.workflow.id).filter(event => event.type === 'source.collected');
  expect(collected).toHaveLength(1);
  expect((collected[0]!.payload as { changedPaths: string[] }).changedPaths.sort()).toEqual(mode === 'delete' ? ['base.txt', 'button.txt'] : ['base.txt', 'button.txt', 'renamed.txt']);
  host.coordinator.resume(f.workflow.id); await f.settled('blocked'); host.coordinator.pause(f.workflow.id);
  const waiting = f.integration();
  expect(waiting).toMatchObject({ status: 'evidence_waiting', candidate: { readiness: { status: 'environment_unavailable', requiredCheckIds: ['diff-check', 'frontend-unit'] } } });
  expect(waiting.candidate.checks!.map(check => [check.commandId, check.exitCode])).toEqual([['diff-check', 0], ['frontend-unit', 127]]);
  expect(f.starts).toHaveLength(1); expect(host.store.task('task').acceptedCommit).toBeNull();
  await expect(f.cli('retry-dispatch', { expectedVersion: host.store.task('task').version })).rejects.toMatchObject({ code: 'EVIDENCE_NOT_READY' });

  // Restore a real required assertion, not diff-check or a developer-provided pass claim.
  const assertion = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.existsSync('base.txt'),false);assert.equal(fs.existsSync('renamed.txt'),${mode !== 'delete'});assert.equal(fs.readFileSync('button.txt','utf8'),'ready');console.log('required source assertions passed')`;
  (host.git as unknown as { commands: Map<string, CheckCommand> }).commands.set('frontend-unit', {
    id: 'frontend-unit', executable: process.execPath, args: ['-e', assertion], required: true, dependsOn: ['diff-check'],
  });
  const evidenceInput = { integrationId: waiting.id, candidateHead: waiting.candidate.candidateHead, expectedVersion: host.store.task('task').version, idempotencyKey: 'wrong-candidate' };
  await expect(f.cli('supplement-evidence', { ...evidenceInput, candidateHead: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'CANDIDATE_EVIDENCE_MISMATCH' });
  const checksInput = recover('checks-restored');
  if (mode === 'defect') {
    await expect(f.cli('recover', checksInput)).rejects.toThrow('CHECK_FAILED');
    expect(f.integration()).toMatchObject({ status: 'blocked', candidate: { readiness: { status: 'failed' } } });
    expect(f.integration().candidate.checks!.map(check => check.exitCode)).toEqual([0, 1]);
    await expect(f.cli('recover', recover('not-infrastructure'))).rejects.toMatchObject({ code: 'CODE_REPAIR_REQUIRED' });
    expect(f.starts).toHaveLength(1); expect(host.store.task('task').acceptedCommit).toBeNull();
  } else {
    const restored = await host.handle('POST', '/v1/tasks/task/recover', checksInput, 'checks');
    expect(restored).toMatchObject({ stage: 'checks', readiness: { status: 'ready' } });
    expect(await f.cli('recover', checksInput)).toEqual(restored);
    const ready = f.integration().candidate;
    expect(ready.candidateHead).toBe(waiting.candidate.candidateHead);
    expect(ready.checkIds.every(id => !waiting.candidate.checkIds.includes(id))).toBe(true); // Explicit serial rebuilds the whole pipeline.
    const route = '/ui-api/v1/workspaces/own/tasks/task/evidence';
    const evidence = await host.handle('GET', route, {}) as TaskEvidence;
    expect(evidence.currentCandidate).toMatchObject({ integrationId: waiting.id, candidateHead: ready.candidateHead, sourceHead, taskAttempt: 1 });
    for (const check of ready.checks!) {
      const log = await f.cli('evidence-log', { integrationId: waiting.id, checkId: check.id }) as CheckEvidence;
      expect(log.host).toMatchObject({ executionSource: 'host', taskId: 'task', attempt: 1, workspaceId: 'own', integrationId: waiting.id, candidateHead: ready.candidateHead, exitStatus: 'passed' });
      expect(log.host!.logSha256).toBe(createHash('sha256').update(JSON.stringify({ stdout: log.stdout, stderr: log.stderr })).digest('hex'));
    }
    const ids = ready.checkIds;
    host.coordinator.resume(f.workflow.id);
    const firstReview = await f.started(1);
    expect(firstReview.run.purpose).toBe('review');
    expect(JSON.parse(firstReview.prompt).candidate.checkIds).toEqual(ids); // Ready unchanged evidence is reused, not rerun.
    firstReview.finish({ stopReason: 'error', text: 'review provider unavailable' });
    await f.settled('blocked'); host.coordinator.pause(f.workflow.id);
    const reviewInput = recover('review-restored');
    const reviewRecovery = await f.cli('recover', reviewInput);
    expect(reviewRecovery).toMatchObject({ stage: 'review' });
    expect(await host.handle('POST', '/v1/tasks/task/recover', reviewInput, 'review-replay')).toEqual(reviewRecovery);
    expect(f.starts).toHaveLength(2); expect(host.store.task('task').acceptedCommit).toBeNull();
    host.coordinator.resume(f.workflow.id);
    const reviewer = await f.started(2), candidate = JSON.parse(reviewer.prompt).candidate as Candidate;
    expect(reviewer.run.purpose).toBe('review');
    expect(candidate.checks!.every(check => check.exitCode === 0 && check.candidateHead === candidate.candidateHead)).toBe(true);
    reviewer.finish({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: 'task', runId: reviewer.run.id, verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] }) });
    await f.settled('succeeded');
    expect(host.store.task('task')).toMatchObject({ attempt: 1, sourceHead, acceptedCommit: candidate.candidateHead } satisfies Partial<Task>);
    expect(await gitOk(f.repo, ['rev-parse', f.workflow.integrationRef])).toBe(candidate.candidateHead);
  }
  expect(host.store.run(dev.run.id)).toEqual(originalRun);
  expect(await readFile(artifactPath)).toEqual(artifactBytes);
  expect(f.starts.filter(start => start.run.purpose !== 'review')).toHaveLength(1);
  expect(host.store.all("SELECT id FROM execution_leases WHERE released_at IS NULL OR cleanup_status<>'confirmed'")).toEqual([]);
  expect(await gitOk(f.repo, ['rev-parse', 'main'])).toBe(f.baseCommit);
}, 30_000);
