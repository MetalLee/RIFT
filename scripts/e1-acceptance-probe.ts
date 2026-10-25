import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { RiftHostService } from '../src/api/host-service.js';
import { redact } from '../src/api/security.js';
import type { Workflow, Workspace } from '../src/contracts/index.js';

if (!process.argv.includes('--run')) {
  console.log('Use --run for two live DSH Leads, four native Codex developers, exact-commit Codex review and an official Workflow analysis batch. Leads are programmatically driven; no Claude is loaded or executed.');
  process.exit(0);
}

const command = promisify(execFile);
const evidence = path.resolve('.runtime-evidence'); await mkdir(evidence, { recursive: true });
const root = await mkdtemp(path.join(evidence, 'e1-acceptance-'));
const home = path.join(root, 'business-home');
process.env.DSH_HOME = path.join(root, 'dsh-home'); process.env.RIFT_HOME = path.join(root, 'unused-plugin-home'); process.env.RIFT_PORT = '0';
const now = () => new Date().toISOString();
const report: Record<string, any> = { startedAt: now(), root, status: 'running', boundary: { lead: 'real live DSH Agents; management/tools driven by this deterministic script, no Lead model call', development: 'official native Codex provider', review: 'official native Codex provider plus real Git checks', analysisReuse: 'official DSH Workflow engine with native Codex child activations', claude: 'not loaded or executed', concurrency: 'records actual provider acceptance and in-flight intervals; does not claim simultaneous individual tool execution' }, versions: { node: process.version, dsh: '0.2.1-rc.3' }, workspaces: [], overlapSamples: [], checkpoints: [] };
const safe = (value: any): any => typeof value === 'string' ? redact(value, 128 * 1024) : Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safe(entry)])) : value;
const requireThat = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const git = async (repo: string, ...args: string[]) => (await command('git', ['-C', repo, ...args], { windowsHide: true, timeout: 30_000 })).stdout.trim();
let host: RiftHostService | undefined;
let runtime: Awaited<ReturnType<typeof runProfile>> | undefined;
let failed = false;
const workflows: { workflow: Workflow; workspace: Workspace; repo: string; baseline: string; names: string[] }[] = [];

async function awaitTasks(label: string, taskIds: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs; let lastPrint = 0;
  while (Date.now() < deadline) {
    const statuses = workflows.map(item => host!.coordinator.status(item.workflow.id));
    const active = statuses.flatMap(status => status.runs.filter(run => run.status === 'running' && !run.slotReleasedAt).map(run => ({ workspaceId: status.workflow.workspaceId, workflowId: status.workflow.id, taskId: run.taskId, id: run.id, purpose: run.purpose, childId: run.dshChildId, startedAt: run.startedAt })));
    if (active.filter(run => run.purpose !== 'review').length > 2 && new Set(active.filter(run => run.purpose !== 'review').map(run => run.workspaceId)).size === 2 && report.overlapSamples.length < 10) report.overlapSamples.push({ at: now(), active });
    const selected = taskIds.map(id => host!.store.task(id));
    if (selected.every(task => task.status === 'succeeded')) { report.checkpoints.push({ label, at: now(), status: 'pass' }); return; }
    const blocked = selected.filter(task => ['blocked', 'failed', 'cancelled'].includes(task.status));
    if (blocked.length) throw new Error(`${label}: terminal/blocked tasks ${JSON.stringify(blocked.map(task => ({ id: task.id, status: task.status, reason: task.blockingReason })))}`);
    if (Date.now() - lastPrint > 10_000) { lastPrint = Date.now(); console.log(JSON.stringify({ stage: label, active, tasks: selected.map(task => [task.id, task.status]) })); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: exceeded ${timeoutMs} ms`);
}

try {
  report.implementation = Object.fromEntries(await Promise.all(['scripts/e1-acceptance-probe.ts', 'profiles/rift.codex.patch.yml', 'src/api/host-service.ts', 'src/task/coordinator.ts', 'src/task/activation-bridge.ts', 'src/git/integration.ts', 'src/storage/database.ts', 'pnpm-lock.yaml'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  const sourcePatch = (await readFile(path.resolve('profiles/rift.codex.patch.yml'), 'utf8')).replaceAll('\r\n', '\n');
  const providerPatch = sourcePatch.split('    - id: rift\n')[0]!; requireThat(!providerPatch.includes('dsh-subagent-claude'), 'Codex probe must never load Claude.');
  const patchFile = path.join(root, 'providers.patch.yml'); await writeFile(patchFile, providerPatch);
  initializeProfileFromDefault('rift-e1-acceptance', 'sdk-minimal', process.env.DSH_HOME);
  runtime = await runProfile({ environment: loadLayeredEnv('rift-e1-acceptance'), profile: 'rift-e1-acceptance', patchFiles: [patchFile], args: [] });
  requireThat(!runtime.ctx.subagents.list().some(name => name.includes('claude')), 'An unexpected Claude provider is registered.');
  report.providers = runtime.ctx.subagents.list(); report.models = { developer: process.env.RIFT_CODEX_DEVELOPER_MODEL ?? 'gpt-6-astra', reviewer: process.env.RIFT_CODEX_MODEL ?? 'gpt-6-astra' };
  host = new RiftHostService(runtime.ctx, { home, port: 0, leadProvider: 'deepseek-official', leadModel: 'deepseek-flash', developerProvider: 'codex-dev', reviewerProvider: 'codex-review', limits: { developers: 4, total: 5 }, runTimeoutMs: 240_000, checks: [{ id: 'markers', executable: process.execPath, args: ['verify.mjs'], timeoutMs: 15_000 }, { id: 'whitespace', executable: 'git', args: ['diff', '--check', 'HEAD^', 'HEAD'], timeoutMs: 15_000 }] });
  await host.initialize();
  for (const suffix of ['east', 'west']) {
    const repo = path.join(root, `中文 ${suffix} 仓库`); await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'RIFT E1 Acceptance'); await git(repo, 'config', 'user.email', 'rift-e1@example.invalid'); await git(repo, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(repo, 'README.md'), `E1 isolated ${suffix} fixture.\n`);
    await writeFile(path.join(repo, 'verify.mjs'), `import { readdirSync, readFileSync } from 'node:fs';\nfor (const file of readdirSync('.').filter(file => file.startsWith('marker-'))) { if (!/^marker-(alpha|beta)\\.txt$/.test(file) || readFileSync(file,'utf8').trim() !== '${suffix}:' + file.slice(7,-4)) throw Error('Bad marker: ' + file); }\nconsole.log('All present markers verified');\n`);
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'E1 baseline'); const baseline = await git(repo, 'rev-parse', 'HEAD');
    const workspace = await host.handle('POST', '/v1/workspaces', { name: `E1 ${suffix}`, repositoryPath: repo, baseRef: 'main' }, `${suffix}-workspace`) as Workspace;
    const workflow = await host.handle('POST', '/v1/workflows', { workspaceId: workspace.id, goal: `Create two verified ${suffix} markers and analyze accepted results.`, startLead: false }, `${suffix}-workflow`) as Workflow;
    const attached = await host.ensureLead(workflow.id); const names = ['alpha', 'beta'];
    workflows.push({ workspace, workflow, repo, baseline, names }); report.workspaces.push({ workspaceId: workspace.id, workflowId: workflow.id, leadSessionId: attached.leadSessionId, repository: repo, baseline });
    host.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: names.map(name => ({ id: `${suffix}-${name}`, kind: 'change', title: `${suffix} ${name} marker`, instructions: `Write exactly ${JSON.stringify(`${suffix}:${name}\n`)} to marker-${name}.txt in your assigned cwd. Do not edit any other file, do not run git commit. Return only one JSON object matching the supplied resultSchema with exact taskId/runId.`, expectedPaths: [`marker-${name}.txt`], acceptanceCriteria: [`marker-${name}.txt contains exactly ${suffix}:${name} plus a newline; no unrelated edits.`] })) });
  }
  requireThat(new Set(report.workspaces.map((workspace: any) => workspace.leadSessionId)).size === 2, 'Workspace Leads are not isolated.');
  // All four reservations happen in one event-loop turn, with no provider completion or deliberate sleep in between.
  const taskIds = workflows.flatMap(item => host!.coordinator.status(item.workflow.id).tasks.map(task => task.id));
  report.dispatches = taskIds.map(taskId => host!.coordinator.dispatch({ taskId, idempotencyKey: `dispatch-${taskId}`, expectedVersion: host!.store.task(taskId).version }));
  await awaitTasks('four-native-developers-and-review', taskIds, 12 * 60_000);
  requireThat(report.overlapSamples.length > 0, 'Did not observe >2 accepted native development activations in flight across both workspaces.');

  const first = workflows[0]!; const batchTaskId = 'east-analysis-batch';
  host.coordinator.submitPlan({ workflowId: first.workflow.id, expectedRevision: host.store.workflow(first.workflow.id).planRevision, tasks: [{ id: batchTaskId, kind: 'analysis', title: 'Batch inspect accepted marker metadata', instructions: 'Answer the batch items read-only. Do not create or modify any files or commits.', expectedPaths: [], analysisItems: [{ id: 'alpha', prompt: 'Return the literal concise text alpha:11. This is analysis only; do not use shell, files or tools.' }, { id: 'beta', prompt: 'Return the literal concise text beta:22. This is analysis only; do not use shell, files or tools.' }] }] });
  host.coordinator.dispatch({ taskId: batchTaskId, idempotencyKey: `dispatch-${batchTaskId}`, expectedVersion: host.store.task(batchTaskId).version });
  await awaitTasks('official-workflow-batch-analysis', [batchTaskId], 8 * 60_000);
  report.analysisBatch = { task: host.store.task(batchTaskId), runs: host.store.all('SELECT * FROM runs WHERE task_id=?', batchTaskId), events: host.store.events(first.workflow.id).filter(event => event.taskId === batchTaskId) };

  report.business = []; report.gitOperations = [];
  for (const item of workflows) {
    const status = host.coordinator.status(item.workflow.id);
    for (const integration of status.integrations) {
      const run = status.runs.find(run => run.id === integration.reviewRunId); const operation = await host.git.readOperation(item.workspace, integration.id);
      requireThat(integration.status === 'accepted' && run?.status === 'succeeded' && (run.result as any)?.reviewedCommit === operation.candidateHead, 'Candidate lacks exact-commit native approval.');
      requireThat(operation.checks?.length && operation.checks.every(check => check.exitCode === 0 && check.candidateHead === operation.candidateHead), 'Trusted checks are missing or bound to a different commit.');
      report.gitOperations.push(operation);
    }
    const head = await git(item.repo, 'rev-parse', status.workflow.integrationRef);
    for (const name of item.names) requireThat(await git(item.repo, 'show', `${head}:marker-${name}.txt`) === `${item.repo.includes('east') ? 'east' : 'west'}:${name}`, 'An accepted marker is missing.');
    requireThat(await git(item.repo, 'rev-parse', 'main') === item.baseline && await git(item.repo, 'status', '--porcelain') === '' && await git(item.repo, 'remote', '-v') === '', 'Fixture default branch/checkout/remote changed unexpectedly.');
    requireThat(status.runs.every(run => run.cleanupStatus === 'confirmed' && run.slotReleasedAt), 'An activation retains unknown cleanup.');
    host.coordinator.finish({ workflowId: item.workflow.id, summary: 'Independent E1 native evidence verified: exact native reviews, trusted checks, accepted marker contents, confirmed cleanup.' });
    report.business.push({ status: host.coordinator.status(item.workflow.id), events: host.store.events(item.workflow.id), integratedHead: head, baselineUnchanged: true });
  }
  report.status = 'pass';
} catch (error) {
  failed = true; report.status = 'fail'; report.error = redact(String(error));
  if (host) report.businessAtFailure = workflows.map(item => ({ status: host!.coordinator.status(item.workflow.id), events: host!.store.events(item.workflow.id) }));
} finally {
  if (host) {
    if (failed) await Promise.allSettled(workflows.map(item => host!.handle('POST', `/v1/workflows/${item.workflow.id}/cancel`, {}, `cleanup-${item.workflow.id}`)));
    try { await host.close(); report.hostCleanup = 'pass'; } catch (error) { failed = true; report.hostCleanup = redact(String(error)); }
  }
  if (runtime) { try { await runtime.shutdown.shutdown(failed ? 1 : 0); report.runtimeUnload = 'pass'; } catch (error) { failed = true; report.runtimeUnload = redact(String(error)); } }
  report.databaseLockReleased = !await access(path.join(home, 'rift.db.host.lock')).then(() => true, () => false); if (!report.databaseLockReleased) failed = true;
  report.endedAt = now(); report.status = failed ? 'fail' : 'pass'; report.exitCode = failed ? 1 : 0;
  const serialized = JSON.stringify(safe(report), null, 2);
  await writeFile(path.join(root, 'report.json'), serialized); await writeFile(path.join(evidence, 'e1-acceptance-probe.json'), serialized);
  await mkdir(path.resolve('docs/evidence'), { recursive: true }); await writeFile(path.resolve('docs/evidence/e1-native-acceptance.json'), serialized);
  console.log(JSON.stringify({ status: report.status, error: report.error, root, report: path.join(root, 'report.json') })); process.exitCode = failed ? 1 : 0;
}
