import { provesPreviousBootExited } from '../agent/boot-identity.js';
import { sandboxCommand } from '../agent/filesystem-sandbox.js';
import { mkdir, readFile, open, rename, realpath, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { EvidenceBinding, EvidenceReadiness } from '@rift/protocol';
import { bindingOf, candidateCleanupUnknown, candidateMatchesTask, CandidateEvidenceError, configurationFingerprint, environmentFingerprint, evidenceReadiness, fingerprint } from './evidence.js';
import type { Candidate, GitContext, GitService, ReviewResult, Run, Worktree, Workflow, Workspace } from '../contracts/index.js';
import { execute, git, gitOk, stageSourcePaths, worktreePorcelain } from './process.js';
import { assertSafeFiles, checkoutClean, sourceCheckoutClean, sourceUntrackedFiles, inspectRepository, key, managedPath, withMetadataLock } from './worktree-binding.js';
import { parseReviewReport } from './quality-gate.js';
import { redact, redactionTailLength } from '../api/security.js';
import type { CheckCommand, CheckEvidence, GitOperation } from './types.js';

export interface LocalGitOptions { managedRoot: string; commands?: readonly CheckCommand[]; checkIds?: readonly string[] }
/** Logical integration ownership lives until publish or explicit, cleanup-confirmed abandon. */
const integrationOwners = new Map<string, string>();
export class LocalGitService implements GitService {
  readonly managedRoot: string;
  private readonly commands = new Map<string, CheckCommand>();
  private readonly checkIds: readonly string[];
  constructor(options: LocalGitOptions) {
    this.managedRoot = path.resolve(options.managedRoot);
    if ((options.commands?.length ?? 0) > 64) throw new Error('INVALID_CHECK_CONFIG: maximum 64 commands');
    for (const command of options.commands ?? []) {
      if (!command.id || command.id.length > 160 || this.commands.has(command.id) || !command.executable || command.executable.length > 4096 || !Array.isArray(command.args) || command.args.length > 64 || command.args.some(arg => typeof arg !== 'string' || arg.length > 4096) || Buffer.byteLength(JSON.stringify(command.args)) > 65_536 || command.required !== undefined && typeof command.required !== 'boolean' || (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 3_600_000))) throw new Error('INVALID_CHECK_CONFIG');
      this.commands.set(command.id, { ...command, args: [...command.args] });
    }
    this.checkIds = options.checkIds ? [...options.checkIds] : [...this.commands.keys()];
    if (this.checkIds.length > 64 || new Set(this.checkIds).size !== this.checkIds.length) throw new Error('INVALID_CHECK_CONFIG');
    for (const id of this.checkIds) if (!this.commands.has(id)) throw new Error(`UNKNOWN_CHECK: ${id}`);
  }
  async inspectRepository(repositoryPath: string, baseRef: string) { return inspectRepository(repositoryPath, baseRef); }
  private ref(workflow: Workflow): string {
    if (!/^refs\/heads\/rift\/[A-Za-z0-9_./-]+$/.test(workflow.integrationRef) || workflow.integrationRef.includes('..')) throw new Error('UNSAFE_REF: only RIFT integration refs may be updated');
    return workflow.integrationRef;
  }
  async ensureIntegration(workspace: Workspace, workflow: Workflow): Promise<string> {
    const ref = this.ref(workflow);
    const common = await realpath(await gitOk(workspace.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    return withMetadataLock(common, async () => {
      const current = await git(workspace.repositoryPath, ['rev-parse', '--verify', ref]);
      if (current.exitCode === 0) return current.stdout.trim();
      const base = await gitOk(workspace.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${workflow.baseCommit}^{commit}`]);
      await gitOk(workspace.repositoryPath, ['update-ref', ref, base, '0'.repeat(base.length)]);
      return base;
    });
  }
  private async directory(workspace: Workspace, kind: string, id: string): Promise<string> {
    await mkdir(this.managedRoot, { recursive: true });
    const root = await realpath(this.managedRoot), target = path.join(root, key(workspace.id), kind, key(id));
    if (await managedPath(root, target) !== target) throw new Error('UNSAFE_EVIDENCE_PATH: aliased workspace directory');
    return target;
  }
  private async record(workspace: Workspace, operation: GitOperation): Promise<void> {
    const directory = await this.directory(workspace, 'operations', operation.integrationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Atomic replace keeps the last completed phase readable after interruption.
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    const safeOperation = { ...operation, ...(operation.reason ? { reason: redact(operation.reason) } : {}), ...(operation.review ? { review: { ...operation.review, findings: operation.review.findings.map(finding => ({ ...finding, reason: redact(finding.reason), suggestion: redact(finding.suggestion) })) } } : {}) };
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(safeOperation, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path.join(directory, 'operation.json'));
  }
  private async readEvidenceFile(directory: string, name: string): Promise<string> {
    if (!/^(?:operation|[a-f0-9-]{36})\.json$/.test(name)) throw new Error('UNSAFE_EVIDENCE_PATH');
    await managedPath(this.managedRoot, directory);
    const file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16_777_216) throw new Error('EVIDENCE_SIZE_LIMIT');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }
  async readOperation(workspace: Workspace, integrationId: string): Promise<GitOperation> {
    const directory = await this.directory(workspace, 'operations', integrationId);
    const operation = JSON.parse(await this.readEvidenceFile(directory, 'operation.json')) as GitOperation;
    if (operation.integrationId !== integrationId || operation.binding && (operation.binding.workspaceId !== workspace.id || operation.binding.integrationId !== integrationId || operation.binding.taskId !== operation.taskId || operation.binding.candidateHead !== operation.candidateHead)) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
    for (const check of operation.checks ?? []) {
      if (!check.host) continue; // Legacy evidence stays readable, never promoted to trusted attachments.
      const saved = JSON.parse(await this.readEvidenceFile(directory, `${check.id}.json`));
      if (fingerprint(saved) !== fingerprint(check) || check.host.executionSource !== 'host' || check.host.schemaVersion !== 1 || fingerprint(bindingOf(check.host)) !== fingerprint(operation.binding) || check.host.logSha256 !== fingerprint({ stdout: check.stdout, stderr: check.stderr })) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
    }
    return operation;
  }
  async readCheckEvidence(input: GitContext & { integrationId: string; checkId: string }): Promise<CheckEvidence> {
    const operation = await this.readOperation(input.workspace, input.integrationId);
    if (operation.taskId !== input.task.id || !operation.binding) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
    await this.assertBinding({ ...input, task: { ...input.task, attempt: operation.binding.attempt, sourceHead: operation.sourceHead } }, operation, operation.candidateHead!);
    if (!/^[a-f0-9-]{36}$/.test(input.checkId)) throw new Error('UNSAFE_EVIDENCE_PATH');
    const check = JSON.parse(await this.readEvidenceFile(await this.directory(input.workspace, 'operations', input.integrationId), `${input.checkId}.json`)) as CheckEvidence;
    if (check.id !== input.checkId || check.host?.executionSource !== 'host' || check.host.schemaVersion !== 1 || fingerprint(bindingOf(check.host)) !== fingerprint(operation.binding) || check.host.logSha256 !== fingerprint({ stdout: check.stdout, stderr: check.stderr })) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
    return check;
  }
  async compareCandidates(input: GitContext & { candidate: Candidate; previousCandidateHead: string }) {
    const from=input.previousCandidateHead,to=input.candidate.candidateHead;
    if(!/^[a-f0-9]{40,64}$/.test(from)||!/^[a-f0-9]{40,64}$/.test(to))throw new Error('INVALID_COMMIT');
    const diff=await gitOk(input.workspace.repositoryPath,['diff','--no-ext-diff','--no-textconv',from,to,'--']);
    const names=await gitOk(input.workspace.repositoryPath,['diff','--no-ext-diff','--no-textconv','--name-only','-z',from,to,'--']);
    return {fromCommit:from,toCommit:to,diff:redact(diff,24000),changedPaths:names.split('\0').filter(Boolean),truncated:diff.length>24000};
  }
  private selectedCommands(): CheckCommand[] { return this.checkIds.map(id => this.commands.get(id)!); }
  private candidate(operation: GitOperation): Candidate {
    const checks = operation.checks ?? [];
    return { taskAttempt: operation.binding?.attempt, integrationId: operation.integrationId, sourceHead: operation.sourceHead, candidateHead: operation.candidateHead!, expectedTargetHead: operation.expectedTargetHead, cwd: operation.reviewPath, checkIds: checks.map(check => check.id), readiness: evidenceReadiness(operation, this.selectedCommands()), checks: checks.map(check => ({ ...check, stdout: check.stdout.slice(0, 8000), stderr: check.stderr.slice(0, 8000), truncated: check.truncated || check.stdout.length > 8000 || check.stderr.length > 8000 })) };
  }
  private async assertBinding(input: GitContext, operation: GitOperation, candidateHead: string): Promise<void> {
    const repository = await inspectRepository(input.workspace.repositoryPath, input.workflow.baseCommit);
    const expected: EvidenceBinding = { workspaceId: input.workspace.id, repositoryId: input.task.repositoryId ?? fingerprint(repository.commonGitDir), repositoryFingerprint: fingerprint(repository.commonGitDir), taskId: input.task.id, attempt: input.task.attempt, integrationId: operation.integrationId, candidateHead };
    if (fingerprint(expected) !== fingerprint(operation.binding) || operation.integrationRef !== this.ref(input.workflow) || operation.sourceHead !== input.task.sourceHead && input.task.sourceHead !== null) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
    for (const [kind, cwd] of [['candidates', operation.candidatePath], ['reviews', operation.reviewPath]] as const) {
      if (cwd !== await this.directory(input.workspace, kind, operation.integrationId)) throw new Error('UNSAFE_EVIDENCE_PATH');
    }
  }
  async candidateReadiness(input: GitContext & { candidate: Candidate }): Promise<EvidenceReadiness> {
    const operation = await this.readOperation(input.workspace, input.candidate.integrationId);
    if (!operation.binding) {
      if (operation.taskId !== input.task.id || operation.candidateHead !== input.candidate.candidateHead) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
      return this.operationReadiness(operation);
    }
    await this.assertBinding(input, operation, input.candidate.candidateHead);
    return this.operationReadiness(operation);
  }
  private async operationReadiness(operation: GitOperation): Promise<EvidenceReadiness> {
    try {
      await readFile(await this.quarantinePath(operation.candidatePath));
      operation.checkCleanup = 'unknown';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return evidenceReadiness(operation, this.selectedCommands());
  }
  private async assertCheckCleanup(workspace: Workspace, operation: GitOperation): Promise<void> {
    const readiness = await this.operationReadiness(operation);
    if (candidateCleanupUnknown(operation)) throw new CandidateEvidenceError(this.candidate(operation), readiness, true);
  }
  async reconcileCandidateCleanup(input: GitContext & { candidate: Candidate; previousBootId: string | null; currentBootId: string | null }): Promise<boolean> {
    const operation = await this.readOperation(input.workspace, input.candidate.integrationId);
    await this.assertRecoveryBinding(input, operation);
    await this.operationReadiness(operation);
    if (!candidateCleanupUnknown(operation)) return !!operation.cleanupRebootProof;
    if (!provesPreviousBootExited(input.previousBootId, input.currentBootId)) throw new Error('CLEANUP_UNKNOWN: same-machine OS reboot proof required');
    await unlink(await this.quarantinePath(operation.candidatePath)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    operation.checkCleanup = 'confirmed';
    operation.cleanupRebootProof = { previousBootId: input.previousBootId!, currentBootId: input.currentBootId! };
    await this.record(input.workspace, operation);
    return true;
  }
  private async assertRecoveryBinding(input: GitContext & { candidate: Candidate }, operation: GitOperation): Promise<void> {
    this.verifyCandidateIdentity(operation, input.candidate, input.task.id, input.workflow.integrationRef);
    const attempt = input.candidate.taskAttempt ?? input.candidate.checks?.find(check => check.host)?.host?.attempt;
    if (attempt === undefined) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
    // Historical cleanup uses the saved candidate's attempt, never the operation's self-declared attempt.
    await this.assertBinding({ ...input, task: { ...input.task, attempt, sourceHead: input.candidate.sourceHead } }, operation, input.candidate.candidateHead);
  }
  async reconcileCandidateEvidence(input: GitContext & { candidate: Candidate; allowEvidenceRefresh: boolean }): Promise<Candidate> {
    const operation = await this.readOperation(input.workspace, input.candidate.integrationId);
    await this.assertRecoveryBinding(input, operation);
    await this.assertCheckCleanup(input.workspace, operation);
    const latest = this.candidate(operation);
    if (JSON.stringify(latest.checkIds) !== JSON.stringify(input.candidate.checkIds)) {
      // Check generations may advance only before review; publication retains exact check-ID verification.
      if (operation.checkCleanup !== 'confirmed' || !input.allowEvidenceRefresh || !candidateMatchesTask(input.candidate, input.task) || operation.review || !['candidate_created', 'checks_recorded', 'blocked'].includes(operation.phase) || !operation.checks?.every(check => check.host)) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
      for (const checkId of input.candidate.checkIds) {
        const prior = await this.readCheckEvidence({ ...input, integrationId: input.candidate.integrationId, checkId });
        if (!operation.checks.some(check => check.commandId === prior.commandId)) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
      }
    }
    return latest;
  }
  private async checkCandidate(input: GitContext, operation: GitOperation): Promise<Candidate> {
    const repository = await inspectRepository(input.workspace.repositoryPath, input.workflow.baseCommit);
    const candidatePath = await managedPath(this.managedRoot, operation.candidatePath);
    await this.assertCheckCleanup(input.workspace, operation);
    if (await gitOk(candidatePath, ['rev-parse', 'HEAD']) !== operation.candidateHead || !(await sourceCheckoutClean(candidatePath))) throw new Error('CHECK_MODIFIED_CANDIDATE: changes preserved');
    for (const command of this.selectedCommands()) {
      const prior = operation.checks?.findLast(check => check.commandId === command.id);
      if (prior?.host?.exitStatus === 'passed' && prior.exitCode === 0 && prior.host.configurationFingerprint === configurationFingerprint(command) && prior.host.environmentFingerprint === environmentFingerprint()) continue;
      // Persist before spawning: interruption is not proof that descendants exited.
      operation.checkCleanup = 'unknown';
      await this.record(input.workspace, operation);
      const startedAt = new Date().toISOString();
      let result: import('./process.js').CommandResult, unavailable = false;
      try {
        const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        const sandbox = await sandboxCommand([await realpath(candidatePath)], candidatePath, [command.executable, ...command.args].map(quote).join(' '), [], { signal: AbortSignal.timeout(command.timeoutMs ?? 120_000), readOnlyRoots: [repository.commonGitDir] });
        result = await execute(sandbox[0]!, sandbox.slice(1), candidatePath, { timeoutMs: command.timeoutMs ?? 120_000, maxOutputBytes: 65_536, env: Object.fromEntries(Object.keys(process.env).map(name => [name, undefined])) });
        unavailable = result.exitCode === 126 || result.exitCode === 127 || result.exitCode !== 0 && result.stderr.startsWith('bwrap:');
      } catch (error) {
        unavailable = true;
        result = { exitCode: 125, stdout: '', stderr: redact(String(error), 8000), truncated: false };
      }
      // A capture boundary can split a registered credential: omit the unverified tail after redaction.
      const safeLog = (raw: string) => { const safe = redact(raw, 1_048_576); return result.truncated ? safe.slice(0, Math.max(0, safe.length - redactionTailLength())) + '\n[TRUNCATED]' : safe; };
      const stdout = safeLog(result.stdout), stderr = safeLog(result.stderr);
      const exitStatus = result.exitCode === 124 ? 'timed_out' : unavailable ? 'environment_unavailable' : result.exitCode === 0 ? 'passed' : 'failed';
      const check: CheckEvidence = { id: randomUUID(), commandId: command.id, candidateHead: operation.candidateHead!, ...result, stdout, stderr, startedAt, finishedAt: new Date().toISOString(), host: { ...operation.binding!, schemaVersion: 1, executionSource: 'host', command: { executable: redact(command.executable, 8000), args: command.args.map(arg => redact(arg, 8000)), timeoutMs: command.timeoutMs ?? 120_000 }, configurationFingerprint: configurationFingerprint(command), environmentFingerprint: environmentFingerprint(), exitStatus, logSha256: fingerprint({ stdout, stderr }), summary: `${command.id}: ${exitStatus} (exit ${result.exitCode})` } };
      const directory = await this.directory(input.workspace, 'operations', operation.integrationId);
      const file = await open(path.join(directory, `${check.id}.json`), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(check)); await file.sync(); } finally { await file.close(); }
      // Latest result for each command; previous immutable attachments remain available by ID.
      operation.checks = [...(operation.checks ?? []).filter(item => item.commandId !== command.id), check];
      operation.checkCleanup = result.exitCode === 124 ? 'unknown' : 'confirmed';
      operation.phase = 'checks_recorded'; operation.readiness = evidenceReadiness(operation, this.selectedCommands());
      await this.record(input.workspace, operation);
      if (result.exitCode === 124) { await this.quarantine(candidatePath, 'CHECK_TIMEOUT_CLEANUP_UNKNOWN: inspect descendant processes before archive'); break; }
      if (await gitOk(candidatePath, ['rev-parse', 'HEAD']) !== operation.candidateHead || !(await sourceCheckoutClean(candidatePath))) throw new Error('CHECK_MODIFIED_CANDIDATE: changes preserved');
    }
    await this.assertCheckCleanup(input.workspace, operation);
    const candidate = this.candidate(operation);
    if (candidate.readiness!.status !== 'ready') throw new CandidateEvidenceError(candidate, candidate.readiness!);
    try { await lstat(operation.reviewPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await withMetadataLock(repository.commonGitDir, async () => { await mkdir(path.dirname(operation.reviewPath), { recursive: true }); await gitOk(repository.rootPath, ['worktree', 'add', '--detach', '--', operation.reviewPath, operation.candidateHead!]); });
    }
    if (await gitOk(operation.reviewPath, ['rev-parse', 'HEAD']) !== operation.candidateHead || !(await sourceCheckoutClean(operation.reviewPath))) throw new Error('REVIEW_MODIFIED_CHECKOUT');
    return candidate;
  }
  async resumeCandidate(input: GitContext & { integrationId: string; candidateHead: string; idempotencyKey: string }): Promise<Candidate> {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 160) throw new Error('INVALID_DEDUPE_KEY');
    const repository = await inspectRepository(input.workspace.repositoryPath, input.workflow.baseCommit);
    const ownerKey = `${repository.commonGitDir}:${this.ref(input.workflow)}`;
    if (integrationOwners.has(ownerKey)) throw new Error('INTEGRATION_BUSY');
    integrationOwners.set(ownerKey, input.integrationId);
    try {
      const operation = await this.readOperation(input.workspace, input.integrationId);
      await this.assertBinding(input, operation, input.candidateHead);
      await this.assertCheckCleanup(input.workspace, operation);
      if (operation.review || ['publish_planned', 'ref_published', 'completed'].includes(operation.phase)) throw new Error('INVALID_STATE: reviewed candidates cannot be supplemented');
      if (await this.currentHead(input) !== operation.expectedTargetHead) throw new Error('STALE_TARGET: new candidate and independent review required');
      const requests = operation.evidenceRequests ??= {};
      const requestKey = fingerprint(input.idempotencyKey);
      const prior = requests[requestKey];
      if (prior) {
        if (prior.candidateHead !== input.candidateHead) throw new Error('IDEMPOTENCY_CONFLICT');
        if (!prior.complete) throw new Error('REQUEST_PENDING: interrupted check will not be automatically repeated');
        const candidate = this.candidate(operation);
        if (candidate.readiness!.status !== 'ready') throw new CandidateEvidenceError(candidate, candidate.readiness!);
        for (const cwd of [operation.candidatePath, operation.reviewPath]) if (await gitOk(cwd, ['rev-parse', 'HEAD']) !== operation.candidateHead || !(await sourceCheckoutClean(cwd))) throw new Error('CHECK_MODIFIED_CANDIDATE');
        return candidate;
      }
      if (Object.keys(requests).length >= 100) throw new Error('EVIDENCE_REQUEST_LIMIT');
      requests[requestKey] = { candidateHead: input.candidateHead, complete: false };
      await this.record(input.workspace, operation);
      try { return await this.checkCandidate(input, operation); }
      catch (error) {
        if (candidateCleanupUnknown(operation)) throw new CandidateEvidenceError(this.candidate(operation), evidenceReadiness(operation, this.selectedCommands()), true);
        throw error;
      }
      finally { requests[requestKey]!.complete = true; await this.record(input.workspace, operation); }
    } finally { integrationOwners.delete(ownerKey); }
  }
  private async quarantinePath(cwd: string): Promise<string> {
    const root = await realpath(this.managedRoot);
    return managedPath(root, path.join(root, 'quarantine', `${key(await realpath(cwd))}.json`));
  }
  private async quarantine(cwd: string, reason: string): Promise<void> {
    const destination = await this.quarantinePath(cwd);
    await mkdir(path.dirname(destination), { recursive: true });
    const file = await open(destination, 'w');
    try { await file.writeFile(JSON.stringify({ cwd, reason, createdAt: new Date().toISOString() })); await file.sync(); } finally { await file.close(); }
  }
  async prepareTask(input: GitContext & { run: Run }): Promise<Worktree> {
    const { workspace, workflow, task, run } = input;
    const repository = await inspectRepository(workspace.repositoryPath, workflow.baseCommit);
    const baseCommit = task.attempt > 1 && task.sourceHead ? task.sourceHead : await this.ensureIntegration(workspace, workflow);
    const id = `${task.id}:${task.attempt}`;
    const cwd = await this.directory(workspace, 'worktrees', id);
    const branch = `rift/${key(workspace.id)}/${key(task.id)}/${task.attempt}`;
    await withMetadataLock(repository.commonGitDir, async () => {
      await mkdir(path.dirname(cwd), { recursive: true });
      // An existing checkout is never silently reused: its writer may be unknown.
      await gitOk(repository.rootPath, ['worktree', 'add', '-b', branch, '--', cwd, baseCommit]);
    });
    return { id, taskId: task.id, attempt: task.attempt, kind: 'task', path: cwd, branch, baseCommit, headCommit: baseCommit, writerRunId: run.id, status: 'active' };
  }
  async collectSource(input: GitContext & { run: Run; worktree: Worktree; priorSource?: { sourceHead: string; baseCommit: string } }): Promise<{ sourceHead: string; diff: string; changedPaths: string[] }> {
    const { workspace, task, run, worktree } = input;
    if (run.cleanupStatus !== 'confirmed' || worktree.taskId !== task.id || worktree.attempt !== task.attempt || worktree.writerRunId !== run.id) throw new Error('WORKTREE_OWNERSHIP: cleanup and exclusive writer required');
    const cwd = await managedPath(this.managedRoot, worktree.path);
    const expectedCommon = (await inspectRepository(workspace.repositoryPath, worktree.baseCommit)).commonGitDir;
    const actualRepository = await inspectRepository(cwd, worktree.baseCommit);
    if (actualRepository.commonGitDir !== expectedCommon || actualRepository.rootPath !== await realpath(cwd)) throw new Error('WORKTREE_OWNERSHIP: repository mismatch');
    await gitOk(cwd, ['merge-base', '--is-ancestor', worktree.baseCommit, 'HEAD']);
    const split = (value: string): string[] => value.split('\0').filter(Boolean);
    let comparisonBase = worktree.baseCommit;
    let reusedSource = false;
    let changedPaths = [...new Set([
      ...split((await git(cwd, ['diff', '--name-only', '-z', '--no-renames', worktree.baseCommit, '--'])).stdout),
      ...split((await git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', worktree.baseCommit, '--'])).stdout),
      ...await sourceUntrackedFiles(cwd),
    ])].sort();
    if (!changedPaths.length) {
      const head = await gitOk(cwd, ['rev-parse', 'HEAD']);
      const prior = input.priorSource;
      // A Host infrastructure retry may have no new edits. Reuse only the
      // already collected source proven by this task's durable collection
      // event, never an empty first attempt or an arbitrary committed HEAD.
      if (task.attempt <= 1 || !prior || prior.sourceHead !== task.sourceHead || head !== task.sourceHead || worktree.baseCommit !== head || !/^[a-f0-9]{40,64}$/.test(prior.baseCommit)) throw new Error('EMPTY_CHANGE: no new diff or verified prior source');
      await gitOk(cwd, ['merge-base', '--is-ancestor', prior.baseCommit, head]);
      comparisonBase = prior.baseCommit;
      changedPaths = split((await git(cwd, ['diff', '--name-only', '-z', '--no-renames', comparisonBase, head, '--'])).stdout).sort();
      reusedSource = true;
    }
    await assertSafeFiles(cwd, changedPaths);
    // expectedPaths is legacy planning metadata, never a file allowlist.
    if (!changedPaths.length) throw new Error('EMPTY_CHANGE: change task has no actual diff');
    if (!reusedSource) {
      await stageSourcePaths(cwd,changedPaths);
      const staged = await git(cwd, ['diff', '--cached', '--quiet']);
      if (staged.exitCode === 1) await gitOk(cwd, ['-c', 'user.name=RIFT', '-c', 'user.email=rift@localhost', 'commit', '-m', `RIFT task ${task.id} attempt ${task.attempt}`]);
      else if (staged.exitCode !== 0) throw new Error('SOURCE_INDEX_INVALID');
    }
    const sourceHead = await gitOk(cwd, ['rev-parse', 'HEAD']);
    const diff = await gitOk(cwd, ['diff', '--no-ext-diff', '--no-textconv', comparisonBase, sourceHead, '--']);
    if (!diff) throw new Error('EMPTY_CHANGE: final source has no actual diff from its attempt base');
    return { sourceHead, diff, changedPaths };
  }
  async verifyAnalysis(input:GitContext & {run:Run;worktree:Worktree}):Promise<{headCommit:string}> {
    const {workspace,task,run,worktree}=input;
    if(task.kind!=='analysis'||run.cleanupStatus!=='confirmed'||worktree.taskId!==task.id||worktree.attempt!==task.attempt||worktree.writerRunId!==run.id)throw new Error('WORKTREE_OWNERSHIP: analysis requires confirmed cleanup and its exclusive checkout');
    const cwd=await managedPath(this.managedRoot,worktree.path);
    const expected=await inspectRepository(workspace.repositoryPath,worktree.baseCommit),actual=await inspectRepository(cwd,worktree.baseCommit);
    if(actual.commonGitDir!==expected.commonGitDir||actual.rootPath!==await realpath(cwd))throw new Error('WORKTREE_OWNERSHIP: analysis repository mismatch');
    const headCommit=await gitOk(cwd,['rev-parse','HEAD']);
    const status=await gitOk(cwd,['status','--porcelain=v1','--untracked-files=all','--ignored']);
    if(headCommit!==worktree.baseCommit||status)throw new Error(`ANALYSIS_MODIFIED_CHECKOUT: expected HEAD ${worktree.baseCommit}; actual HEAD ${headCommit}; changes preserved for inspection${status?`\n${status}`:''}`);
    return {headCommit};
  }
  async prepareCandidate(input: GitContext & { sourceHead: string; integrationId: string }): Promise<Candidate> {
    const { workspace, workflow, task, integrationId } = input;
    const repository = await inspectRepository(workspace.repositoryPath, workflow.baseCommit);
    const ownerKey = `${repository.commonGitDir}:${this.ref(workflow)}`;
    if (integrationOwners.has(ownerKey)) throw new Error('INTEGRATION_BUSY');
    integrationOwners.set(ownerKey, integrationId);
    let operation: GitOperation | undefined;
    try {
      const sourceHead = await gitOk(repository.rootPath, ['rev-parse', '--verify', '--end-of-options', `${input.sourceHead}^{commit}`]);
      const expectedTargetHead = await this.ensureIntegration(workspace, workflow);
      const candidatePath = await this.directory(workspace, 'candidates', integrationId);
      const reviewPath = await this.directory(workspace, 'reviews', integrationId);
      operation = { integrationId, taskId: task.id, integrationRef: this.ref(workflow), sourceHead, expectedTargetHead, candidatePath, reviewPath, phase: 'candidate_planned' };
      await this.record(workspace, operation);
      await withMetadataLock(repository.commonGitDir, async () => { await mkdir(path.dirname(candidatePath), { recursive: true }); await gitOk(repository.rootPath, ['worktree', 'add', '--detach', '--', candidatePath, expectedTargetHead]); });
      const merge = await git(candidatePath, ['-c', 'user.name=RIFT', '-c', 'user.email=rift@localhost', 'merge', '--no-ff', '--no-edit', sourceHead]);
      if (merge.exitCode !== 0) {
        const conflictedPaths = await gitOk(candidatePath, ['diff', '--name-only', '--diff-filter=U']);
        const detail = [merge.stdout.trim(), merge.stderr.trim(), conflictedPaths ? `Conflicted paths:\n${conflictedPaths}` : ''].filter(Boolean).join('\n');
        throw new Error(`${conflictedPaths ? 'INTEGRATION_CONFLICT' : 'INTEGRATION_FAILED'}: ${detail}`);
      }
      const candidateHead = await gitOk(candidatePath, ['rev-parse', 'HEAD']);
      operation = { ...operation, candidateHead, binding: { workspaceId: workspace.id, repositoryId: task.repositoryId ?? fingerprint(repository.commonGitDir), repositoryFingerprint: fingerprint(repository.commonGitDir), taskId: task.id, attempt: task.attempt, integrationId, candidateHead }, phase: 'candidate_created' }; await this.record(workspace, operation);
      return await this.checkCandidate(input, operation);
    } catch (error) {
      if (operation) await this.record(workspace, { ...operation, phase: 'blocked', reason: String(error) });
      integrationOwners.delete(ownerKey);
      if (operation && candidateCleanupUnknown(operation)) throw new CandidateEvidenceError(this.candidate(operation), evidenceReadiness(operation, this.selectedCommands()), true);
      throw error;
    }
  }
  async publishCandidate(input: GitContext & { candidate: Candidate; review: ReviewResult }): Promise<{ acceptedCommit: string }> {
    const { workspace, workflow, task, candidate } = input;
    const repository = await inspectRepository(workspace.repositoryPath, workflow.baseCommit);
    const ownerKey = `${repository.commonGitDir}:${this.ref(workflow)}`;
    if (integrationOwners.has(ownerKey) && integrationOwners.get(ownerKey) !== candidate.integrationId) throw new Error('INTEGRATION_OWNERSHIP');
    let operation = await this.readOperation(workspace, candidate.integrationId);
    await this.assertBinding(input, operation, candidate.candidateHead);
    await this.assertCheckCleanup(workspace, operation);
    if (evidenceReadiness(operation, this.selectedCommands()).status !== 'ready') throw new Error('EVIDENCE_NOT_READY');
    integrationOwners.set(ownerKey, candidate.integrationId);
    let published = false;
    try {
      this.verifyCandidate(operation, candidate, task.id, workflow.integrationRef);
      const review = parseReviewReport(JSON.stringify(input.review), { taskId: task.id, runId: input.review.runId, candidateHead: candidate.candidateHead });
      operation = { ...operation, review, phase: 'review_recorded' }; await this.record(workspace, operation);
      if (review.verdict !== 'approve') throw new Error('REVIEW_REJECTED');
      for (const cwd of [operation.candidatePath, operation.reviewPath]) {
        await managedPath(this.managedRoot, cwd);
        if (await gitOk(cwd, ['rev-parse', 'HEAD']) !== candidate.candidateHead || !(await sourceCheckoutClean(cwd))) throw new Error('REVIEW_MODIFIED_CHECKOUT');
      }
      operation = { ...operation, phase: 'publish_planned' }; await this.record(workspace, operation);
      await withMetadataLock(repository.commonGitDir,async()=>{
        const checkedOut = await gitOk(repository.rootPath, ['worktree', 'list', '--porcelain']);
        if (checkedOut.split('\n').includes(`branch ${this.ref(workflow)}`)) throw new Error('INTEGRATION_REF_CHECKED_OUT');
        const update = await git(repository.rootPath, ['update-ref', this.ref(workflow), candidate.candidateHead, candidate.expectedTargetHead]);
        if (update.exitCode !== 0) throw new Error('STALE_TARGET: rebuild candidate and rerun checks/review');
      });
      published = true;
      operation = { ...operation, phase: 'ref_published' };
      // publish_planned was flushed before update-ref; failure to advance the
      // journal cannot undo a successful Git transaction or invalidate its gate.
      await this.record(workspace, operation).catch(() => undefined);
      // The coordinator persists business acceptance; recovery can complete that gap.
      return { acceptedCommit: candidate.candidateHead };
    } catch (error) { if (!published) await this.record(workspace, { ...operation, phase: 'blocked', reason: String(error) }); throw error; }
    finally { integrationOwners.delete(ownerKey); }
  }
  private verifyCandidateIdentity(operation: GitOperation, candidate: Candidate, taskId: string, integrationRef: string): void {
    if (operation.integrationId !== candidate.integrationId || operation.taskId !== taskId || operation.integrationRef !== integrationRef || operation.sourceHead !== candidate.sourceHead || operation.candidateHead !== candidate.candidateHead || operation.expectedTargetHead !== candidate.expectedTargetHead || operation.reviewPath !== candidate.cwd || (operation.checks??[]).some(check => check.candidateHead !== candidate.candidateHead)) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
  }
  private verifyCandidate(operation: GitOperation, candidate: Candidate, taskId: string, integrationRef: string): void {
    this.verifyCandidateIdentity(operation, candidate, taskId, integrationRef);
    if (JSON.stringify((operation.checks??[]).map(check => check.id)) !== JSON.stringify(candidate.checkIds)) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
  }
  async abandonCandidate(input: GitContext & { candidate: Candidate; reason: string }): Promise<void> {
    const repository = await inspectRepository(input.workspace.repositoryPath, input.workflow.baseCommit);
    const ownerKey = `${repository.commonGitDir}:${this.ref(input.workflow)}`;
    const operation = await this.readOperation(input.workspace, input.candidate.integrationId);
    if (['publish_planned', 'ref_published', 'completed'].includes(operation.phase) && await this.recoverPublication(input) === 'published') {
      if (integrationOwners.get(ownerKey) === input.candidate.integrationId) integrationOwners.delete(ownerKey);
      return;
    }
    await this.record(input.workspace, { ...operation, phase: 'blocked', reason: input.reason });
    if (integrationOwners.get(ownerKey) === input.candidate.integrationId) integrationOwners.delete(ownerKey);
  }
  async containsCommit(input: { workspace: Workspace; workflow: Workflow; commit: string }): Promise<boolean> {
    const head = await this.ensureIntegration(input.workspace, input.workflow);
    return (await git(input.workspace.repositoryPath, ['merge-base', '--is-ancestor', input.commit, head])).exitCode === 0;
  }
  async currentHead(input: { workspace: Workspace; workflow: Workflow }): Promise<string> {
    return this.ensureIntegration(input.workspace, input.workflow);
  }
  async recoverPublication(input: GitContext & { candidate: Candidate }): Promise<'published' | 'not-published' | 'unknown'> {
    try {
      const operation = await this.readOperation(input.workspace, input.candidate.integrationId);
      this.verifyCandidate(operation, input.candidate, input.task.id, input.workflow.integrationRef);
      const head = await gitOk(input.workspace.repositoryPath, ['rev-parse', '--verify', this.ref(input.workflow)]);
      if (head === input.candidate.candidateHead && ['publish_planned', 'ref_published', 'completed'].includes(operation.phase)) return (await this.operationReadiness(operation)).status === 'ready' ? 'published' : 'unknown';
      if (head === input.candidate.expectedTargetHead) return 'not-published';
      return 'unknown';
    } catch { return 'unknown'; }
  }
  /** Validation is also used to explain disabled deletion actions in the UI. */
  async inspectWorktreeRemoval(workspace: Workspace, worktree: Worktree): Promise<{ cwd: string; commonGitDir: string; rootPath: string; headCommit: string }> {
    const cwd = await managedPath(this.managedRoot, worktree.path);
    const repository = await inspectRepository(workspace.repositoryPath, worktree.baseCommit);
    if (workspace.commonGitDir && repository.commonGitDir !== await realpath(workspace.commonGitDir)) throw new Error('ARCHIVE_BLOCKED: repository ownership changed');
    const actual = await inspectRepository(cwd, worktree.baseCommit);
    if (actual.commonGitDir !== repository.commonGitDir || actual.rootPath !== await realpath(cwd)) throw new Error('ARCHIVE_BLOCKED: worktree repository mismatch');
    // A primary checkout may itself be below managedRoot. Path containment alone
    // is not proof that it is a disposable linked worktree.
    const gitDir = await realpath(await gitOk(cwd, ['rev-parse', '--absolute-git-dir']));
    if (actual.rootPath === repository.rootPath || gitDir === actual.commonGitDir) throw new Error('ARCHIVE_BLOCKED: primary repository checkout');
    const registered = await worktreePorcelain(repository.rootPath);
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const entry = registered.split('\0\0').find(block => block.split('\0').some(field => field.startsWith('worktree ') && normalize(field.slice(9)) === normalize(cwd)));
    if (!entry) throw new Error('ARCHIVE_BLOCKED: unregistered worktree');
    if (entry.split('\0').some(field => field === 'locked' || field.startsWith('locked '))) throw new Error('ARCHIVE_BLOCKED: locked worktree');
    // status alone can hide modified tracked files with index trust flags.
    const index = await gitOk(cwd, ['ls-files', '-v', '-z']);
    if (index.split('\0').some(field => field && (field[0] === 'S' || /^[a-z]/.test(field)))) throw new Error('ARCHIVE_BLOCKED: assume-unchanged or skip-worktree index entries');
    for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG']) {
      const file = path.join(gitDir, marker);
      try { await lstat(file); throw new Error('ARCHIVE_BLOCKED: unfinished Git operation'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { await readFile(await this.quarantinePath(cwd)); throw new Error('ARCHIVE_BLOCKED: prior check timed out; descendant cleanup is unconfirmed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!(await checkoutClean(cwd))) throw new Error('ARCHIVE_BLOCKED: dirty, untracked or ignored content');
    return { cwd, commonGitDir: repository.commonGitDir, rootPath: repository.rootPath, headCommit: await gitOk(cwd, ['rev-parse', 'HEAD']) };
  }
  async archiveWorktree(input: { workspace: Workspace; worktree: Worktree; active: boolean; cleanupConfirmed: boolean; artifactsSaved: boolean; beforeRemove?: (evidence: { headCommit: string; preservationRef: string }) => Promise<void> | void }): Promise<void> {
    if (input.active || !input.cleanupConfirmed || !input.artifactsSaved) throw new Error('ARCHIVE_BLOCKED: execution cleanup and saved artifacts required');
    const repository = await inspectRepository(input.workspace.repositoryPath, input.worktree.baseCommit);
    await withMetadataLock(repository.commonGitDir, async () => {
      const target = await this.inspectWorktreeRemoval(input.workspace, input.worktree);
      // Detached candidate/review HEADs also need a durable reachability root.
      // Never delete a branch, integration ref or operation/check/review evidence.
      const preservationRef = `refs/rift/deleted-worktrees/${key(target.cwd)}/${target.headCommit}`;
      await gitOk(target.rootPath, ['update-ref', preservationRef, target.headCommit]);
      await input.beforeRemove?.({ headCommit: target.headCommit, preservationRef });
      const final = await this.inspectWorktreeRemoval(input.workspace, input.worktree);
      if (final.cwd !== target.cwd || final.headCommit !== target.headCommit || final.commonGitDir !== target.commonGitDir) throw new Error('ARCHIVE_BLOCKED: worktree changed during deletion verification');
      await gitOk(target.rootPath, ['worktree', 'remove', '--', target.cwd]);
    });
  }
}
