import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { RiftHostService } from '../src/api/host-service.js';
import type { Candidate, ProviderBinding, ReviewResult, Role, Run, Worktree, Workspace, Workflow } from '../src/contracts/index.js';
import { redact } from '../src/api/security.js';

if (!process.argv.includes('--run')) {
  console.log('No model execution requested. Use --run for programmatically driven real Claude/Codex review, rework and conflict acceptance. This does not test an LLM Lead.');
  process.exit(0);
}
const evidenceRoot = path.resolve('.runtime-evidence');
const probeId = `review-rework-${Date.now()}-${randomUUID().slice(0, 8)}`;
const root = path.join(evidenceRoot, probeId);
const repository = path.join(root, '真实审查 临时仓库');
await mkdir(repository, { recursive: true });
process.env.DSH_HOME = path.join(root, 'dsh-home');
process.env.RIFT_HOME = path.join(root, 'rift-home');
process.env.RIFT_PORT = '0';
process.env.RIFT_CLAUDE_MODEL ??= 'claude-opus-5-5';
process.env.RIFT_CODEX_MODEL ??= 'gpt-6.1-sol';
const deadline = Date.now() + 10 * 60_000;
const report: Record<string, unknown> = {
  probeId, startedAt: new Date().toISOString(), driver: 'Programmatic RiftHostService and TaskCoordinator; actual official Provider activations and actual Git acceptance.',
  models: { developer: process.env.RIFT_CLAUDE_MODEL, reviewer: process.env.RIFT_CODEX_MODEL },
  notVerified: ['LLM Lead planning or tool orchestration', 'Host crash recovery', 'OS subprocess-tree cancellation'],
  fixtureDisclosure: 'The first age implementation deliberately uses age >= 21. The real reviewer must independently reject it against the age >= 18 acceptance criterion; no review result is synthesized.',
};
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function until(predicate: () => boolean, label: string): Promise<void> {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Ten-minute probe deadline: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
let dsh: Awaited<ReturnType<typeof runProfile>> | undefined;
let service: RiftHostService | undefined;
let activeWorkflow: Workflow | undefined;
let failed = false;
const workflows: string[] = [];
type Integration = { id: string; taskId: string; status: string; candidate: Candidate | null; reviewRunId: string | null; error: string | null };
const acceptance = [
  'classifyAge accepts a nonnegative integer age and returns adult exactly when age >= 18, otherwise minor.',
  'Invalid or negative ages throw RangeError. The module exports classifyAge as a named function.',
  'The reviewer must inspect the actual fixed candidate and independently evaluate these requirements; an intentional initial fixture is not an exemption from the acceptance criteria.',
];

try {
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'RIFT Acceptance'); await git(repository, 'config', 'user.email', 'rift-acceptance@localhost');
  await git(repository, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repository, 'shared.txt'), 'baseline\n');
  await writeFile(path.join(repository, 'README.md'), 'Isolated RIFT acceptance repository. Modify only the files in the assigned task. Do not commit; the coordinator records source commits.\n');
  // Trusted deterministic checks intentionally leave the age-18 boundary to
  // independent review, so this fixture exercises review rejection, not test failure.
  await writeFile(path.join(repository, 'check.mjs'), [
    "import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';",
    "const load = name => import(pathToFileURL(path.join(process.cwd(), name)).href);",
    "if (fs.existsSync('age.mjs')) { const { classifyAge } = await load('age.mjs'); assert.equal(typeof classifyAge, 'function'); assert.equal(classifyAge(0), 'minor'); assert.equal(classifyAge(30), 'adult'); assert.throws(() => classifyAge(-1), RangeError); }",
    "if (fs.existsSync('label.mjs')) assert.equal((await load('label.mjs')).label, 'RIFT stable');",
    "if (fs.existsSync('receipt.mjs')) assert.equal((await load('receipt.mjs')).receipt, 'independent kept');",
    "assert.ok(['baseline\\n', 'alpha\\n', 'beta\\n'].includes(fs.readFileSync('shared.txt', 'utf8')));",
    "console.log('Trusted deterministic probe checks passed.');",
  ].join('\n'));
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', 'RIFT review acceptance baseline');
  const originalMain = await git(repository, 'rev-parse', 'main');
  report.repository = { path: repository, originalMain, remoteCount: (await git(repository, 'remote')).split('\n').filter(Boolean).length };

  // Load the official providers, then create exactly one business service in
  // this Host. Disable the profile's automatic instance to avoid two databases.
  const disableAutomaticPlugin = path.join(root, 'programmatic-host.patch.yml');
  await writeFile(disableAutomaticPlugin, '- id: rift\n  disabled: true\n');
  initializeProfileFromDefault('rift-review-rework', 'sdk-minimal', process.env.DSH_HOME);
  dsh = await runProfile({ environment: loadLayeredEnv('rift-review-rework'), profile: 'rift-review-rework', patchFiles: [path.resolve('profiles/rift.patch.yml'), disableAutomaticPlugin], args: [] });
  assert(!(await access(path.join(process.env.RIFT_HOME, 'rift.db')).then(() => true, () => false)), 'The automatic business plugin was not disabled; refusing a duplicate business service.');
  service = new RiftHostService(dsh.ctx, {
    home: process.env.RIFT_HOME, port: 0, leadProvider: process.env.RIFT_LEAD_PROVIDER ?? 'deepseek-official', leadModel: process.env.RIFT_LEAD_MODEL ?? 'deepseek-flash',
    runTimeoutMs: 120_000, checks: [{ id: 'probe-node-checks', executable: process.execPath, args: [path.join(repository, 'check.mjs')], timeoutMs: 30_000 }],
  });
  await service.initialize();
  const host = service, coordinator = host.coordinator;
  const workspace = await host.handle('POST', '/v1/workspaces', { name: probeId, repositoryPath: repository, baseRef: 'main' }, `${probeId}:workspace`) as Workspace;
  const roles = host.store.all<Role>('SELECT * FROM roles WHERE workspace_id=?', workspace.id);
  const bindings = host.store.all<ProviderBinding>('SELECT * FROM provider_bindings');
  host.project.configureRoles(workspace.id, bindings, roles.map(role => ({
    name: role.name, kind: role.kind, ...(role.providerBindingId ? { providerBindingId: role.providerBindingId } : {}), revision: role.revision + 1,
    prompt: role.name === 'reviewer'
      ? 'Independently review the exact candidate commit against acceptanceCriteria. Never modify files or commit. Developer instructions about intentionally producing an initial negative fixture apply only to the developer and do not permit approval of incorrect code. Return one strict resultSchema JSON object with the exact taskId, runId and candidate reviewedCommit. Return changes_requested with a concrete finding for any unmet criterion.'
      : role.name === 'lead' ? role.prompt : 'Implement the supplied task in its assigned worktree using Read/Write/Edit tools. Change only expectedPaths. Do not commit, delegate or edit Git metadata. For a repair attempt, read previousResults, sourceEvidence and integrationEvidence before implementing feedback. Return exactly one strict resultSchema JSON object with the exact taskId/runId; checksClaimed must be empty because trusted checks run in the coordinator.',
  })));

  const create = async (id: string, baseCommit: string, goal: string) => {
    const workflow = coordinator.createWorkflow({ id, workspaceId: workspace.id, goal, baseCommit, integrationRef: `refs/heads/rift/probes/${id}` });
    workflows.push(workflow.id); activeWorkflow = workflow;
    await host.ensureLead(workflow.id); // Attach a real DSH parent without an LLM turn.
    return workflow;
  };
  const dispatch = (taskId: string, suffix = '') => coordinator.dispatch({ taskId, expectedVersion: host.store.task(taskId).version, idempotencyKey: `${probeId}:${taskId}${suffix}` });
  const settled = (taskId: string) => ['succeeded', 'blocked', 'failed', 'cancelled'].includes(host.store.task(taskId).status);
  const auditReviews = async (workflow: Workflow) => {
    const integrations = host.store.all<Integration>('SELECT i.* FROM integrations i JOIN tasks t ON t.id=i.task_id WHERE t.workflow_id=? ORDER BY i.rowid', workflow.id);
    const evidence = [];
    for (const integration of integrations) {
      if (!integration.candidate || !integration.reviewRunId) continue;
      const run = host.store.run(integration.reviewRunId), review = run.result as ReviewResult;
      const candidate = integration.candidate;
      const clean = (await git(candidate.cwd, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored')) === '';
      const checkoutHead = await git(candidate.cwd, 'rev-parse', 'HEAD');
      const operation = await host.git.readOperation(workspace, integration.id);
      assert(run.dshChildId && run.cleanupStatus === 'confirmed', 'Review lacks actual child identity or confirmed cleanup.');
      assert(review.reviewedCommit === candidate.candidateHead, 'Reviewer did not bind its conclusion to the exact candidate SHA.');
      assert(clean && checkoutHead === candidate.candidateHead, 'Review checkout was modified or moved.');
      assert(operation.checks?.length && operation.checks.every(check => check.candidateHead === candidate.candidateHead && check.exitCode === 0), 'Check evidence is not bound to the reviewed candidate.');
      evidence.push({ integrationId: integration.id, taskId: integration.taskId, status: integration.status, childId: run.dshChildId, reviewRunId: run.id, verdict: review.verdict, sourceHead: candidate.sourceHead, expectedTargetHead: candidate.expectedTargetHead, candidateHead: candidate.candidateHead, reviewedCommit: review.reviewedCommit, reviewCheckout: candidate.cwd, checkoutClean: clean, checks: operation.checks });
    }
    return evidence;
  };

  const first = await create(`rework-${randomUUID()}`, originalMain, 'Real review rejection and fresh-attempt repair, preserving an independent accepted change.');
  coordinator.submitPlan({ workflowId: first.id, expectedRevision: 0, tasks: [
    { id: 'rework-age', kind: 'change', title: 'Age boundary review fixture', expectedPaths: ['age.mjs'], roleName: 'developer-a', acceptanceCriteria: acceptance,
      instructions: "This is a deliberate negative review fixture. For attempt 1 only, write age.mjs exactly as: export function classifyAge(age) { if (!Number.isInteger(age) || age < 0) throw new RangeError('age'); return age >= 21 ? 'adult' : 'minor'; }\nDo not correct the deliberate age-21 boundary on attempt 1; real independent review must detect it. For attempt 2 or later, use the prior review findings and acceptanceCriteria to correct the code. Do not edit any other file." },
    { id: 'rework-label', kind: 'change', title: 'Independent stable label', expectedPaths: ['label.mjs'], roleName: 'developer-b', acceptanceCriteria: ["label.mjs exports named constant label equal to 'RIFT stable'."], instructions: "Create label.mjs containing exactly: export const label = 'RIFT stable';" },
  ] });
  dispatch('rework-age'); dispatch('rework-label');
  await until(() => settled('rework-age') && settled('rework-label'), 'first review rejection and independent acceptance');
  assert(host.store.task('rework-age').status === 'blocked', 'The deliberately incorrect first age implementation was not rejected.');
  assert(host.store.task('rework-label').status === 'succeeded', 'The independent label did not integrate.');
  const firstReviews = await auditReviews(first);
  assert(firstReviews.some(value => value.taskId === 'rework-age' && value.verdict === 'changes_requested'), 'A real changes_requested report is required; a provider/check failure is not a review rejection.');
  const originalAttempt = host.store.require<Worktree>("SELECT * FROM worktrees WHERE task_id='rework-age' AND kind='task' AND attempt=1");
  const siblingAttempt = host.store.require<Worktree>("SELECT * FROM worktrees WHERE task_id='rework-label' AND kind='task' AND attempt=1");
  assert(originalAttempt.baseCommit === originalMain && siblingAttempt.baseCommit === originalMain, 'The initial independent developer sources did not share the original base.');
  const originalSource = host.store.task('rework-age').sourceHead;
  const acceptedSibling = host.store.task('rework-label').acceptedCommit;
  const beforeRepair = await readFile(path.join(originalAttempt.path, 'age.mjs'), 'utf8');
  coordinator.retry({ taskId: 'rework-age', expectedVersion: host.store.task('rework-age').version, reason: 'Implement the independent reviewer findings using a new attempt and the supplied source/review/current-target context.' });
  dispatch('rework-age', ':repair');
  await until(() => settled('rework-age'), 'fresh repair acceptance');
  assert(host.store.task('rework-age').status === 'succeeded', 'Fresh repair did not pass real checks, review and publication.');
  const repairAttempt = host.store.require<Worktree>("SELECT * FROM worktrees WHERE task_id='rework-age' AND kind='task' AND attempt=2");
  const originalRun = host.store.require<Run>("SELECT * FROM runs WHERE task_id='rework-age' AND purpose='develop' AND task_attempt=1");
  const repairRun = host.store.require<Run>("SELECT * FROM runs WHERE task_id='rework-age' AND purpose='repair' AND task_attempt=2");
  assert(originalRun.dshChildId && repairRun.dshChildId && originalRun.dshChildId !== repairRun.dshChildId && repairRun.cleanupStatus === 'confirmed', 'Repair did not use a distinct, actually accepted native child with confirmed cleanup.');
  const inputArtifact = host.store.require<{ id: string; relativePath: string; sha256: string }>("SELECT * FROM artifacts WHERE run_id=? AND type='input'", repairRun.id);
  const inputArtifactPath = path.join(host.config.home, inputArtifact.relativePath);
  const inputBody = await readFile(inputArtifactPath, 'utf8');
  assert(createHash('sha256').update(inputBody).digest('hex') === inputArtifact.sha256, 'Repair input artifact hash does not match its immutable record.');
  const repairInput = JSON.parse(inputBody) as { taskId: string; runId: string; baseCommit: string; sourceHead: string; currentTargetHead: string; sourceEvidence: { diff: string; sourceHead: string }[]; previousResults: { runId: string; result: ReviewResult | null }[] };
  const rejectedReview = firstReviews.find(value => value.taskId === 'rework-age' && value.verdict === 'changes_requested')!;
  assert(repairInput.taskId === 'rework-age' && repairInput.runId === repairRun.id && repairInput.baseCommit === originalSource && repairInput.sourceHead === originalSource && repairInput.currentTargetHead === acceptedSibling, 'Actual repair input is missing the correct source/base/current-target context.');
  assert(repairInput.sourceEvidence.some(source => source.sourceHead === originalSource && source.diff.length > 0), 'Actual repair input did not carry the previous real diff.');
  assert(repairInput.previousResults.some(previous => previous.runId === rejectedReview.reviewRunId && previous.result?.verdict === 'changes_requested' && previous.result.reviewedCommit === rejectedReview.candidateHead), 'Actual repair input did not carry the independent prior review report.');
  assert(repairAttempt.path !== originalAttempt.path && repairAttempt.baseCommit === originalSource, 'Repair did not get a fresh worktree from the preserved source.');
  assert(await readFile(path.join(originalAttempt.path, 'age.mjs'), 'utf8') === beforeRepair, 'Old attempt contents were changed during repair.');
  const firstAudit = await auditReviews(first);
  const finalAge = firstAudit.find(value => value.taskId === 'rework-age' && value.status === 'accepted');
  assert(finalAge?.expectedTargetHead === acceptedSibling, 'Repair candidate did not start from the latest accepted sibling HEAD.');
  const acceptedFirst = await host.git.currentHead({ workspace, workflow: first });
  assert((await git(repository, 'show', `${acceptedFirst}:label.mjs`)).includes('RIFT stable'), 'Final integration lost independent label output.');
  assert((await git(repository, 'show', `${acceptedFirst}:age.mjs`)).includes('18'), 'Final integration does not contain the corrected age boundary.');
  const fullBoundaryCheck = await exec(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import path from 'node:path'; import {pathToFileURL} from 'node:url'; const {classifyAge}=await import(pathToFileURL(path.resolve('age.mjs')).href); for(const age of [0,1,17]) assert.equal(classifyAge(age),'minor'); for(const age of [18,19,20,21,99]) assert.equal(classifyAge(age),'adult'); for(const age of [-1,1.5,'18',null]) assert.throws(()=>classifyAge(age),RangeError); console.log('Full age-boundary acceptance verified.');"], { cwd: finalAge!.reviewCheckout, windowsHide: true, timeout: 30_000 });
  coordinator.finish({ workflowId: first.id, summary: 'Real reviewer rejected the initial fixture; fresh repair and independent label both accepted.' });
  report.rework = { status: 'pass', workflowId: first.id, sharedOriginalBase: originalMain, originalSource, acceptedSibling, originalAttempt: originalAttempt.path, repairAttempt: repairAttempt.path, originalChildId: originalRun.dshChildId, repairChildId: repairRun.dshChildId, repairInputEvidence: { artifactId: inputArtifact.id, path: inputArtifactPath, sha256: inputArtifact.sha256, sourceDiffVerified: true, priorReviewVerified: true, currentTargetHead: repairInput.currentTargetHead }, finalHead: acceptedFirst, postAcceptanceSemanticCheck: { candidateHead: finalAge!.candidateHead, commandId: 'probe-full-age-boundary', exitCode: 0, stdout: fullBoundaryCheck.stdout }, reviews: firstAudit };

  const conflict = await create(`conflict-${randomUUID()}`, acceptedFirst, 'Two real sources conflict; preserve prior acceptance and continue an independent task.');
  coordinator.submitPlan({ workflowId: conflict.id, expectedRevision: 0, tasks: [
    { id: 'conflict-alpha', kind: 'change', title: 'Set shared value alpha', expectedPaths: ['shared.txt'], roleName: 'developer-a', acceptanceCriteria: ["shared.txt contains exactly alpha followed by one newline."], instructions: 'Use Edit/Write to replace shared.txt with exactly alpha followed by one newline.' },
    { id: 'conflict-beta', kind: 'change', title: 'Set shared value beta', expectedPaths: ['shared.txt'], roleName: 'developer-b', acceptanceCriteria: ["shared.txt contains exactly beta followed by one newline."], instructions: 'Use Edit/Write to replace shared.txt with exactly beta followed by one newline.' },
    { id: 'conflict-independent', kind: 'change', title: 'Preserve independent receipt', expectedPaths: ['receipt.mjs'], roleName: 'developer-a', acceptanceCriteria: ["receipt.mjs exports named constant receipt equal to 'independent kept'."], instructions: "Create receipt.mjs containing exactly: export const receipt = 'independent kept';" },
  ] });
  dispatch('conflict-alpha');
  // Pause immediately after reservation. The already admitted developer may
  // finish, while the coordinator must keep its new integration request queued.
  coordinator.pause(conflict.id);
  await until(() => host.store.task('conflict-alpha').status === 'validating' || settled('conflict-alpha'), 'alpha source while integration queue paused');
  assert(host.store.task('conflict-alpha').status === 'validating', 'Alpha did not produce a source before review.');
  dispatch('conflict-beta');
  // Both calls run in one JS turn: beta gets a persistent reservation, and any
  // alpha candidate cannot start its reviewer before the pause is visible.
  coordinator.resume(conflict.id); coordinator.pause(conflict.id);
  await until(() => host.store.task('conflict-beta').status === 'validating' || settled('conflict-beta'), 'beta source before alpha publication');
  assert(host.store.task('conflict-beta').status === 'validating', 'Beta did not produce the competing source.');
  const alphaTree = host.store.require<Worktree>("SELECT * FROM worktrees WHERE task_id='conflict-alpha' AND kind='task'");
  const betaTree = host.store.require<Worktree>("SELECT * FROM worktrees WHERE task_id='conflict-beta' AND kind='task'");
  assert(alphaTree.baseCommit === betaTree.baseCommit && alphaTree.baseCommit === acceptedFirst, 'Conflict sources did not share the intended base.');
  coordinator.resume(conflict.id);
  await until(() => settled('conflict-alpha') && settled('conflict-beta'), 'alpha acceptance and actual beta merge conflict');
  assert(host.store.task('conflict-alpha').status === 'succeeded', 'Alpha was not accepted.');
  assert(host.store.task('conflict-beta').status === 'blocked' && host.store.task('conflict-beta').blockingReason?.includes('INTEGRATION_CONFLICT'), 'Beta was not blocked by an actual Git merge conflict.');
  const headAfterConflict = await host.git.currentHead({ workspace, workflow: conflict });
  assert(headAfterConflict === host.store.task('conflict-alpha').acceptedCommit, 'Conflict moved or rolled back the accepted integration ref.');
  dispatch('conflict-independent');
  await until(() => settled('conflict-independent'), 'independent task after conflicting task');
  assert(host.store.task('conflict-independent').status === 'succeeded', 'Conflict prevented independent work from integrating.');
  const finalHead = await host.git.currentHead({ workspace, workflow: conflict });
  assert(await git(repository, 'show', `${finalHead}:shared.txt`) === 'alpha', 'The conflicting source polluted accepted shared content.');
  assert((await git(repository, 'show', `${finalHead}:receipt.mjs`)).includes('independent kept'), 'Independent receipt is absent.');
  assert((await git(repository, 'show', `${finalHead}:label.mjs`)).includes('RIFT stable'), 'The second workflow lost prior accepted results.');
  report.conflict = { status: 'pass', workflowId: conflict.id, sharedBase: alphaTree.baseCommit, blockedTask: host.store.task('conflict-beta'), headAfterConflict, finalHead, reviews: await auditReviews(conflict) };
  // The deliberately conflicting task remains blocked; cancellation closes the
  // fixture without inventing a successful completion of that workflow.
  await coordinator.cancelWorkflow(conflict.id); activeWorkflow = undefined;
  assert(await git(repository, 'rev-parse', 'main') === originalMain, 'The original main branch moved.');
  assert(await git(repository, 'remote') === '', 'Unexpected remote configuration.');
  report.defaultBranchUnchanged = true;
} catch (error) { failed = true; report.error = redact(String(error)); }
finally {
  if (service) {
    if (activeWorkflow && !['completed', 'cancelled', 'failed'].includes(service.store.workflow(activeWorkflow.id).status)) {
      try { await service.coordinator.cancelWorkflow(activeWorkflow.id); }
      catch (error) { failed = true; report.cancelError = redact(String(error)); }
    }
    report.workflows = workflows.map(workflowId => ({ status: service!.coordinator.status(workflowId), events: service!.store.events(workflowId) }));
    try { await service.close(); report.businessCleanup = 'confirmed'; }
    catch (error) { failed = true; report.businessCleanup = 'failed'; report.businessCleanupError = redact(String(error)); }
  }
  if (dsh) {
    try { await dsh.shutdown.shutdown(failed ? 1 : 0); report.hostCleanup = 'confirmed'; }
    catch (error) { failed = true; report.hostCleanup = 'failed'; report.hostCleanupError = redact(String(error)); }
  }
  const lockRemains = await access(path.join(process.env.RIFT_HOME, 'rift.db.host.lock')).then(() => true, () => false);
  if (lockRemains) failed = true;
  report.databaseLockReleased = !lockRemains; report.status = failed ? 'fail' : 'pass'; report.exitCode = failed ? 1 : 0; report.endedAt = new Date().toISOString();
  process.exitCode = failed ? 1 : 0;
  const safe = (value: unknown): unknown => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, safe(nested)])) : value;
  const serialized = JSON.stringify(safe(report), null, 2);
  await writeFile(path.join(root, 'report.json'), serialized, { flag: 'wx' });
  await writeFile(path.join(evidenceRoot, `${probeId}.json`), serialized, { flag: 'wx' });
  await writeFile(path.join(evidenceRoot, 'review-rework-probe.json'), serialized);
  console.log(serialized);
}
