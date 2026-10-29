import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Candidate, GitContext } from '../../src/contracts/index.js';
import type { CheckCommand, CheckPlan } from '../../src/git/types.js';
import { LocalGitService } from '../../src/git/integration.js';
import { CandidateEvidenceError } from '../../src/git/evidence.js';
import { gitOk } from '../../src/git/process.js';
import { key } from '../../src/git/worktree-binding.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const node = (id: string, script = 'console.log("ok")', extra: Partial<CheckCommand> = {}): CheckCommand => ({ id, executable: process.execPath, args: ['-e', script], ...extra });
const beforeBoot = `v1:${'a'.repeat(64)}:${'1'.repeat(64)}`, afterBoot = `v1:${'a'.repeat(64)}:${'2'.repeat(64)}`;
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rift-check-plan-')); roots.push(root);
  const repo = path.join(root, '候选 repo'); await mkdir(repo);
  await gitOk(repo, ['init', '-b', 'main']); await gitOk(repo, ['config', 'user.name', 'Test']); await gitOk(repo, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(repo, 'input.txt'), 'base'); await writeFile(path.join(repo, '.gitignore'), 'dist/\n');
  await gitOk(repo, ['add', '.']); await gitOk(repo, ['commit', '-m', 'base']);
  const base = await gitOk(repo, ['rev-parse', 'HEAD']);
  await writeFile(path.join(repo, 'input.txt'), 'candidate'); await gitOk(repo, ['commit', '-am', 'change']);
  const source = await gitOk(repo, ['rev-parse', 'HEAD']);
  const ctx: GitContext = {
    workspace: { id: 'workspace', name: 'Test', repositoryPath: repo, rootPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main', status: 'active' },
    workflow: { id: 'workflow', workspaceId: 'workspace', goal: 'Test', leadSessionId: null, planRevision: 1, version: 1, status: 'running', integrationRef: 'refs/heads/rift/check-plan', baseCommit: base, summary: null },
    task: { id: 'task', workflowId: 'workflow', roleId: null, kind: 'change', title: 'Task', instructions: 'Task', expectedPaths: [], acceptanceCriteria: [], status: 'validating', attempt: 1, version: 1, sourceHead: source, acceptedCommit: null, blockingReason: null },
  };
  const managedRoot = path.join(root, 'managed');
  const service = (commands: CheckCommand[], checkPlan?: CheckPlan) => new LocalGitService({ managedRoot, commands, checkPlan });
  const prepare = async (git: LocalGitService, integrationId: string, context = ctx) => {
    let candidate: Candidate;
    try { candidate = await git.prepareCandidate({ ...context, sourceHead: source, integrationId }); }
    catch (error) { if (!(error instanceof CandidateEvidenceError)) throw error; candidate = error.candidate; }
    await git.abandonCandidate({ ...context, candidate, reason: 'Test finished' });
    return candidate;
  };
  const operationFile = (id: string) => path.join(managedRoot, key(ctx.workspace.id), 'operations', key(id), 'operation.json');
  const approve = (candidate: Candidate) => ({ schemaVersion: 1 as const, taskId: ctx.task.id, runId: 'independent-review', verdict: 'approve' as const, reviewedCommit: candidate.candidateHead, findings: [] });
  return { root, repo, ctx, source, managedRoot, service, prepare, operationFile, approve };
}

it('rejects malformed graphs and quotas before executing anything; graph fields require explicit opt-in', () => {
  const commands = [node('a'), node('b', '', { dependsOn: ['a'] })], dag: CheckPlan = { mode: 'dag' };
  const service = (commands: CheckCommand[], checkPlan: CheckPlan | undefined = dag, checkIds?: string[]) => new LocalGitService({ managedRoot: '/unused', commands, checkPlan, checkIds });
  expect(() => service(commands)).not.toThrow();
  for (const bad of [
    [node('a'), node('a')], [node('a', '', { dependsOn: ['missing'] })], [node('a', '', { dependsOn: ['a'] })],
    [node('a', '', { dependsOn: ['b'] }), node('b', '', { dependsOn: ['a'] })],
    [node('a'), node('b', '', { dependsOn: ['a', 'a'] })], [node('a'), node('b', '', { dependsOn: 'a' as unknown as string[] })], [node('a', '', { resourceSlots: 3 })],
    [node('a', '', { resourceSlots: 0 })], [node('a', '', { resourceSlots: 1.5 })], [node('a', '', { mutexGroup: '' })],
    [node('a', '', { isolation: 'unverified' as 'snapshot' })],
  ]) expect(() => service(bad)).toThrow('INVALID_CHECK_CONFIG');
  for (const bad of [{ mode: 'dag', maxConcurrency: 0 }, { mode: 'dag', maxConcurrency: 65 }, { mode: 'dag', resourceSlots: -1 }, { mode: 'dag', resourceSlots: 2.5 }, { mode: 'serial', maxConcurrency: 2 }, { mode: 'unknown' }]) expect(() => service(commands, bad as CheckPlan)).toThrow('INVALID_CHECK_CONFIG');
  expect(() => service(commands, dag, ['b'])).toThrow('INVALID_CHECK_CONFIG');
  expect(() => new LocalGitService({ managedRoot: '/unused', commands })).toThrow('INVALID_CHECK_CONFIG');
  expect(() => service([node('a', '', { isolation: 'snapshot' })], { mode: 'serial' })).toThrow('INVALID_CHECK_CONFIG');
});

it('proves real independent command speedup while legacy checks remain serial and required', async () => {
  const f = await fixture();
  const commands = [node('a', 'setTimeout(()=>console.log("a"),1000)'), node('b', 'setTimeout(()=>console.log("b"),1000)')];
  const serial = await f.prepare(f.service(commands), 'serial');
  const parallel = await f.prepare(f.service(commands.map(command => ({ ...command, isolation: 'read_only' })), { mode: 'dag', maxConcurrency: 2, resourceSlots: 2 }), 'parallel');
  expect(serial.readiness).toMatchObject({ status: 'ready', requiredCheckIds: ['a', 'b'] });
  expect(Date.parse(serial.checks![1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(serial.checks![0]!.finishedAt));
  expect(parallel.readiness!.status).toBe('ready');
  expect(Date.parse(parallel.checks![1]!.startedAt)).toBeLessThan(Date.parse(parallel.checks![0]!.finishedAt));
  expect(parallel.timings!.checksWallMs!).toBeLessThan(serial.timings!.checksWallMs! * .8);
  console.log('DAG real command performance ms', JSON.stringify({ serial: serial.timings!.checksWallMs, parallel: parallel.timings!.checksWallMs, commands: commands.map(item => [item.executable, ...item.args]) }));
});

it('isolates writable candidate inputs, outputs, HOME/cache, /tmp and ports for the exact same candidate', async () => {
  const f = await fixture();
  const commands = ['a', 'b'].map(id => node(id, `
    const fs=require('fs'),path=require('path'),assert=require('assert');
    assert.equal(fs.readFileSync('input.txt','utf8'),'candidate');
    for(const file of ['out.txt','/tmp/check-marker',path.join(process.env.HOME,'cache-marker')]){assert(!fs.existsSync(file));fs.writeFileSync(file,${JSON.stringify(id)});}
    fs.writeFileSync('input.txt',${JSON.stringify(id)});
    const server=require('net').createServer();server.listen(18473,'0.0.0.0',()=>setTimeout(()=>{
      assert.equal(fs.readFileSync('input.txt','utf8'),${JSON.stringify(id)});server.close();console.log(${JSON.stringify(id)});
    },500));
  `));
  const git = f.service(commands, { mode: 'dag' }), candidate = await f.prepare(git, 'isolate');
  expect(candidate.readiness!.status).toBe('ready');
  expect(candidate.checks!.map(check => check.stdout.trim())).toEqual(['a', 'b']);
  expect(Date.parse(candidate.checks![1]!.startedAt)).toBeLessThan(Date.parse(candidate.checks![0]!.finishedAt));
  const operation = await git.readOperation(f.ctx.workspace, 'isolate');
  expect(await readFile(path.join(operation.candidatePath, 'input.txt'), 'utf8')).toBe('candidate');
  expect(await readdir(operation.candidatePath)).not.toContain('out.txt');
  for (const check of candidate.checks!) {
    expect(check.candidateHead).toBe(candidate.candidateHead);
    expect(check.host).toMatchObject({ candidateHead: candidate.candidateHead, integrationId: 'isolate', taskId: f.ctx.task.id, attempt: 1 });
    expect((await git.readCheckEvidence({ ...f.ctx, integrationId: 'isolate', checkId: check.id })).id).toBe(check.id);
  }
  const inputs = path.join(f.managedRoot, key(f.ctx.workspace.id), 'check-inputs');
  expect((await Promise.all((await readdir(inputs)).map(async dir => readFile(path.join(inputs, dir, 'out.txt'), 'utf8')))).sort()).toEqual(['a', 'b']);
});

it('enforces declared read-only sharing with an actual read-only mount', async () => {
  const f = await fixture();
  const command = node('ro', `const fs=require('fs'),assert=require('assert');assert.throws(()=>fs.writeFileSync('input.txt','corrupt'),e=>e.code==='EROFS');console.log(fs.readFileSync('input.txt','utf8'));`, { isolation: 'read_only' });
  const candidate = await f.prepare(f.service([command], { mode: 'dag' }), 'ro');
  expect(candidate.readiness!.status).toBe('ready'); expect(candidate.checks![0]!.stdout.trim()).toBe('candidate');
});

it('respects dependency, mutex and weighted slot ordering, not merely a concurrent promise limit', async () => {
  const f = await fixture(), delay = 'setTimeout(()=>console.log("done"),300)';
  const commands = [node('a', delay, { mutexGroup: 'database' }), node('b', delay, { mutexGroup: 'database' }), node('c', delay, { dependsOn: ['a'] }), node('heavy', delay, { resourceSlots: 2 })];
  const candidate = await f.prepare(f.service(commands, { mode: 'dag', maxConcurrency: 3, resourceSlots: 2 }), 'order');
  expect(candidate.readiness!.status).toBe('ready');
  const check = (id: string) => candidate.checks!.find(check => check.commandId === id)!;
  const startsAfter = (a: string, b: string) => expect(Date.parse(check(a).startedAt)).toBeGreaterThanOrEqual(Date.parse(check(b).finishedAt));
  startsAfter('b', 'a'); startsAfter('c', 'a'); startsAfter('heavy', 'b'); startsAfter('heavy', 'c');
  expect(candidate.checkPlan).toMatchObject({ mode: 'dag', maxConcurrency: 3, resourceSlots: 2, nodes: commands.map(command => ({ commandId: command.id, status: 'passed' })) });
});

it('collects started independent failures and results, records readable downstream skips and blocks publication', async () => {
  const f = await fixture(), commands = [node('fail', 'setTimeout(()=>process.exit(1),100)'), node('independent', 'setTimeout(()=>console.log("collected"),400)'), node('downstream', 'throw Error("must not run")', { dependsOn: ['fail'] })];
  const git = f.service(commands, { mode: 'dag' }), candidate = await f.prepare(git, 'failed');
  expect(candidate.readiness!.status).toBe('failed');
  expect(candidate.checks!.map(check => check.host!.exitStatus)).toEqual(['failed', 'passed', 'skipped']);
  expect(candidate.checks![1]!.stdout).toContain('collected'); expect(candidate.checks![2]!.host!.summary).toContain('Dependency fail is failed');
  expect(candidate.checkPlan!.nodes[2]!.status).toBe('skipped');
  await expect(git.publishCandidate({ ...f.ctx, candidate, review: f.approve(candidate) })).rejects.toThrow('EVIDENCE_NOT_READY');
  expect((await git.readOperation(f.ctx.workspace, 'failed')).review).toBeUndefined();
  const restarted = f.service(commands, { mode: 'dag' });
  expect(await restarted.candidateReadiness({ ...f.ctx, candidate })).toMatchObject({ status: 'failed', cleanupStatus: 'confirmed' });
});

it('supports explicit serial artifact pipelines instead of losing producer outputs in snapshots', async () => {
  const f = await fixture();
  const commands = [node('build', 'const fs=require("fs");fs.mkdirSync("dist");fs.writeFileSync("dist/result","candidate artifact");'), node('test-build', 'require("assert").equal(require("fs").readFileSync("dist/result","utf8"),"candidate artifact");', { dependsOn: ['build'] })];
  const isolated = await f.prepare(f.service(commands, { mode: 'dag' }), 'no-implicit-artifacts');
  expect(isolated.readiness!.status).toBe('failed');
  expect(isolated.checks![1]!.stderr).toContain('ENOENT');
  const candidate = await f.prepare(f.service(commands, { mode: 'serial' }), 'artifacts');
  expect(candidate.readiness!.status).toBe('ready');
  expect(candidate.checkPlan).toMatchObject({ maxConcurrency: 1, nodes: [{ isolation: 'serial' }, { isolation: 'serial' }] });
});

for (const required of [true, false]) it(`keeps timeout cleanup and its resource/mutex lease across restart (required=${required})`, async () => {
  const f = await fixture(), commands = [node('timeout', 'setTimeout(()=>{},10000)', { timeoutMs: 600, required, mutexGroup: 'resource' }), node('independent', 'setTimeout(()=>console.log("collected"),900)'), node('later', '', { dependsOn: ['timeout'], mutexGroup: 'resource' })];
  const plan: CheckPlan = { mode: 'dag' }, git = f.service(commands, plan), candidate = await f.prepare(git, `timeout-${required}`);
  expect(candidate.readiness).toMatchObject({ status: 'environment_unavailable', cleanupStatus: 'unknown' });
  expect(candidate.checks!.map(check => check.host!.exitStatus)).toEqual(['timed_out', 'passed', 'skipped']);
  expect(candidate.checks![1]!.stdout).toContain('collected');
  const restarted = f.service(commands, plan);
  await expect(restarted.resumeCandidate({ ...f.ctx, integrationId: candidate.integrationId, candidateHead: candidate.candidateHead, idempotencyKey: 'cannot-repeat' })).rejects.toThrow('CLEANUP_UNKNOWN');
  await expect(restarted.publishCandidate({ ...f.ctx, candidate, review: f.approve(candidate) })).rejects.toThrow('CLEANUP_UNKNOWN');
  expect(await readdir(path.join(f.managedRoot, 'check-plan-lease'))).toHaveLength(1);
  await expect(restarted.reconcileCandidateCleanup({ ...f.ctx, candidate, previousBootId: beforeBoot, currentBootId: beforeBoot })).rejects.toThrow('CLEANUP_UNKNOWN');
  await restarted.reconcileCandidateCleanup({ ...f.ctx, candidate, previousBootId: beforeBoot, currentBootId: afterBoot });
  await expect(readdir(path.join(f.managedRoot, 'check-plan-lease'))).rejects.toMatchObject({ code: 'ENOENT' });
  // Timeout is not converted to a pass by cleanup recovery, including optional checks.
  expect((await restarted.candidateReadiness({ ...f.ctx, candidate })).status).not.toBe('ready');
});

it('cancels active real processes, skips unstarted nodes and retains the lease until cleanup proof', async () => {
  const f = await fixture(), commands = [node('a', 'setTimeout(()=>{},10000)'), node('b', 'setTimeout(()=>{},10000)'), node('c', '', { dependsOn: ['a'] })];
  const git = f.service(commands, { mode: 'dag' }), controller = new AbortController();
  const pending = f.prepare(git, 'cancel', { ...f.ctx, signal: controller.signal });
  for (let i = 0; i < 300; i++) {
    const saved = await readFile(f.operationFile('cancel'), 'utf8').then(JSON.parse).catch(() => null);
    if (saved?.checkPlan?.nodes.filter((node: { status: string }) => node.status === 'running').length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 10));
    if (i === 299) throw new Error('Checks never started');
  }
  await new Promise(resolve => setTimeout(resolve, 200)); controller.abort();
  const candidate = await pending;
  expect(candidate.readiness).toMatchObject({ status: 'environment_unavailable', cleanupStatus: 'unknown' });
  expect(candidate.checks!.map(check => check.host!.exitStatus)).toEqual(['cancelled', 'cancelled', 'skipped']);
  expect(await readdir(path.join(f.managedRoot, 'check-plan-lease'))).toHaveLength(1);
});

it('does not turn in-flight or pending checks into passes after actual Host process restart', async () => {
  const f = await fixture(), commands = [node('fast'), node('inflight', 'setTimeout(()=>{},2500)'), node('pending', '', { dependsOn: ['inflight'] })];
  const options = { managedRoot: f.managedRoot, commands, checkPlan: { mode: 'dag' } };
  const script = `
    import {readFile} from 'node:fs/promises';
    import {LocalGitService} from ${JSON.stringify(pathToFileURL(path.resolve('src/git/integration.ts')).href)};
    const git=new LocalGitService(${JSON.stringify(options)});
    setInterval(async()=>{try {const op=JSON.parse(await readFile(${JSON.stringify(f.operationFile('crash'))},'utf8'));if(op.checks?.some(c=>c.commandId==='fast')&&op.checkPlan.nodes.some(n=>n.status==='running'))process.exit(73);}catch{}},20);
    await git.prepareCandidate(${JSON.stringify({ ...f.ctx, sourceHead: f.source, integrationId: 'crash' })});process.exit(74);
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(73);
  const git = f.service(commands, { mode: 'dag' }), operation = await git.readOperation(f.ctx.workspace, 'crash');
  expect(operation.checkPlan!.nodes.map(node => node.status)).toEqual(['passed', 'running', 'pending']);
  const candidate: Candidate = { integrationId: 'crash', taskAttempt: 1, candidateHead: operation.candidateHead!, expectedTargetHead: operation.expectedTargetHead, sourceHead: operation.sourceHead, cwd: operation.reviewPath, checkIds: operation.checks!.map(check => check.id) };
  expect(await git.candidateReadiness({ ...f.ctx, candidate })).toMatchObject({ status: 'environment_unavailable', missingCheckIds: ['inflight', 'pending'] });
  await expect(git.resumeCandidate({ ...f.ctx, integrationId: 'crash', candidateHead: candidate.candidateHead, idempotencyKey: 'restart' })).rejects.toThrow('CLEANUP_UNKNOWN');
  await expect(git.publishCandidate({ ...f.ctx, candidate, review: f.approve(candidate) })).rejects.toThrow('CLEANUP_UNKNOWN');
});

it('reuses only same-candidate passes on supplementation and invalidates graph/resource/isolation configuration', async () => {
  const f = await fixture(), commands = [node('a'), node('b', 'process.exit(127)', { dependsOn: ['a'] })], plan: CheckPlan = { mode: 'dag' };
  const candidate = await f.prepare(f.service(commands, plan), 'supplement');
  expect(candidate.readiness!.status).toBe('environment_unavailable');
  const unchanged = f.service(commands, plan);
  await expect(unchanged.resumeCandidate({ ...f.ctx, integrationId: candidate.integrationId, candidateHead: candidate.candidateHead, idempotencyKey: 'retry' })).rejects.toBeInstanceOf(CandidateEvidenceError);
  expect((await unchanged.readOperation(f.ctx.workspace, 'supplement')).checks![0]!.id).toBe(candidate.checks![0]!.id);
  const fixed = [commands[0]!, node('b', 'console.log("fixed")', { dependsOn: ['a'] })];
  const ready = await f.service(fixed, plan).resumeCandidate({ ...f.ctx, integrationId: candidate.integrationId, candidateHead: candidate.candidateHead, idempotencyKey: 'fixed' });
  expect(ready.candidateHead).toBe(candidate.candidateHead); expect(ready.taskAttempt).toBe(1); expect(ready.readiness!.status).toBe('ready');
  expect(ready.checks![0]!.id).not.toBe(candidate.checks![0]!.id);
  for (const changed of [
    f.service(fixed, { mode: 'dag', maxConcurrency: 1 }), f.service(fixed, { mode: 'dag', resourceSlots: 3 }),
    f.service([fixed[0]!, { ...fixed[1]!, mutexGroup: 'changed' }], plan), f.service([fixed[0]!, { ...fixed[1]!, isolation: 'read_only' }], plan),
    f.service([fixed[0]!, { ...fixed[1]!, dependsOn: [] }], plan),
  ]) expect((await changed.candidateReadiness({ ...f.ctx, candidate: ready })).status).toBe('waiting_evidence');
});

it('includes graph, isolation, mutex and resource policy in historical baseline identities', async () => {
  const f = await fixture(), command = node('unit', 'console.log("self-contained baseline")', { baseline: { environmentId: 'node24-immutable-test-v1' } });
  const first = await f.prepare(f.service([command], { mode: 'dag' }), 'policy-first');
  const reused = await f.prepare(f.service([command], { mode: 'dag' }), 'policy-reused');
  expect(reused.baselines![0]).toMatchObject({ status: 'reused', key: first.baselines![0]!.key });
  const variants: [CheckCommand, CheckPlan][] = [
    [command, { mode: 'dag', maxConcurrency: 1 }], [command, { mode: 'dag', resourceSlots: 3 }],
    [{ ...command, isolation: 'read_only' }, { mode: 'dag' }], [{ ...command, mutexGroup: 'database' }, { mode: 'dag' }],
  ];
  for (const [i, [command, plan]] of variants.entries()) {
    const changed = await f.prepare(f.service([command], plan), `policy-variant-${i}`);
    expect(changed.baselines![0]!.key).not.toBe(first.baselines![0]!.key);
    expect(changed.baselines![0]!.status).toBe('recorded');
  }
});


it('marks the whole failed transitive downstream skipped even when configuration order is reversed', async () => {
  const f = await fixture();
  const commands = [node('leaf', '', { dependsOn: ['middle'] }), node('middle', '', { dependsOn: ['root'] }), node('root', 'process.exit(1)')];
  const candidate = await f.prepare(f.service(commands, { mode: 'dag' }), 'reverse-skips');
  expect(candidate.checks!.map(check => check.host!.exitStatus)).toEqual(['skipped', 'skipped', 'failed']);
  expect(candidate.checks![0]!.host!.summary).toContain('Dependency middle is skipped');
  expect(candidate.checks![0]!.durationMs).toBe(0);
});

it('does not bypass retained resource ownership by starting a new candidate historical baseline', async () => {
  const f = await fixture(), plan: CheckPlan = { mode: 'dag' };
  const timeout = await f.prepare(f.service([node('timeout', 'setTimeout(()=>{},10000)', { timeoutMs: 300 })], plan), 'lease-holder');
  expect(timeout.readiness!.cleanupStatus).toBe('unknown');
  const next = await f.prepare(f.service([node('baseline', 'throw Error("must not start")', { baseline: { environmentId: 'immutable-test' } })], plan), 'blocked-next');
  expect(next.readiness!.cleanupStatus).toBe('unknown');
  expect(next.checks).toEqual([]); expect(next.baselines).toBeUndefined();
  expect(await readdir(path.join(f.managedRoot, 'check-plan-lease'))).toHaveLength(1);
});

for (const holderPlan of [undefined, { mode: 'serial' }, { mode: 'dag' }] as const) for (const required of [true, false]) it(`blocks every check mode and baseline behind ${holderPlan?.mode ?? 'legacy'} timeout leases (required=${required})`, async () => {
  const f = await fixture();
  const commands = [node('required'), node('timeout', 'setTimeout(()=>{},10000)', { timeoutMs: 300, required })];
  const holder = await f.prepare(f.service(commands, holderPlan), 'mode-holder');
  expect(holder.readiness!.cleanupStatus).toBe('unknown');
  const leaseDirectory = path.join(f.managedRoot, 'check-plan-lease');
  const [owner] = await readdir(leaseDirectory), saved = await readFile(path.join(leaseDirectory, owner!), 'utf8');
  for (const [i, nextPlan] of [undefined, { mode: 'serial' }, { mode: 'dag' }].entries()) {
    const next = await f.prepare(f.service([node('probe', 'throw Error("must not execute")', { baseline: { environmentId: 'lease-probe' } })], nextPlan as CheckPlan | undefined), `blocked-mode-${i}`);
    expect(next.readiness!.cleanupStatus).toBe('unknown');
    expect(next.checks).toEqual([]); expect(next.baselines).toBeUndefined();
  }
  expect(await readFile(path.join(leaseDirectory, owner!), 'utf8')).toBe(saved);
  const restarted = f.service(commands); // Removing checkPlan cannot bypass cleanup, including recovery.
  await expect(restarted.resumeCandidate({ ...f.ctx, integrationId: holder.integrationId, candidateHead: holder.candidateHead, idempotencyKey: 'unknown' })).rejects.toThrow('CLEANUP_UNKNOWN');
  await expect(restarted.publishCandidate({ ...f.ctx, candidate: holder, review: f.approve(holder) })).rejects.toThrow('CLEANUP_UNKNOWN');
  await expect(restarted.reconcileCandidateCleanup({ ...f.ctx, candidate: holder, previousBootId: beforeBoot, currentBootId: beforeBoot })).rejects.toThrow('CLEANUP_UNKNOWN');
  expect(await readFile(path.join(leaseDirectory, owner!), 'utf8')).toBe(saved);
  await restarted.reconcileCandidateCleanup({ ...f.ctx, candidate: holder, previousBootId: beforeBoot, currentBootId: afterBoot });
  expect((await restarted.candidateReadiness({ ...f.ctx, candidate: holder })).status).not.toBe('ready');
  const recovered = await f.prepare(f.service([node('probe', 'console.log("actually executed")', { baseline: { environmentId: 'lease-probe' } })]), 'after-cleanup');
  expect(recovered.readiness!.status).toBe('ready');
  expect(recovered.baselines![0]!.status).toBe('recorded');
  expect(recovered.checks![0]!.stdout).toContain('actually executed');
});

for (const damage of ['no-owner', 'corrupt-owner', 'wrong-binding'] as const) it(`never executes, supplements, publishes or deletes a ${damage} lease`, async () => {
  const f = await fixture(), commands = [node('probe')];
  const ready = await f.prepare(f.service(commands), 'ready-before-damage');
  const directory = path.join(f.managedRoot, 'check-plan-lease'); await mkdir(directory);
  const owner = path.join(directory, `${key(JSON.stringify([f.ctx.workspace.id, ready.integrationId]))}.json`);
  if (damage !== 'no-owner') await writeFile(owner, damage === 'corrupt-owner' ? '{broken' : JSON.stringify({ candidateHead: 'wrong' }));
  const restarted = f.service(commands);
  expect(await restarted.candidateReadiness({ ...f.ctx, candidate: ready })).toMatchObject({ status: 'environment_unavailable', cleanupStatus: 'unknown' });
  await expect(restarted.resumeCandidate({ ...f.ctx, integrationId: ready.integrationId, candidateHead: ready.candidateHead, idempotencyKey: 'must-not-run' })).rejects.toThrow('CHECK_PLAN_LEASE_HELD');
  await expect(restarted.publishCandidate({ ...f.ctx, candidate: ready, review: f.approve(ready) })).rejects.toThrow('CHECK_PLAN_LEASE_HELD');
  await expect(restarted.reconcileCandidateCleanup({ ...f.ctx, candidate: ready, previousBootId: beforeBoot, currentBootId: afterBoot })).rejects.toThrow('CHECK_PLAN_LEASE_HELD');
  for (const [i, plan] of [undefined, { mode: 'serial' }, { mode: 'dag' }].entries()) {
    const blocked = await f.prepare(f.service([node('probe', 'throw Error("must not execute")', { baseline: { environmentId: 'damaged-lease' } })], plan as CheckPlan | undefined), `damaged-${i}`);
    expect(blocked.checks).toEqual([]); expect(blocked.baselines).toBeUndefined();
  }
  expect(await readdir(directory)).toEqual(damage === 'no-owner' ? [] : [path.basename(owner)]);
  if (damage !== 'no-owner') expect(await readFile(owner, 'utf8')).toBe(damage === 'corrupt-owner' ? '{broken' : JSON.stringify({ candidateHead: 'wrong' }));
  expect((await restarted.readOperation(f.ctx.workspace, ready.integrationId)).checks![0]!.id).toBe(ready.checks![0]!.id);
});

for (const oldEnvironment of ['same-process', 'retained', 'missing', 'corrupt'] as const) it(`rebuilds serial HOME prerequisites with fresh evidence after persistent restart (${oldEnvironment})`, async () => {
  const f = await fixture();
  const commands = [
    node('setup', `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.env.HOME,'tool'),'#!/bin/sh\\necho installed\\n',{mode:0o700});console.log('installed this generation');`),
    node('use-tool', `const fs=require('fs'),p=require('path');fs.mkdirSync('dist',{recursive:true});if(!fs.existsSync('dist/retry')){fs.writeFileSync('dist/retry','retry');process.exit(127);}const result=require('child_process').spawnSync(p.join(process.env.HOME,'tool'),[],{encoding:'utf8'});console.log(result.stdout);process.exit(result.status??127);`, { dependsOn: ['setup'] }),
  ];
  const original = f.service(commands, { mode: 'serial' });
  const first = await f.prepare(original, 'serial-home');
  expect(first.checks!.map(check => check.host!.exitStatus)).toEqual(['passed', 'environment_unavailable']);
  const homes = path.join(f.managedRoot, key(f.ctx.workspace.id), 'check-homes');
  const [firstHome] = await readdir(homes);
  if (oldEnvironment === 'missing') await rm(path.join(homes, firstHome!), { recursive: true });
  if (oldEnvironment === 'corrupt') await writeFile(path.join(homes, firstHome!, 'tool'), 'corrupt');
  // A separate Host process consumes the persisted operation and executes real sandboxes.
  const script = `import {LocalGitService} from ${JSON.stringify(pathToFileURL(path.resolve('src/git/integration.ts')).href)};const git=new LocalGitService(${JSON.stringify({ managedRoot: f.managedRoot, commands, checkPlan: { mode: 'serial' } })});await git.resumeCandidate(${JSON.stringify({ ...f.ctx, integrationId: first.integrationId, candidateHead: first.candidateHead, idempotencyKey: 'restart-home' })});`;
  if (oldEnvironment === 'same-process') await original.resumeCandidate({ ...f.ctx, integrationId: first.integrationId, candidateHead: first.candidateHead, idempotencyKey: 'same-process-home' });
  else {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
  }
  const restarted = f.service(commands, { mode: 'serial' }), operation = await restarted.readOperation(f.ctx.workspace, first.integrationId);
  expect(operation.checks!.map(check => check.host!.exitStatus)).toEqual(['passed', 'passed']);
  expect(operation.checks![0]!.id).not.toBe(first.checks![0]!.id);
  expect(operation.checks![0]!.stdout).toContain('installed this generation'); expect(operation.checks![1]!.stdout).toContain('installed');
  expect(operation.binding!.attempt).toBe(1); expect(operation.candidateHead).toBe(first.candidateHead); expect(operation.review).toBeUndefined();
  expect((await restarted.readCheckEvidence({ ...f.ctx, integrationId: first.integrationId, checkId: first.checks![0]!.id })).id).toBe(first.checks![0]!.id);
  // An approval carrying the old generation cannot publish this new evidence.
  await expect(restarted.publishCandidate({ ...f.ctx, candidate: first, review: f.approve(first) })).rejects.toThrow('CANDIDATE_EVIDENCE_MISMATCH');
});

it('does not share serial HOME products across tasks or candidate integrations', async () => {
  const f = await fixture();
  const commands = [node('setup', `const fs=require('fs'),p=require('path'),assert=require('assert');assert(!fs.existsSync(p.join(process.env.HOME,'tool')));fs.writeFileSync(p.join(process.env.HOME,'tool'),'private');`), node('use', `require('assert').equal(require('fs').readFileSync(require('path').join(process.env.HOME,'tool'),'utf8'),'private');`, { dependsOn: ['setup'] })];
  for (const [i, taskId] of ['task', 'task', 'other-task'].entries()) {
    const candidate = await f.prepare(f.service(commands, { mode: 'serial' }), `private-${i}`, { ...f.ctx, task: { ...f.ctx.task, id: taskId } });
    expect(candidate.readiness!.status).toBe('ready'); expect(candidate.checks![0]!.host!.taskId).toBe(taskId);
  }
});

it('does not release a retained bound lease using a transient confirmed journal as cleanup proof', async () => {
  const f = await fixture(), commands = [node('probe')];
  const ready = await f.prepare(f.service(commands), 'confirmed-before-release');
  const operation = await f.service(commands).readOperation(f.ctx.workspace, ready.integrationId);
  const directory = path.join(f.managedRoot, 'check-plan-lease'); await mkdir(directory);
  const owner = path.join(directory, `${key(JSON.stringify([f.ctx.workspace.id, ready.integrationId]))}.json`);
  await writeFile(owner, JSON.stringify(operation.binding));
  const restarted = f.service(commands);
  await expect(restarted.reconcileCandidateCleanup({ ...f.ctx, candidate: ready, previousBootId: beforeBoot, currentBootId: beforeBoot })).rejects.toThrow('CLEANUP_UNKNOWN');
  expect(JSON.parse(await readFile(owner, 'utf8'))).toEqual(operation.binding);
  await restarted.reconcileCandidateCleanup({ ...f.ctx, candidate: ready, previousBootId: beforeBoot, currentBootId: afterBoot });
  expect(await restarted.candidateReadiness({ ...f.ctx, candidate: ready })).toMatchObject({ status: 'ready', cleanupStatus: 'confirmed' });
});
