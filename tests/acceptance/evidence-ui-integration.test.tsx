import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatPage, TaskEvidence } from '@rift/protocol';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import type { ActivationBridge, ActivationResult, Candidate } from '../../src/contracts/index.js';
import type { CheckCommand } from '../../src/git/types.js';
import { RiftHostService } from '../../src/api/host-service.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { configureRoles } from '../../src/project/agent-roles.js';
import { gitOk } from '../../src/git/process.js';
import { registerCredentialRedaction } from '../../src/api/security.js';
import { mutate, request } from '../../ui/src/api';
import { readTaskEvidence } from '../../ui/src/task-evidence';
import { EvidenceContent } from '../../ui/src/TaskEvidence';

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Evidence integration did not settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
type Call = Parameters<ActivationBridge['start']>[0] & { finish: (result: ActivationResult) => void };
const passing: CheckCommand[] = [{ id: 'unit', executable: process.execPath, args: ['-e', 'console.log("Host checked")'] }];

async function fixture(checks: CheckCommand[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'rift-evidence-ui-integration-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, '真实 仓库'); await mkdir(repo);
  await gitOk(repo, ['init', '-b', 'main']);
  await gitOk(repo, ['config', 'user.name', 'Test']); await gitOk(repo, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(repo, 'base.txt'), 'base\n'); await gitOk(repo, ['add', '.']); await gitOk(repo, ['commit', '-m', 'base']);
  const base = await gitOk(repo, ['rev-parse', 'HEAD']), home = path.join(root, 'host');
  const calls: Call[] = [];
  // Only model execution is a controlled test adapter. Git, checks, leases, SQLite, HTTP and UI are real.
  vi.spyOn(DshActivationBridge.prototype, 'start').mockImplementation(async input => {
    let finish!: Call['finish'];
    const result = new Promise<ActivationResult>(resolve => { finish = resolve; });
    calls.push({ ...input, finish });
    return { childId: `test-model-${input.run.id}`, result, dispose: async () => { finish({ stopReason: 'cancelled', text: '' }); } };
  });
  const nativeFetch = globalThis.fetch;
  let host!: RiftHostService, api!: Awaited<ReturnType<typeof startLocalApi>>, csrf: string;
  async function start(commands: CheckCommand[]) {
    host = new RiftHostService({ subagents: { list: () => [] } } as unknown as Context, { home, port: 0, leadProvider: 'test-adapter', leadModel: 'test-adapter', checks: commands });
    await host.initialize();
    // No model Lead is needed by the test adapter; retain the real retry route.
    vi.spyOn(host, 'ensureLead').mockResolvedValue({ leadSessionId: 'test-adapter' });
    api = await startLocalApi(host, host.config);
    const origin = `http://127.0.0.1:${api.port}`;
    const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const session = await nativeFetch(`${origin}/ui-api/v1/session/connect`, { method: 'POST', headers, body: '{}' });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    csrf = (await session.json() as { csrfToken: string }).csrfToken;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => nativeFetch(new URL(url, origin), { ...init, headers: { ...headers, Cookie: cookie, ...init?.headers } }));
  }
  await start(checks);
  cleanups.push(async () => { await api.close(); await host.close(); });
  const workspace = createWorkspace(host.store, { id: 'own', name: 'Own', rootPath: repo, repositoryPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main' });
  createWorkspace(host.store, { id: 'foreign', name: 'Foreign', rootPath: repo, repositoryPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main' });
  configureRoles(host.store, workspace.id, [{ id: 'model', providerName: 'test-adapter', packageVersion: 'test', configRevision: 1, capabilities: {}, credentialRefs: [] }], [
    { name: 'lead', kind: 'dsh-lead', prompt: 'Lead', revision: 1 },
    { name: 'developer-a', kind: 'subagent', providerBindingId: 'model', prompt: 'Develop', revision: 1 },
    { name: 'reviewer', purpose: 'reviewer', kind: 'subagent', providerBindingId: 'model', prompt: 'Read only', revision: 1 },
  ], new Set(['test-adapter']));
  const workflow = host.coordinator.createWorkflow({ id: 'workflow', workspaceId: workspace.id, goal: 'Evidence integration', integrationRef: 'refs/heads/rift/evidence-ui', baseCommit: base });
  host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'task', kind: 'change', title: 'Task', instructions: 'Implement task', acceptanceCriteria: ['Actual Host evidence'] }] });
  const cli = async (action: string | [string, string], input: object = {}, key = String(action), workspaceId = 'own') => JSON.parse((await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli/main.ts'), 'ws', ...(typeof action === 'string' ? ['task', action] : action), 'task', '--workspace', workspaceId, '--home', home, '--json', '--data', JSON.stringify(input), '--key', key], { timeout: 25_000 })).stdout);
  const route = '/workspaces/own/tasks/task';
  const post = (suffix: string, body: object, key: string) => mutate(route + suffix, csrf, body, 'POST', key);
  const view = () => readTaskEvidence('own', 'task', new AbortController().signal);
  const raw = () => request<TaskEvidence>(route + '/evidence');
  const reviewCalls = () => calls.filter(call => call.run.purpose === 'review');
  const started = async (purpose: string, attempt = 1) => { await until(() => calls.some(call => call.run.purpose === purpose && call.run.taskAttempt === attempt)); return calls.find(call => call.run.purpose === purpose && call.run.taskAttempt === attempt)!; };
  const develop = async (call: Call, content: string) => {
    await writeFile(path.join(call.cwd, 'task.txt'), content);
    call.finish({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: 'task', runId: call.run.id, outcome: 'completed', summary: 'Test adapter wrote source', changedPaths: ['task.txt'], checksClaimed: [], blockingReasons: [] }) });
  };
  const candidate = (call: Call) => (JSON.parse(call.prompt) as { candidate: Candidate }).candidate;
  const approve = (call: Call, head = candidate(call).candidateHead) => call.finish({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: 'task', runId: call.run.id, verdict: 'approve', reviewedCommit: head, findings: [] }) });
  const settled = (status: string) => until(() => host.store.task('task').status === status);
  const restart = async (commands: CheckCommand[]) => { await api.close(); await host.close(); await start(commands); };
  return { get host() { return host; }, repo, workflow, calls, cli, post, view, raw, reviewCalls, started, develop, candidate, approve, settled, restart };
}

it.each(['http', 'cli'])('connects real %s supplementation after restart to read-only Reviewer evidence and the UI consumer', async transport => {
  const f = await fixture([{ id: 'unit', executable: 'rift-intentionally-missing-check', args: [] }]);
  await f.cli('dispatch', { expectedVersion: 0, idempotencyKey: 'dispatch' });
  await f.develop(await f.started('develop'), 'complete\n'); await f.settled('blocked');
  expect(f.reviewCalls()).toHaveLength(0);
  const before = await f.raw(), current = before.currentCandidate!;
  expect(before.integrations[0]).toMatchObject({ readiness: { status: 'environment_unavailable', requiredCheckIds: ['unit'] } });
  expect((await f.view()).integrations[0]?.readyConfirmed).toBe(false);
  await expect(f.post('/retry', { expectedVersion: f.host.store.task('task').version, reason: 'Not a code failure' }, 'no-repair')).rejects.toMatchObject({ code: 'EVIDENCE_NOT_READY' });
  f.host.coordinator.pause(f.workflow.id);
  const secret = 'integration-private-value-937'; registerCredentialRedaction('RIFT_EVIDENCE_INTEGRATION_SECRET', secret);
  await f.restart([{ ...passing[0]!, args: ['-e', `console.log(${JSON.stringify('Host checked ' + secret + ' <script>not executable</script>')})`] }]);
  expect((await f.raw()).currentCandidate).toEqual(current); expect(f.reviewCalls()).toHaveLength(0);
  const input = { integrationId: current.integrationId, candidateHead: current.candidateHead, expectedVersion: f.host.store.task('task').version, idempotencyKey: 'supplement' };
  await expect(request('/workspaces/foreign/tasks/task/evidence')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(f.cli('evidence', {}, 'foreign', 'foreign')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('NOT_FOUND') });
  await expect(f.post('/evidence', { ...input, stdout: 'forged', exitCode: 0 }, 'forged')).rejects.toThrow();
  await expect(f.post('/evidence', { ...input, candidateHead: 'f'.repeat(40) }, 'wrong-head')).rejects.toMatchObject({ code: 'CANDIDATE_EVIDENCE_MISMATCH' });
  const supplement = () => transport === 'http' ? f.post('/evidence', input, 'supplement') : f.cli('supplement-evidence', input, 'supplement');
  const result = await supplement(); expect(await supplement()).toEqual(result);
  const ready = await f.view();
  expect(ready.currentCandidate).toEqual(current);
  expect(ready.integrations[0]).toMatchObject({ isCurrent: true, readyConfirmed: true, checks: [{ currentHost: true, passed: true }] });
  const html = renderToStaticMarkup(<EvidenceContent state={{ status: 'loaded', evidence: ready }} onRetry={() => {}} />);
  expect(html).toContain('当前 Host 检查通过'); expect(html).toContain('审核前证据就绪：检查就绪');
  expect(html).not.toContain(secret); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
  const logInput = { integrationId: current.integrationId, checkId: ready.integrations[0]!.checks[0]!.id };
  const cliLog = await f.cli('evidence-log', logInput);
  expect(cliLog.stdout).toContain('[REDACTED]'); expect(JSON.stringify(cliLog)).not.toContain(secret);
  expect(f.host.store.all('SELECT id FROM integrations')).toHaveLength(1);
  expect(f.calls).toHaveLength(1); expect(f.host.store.task('task').attempt).toBe(1);
  f.host.coordinator.resume(f.workflow.id);
  const reviewer = await f.started('review'), tool = reviewer.tools!.find(tool => tool.name === 'rift_read_evidence')!;
  const invoke = (input: object) => tool.execute(input, reviewer.signal);
  expect((await invoke({}) as TaskEvidence).currentCandidate).toEqual(current);
  expect(await invoke(logInput)).toEqual(cliLog);
  await expect(invoke({ ...logInput, taskId: 'foreign' })).rejects.toThrow();
  await expect(invoke({ command: 'echo forged' })).rejects.toThrow();
  expect(f.candidate(reviewer).candidateHead).toBe(current.candidateHead);
  f.approve(reviewer); await f.settled('succeeded');
  expect(await gitOk(f.repo, ['rev-parse', f.workflow.integrationRef])).toBe(current.candidateHead);
  expect(f.host.store.task('task')).toMatchObject({ attempt: 1, acceptedCommit: current.candidateHead });
  await expect(invoke({})).rejects.toThrow();
  const accepted = await f.raw(); expect(accepted.integrations[0]?.review?.reviewedCommit).toBe(current.candidateHead);
  await f.restart(f.host.config.checks);
  expect((await f.raw()).acceptedCommit).toBe(current.candidateHead); expect(f.calls).toHaveLength(2);
});

it('repairs a real code failure and invalidates old evidence and stale candidate approval', async () => {
  const f = await fixture([{ id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(require("fs").readFileSync("task.txt","utf8").includes("fixed")?0:1)'] }]);
  await f.cli('dispatch', { expectedVersion: 0, idempotencyKey: 'dispatch' });
  await f.develop(await f.started('develop'), 'broken\n'); await f.settled('blocked');
  const failed = (await f.raw()).currentCandidate!;
  expect((await f.view()).integrations[0]?.readiness?.blockers[0]?.classification).toBe('code_defect');
  expect(f.reviewCalls()).toHaveLength(0);
  await f.post('/retry', { expectedVersion: f.host.store.task('task').version, reason: 'Repair failed check' }, 'repair');
  await f.develop(await f.started('repair', 2), 'fixed\n');
  const reviewer = await f.started('review', 2), current = (await f.raw()).currentCandidate!;
  expect(current.candidateHead).not.toBe(failed.candidateHead);
  const projected = await f.view();
  expect(projected.integrations.find(item => item.id === failed.integrationId)).toMatchObject({ isCurrent: false, readyConfirmed: false });
  // A syntactically valid approval for the old candidate must not publish this candidate.
  f.approve(reviewer, failed.candidateHead); await f.settled('blocked');
  expect(f.host.store.task('task').acceptedCommit).toBeNull();
  expect(await gitOk(f.repo, ['rev-parse', f.workflow.integrationRef])).toBe(f.workflow.baseCommit);
});

it.each(['transport', 'blocked'])('coalesces real CLI integration requests and permits explicit %s review retry', async mode => {
  const f = await fixture(passing);
  await f.cli('dispatch', { expectedVersion: 0, idempotencyKey: 'dispatch' });
  await f.develop(await f.started('develop'), 'complete\n'); const reviewer = await f.started('review');
  const current = (await f.raw()).currentCandidate!;
  const requestInput = { sourceHead: current.sourceHead, expectedVersion: 0, idempotencyKey: 'client-one' };
  const first = await f.cli(['integration', 'request'], requestInput, 'client-one');
  expect((await f.cli(['integration', 'request'], { ...requestInput, idempotencyKey: 'client-two' }, 'client-two')).id).toBe(first.id);
  expect(f.reviewCalls()).toHaveLength(1);
  reviewer.finish(mode === 'transport'
    ? { stopReason: 'error', text: '', diagnostic: 'Test model adapter transport failed' }
    : { stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: 'task', runId: reviewer.run.id, verdict: 'blocked', reviewedCommit: current.candidateHead, findings: [{ severity: 'high', file: 'task.txt', line: 1, reason: 'External verification unavailable', suggestion: 'Retry after environment recovery' }] }) });
  await f.settled('blocked');
  const retry = await f.cli(['integration', 'request'], { sourceHead: current.sourceHead, expectedVersion: f.host.store.task('task').version, idempotencyKey: 'explicit-retry' }, 'explicit-retry');
  expect(retry.id).not.toBe(first.id);
  await until(() => f.reviewCalls().length === 2);
  const finalReview = f.reviewCalls()[1]!;
  const prompt = JSON.parse(finalReview.prompt);
  if (mode === 'blocked') {
    expect(prompt.reviewContext).toMatchObject({ previousRunId: reviewer.run.id, previousVerdict: 'blocked', previousReviewedCommit: current.candidateHead,
      findings: [{ reason: 'External verification unavailable' }], repairDiff: { status: 'available' },
      checkedScope: { checks: [{ executionSource: 'host', exitStatus: 'passed' }] },
      evidenceReferences: { current: { integrationId: f.candidate(finalReview).integrationId } } });
  } else {
    expect(prompt.reviewContext).toBeUndefined();
    expect(prompt.previousResults).toContainEqual(expect.objectContaining({ runId: reviewer.run.id, status: 'failed' }));
  }
  expect((await f.cli(['integration', 'request'], requestInput, 'replay-old-key')).id).toBe(first.id);
  expect(f.host.store.task('task').attempt).toBe(1);
  f.approve(finalReview); await f.settled('succeeded');
  expect(f.host.store.task('task').acceptedCommit).toBe(f.candidate(finalReview).candidateHead);
  await f.restart(passing);
  expect((await f.cli(['integration', 'request'], { ...requestInput, idempotencyKey: 'client-two' }, 'restart-replay')).id).toBe(first.id);
  expect(f.reviewCalls()).toHaveLength(2);
});

it('keeps cancellation durable across Host restart and rejects a late approval/tool', async () => {
  const f = await fixture(passing);
  await f.cli('dispatch', { expectedVersion: 0, idempotencyKey: 'dispatch' });
  await f.develop(await f.started('develop'), 'complete\n'); const reviewer = await f.started('review');
  const tool = reviewer.tools!.find(tool => tool.name === 'rift_read_evidence')!;
  await f.cli('cancel'); f.approve(reviewer); await f.settled('cancelled');
  await expect(tool.execute({}, reviewer.signal)).rejects.toThrow();
  expect(f.host.store.task('task').acceptedCommit).toBeNull();
  await f.restart(passing);
  expect(f.host.store.task('task')).toMatchObject({ status: 'cancelled', acceptedCommit: null, attempt: 1 });
  expect(f.reviewCalls()).toHaveLength(1);
  expect(await gitOk(f.repo, ['rev-parse', f.workflow.integrationRef])).toBe(f.workflow.baseCommit);
});

it('keeps actual pipeline receipts without routine Lead wakes and resumes successors and workflow finish from accepted events', async () => {
  const f = await fixture(passing), host = f.host;
  const decisions: { input: RuntimeTurnInput; finish: (value: RuntimeTurnResult) => void }[] = [];
  host.registerChatRuntime('codex', { async start(input) {
    let finish!: (value: RuntimeTurnResult) => void;
    const result = new Promise<RuntimeTurnResult>(resolve => { finish = resolve; });
    decisions.push({ input, finish });
    return { result, dispose: async () => { finish({ stopReason: 'cancelled', text: '' }); } };
  } }, ['test-lead']);
  const connection = JSON.stringify({ runtime: 'codex', model: 'test-lead' });
  host.store.exec("UPDATE workspaces SET lead_connection=? WHERE id='own'", connection);
  host.store.exec("UPDATE roles SET chat_connection=? WHERE workspace_id='own' AND purpose='lead'", connection);
  const lead = host.store.require<{ id: string }>("SELECT id FROM roles WHERE workspace_id='own' AND purpose='lead'");
  const conversation = host.chat.createConversation('own', 'Actual pipeline decisions');
  host.store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES(?,'own',?,?,'chat','now')", f.workflow.id, conversation.id, lead.id);
  host.coordinator.replan({ workflowId: f.workflow.id, expectedRevision: 1, updates: [], tasks: [{ id: 'successor', kind: 'analysis', title: 'Follow up', instructions: 'Summarize accepted work', dependsOn: ['task'] }] });
  const prepare = host.git.prepareCandidate.bind(host.git);
  // Pump at the actual stage boundary, not after a scheduler-dependent sleep or a fabricated ledger event.
  vi.spyOn(host.git, 'prepareCandidate').mockImplementation(async input => { await host.orchestration.pump(); return prepare(input); });
  await f.cli('dispatch', { expectedVersion: 0, idempotencyKey: 'dispatch' });
  await f.develop(await f.started('develop'), 'complete\n'); const reviewer = await f.started('review');
  await host.orchestration.pump(); expect(host.orchestration.lastError).toBeNull();
  expect(decisions).toHaveLength(0);
  const progress = host.store.all<{ eventSeq: number }>("SELECT event_seq FROM task_events WHERE task_id='task' AND type IN ('source.collected','cleanup.confirmed')");
  expect(progress).toHaveLength(2);
  for (const event of progress) {
    expect(host.store.all("SELECT id FROM coordination_outbox WHERE event_seq=? AND kind='wake'", event.eventSeq)).toHaveLength(0);
    expect(host.store.all('SELECT id FROM coordination_receipts WHERE event_seq=?', event.eventSeq)).toHaveLength(1);
  }
  f.approve(reviewer); await f.settled('succeeded'); await until(() => decisions.length === 1);
  const invoke = (input: RuntimeTurnInput, name: string, args: object) => input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
  const first = decisions[0]!;
  await invoke(first.input, 'rift_status', {});
  await invoke(first.input, 'rift_task_dispatch', { taskId: 'successor', expectedVersion: host.store.task('successor').version, idempotencyKey: 'dispatch-successor' });
  await invoke(first.input, 'rift_yield', { summary: 'Ready successor dispatched', taskIds: ['successor'], requestIds: [] });
  first.finish({ stopReason: 'completed', text: 'Follow-up dispatched' });
  await until(() => host.chat.turn('own', first.input.turnId).status === 'completed');
  await until(() => f.calls.some(call => call.task.id === 'successor'));
  const successor = f.calls.find(call => call.task.id === 'successor')!;
  successor.finish({ stopReason: 'completed', text: JSON.stringify({ schemaVersion: 1, taskId: 'successor', runId: successor.run.id, outcome: 'completed', summary: 'Accepted work summarized', changedPaths: [], checksClaimed: [], blockingReasons: [] }) });
  await until(() => host.store.task('successor').status === 'succeeded');
  await until(() => decisions.length === 2);
  const last = decisions[1]!;
  await invoke(last.input, 'rift_status', {});
  await invoke(last.input, 'rift_workflow_finish', { summary: 'All actual acceptance and cleanup gates settled' });
  last.finish({ stopReason: 'completed', text: 'Workflow finished' });
  await until(() => host.chat.turn('own', last.input.turnId).status === 'completed');
  await host.orchestration.pump();
  expect(host.store.workflow(f.workflow.id).status).toBe('completed');
  const page = await request<ChatPage>(`/workspaces/own/conversations/${conversation.id}/messages?view=timeline`);
  const receipts = page.receipts!;
  for (const type of ['source.collected', 'cleanup.confirmed', 'integration.accepted', 'task.succeeded', 'workflow.completed']) expect(receipts.some(receipt => receipt.payload.type === type)).toBe(true);
  expect(new Set(receipts.map(receipt => receipt.eventSeq)).size).toBe(receipts.length);
  expect(host.store.all("SELECT id FROM execution_leases WHERE workspace_id='own' AND released_at IS NULL")).toHaveLength(0);
  expect(decisions).toHaveLength(2);
});

it('exposes historical baseline and measured timings through real HTTP/CLI evidence after restart, without relaxing gates', async () => {
  const checks: CheckCommand[] = [{ id: 'unit', executable: process.execPath, args: ['-e', 'console.log("historical failure");process.exit(1)'], baseline: { environmentId: 'immutable-evidence-test-v1' } }];
  const f = await fixture(checks);
  await f.cli('dispatch', { expectedVersion: 0, idempotencyKey: 'dispatch-baseline' });
  await f.develop(await f.started('develop'), 'candidate\n'); await f.settled('blocked');
  const evidence = await f.raw(), integration = evidence.integrations[0]!, baseline = integration.baselines![0]!;
  expect(integration.readiness.status).toBe('failed');
  expect(baseline).toMatchObject({ status: 'recorded', check: { host: { taskId: '$baseline', exitStatus: 'failed' } } });
  expect(baseline.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(integration.timings!.prepareMs).toBeGreaterThan(0);
  expect(integration.timings!.baselineMs).toBeGreaterThan(0);
  expect(integration.timings!.checksMs).toBe(integration.checks[0]!.durationMs);
  expect(integration.checks[0]!.candidateHead).toBe(evidence.currentCandidate!.candidateHead);
  expect(baseline.check!.candidateHead).not.toBe(evidence.currentCandidate!.candidateHead);
  expect(f.reviewCalls()).toHaveLength(0);
  const logInput = { integrationId: integration.id, checkId: baseline.check!.id };
  const cliLog = await f.cli('evidence-log', logInput);
  expect(cliLog.host.taskId).toBe('$baseline'); expect(cliLog.stdout).toContain('historical failure');
  const httpLog = await request('/workspaces/own/tasks/task/evidence/log?' + new URLSearchParams(logInput));
  expect(httpLog).toEqual(cliLog);
  f.host.coordinator.pause(f.workflow.id);
  await f.restart(checks);
  expect(await f.raw()).toEqual(evidence);
  const cliEvidence = await f.cli('evidence');
  expect(cliEvidence.integrations[0].baselines).toEqual(integration.baselines);
  expect(f.reviewCalls()).toHaveLength(0);
  await expect(f.post('/evidence', { ...logInput, candidateHead: evidence.currentCandidate!.candidateHead, expectedVersion: f.host.store.task('task').version, idempotencyKey: 'baseline-is-not-pass', baseline: { exitCode: 0 } }, 'forged-baseline')).rejects.toThrow();
});
