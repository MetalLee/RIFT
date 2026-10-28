import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RiftStore } from '../../src/storage/database.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { configureRoles } from '../../src/project/agent-roles.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { LocalGitService } from '../../src/git/integration.js';
import { gitOk } from '../../src/git/process.js';
import type { ActivationBridge, ActivationResult, Candidate, PlanTask, Run } from '../../src/contracts/index.js';

type Started = Parameters<ActivationBridge['start']>[0] & { finish: (result: ActivationResult) => void; disposed: boolean };
class ControlledBridge implements ActivationBridge {
  starts: Started[] = [];
  async start(input: Parameters<ActivationBridge['start']>[0]) {
    let finish!: (result: ActivationResult) => void;
    const result = new Promise<ActivationResult>(resolve => { finish = resolve; });
    const started = { ...input, finish, disposed: false }; this.starts.push(started);
    return { childId: `fake-${input.run.id}`, result, dispose: async () => { started.disposed = true; finish({ stopReason: 'cancelled', text: '' }); } };
  }
}
async function eventually(predicate: () => boolean, label = 'condition'): Promise<void> {
  const until = Date.now() + 25_000;
  while (!predicate()) { if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(check = 'process.exit(0)') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rift-core-git-'));
  const repo = path.join(root, '协作 仓库'); await mkdir(repo);
  await gitOk(repo, ['init', '-b', 'main']); await gitOk(repo, ['config', 'core.autocrlf', 'false']);
  await gitOk(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'base']);
  await writeFile(path.join(repo, 'base.txt'), 'base\n'); await gitOk(repo, ['add', '.']);
  await gitOk(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'base file']);
  const baseCommit = await gitOk(repo, ['rev-parse', 'HEAD']);
  const store = new RiftStore(path.join(root, 'rift.db'));
  const workspace = createWorkspace(store, { id: 'workspace', name: 'test', rootPath: repo, repositoryPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main' });
  configureRoles(store, workspace.id, [
    { id: 'dev', providerName: 'fake-dev', packageVersion: 'test', configRevision: 1, capabilities: {}, credentialRefs: [] },
    { id: 'review', providerName: 'fake-review', packageVersion: 'test', configRevision: 1, capabilities: {}, credentialRefs: [] },
  ], [
    { name: 'lead', kind: 'dsh-lead', prompt: 'Lead', revision: 1 },
    { name: 'developer-a', kind: 'subagent', providerBindingId: 'dev', prompt: 'Develop', revision: 1 },
    { name: 'developer-b', kind: 'subagent', providerBindingId: 'dev', prompt: 'Develop', revision: 1 },
    { name: 'reviewer', kind: 'subagent', providerBindingId: 'review', prompt: 'Review', revision: 1 },
  ], new Set(['fake-dev', 'fake-review']));
  const bridge = new ControlledBridge();
  const git = new LocalGitService({ managedRoot: path.join(root, '受管 目录'), commands: [{ id: 'unit', executable: process.execPath, args: ['-e', check] }] });
  const coordinator = new TaskCoordinator({ store, bridge, git });
  const workflow = coordinator.createWorkflow({ id: 'workflow', workspaceId: workspace.id, goal: 'Integration proof', integrationRef: 'refs/heads/rift/integration/core', baseCommit });
  cleanups.push(async () => { await coordinator.shutdown(); store.close(); if (!path.basename(root).startsWith('rift-core-git-') || path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  const plan = (tasks: { id: string; expectedPaths: string[] }[]) => coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: tasks.map(task => ({ ...task, kind: 'change', title: task.id, instructions: `Implement ${task.id}` } satisfies PlanTask)) });
  const dispatch = (taskId: string, suffix = '') => coordinator.dispatch({ taskId, expectedVersion: store.task(taskId).version, idempotencyKey: `dispatch-${taskId}${suffix}` });
  const started = async (taskId: string, purpose: Run['purpose'], attempt = 1): Promise<Started> => { await eventually(() => bridge.starts.some(s => s.task.id === taskId && s.run.purpose === purpose && s.run.taskAttempt === attempt), `${taskId} ${purpose}`); return bridge.starts.find(s => s.task.id === taskId && s.run.purpose === purpose && s.run.taskAttempt === attempt)!; };
  const develop = async (execution: Started, files: Record<string, string>) => { for (const [file, content] of Object.entries(files)) await writeFile(path.join(execution.cwd, file), content); execution.finish({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: execution.task.id, runId: execution.run.id, outcome: 'completed', summary: 'Implemented', changedPaths: Object.keys(files), checksClaimed: [], blockingReasons: [] }) }); };
  const review = (execution: Started, verdict = 'approve') => { const payload = JSON.parse(execution.prompt) as { candidate: Candidate }; execution.finish({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: execution.task.id, runId: execution.run.id, verdict, reviewedCommit: payload.candidate.candidateHead, findings: verdict === 'approve' ? [] : [{ severity: 'medium', file: 'a.txt', line: 1, reason: 'Needs refinement', suggestion: 'Refine content' }] }) }); return payload.candidate; };
  const settled = (id: string, status: string) => eventually(() => store.task(id).status === status, `${id} ${status}; current=${store.task(id).status}`);
  return { root, repo, baseCommit, store, workspace, bridge, git, coordinator, workflow, plan, dispatch, started, develop, review, settled };
}

describe('real Git with persistent coordinator and controlled fake activations', () => {
  it('classifies real required failures as defects and permits a fresh development repair',async()=>{
    const f=await fixture('process.exit(require("node:fs").readFileSync("a.txt","utf8")==="fixed"?0:1)');
    f.plan([{id:'a',expectedPaths:['a.txt']}]);f.dispatch('a');
    await f.develop(await f.started('a','develop'),{'a.txt':'broken'});await f.settled('a','blocked');
    const failed=f.store.require<{status:string;candidate:Candidate}>('SELECT * FROM integrations WHERE task_id=?','a');
    expect(failed).toMatchObject({status:'blocked',candidate:{taskAttempt:1,readiness:{status:'failed',blockers:[{classification:'code_defect'}]}}});
    expect(f.bridge.starts.filter(run=>run.run.purpose==='review')).toHaveLength(0);
    f.coordinator.retry({taskId:'a',expectedVersion:f.store.task('a').version,reason:'Fix actual failed check'});f.dispatch('a','-fix');
    await f.develop(await f.started('a','repair',2),{'a.txt':'fixed'});
    f.review(await f.started('a','review',2));await f.settled('a','succeeded');
    expect(f.store.task('a').attempt).toBe(2);
  });
  it.each([true,false])('retains cleanup ownership across cancellation and restart (required=%s)',async required=>{
    const f=await fixture('setInterval(()=>{},1000)');
    const command=(f.git as unknown as {commands:Map<string,{timeoutMs?:number;required?:boolean}>}).commands.get('unit')!;command.timeoutMs=100;
    // Keep a successful required check when the timeout itself is optional.
    if(!required){command.required=false;const internals=f.git as unknown as {commands:Map<string,unknown>;checkIds:string[]};internals.commands.set('required',{id:'required',executable:process.execPath,args:['-e','process.exit(0)']});internals.checkIds.unshift('required');}
    const before=`v1:${'a'.repeat(64)}:${'1'.repeat(64)}`,after=`v1:${'a'.repeat(64)}:${'2'.repeat(64)}`;
    f.coordinator.setBootIdentity(before);f.plan([{id:'a',expectedPaths:['a.txt']}]);f.dispatch('a');
    await f.develop(await f.started('a','develop'),{'a.txt':'complete'});await f.settled('a','blocked');
    const record=()=>f.store.require<{id:string;version:number;status:string;candidate:Candidate}>('SELECT * FROM integrations WHERE task_id=?','a');
    expect(record().status).toBe('cleanup_unknown');expect(f.bridge.starts.filter(run=>run.run.purpose==='review')).toHaveLength(0);
    expect(()=>f.coordinator.retry({taskId:'a',expectedVersion:f.store.task('a').version,reason:'not proof'})).toThrow();
    await expect(f.coordinator.supplementEvidence({taskId:'a',integrationId:record().id,candidateHead:record().candidate.candidateHead,expectedVersion:f.store.task('a').version,idempotencyKey:'not-proof'})).rejects.toThrow();
    await f.coordinator.cancelTask('a');await f.coordinator.shutdown();
    const restarted=new TaskCoordinator({store:f.store,bridge:f.bridge,git:f.git});
    cleanups.unshift(()=>restarted.shutdown());restarted.setBootIdentity(before);await restarted.recover();
    await expect(restarted.reconcileIntegration(record().id,record().version)).rejects.toMatchObject({code:'CLEANUP_UNKNOWN'});
    restarted.setBootIdentity(after);await restarted.reconcileIntegration(record().id,record().version);
    expect(record().status).toBe('evidence_waiting');expect(f.store.task('a').status).toBe('cancelled');
    const retried=restarted.retry({taskId:'a',expectedVersion:f.store.task('a').version,reason:'cleanup proven'});expect(retried.attempt).toBe(2);
  });
  it('resumes the same timed-out candidate only after Host reboot proof and explicit supplementation',async()=>{
    const f=await fixture('setInterval(()=>{},1000)');
    const command=(f.git as unknown as {commands:Map<string,{args:string[];timeoutMs?:number}>}).commands.get('unit')!;command.timeoutMs=100;
    const before=`v1:${'a'.repeat(64)}:${'1'.repeat(64)}`,after=`v1:${'a'.repeat(64)}:${'2'.repeat(64)}`;
    f.coordinator.setBootIdentity(before);f.plan([{id:'a',expectedPaths:['a.txt']}]);f.dispatch('a');
    await f.develop(await f.started('a','develop'),{'a.txt':'complete'});await f.settled('a','blocked');f.coordinator.pause(f.workflow.id);
    const saved=f.store.require<{id:string;version:number;candidate:Candidate}>('SELECT * FROM integrations WHERE task_id=?','a');
    f.coordinator.setBootIdentity(after);await f.coordinator.reconcileIntegration(saved.id,saved.version);
    command.args=['-e','process.exit(0)'];command.timeoutMs=5000;
    await f.coordinator.supplementEvidence({taskId:'a',integrationId:saved.id,candidateHead:saved.candidate.candidateHead,expectedVersion:f.store.task('a').version,idempotencyKey:'after-cleanup-proof'});
    expect(f.bridge.starts).toHaveLength(1);f.coordinator.resume(f.workflow.id);
    const reviewed=f.review(await f.started('a','review'));expect(reviewed.candidateHead).toBe(saved.candidate.candidateHead);
    await f.settled('a','succeeded');expect(f.store.task('a').attempt).toBe(1);
  });
  it('waits for Host evidence without review or development and resumes the exact candidate after supplementation',async()=>{
    const f=await fixture('process.exit(127)');f.plan([{id:'a',expectedPaths:['a.txt']}]);f.dispatch('a');
    await f.develop(await f.started('a','develop'),{'a.txt':'complete'});await f.settled('a','blocked');
    expect(f.bridge.starts.filter(run=>run.run.purpose==='review')).toHaveLength(0);
    const original=f.store.require<{id:string;candidate:Candidate;status:string}>('SELECT * FROM integrations WHERE task_id=?','a');
    expect(()=>f.coordinator.retry({taskId:'a',expectedVersion:f.store.task('a').version,reason:'not a code fix'})).toThrow('supplement-evidence');
    expect(original.status).toBe('evidence_waiting');expect(original.candidate.readiness?.status).toBe('environment_unavailable');
    expect(()=>f.coordinator.finish({workflowId:f.workflow.id,summary:'not ready'})).toThrow('Every task must pass');
    const before=f.store.task('a');f.coordinator.pause(f.workflow.id);
    (f.git as unknown as {commands:Map<string,{args:string[]}>}).commands.get('unit')!.args=['-e','console.log("Host evidence restored")'];
    const input={taskId:'a',integrationId:original.id,candidateHead:original.candidate.candidateHead,expectedVersion:before.version,idempotencyKey:'supplement'};
    const result=await f.coordinator.supplementEvidence(input);
    expect(result.task).toMatchObject({attempt:1,status:'validating',sourceHead:before.sourceHead,acceptedCommit:null});
    expect((await f.coordinator.supplementEvidence(input)).request.id).toBe(result.request.id);
    expect(f.store.all('SELECT * FROM integrations')).toHaveLength(1);expect(f.bridge.starts).toHaveLength(1);
    f.coordinator.resume(f.workflow.id);
    const reviewer=await f.started('a','review');const checked=f.review(reviewer);
    expect(checked.candidateHead).toBe(original.candidate.candidateHead);expect(checked.integrationId).toBe(original.id);expect(checked.checks![0]!.stdout).toContain('Host evidence restored');
    await f.settled('a','succeeded');expect(f.store.task('a').acceptedCommit).toBe(original.candidate.candidateHead);expect(f.bridge.starts.filter(run=>run.run.purpose!=='review')).toHaveLength(1);
  });
  it('reuses a proven collected source after an infrastructure failure without inventing an empty commit or skipping review',async()=>{
    const f=await fixture('process.exit(require("node:fs").existsSync("a.txt")?1:0)');
    f.plan([{id:'seed',expectedPaths:['seed.txt']},{id:'a',expectedPaths:['a.txt']}]);f.dispatch('seed');
    await f.develop(await f.started('seed','develop'),{'seed.txt':'previous accepted task'});f.review(await f.started('seed','review'));await f.settled('seed','succeeded');
    f.dispatch('a');const first=await f.started('a','develop');await f.develop(first,{'a.txt':'complete implementation'});await f.settled('a','blocked');
    const source=f.store.task('a').sourceHead!;expect(f.store.task('a').blockingReason).toContain('CHECK_FAILED');
    // Operator repairs the check configuration, not an out-of-sandbox marker file.
    (f.git as unknown as {commands:Map<string,{args:string[]}>}).commands.get('unit')!.args=['-e','process.exit(0)'];
    f.coordinator.retry({taskId:'a',reason:'Host check infrastructure recovered; implementation unchanged',expectedVersion:f.store.task('a').version});f.dispatch('a','-no-op');
    const repair=await f.started('a','repair',2);expect(await gitOk(repair.cwd,['rev-parse','HEAD'])).toBe(source);
    await f.develop(repair,{});const review=await f.started('a','review',2);
    expect(f.store.task('a').sourceHead).toBe(source);expect(f.store.task('a').acceptedCommit).toBeNull();expect(await gitOk(repair.cwd,['rev-parse','HEAD'])).toBe(source);
    const candidate=f.review(review);expect(candidate.checks?.every(check=>check.exitCode===0&&check.candidateHead===candidate.candidateHead)).toBe(true);await f.settled('a','succeeded');
    expect(await gitOk(f.repo,['show',`${f.workflow.integrationRef}:seed.txt`])).toBe('previous accepted task');
    expect(await gitOk(f.repo,['show',`${f.workflow.integrationRef}:a.txt`])).toBe('complete implementation');
  });
  it('collects required helper files beyond legacy path metadata and still requires exact independent review',async()=>{
    const f=await fixture();f.plan([{id:'wide',expectedPaths:['**/*']},{id:'narrow',expectedPaths:['src/**/*.ts']}]);f.dispatch('wide');
    const wide=await f.started('wide','develop');
    expect(JSON.parse(wide.prompt).developmentProtocol.instructions).toContain('Local git add/commit is permitted');
    expect(JSON.parse(wide.prompt).developmentProtocol.instructions).toContain('only when explicitly requested by the user');
    expect(JSON.parse(wide.prompt).developmentProtocol.instructions).toContain('not that the Task is accepted');
    await f.develop(wide,{'root.txt':'Root file'});const review=await f.started('wide','review');f.review(review);await f.settled('wide','succeeded');
    f.dispatch('narrow');const narrow=await f.started('narrow','develop');await f.develop(narrow,{'outside.txt':'Required helper'});const narrowReview=await f.started('narrow','review');
    expect(f.store.task('narrow').acceptedCommit).toBeNull();expect(JSON.parse(narrowReview.prompt).reviewProtocol.instructions).toContain('not an allowlist');
    f.review(narrowReview);await f.settled('narrow','succeeded');expect(await gitOk(f.repo,['show',`${f.store.task('narrow').acceptedCommit}:outside.txt`])).toBe('Required helper');
  });
  it('starts both developers, accepts the second result first and retains both through serial reviews', async () => {
    const f = await fixture(); f.plan([{ id: 'a', expectedPaths: ['a.txt'] }, { id: 'b', expectedPaths: ['b.txt'] }]);
    f.dispatch('a'); f.dispatch('b');
    const [a, b] = await Promise.all([f.started('a', 'develop'), f.started('b', 'develop')]);
    expect(a.cwd).not.toBe(b.cwd); expect(f.coordinator.status(f.workflow.id).slots.developers).toBe(2);
    await f.develop(b, { 'b.txt': 'B' }); const rb = await f.started('b', 'review');
    const reviewInput=JSON.parse(rb.prompt) as {candidate:Candidate;reviewProtocol:{stage:string;instructions:string}};
    expect(reviewInput.reviewProtocol.stage).toBe('pre-publication-independent-review');
    expect(reviewInput.reviewProtocol.instructions).toContain('cannot be preconditions');
    expect(reviewInput.candidate.checks?.map(check=>check.id)).toEqual(reviewInput.candidate.checkIds);
    expect(reviewInput.candidate.checks).toHaveLength(1);
    expect(reviewInput.candidate.checks![0]).toMatchObject({commandId:'unit',candidateHead:reviewInput.candidate.candidateHead,exitCode:0,startedAt:expect.any(String),finishedAt:expect.any(String)});
    const operationEvidence=await f.git.readOperation(f.workspace,reviewInput.candidate.integrationId);
    expect(reviewInput.candidate.checks).toEqual(operationEvidence.checks);
    expect(f.coordinator.status(f.workflow.id).slots).toEqual({ developers: 1, reviewers: 1, total: 2 });
    const cb = f.review(rb); await f.settled('b', 'succeeded');
    await f.develop(a, { 'a.txt': 'A' }); const ra = await f.started('a', 'review'); const ca = f.review(ra); await f.settled('a', 'succeeded');
    expect(ca.expectedTargetHead).toBe(cb.candidateHead);
    expect(await gitOk(f.repo, ['show', `${f.workflow.integrationRef}:a.txt`])).toBe('A');
    expect(await gitOk(f.repo, ['show', `${f.workflow.integrationRef}:b.txt`])).toBe('B');
    expect(await gitOk(f.repo, ['rev-parse', 'main'])).toBe(f.baseCommit);
    expect(f.coordinator.finish({ workflowId: f.workflow.id, summary: 'Both accepted' }).status).toBe('completed');
  });
  it('releases a rejected candidate and repairs in a fresh attempt with prior evidence', async () => {
    const f = await fixture(); f.plan([{ id: 'a', expectedPaths: ['a.txt'] }]); f.dispatch('a');
    const first = await f.started('a', 'develop'); await f.develop(first, { 'a.txt': 'first' });
    f.review(await f.started('a', 'review'), 'changes_requested'); await f.settled('a', 'blocked');
    const originalSource = f.store.task('a').sourceHead;
    f.coordinator.retry({ taskId: 'a', reason: 'Implement feedback', expectedVersion: f.store.task('a').version }); f.dispatch('a', '-repair');
    const repair = await f.started('a', 'repair', 2); expect(repair.cwd).not.toBe(first.cwd); expect(repair.prompt).toContain('Needs refinement');
    expect(await gitOk(repair.cwd, ['rev-parse', 'HEAD'])).toBe(originalSource);
    await f.develop(repair, { 'a.txt': 'refined' }); f.review(await f.started('a', 'review', 2)); await f.settled('a', 'succeeded');
    expect(await readFile(path.join(first.cwd, 'a.txt'), 'utf8')).toBe('first');
    expect(await gitOk(f.repo, ['show', `${f.workflow.integrationRef}:a.txt`])).toBe('refined');
  });
  it('a failed deterministic check does not consume the reviewer or block an independent candidate', async () => {
    const f = await fixture('process.exit(require("node:fs").existsSync("bad.txt") ? 1 : 0)');
    f.plan([{ id: 'bad', expectedPaths: ['bad.txt'] }, { id: 'good', expectedPaths: ['good.txt'] }]); f.dispatch('bad'); f.dispatch('good');
    const [bad, good] = await Promise.all([f.started('bad', 'develop'), f.started('good', 'develop')]);
    await f.develop(bad, { 'bad.txt': 'fail check' }); await f.settled('bad', 'blocked');
    expect(f.bridge.starts.some(s => s.task.id === 'bad' && s.run.purpose === 'review')).toBe(false);
    await f.develop(good, { 'good.txt': 'success' }); f.review(await f.started('good', 'review')); await f.settled('good', 'succeeded');
    expect(await gitOk(f.repo, ['show', `${f.workflow.integrationRef}:good.txt`])).toBe('success');
  });
  it('a conflicting later source preserves accepted changes and lets independent work integrate', async () => {
    const f = await fixture(); f.plan([{ id: 'a', expectedPaths: ['base.txt'] }, { id: 'b', expectedPaths: ['base.txt'] }, { id: 'c', expectedPaths: ['c.txt'] }]);
    f.dispatch('a'); f.dispatch('b'); f.dispatch('c');
    const [a, b] = await Promise.all([f.started('a', 'develop'), f.started('b', 'develop')]);
    await f.develop(a, { 'base.txt': 'A\n' }); const ra = await f.started('a', 'review');
    const c = await f.started('c', 'develop'); expect(await gitOk(b.cwd, ['rev-parse', 'HEAD'])).toBe(f.baseCommit);
    await f.develop(b, { 'base.txt': 'B\n' }); f.review(ra); await f.settled('a', 'succeeded'); await f.settled('b', 'blocked');
    expect(f.store.task('b').blockingReason).toContain('CONFLICT');
    await f.develop(c, { 'c.txt': 'C' }); f.review(await f.started('c', 'review')); await f.settled('c', 'succeeded');
    expect(await gitOk(f.repo, ['show', `${f.workflow.integrationRef}:base.txt`])).toBe('A');
    expect(await gitOk(f.repo, ['show', `${f.workflow.integrationRef}:c.txt`])).toBe('C');
  });
});
