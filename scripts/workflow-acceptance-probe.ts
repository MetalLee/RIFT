import { mkdir, mkdtemp, readFile, writeFile, appendFile, access, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RiftHostService } from '../src/api/host-service.js';
import { redact } from '../src/api/security.js';
import type { Workflow, Workspace, Role, ProviderBinding } from '../src/contracts/index.js';

if (!process.argv.includes('--run')) {
  console.log('Use --run to execute a real DSH Lead, Claude developers and Codex reviewers in an isolated Git fixture.');
  process.exit(0);
}
const command = promisify(execFile);
const evidence = path.resolve('.runtime-evidence');
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(path.join(evidence, 'workflow-acceptance-'));
const repo = path.join(root, '中文 业务仓库');
const home = path.join(root, 'business-home');
process.env.DSH_HOME = path.join(root, 'dsh-home');
process.env.RIFT_HOME = path.join(root, 'unused-plugin-home');
process.env.RIFT_PORT = '0';
const now = () => new Date().toISOString();
const report: Record<string, any> = { startedAt: now(), root, mode: 'Real LLM Lead tools -> durable business coordinator -> official providers -> exact Git acceptance', lead: { provider: 'deepseek-official', model: process.env.RIFT_LEAD_MODEL || 'deepseek-flash' }, developerModel: process.env.RIFT_CLAUDE_MODEL || 'claude-opus-5-5', reviewerModel: process.env.RIFT_CODEX_MODEL || 'gpt-6.1-sol', toolCalls: [], leadRequests: [], leadErrors: [], gates: [], overlapSamples: [], queueSamples: [] };
const safe = (v: any): any => typeof v === 'string' ? redact(v, 64 * 1024) : Array.isArray(v) ? v.map(safe) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safe(x)])) : v;
const git = async (...args: string[]) => (await command('git', ['-C', repo, ...args], { windowsHide: true, timeout: 30_000 })).stdout.trim();
const requireThat = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const releaseGate = async (file: string) => { await writeFile(`${file}.next`, '{"release":true}'); await rename(`${file}.next`, file); };
const leadObservedFastResult = () => report.toolCalls.some((call: any) => {
  const status = call.name === 'rift_status' ? call.result : call.name === 'rift_wait' ? call.result?.status : undefined;
  return status?.runs?.some((run: any) => run.taskId === 'fast-b' && run.purpose !== 'review' && run.endedAt) && status?.runs?.some((run: any) => run.taskId === 'slow-a' && run.purpose !== 'review' && !run.endedAt);
});
let host: RiftHostService | undefined;
let runtime: Awaited<ReturnType<typeof runProfile>> | undefined;
let workflowId: string | undefined;
let failed = false;
try {
  report.runtime = { node: process.version, platform: process.platform, dsh: '0.2.1-rc.3', permissionModes: { claude: 'acceptEdits', codex: 'never' }, modelConfigurationEvidence: 'profiles/rift.patch.yml; model/permission are configured per official provider instance' };
  report.implementation = Object.fromEntries(await Promise.all(['scripts/workflow-acceptance-probe.ts', 'profiles/rift.patch.yml', 'src/api/host-service.ts', 'src/task/coordinator.ts', 'src/git/integration.ts', 'src/storage/database.ts', 'src/tools/rift-tools.ts', 'pnpm-lock.yaml'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  await mkdir(repo, { recursive: true });
  await git('init', '-b', 'main'); await git('config', 'user.name', 'RIFT Acceptance'); await git('config', 'user.email', 'rift-acceptance@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, '.gitignore'), '.probe-control/\n');
  await writeFile(path.join(repo, 'README.md'), 'Isolated four-role acceptance fixture. Only feature JSON files are development outputs.\n');
  await writeFile(path.join(repo, 'verify.mjs'), `import { existsSync, readFileSync, readdirSync } from 'node:fs';\nconst expected={alpha:11,beta:22,gamma:33,delta:44};\nif(!existsSync('features'))throw Error('No feature changes');\nfor(const f of readdirSync('features')){const key=f.replace(/\\.json$/,'');if(!(key in expected)||JSON.parse(readFileSync('features/'+f,'utf8')).value!==expected[key])throw Error('Invalid feature '+f);}\nconsole.log('All present feature JSON values verified.');\n`);
  await git('add', '.'); await git('commit', '-m', 'Isolated acceptance baseline');
  const base = await git('rev-parse', 'HEAD'); report.baseline = { repository: repo, branch: 'main', head: base, remotes: await git('remote', '-v') };
  // Keep the official profile/providers, but instantiate exactly one production
  // business service below so the harness can inspect its durable evidence.
  const patch = (await readFile(path.resolve('profiles/rift.patch.yml'), 'utf8')).split('    - id: rift\n')[0]!;
  const patchFile = path.join(root, 'providers.patch.yml'); await writeFile(patchFile, patch);
  initializeProfileFromDefault('rift-workflow-acceptance', 'sdk-minimal', process.env.DSH_HOME);
  runtime = await runProfile({ environment: loadLayeredEnv('rift-workflow-acceptance'), profile: 'rift-workflow-acceptance', patchFiles: [patchFile], args: [] });
  host = new RiftHostService(runtime.ctx, { home, port: 0, leadProvider: report.lead.provider, leadModel: report.lead.model, runTimeoutMs: 180_000, checks: [{ id: 'fixture-functional', executable: process.execPath, args: ['verify.mjs'], timeoutMs: 15_000 }, { id: 'whitespace', executable: 'git', args: ['diff', '--check', 'HEAD^', 'HEAD'], timeoutMs: 15_000 }] });
  await host.initialize();
  runtime.ctx.on('agent/request', async (event, next) => { report.leadRequests.push({ at: now(), agentId: event.agent.id, turn: event.turn, step: event.step }); return next(); });
  runtime.ctx.on('agent/error', event => { const error = { at: now(), agentId: event.agent.id, error: redact(String(event.error)) }; report.leadErrors.push(error); console.log(JSON.stringify({ leadError: error })); });
  runtime.ctx.on('tools/execute', async (exec, next) => {
    if (!exec.name.startsWith('rift_')) return next();
    const entry: Record<string, any> = { name: exec.name, callId: exec.callId, agentId: exec.agent?.id, startedAt: now(), arguments: safe(exec.arguments) };
    report.toolCalls.push(entry);
    const result = await next(); entry.endedAt = now(); entry.isError = result.isError; entry.result = safe(result.value ?? result.content);
    console.log(JSON.stringify({ leadTool: entry.name, isError: entry.isError, at: entry.endedAt }));
    await appendFile(path.join(root, 'lead-tools.jsonl'), JSON.stringify(entry) + '\n');
    return result;
  });
  const workspace = await host.handle('POST', '/v1/workspaces', { name: 'Real Lead acceptance', repositoryPath: repo, baseRef: 'main' }, 'fixture-workspace') as Workspace;
  const reviewGate = path.join(root, 'review-gate.json'); await writeFile(reviewGate, '{"release":false}');
  const roles = host.store.all<Role>('SELECT * FROM roles WHERE workspace_id=?', workspace.id);
  host.project.configureRoles(workspace.id, host.store.all<ProviderBinding>('SELECT * FROM provider_bindings'), roles.map(role => ({ name: role.name, kind: role.kind, ...(role.providerBindingId ? { providerBindingId: role.providerBindingId } : {}), revision: role.revision + 1, prompt: role.prompt + (role.name === 'reviewer' ? ` Acceptance harness coordination: before returning your actual independent review, read the JSON file ${JSON.stringify(reviewGate)} until release=true (bounded to 90 seconds, use a read-only PowerShell polling loop with Start-Sleep). Never change that file. Then complete the exact-commit review and return resultSchema JSON. This gate only keeps the review activation observable; it never decides approval.` : '') })));
  const gateInstruction = 'After writing the feature, write exactly READY to .probe-control/ready.txt. The harness creates .probe-control/gate.json in this worktree; read it using Read until release is true (at most 60 reads). Do not change gate.json. Only then return your exact resultSchema JSON. These ignored control files are harness coordination, not source changes. Use Read/Write/Edit, no shell or git commands.';
  const plans = [
    { id: 'slow-a', roleName: 'developer-a', kind: 'change', title: 'Alpha feature', instructions: `Create features/alpha.json with exactly {"value":11}. ${gateInstruction}`, expectedPaths: ['features/alpha.json'], acceptanceCriteria: ['features/alpha.json parses as JSON and value equals 11; no unrelated tracked changes.'] },
    { id: 'fast-b', roleName: 'developer-b', kind: 'change', title: 'Beta feature', instructions: 'Create features/beta.json with exactly {"value":22}. Use Write/Edit tools, no shell or git. Return only the exact development resultSchema JSON promptly; do not wait for any other task.', expectedPaths: ['features/beta.json'], acceptanceCriteria: ['features/beta.json parses as JSON and value equals 22; no unrelated tracked changes.'] },
    { id: 'queued-b', roleName: 'developer-b', kind: 'change', title: 'Gamma feature', instructions: `Create features/gamma.json with exactly {"value":33}. ${gateInstruction}`, expectedPaths: ['features/gamma.json'], acceptanceCriteria: ['features/gamma.json parses as JSON and value equals 33; no unrelated tracked changes.'] },
    { id: 'dependent-d', roleName: 'developer-a', kind: 'change', title: 'Dependent delta feature', instructions: 'Read features/beta.json from your integrated baseline and confirm value 22, then create features/delta.json with exactly {"value":44}. Use direct file tools, no shell or git. Return only the exact development resultSchema JSON.', expectedPaths: ['features/delta.json'], acceptanceCriteria: ['features/delta.json value is 44 and integrated features/beta.json remains 22.'], dependsOn: ['fast-b'] },
  ];
  const goal = `Run this real acceptance workload. Submit exactly these four task IDs and task definitions (no added tasks): ${JSON.stringify(plans)}. Preserve each task instruction and acceptance criterion. Dispatch slow-a first, fast-b second, queued-b third and dependent-d fourth, all BEFORE the first wait; use the specified roles and accept queued requests rather than retrying a duplicate. The harness releases gated developers only after their ready markers and one real Codex candidate review overlap. You may only use RIFT business tools; you cannot edit files directly. Observe status/results and continue until all four changes are reviewed, integrated and workflow_finish succeeds. The reviewer must inspect the exact candidate and functional evidence, never edit it. Do not treat ignored .probe-control harness files as production source changes. Do not claim success while blocked; report concrete failures if retries cannot fix them.`;
  const workflow = await host.handle('POST', '/v1/workflows', { workspaceId: workspace.id, goal, startLead: false }, 'fixture-workflow') as Workflow;
  workflowId = workflow.id; report.workflowId = workflowId;
  const attached = await host.startLead(workflowId); report.lead.sessionId = attached.leadSessionId;
  const expires = Date.now() + 8 * 60_000;
  const controlled = new Map<string, { cwd: string; released: boolean }>();
  let overlap = false;
  let lastPrint = 0;
  while (Date.now() < expires) {
    const status = host.coordinator.status(workflowId);
    for (const tree of status.worktrees.filter(tree => ['slow-a', 'queued-b'].includes(tree.taskId) && tree.kind === 'task')) {
      if (!controlled.has(tree.id)) {
        const dir = path.join(tree.path, '.probe-control'); await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'gate.json'), JSON.stringify({ release: overlap }));
        controlled.set(tree.id, { cwd: tree.path, released: overlap }); report.gates.push({ taskId: tree.taskId, cwd: tree.path, createdAt: now(), releasedOnCreation: overlap });
      }
    }
    const active = status.runs.filter(run => run.status === 'running' && !run.slotReleasedAt);
    if (!report.queueSamples.length && status.slots.developers === 2 && status.operations.some(op => op.entityId === 'queued-b' && op.kind === 'dispatch' && op.phase === 'queued')) report.queueSamples.push({ at: now(), slots: status.slots, operations: status.operations, active: active.map(run => ({ id: run.id, taskId: run.taskId })) });
    const gatedReady = await Promise.all([...controlled.values()].map(async value => (await readFile(path.join(value.cwd, '.probe-control', 'ready.txt'), 'utf8').catch(() => '')).trim() === 'READY'));
    if (!overlap && active.filter(run => run.purpose !== 'review').length === 2 && active.some(run => run.purpose === 'review') && controlled.size >= 2 && gatedReady.every(Boolean) && leadObservedFastResult()) {
      overlap = true; report.overlapSamples.push({ at: now(), slots: status.slots, active: active.map(run => ({ id: run.id, taskId: run.taskId, purpose: run.purpose, childId: run.dshChildId, startedAt: run.startedAt })) });
      for (const value of controlled.values()) { await releaseGate(path.join(value.cwd, '.probe-control', 'gate.json')); value.released = true; }
      await releaseGate(reviewGate);
      report.gatesReleasedAt = now(); console.log(JSON.stringify({ threeRoleBusinessOverlap: true, at: now() }));
    }
    if (Date.now() - lastPrint > 10_000) { lastPrint = Date.now(); console.log(JSON.stringify({ tasks: status.tasks.map(task => [task.id, task.status, task.attempt]), slots: status.slots, leadRequests: report.leadRequests.length })); }
    if (status.workflow.status === 'completed') break;
    if (report.leadErrors.length) throw new Error('The real Lead reported a model/turn failure; see leadErrors.');
    const lead = runtime.ctx.agents.get(SessionId(attached.leadSessionId));
    if (lead?.status === 'idle' && status.slots.total === 0 && report.toolCalls.length) throw new Error('Lead ended before the durable workflow finished.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = host.coordinator.status(workflowId); report.business = status; report.events = host.store.events(workflowId);
  requireThat(status.workflow.status === 'completed', 'Workflow did not complete within the bounded probe.');
  requireThat(report.leadRequests.length > 0 && report.toolCalls.some((call: any) => call.name === 'rift_plan_submit') && report.toolCalls.some((call: any) => call.name === 'rift_workflow_finish' && !call.isError), 'Missing actual Lead model/tool orchestration evidence.');
  requireThat(overlap, 'Two real developers and an exact-candidate review did not overlap.');
  requireThat(status.tasks.length === 4 && status.tasks.every(task => task.status === 'succeeded' && task.acceptedCommit), 'All four task acceptances were not proven.');
  const development = status.runs.filter(run => run.purpose !== 'review');
  const firstA = development.find(run => run.taskId === 'slow-a')!, firstB = development.find(run => run.taskId === 'fast-b')!;
  requireThat(firstA.startedAt && firstB.startedAt && firstB.endedAt && firstA.endedAt && firstA.startedAt < firstB.endedAt && firstB.endedAt < firstA.endedAt, 'Requested out-of-order developer completion was not observed.');
  const queuedCall = report.toolCalls.find((call: any) => call.name === 'rift_task_dispatch' && call.arguments?.taskId === 'queued-b');
  const firstBCleanup = report.events.find((event: any) => event.runId === firstB.id && event.type === 'cleanup.confirmed');
  const queuedReservation = report.events.find((event: any) => event.taskId === 'queued-b' && event.type === 'dispatch_reserved');
  const queued = report.queueSamples.length > 0 && queuedCall?.result?.phase === 'queued' && firstBCleanup && queuedReservation && firstBCleanup.eventSeq < queuedReservation.eventSeq;
  report.thirdDeveloperQueued = queued;
  requireThat(queued, 'The third developer request was not observed in the durable queue.');
  requireThat(leadObservedFastResult(), 'Lead did not read the out-of-order durable developer result while the first developer was still running.');
  const dependencyAccepted = report.events.find((event: any) => event.taskId === 'fast-b' && event.type === 'integration.accepted');
  const dependentStart = report.events.find((event: any) => event.taskId === 'dependent-d' && event.type === 'activation_accepted');
  requireThat(dependencyAccepted && dependentStart && dependencyAccepted.eventSeq < dependentStart.eventSeq, 'Dependent development started before predecessor acceptance.');
  report.gitOperations = [];
  for (const integration of status.integrations) {
    const run = status.runs.find(run => run.id === integration.reviewRunId);
    requireThat(integration.status === 'accepted' && run?.status === 'succeeded' && (run.result as any)?.reviewedCommit === integration.candidate?.candidateHead, 'Review and exact accepted candidate are not bound.');
    const operation = await host.git.readOperation(workspace, integration.id);
    requireThat(operation.checks?.length && operation.checks.every(check => check.exitCode === 0 && check.candidateHead === operation.candidateHead), 'Trusted checks are not bound to the accepted candidate.');
    const task = status.tasks.find(task => task.id === integration.taskId)!;
    requireThat(task.acceptedCommit === operation.candidateHead && task.sourceHead === operation.sourceHead, 'Source/candidate/accepted mapping differs from the durable task.');
    for (const checkout of [operation.candidatePath, operation.reviewPath]) {
      requireThat((await command('git', ['-C', checkout, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim() === operation.candidateHead, 'Review/candidate checkout moved.');
      requireThat((await command('git', ['-C', checkout, 'status', '--porcelain'], { windowsHide: true })).stdout.trim() === '', 'Review/candidate checkout is not clean.');
    }
    report.gitOperations.push(operation);
  }
  report.acceptedChain = [];
  let expectedTarget = base;
  for (const event of report.events.filter((event: any) => event.type === 'integration.accepted')) {
    const operation = report.gitOperations.find((item: any) => item.integrationId === event.payload.integrationId);
    requireThat(operation && operation.expectedTargetHead === expectedTarget && await git('rev-parse', `${operation.candidateHead}^1`) === expectedTarget, 'A later candidate did not merge onto the latest accepted target.');
    report.acceptedChain.push({ taskId: operation.taskId, sourceHead: operation.sourceHead, expectedTarget, reviewedCommit: operation.review.reviewedCommit, acceptedCommit: operation.candidateHead });
    expectedTarget = operation.candidateHead;
  }
  const head = await git('rev-parse', status.workflow.integrationRef); report.integratedHead = head;
  for (const [feature, value] of Object.entries({ alpha: 11, beta: 22, gamma: 33, delta: 44 })) requireThat(JSON.parse(await git('show', `${head}:features/${feature}.json`)).value === value, `Integrated ${feature} value missing.`);
  requireThat(await git('rev-parse', 'main') === base && await git('status', '--porcelain') === '' && await git('remote', '-v') === '', 'Baseline branch, checkout or remote was unexpectedly modified.');
  report.baselineUnchanged = true;
  requireThat(status.runs.every(run => run.cleanupStatus === 'confirmed' && run.slotReleasedAt), 'Unconfirmed execution cleanup remains.');
  report.status = 'pass';
} catch (error) {
  failed = true; report.status = 'fail'; report.error = redact(String(error));
  if (host && workflowId) { report.business = host.coordinator.status(workflowId); report.events = host.store.events(workflowId); }
} finally {
  if (host) {
    if (failed && workflowId) await host.handle('POST', `/v1/workflows/${workflowId}/cancel`, {}, `probe-cleanup-${Date.now()}`).catch(error => { report.cancelError = redact(String(error)); });
    try { await host.close(); report.hostCleanup = 'pass'; } catch (error) { failed = true; report.hostCleanup = redact(String(error)); }
  }
  if (runtime) { try { await runtime.shutdown.shutdown(failed ? 1 : 0); report.runtimeUnload = 'pass'; } catch (error) { failed = true; report.runtimeUnload = redact(String(error)); } }
  report.databaseLockReleased = !await access(path.join(home, 'rift.db.host.lock')).then(() => true, () => false);
  if (!report.databaseLockReleased) failed = true;
  report.status = failed ? 'fail' : 'pass'; report.endedAt = now(); report.exitCode = failed ? 1 : 0;
  const serialized = JSON.stringify(safe(report), null, 2);
  await writeFile(path.join(root, 'report.json'), serialized);
  await writeFile(path.join(evidence, `workflow-acceptance-${path.basename(root)}.json`), serialized, { flag: 'wx' });
  await writeFile(path.join(evidence, 'workflow-acceptance-probe.json'), serialized);
  console.log(JSON.stringify({ status: report.status, error: report.error, root, report: path.join(root, 'report.json') }));
  process.exitCode = failed ? 1 : 0;
}
