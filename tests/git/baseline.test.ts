import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Candidate, GitContext } from '../../src/contracts/index.js';
import type { CheckCommand } from '../../src/git/types.js';
import { LocalGitService } from '../../src/git/integration.js';
import { CandidateEvidenceError } from '../../src/git/evidence.js';
import { key } from '../../src/git/worktree-binding.js';
import { gitOk } from '../../src/git/process.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rift-baseline-')); roots.push(root);
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await gitOk(repo, ['init', '-b', 'main']);
  await gitOk(repo, ['config', 'user.name', 'Test']); await gitOk(repo, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(repo, 'input.txt'), 'base'); await gitOk(repo, ['add', '.']); await gitOk(repo, ['commit', '-m', 'base']);
  const base = await gitOk(repo, ['rev-parse', 'HEAD']);
  await writeFile(path.join(repo, 'input.txt'), 'fixed'); await gitOk(repo, ['commit', '-am', 'fix']);
  const source = await gitOk(repo, ['rev-parse', 'HEAD']);
  const ctx: GitContext = {
    workspace: { id: 'own', name: 'Own', repositoryPath: repo, rootPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main', status: 'active' },
    workflow: { id: 'flow', workspaceId: 'own', goal: 'test', leadSessionId: null, planRevision: 1, version: 1, status: 'running', integrationRef: 'refs/heads/rift/baseline', baseCommit: base, summary: null },
    task: { id: 'task', workflowId: 'flow', roleId: null, kind: 'change', title: 'Task', instructions: 'Task', expectedPaths: [], acceptanceCriteria: ['Natural language is not a command.'], status: 'validating', attempt: 1, version: 1, sourceHead: source, acceptedCommit: null, blockingReason: null },
  };
  const command: CheckCommand = { id: 'unit', executable: process.execPath, args: ['-e', "setTimeout(()=>{console.log('historical comparison');process.exit(require('fs').readFileSync('input.txt','utf8')==='fixed'?0:1)},150)"], baseline: { environmentId: 'immutable-test-image-v1' } };
  const service = (commands = [command]) => new LocalGitService({ managedRoot: path.join(root, 'managed'), commands });
  const prepare = async (git: LocalGitService, id: string, context = ctx) => {
    let candidate: Candidate;
    try { candidate = await git.prepareCandidate({ ...context, sourceHead: source, integrationId: id }); }
    catch (error) { if (!(error instanceof CandidateEvidenceError)) throw error; candidate = error.candidate; }
    await git.abandonCandidate({ ...context, candidate, reason: 'test finished' });
    return candidate;
  };
  const operationFile = (integrationId: string) => path.join(root, 'managed', key(ctx.workspace.id), 'operations', key(integrationId), 'operation.json');
  return { root, repo, base, source, ctx, command, service, prepare, operationFile };
}

it('persists and reuses a failed historical baseline across roles/tasks and restart, never candidate passes or review', async () => {
  const f = await fixture(), service = f.service();
  const first = await f.prepare(service, 'first'), baseline = first.baselines![0]!;
  expect(baseline).toMatchObject({ status: 'recorded', cleanupStatus: 'confirmed', check: { candidateHead: f.base, exitCode: 1, host: { taskId: '$baseline', exitStatus: 'failed' } } });
  expect(baseline.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(first.readiness?.status).toBe('ready');
  expect(first.checkIds).not.toContain(baseline.check!.id);
  expect(first.checks![0]!.candidateHead).toBe(first.candidateHead);
  const restarted = f.service(), second = await f.prepare(restarted, 'second', { ...f.ctx, task: { ...f.ctx.task, id: 'another-role-task', attempt: 2 } });
  expect(second.baselines![0]).toMatchObject({ status: 'reused', key: baseline.key, check: { id: baseline.check!.id } });
  expect(second.checkIds).not.toEqual(first.checkIds);
  expect(second.timings!.prepareMs).toBeGreaterThan(0);
  expect(second.timings!.checksMs).toBe(second.checks![0]!.durationMs);
  expect(baseline.check!.durationMs).toBeGreaterThanOrEqual(150);
  const full = await restarted.readCheckEvidence({ ...f.ctx, integrationId: 'first', checkId: baseline.check!.id });
  expect(full).toEqual(baseline.check);
  const saved = await restarted.readOperation(f.ctx.workspace, baseline.integrationId!);
  expect(saved).not.toHaveProperty('review');
  const supplemented = await restarted.resumeCandidate({ ...f.ctx, integrationId: 'first', candidateHead: first.candidateHead, idempotencyKey: 'already-passed' });
  expect(supplemented.checkIds).toEqual(first.checkIds);
  expect(supplemented.timings!.checksMs).toBe(first.timings!.checksMs);
  await restarted.abandonCandidate({ ...f.ctx, candidate: supplemented, reason: 'test finished' });
  expect(saved.baselineIdentity?.tree).toBe(await gitOk(f.repo, ['rev-parse', `${f.base}^{tree}`]));
  console.info('baseline performance ms', JSON.stringify({ cold: first.timings!.baselineMs, warm: second.timings!.baselineMs, baselineExecution: baseline.check!.durationMs, candidateExecution: second.timings!.checksMs }));
});

it('does not turn a reused failure into a current required-check pass or an approval', async () => {
  const f = await fixture(), command = { ...f.command, args: ['-e', 'console.log("known failure");process.exit(1)'] };
  const first = await f.prepare(f.service([command]), 'first');
  const second = await f.prepare(f.service([command]), 'second');
  expect(second.baselines![0]).toMatchObject({ status: 'reused', failureFingerprint: first.baselines![0]!.failureFingerprint });
  expect(second.readiness).toMatchObject({ status: 'failed', requiredCheckIds: ['unit'] });
  await expect(f.service([command]).publishCandidate({ ...f.ctx, candidate: second, review: { schemaVersion: 1, taskId: 'task', runId: 'review', verdict: 'approve', reviewedCommit: second.candidateHead, findings: [] } })).rejects.toThrow('EVIDENCE_NOT_READY');
});

it('invalidates command, required/optional, timeout, environment, and complete base tree/commit inputs', async () => {
  const f = await fixture(), first = await f.prepare(f.service(), 'first'), originalKey = first.baselines![0]!.key;
  const changes: CheckCommand[] = [
    { ...f.command, args: ['-e', 'process.exit(0)'] },
    { ...f.command, timeoutMs: 9999 },
    { ...f.command, required: false },
    { ...f.command, baseline: { environmentId: 'immutable-test-image-v2' } },
  ];
  for (const [index, command] of changes.entries()) {
    const next = await f.prepare(f.service([command]), `changed-${index}`);
    expect(next.baselines![0]!.status).toBe('recorded'); expect(next.baselines![0]!.key).not.toBe(originalKey);
  }
  await gitOk(f.repo, ['config', 'user.email', 'changed@localhost']);
  const configured = await f.prepare(f.service(), 'changed-git-config');
  expect(configured.baselines![0]!.status).toBe('recorded');
  expect(configured.baselines![0]!.identity!.repositoryConfigurationFingerprint).not.toBe(first.baselines![0]!.identity!.repositoryConfigurationFingerprint);
  await gitOk(f.repo, ['update-ref', f.ctx.workflow.integrationRef, f.source, f.base]);
  const next = await f.prepare(f.service(), 'changed-base');
  expect(next.baselines![0]).toMatchObject({ status: 'recorded', identity: { baselineCommit: f.source }, check: { exitCode: 0 } });
  expect(next.baselines![0]!.key).not.toBe(originalKey);
}, 60000);

it('isolates workspace and repository trust scopes, even for identical commits', async () => {
  const f = await fixture(), first = await f.prepare(f.service(), 'first');
  const workspace = { ...f.ctx.workspace, id: 'foreign' }, second = await f.prepare(f.service(), 'second', { ...f.ctx, workspace });
  expect(second.baselines![0]!.status).toBe('recorded'); expect(second.baselines![0]!.key).not.toBe(first.baselines![0]!.key);
  const clone = path.join(f.root, 'clone'); await gitOk(f.repo, ['clone', '--no-local', f.repo, clone]);
  const third = await f.prepare(f.service(), 'third', { ...f.ctx, workspace: { ...f.ctx.workspace, repositoryPath: clone, rootPath: clone, commonGitDir: path.join(clone, '.git') } });
  expect(third.baselines![0]!.status).toBe('recorded'); expect(third.baselines![0]!.key).not.toBe(first.baselines![0]!.key);
  const fourth = await f.prepare(f.service(), 'fourth', { ...f.ctx, task: { ...f.ctx.task, repositoryId: 'different-registration' } });
  expect(fourth.baselines![0]!.key).not.toBe(first.baselines![0]!.key);
});

it.each(['corrupt', 'interrupted'])('fails closed on %s persistent evidence and does not repeat the claimed baseline', async mode => {
  const f = await fixture(), first = await f.prepare(f.service(), 'first'), baseline = first.baselines![0]!;
  const file = f.operationFile(baseline.integrationId!);
  if (mode === 'corrupt') await writeFile(file, '{broken');
  else {
    const saved = JSON.parse(await readFile(file, 'utf8')); saved.checkCleanup = 'unknown'; saved.checks = []; saved.phase = 'candidate_created'; await writeFile(file, JSON.stringify(saved));
  }
  const before = await readFile(file, 'utf8'), second = await f.prepare(f.service(), 'second');
  expect(second.baselines![0]).toMatchObject({ status: 'unavailable', cleanupStatus: 'unknown', key: baseline.key });
  expect(second.checkIds).toEqual([]); expect(second.readiness).toMatchObject({ status: 'environment_unavailable', cleanupStatus: 'unknown' });
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('retains timeout cleanup gates for optional baseline commands across restart', async () => {
  const f = await fixture(), commands = [{ ...f.command, required: false, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }];
  const first = await f.prepare(f.service(commands), 'first');
  expect(first.baselines![0]).toMatchObject({ status: 'unavailable', cleanupStatus: 'unknown', check: { exitCode: 124 } });
  const second = await f.prepare(f.service(commands), 'second');
  expect(second.baselines![0]).toMatchObject({ status: 'unavailable', cleanupStatus: 'unknown' });
  expect(second.checkIds).toEqual([]);
});

it('keeps legacy serial checks unchanged and does not infer commands from acceptance prose', async () => {
  const f = await fixture(), { baseline: _, ...legacy } = f.command;
  const candidate = await f.prepare(f.service([legacy, { id: 'after', executable: process.execPath, args: ['-e', 'process.exit(0)'] }]), 'legacy');
  expect(candidate.baselines).toEqual([]);
  expect(candidate.checks!.map(check => check.commandId)).toEqual(['unit', 'after']);
  expect(Date.parse(candidate.checks![1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(candidate.checks![0]!.finishedAt));
  const empty = await f.prepare(f.service([]), 'no-config'); expect(empty.readiness!.status).toBe('waiting_evidence');
});

it('rejects malformed Host opt-ins and cannot reuse an unresolvable environment', async () => {
  const f = await fixture();
  expect(() => f.service([{ ...f.command, baseline: { environmentId: '' } }])).toThrow('INVALID_CHECK_CONFIG');
  const candidate = await f.prepare(f.service([{ ...f.command, executable: 'missing-rift-test-tool' }]), 'unavailable');
  expect(candidate.baselines![0]).toMatchObject({ status: 'unavailable', cleanupStatus: 'confirmed' });
  expect(candidate.readiness!.status).toBe('environment_unavailable');
  expect(candidate.baselines![0]!.identity).toBeUndefined();
  expect(candidate.baselines![0]!.key).toBe('');
});

it('invalidates the ordered command plan and never shares writable dependency output', async () => {
  const f = await fixture();
  const command = { ...f.command, args: ['-e', "const fs=require('fs');if(fs.existsSync('.pnpm-store/private'))process.exit(2);fs.mkdirSync('.pnpm-store',{recursive:true});fs.writeFileSync('.pnpm-store/private',String(process.pid));console.log('private output')"] };
  const first = await f.prepare(f.service([command]), 'first'), nextCommand = { id: 'other', executable: process.execPath, args: ['-e', 'process.exit(0)'] };
  const second = await f.prepare(f.service([command, nextCommand]), 'second');
  expect(second.baselines![0]).toMatchObject({ status: 'recorded', check: { exitCode: 0 } });
  expect(second.baselines![0]!.identity!.planFingerprint).not.toBe(first.baselines![0]!.identity!.planFingerprint);
  const third = await f.prepare(f.service([command, nextCommand]), 'third');
  expect(third.baselines![0]!.status).toBe('reused');
  expect(third.checks![0]!.exitCode).toBe(0);
  const baselineOperation = await f.service([command, nextCommand]).readOperation(f.ctx.workspace, second.baselines![0]!.integrationId!);
  const candidateOperation = await f.service([command, nextCommand]).readOperation(f.ctx.workspace, 'third');
  await writeFile(path.join(baselineOperation.candidatePath, '.pnpm-store/private'), 'changed baseline output');
  expect(await readFile(path.join(candidateOperation.candidatePath, '.pnpm-store/private'), 'utf8')).not.toBe('changed baseline output');
});

it('does not let a reused passing baseline satisfy a failing current candidate', async () => {
  const f = await fixture(), commands = [{ ...f.command, args: ['-e', "process.exit(require('fs').readFileSync('input.txt','utf8')==='base'?0:1)"] }];
  const first = await f.prepare(f.service(commands), 'first');
  const second = await f.prepare(f.service(commands), 'second');
  expect(first.baselines![0]!.check!.exitCode).toBe(0);
  expect(second.baselines![0]).toMatchObject({ status: 'reused', check: { id: first.baselines![0]!.check!.id, exitCode: 0 } });
  expect(second.checks![0]!.exitCode).toBe(1); expect(second.readiness!.status).toBe('failed');
  expect(second.checkIds).not.toContain(second.baselines![0]!.check!.id);
});
