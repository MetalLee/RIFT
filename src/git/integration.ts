import { sandboxCommand } from '../agent/filesystem-sandbox.js';
import { mkdir, readFile, open, rename, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Candidate, GitContext, GitService, ReviewResult, Run, Worktree, Workflow, Workspace } from '../contracts/index.js';
import { execute, git, gitOk, stageSourcePaths, worktreePorcelain } from './process.js';
import { assertSafeFiles, checkoutClean, sourceCheckoutClean, sourceUntrackedFiles, inspectRepository, key, managedPath, withMetadataLock } from './worktree-binding.js';
import { parseReviewReport } from './quality-gate.js';
import { redact } from '../api/security.js';
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
    for (const command of options.commands ?? []) {
      if (!command.id || this.commands.has(command.id) || !command.executable || !Array.isArray(command.args)) throw new Error('INVALID_CHECK_CONFIG');
      this.commands.set(command.id, { ...command, args: [...command.args] });
    }
    this.checkIds = options.checkIds ? [...options.checkIds] : [...this.commands.keys()];
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
    return managedPath(await realpath(this.managedRoot), path.join(await realpath(this.managedRoot), key(workspace.id), kind, key(id)));
  }
  private async record(workspace: Workspace, operation: GitOperation): Promise<void> {
    const directory = await this.directory(workspace, 'operations', operation.integrationId);
    await mkdir(directory, { recursive: true });
    // Atomic replace keeps the last completed phase readable after interruption.
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    const safeOperation = { ...operation, ...(operation.reason ? { reason: redact(operation.reason) } : {}), ...(operation.review ? { review: { ...operation.review, findings: operation.review.findings.map(finding => ({ ...finding, reason: redact(finding.reason), suggestion: redact(finding.suggestion) })) } } : {}) };
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(safeOperation, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path.join(directory, 'operation.json'));
  }
  async readOperation(workspace: Workspace, integrationId: string): Promise<GitOperation> {
    return JSON.parse(await readFile(path.join(await this.directory(workspace, 'operations', integrationId), 'operation.json'), 'utf8')) as GitOperation;
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
      if (!this.checkIds.length) throw new Error('NO_CHECKS_CONFIGURED: configure at least one deterministic check');
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
      operation = { ...operation, candidateHead, phase: 'candidate_created' }; await this.record(workspace, operation);
      const checks: CheckEvidence[] = [];
      for (const id of this.checkIds) {
        const command = this.commands.get(id)!;
        const startedAt = new Date().toISOString();
        const quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
        const sandbox=await sandboxCommand([await realpath(candidatePath)],candidatePath,[command.executable,...command.args].map(quote).join(' '),[],{signal:AbortSignal.timeout(command.timeoutMs??120000),readOnlyRoots:[repository.commonGitDir]});
        const result = await execute(sandbox[0]!, sandbox.slice(1), candidatePath, { timeoutMs: command.timeoutMs ?? 120_000, env:Object.fromEntries(Object.keys(process.env).map(name=>[name,undefined])) });
        checks.push({ id: randomUUID(), commandId: id, candidateHead, ...result, stdout: redact(result.stdout, 1_048_576), stderr: redact(result.stderr, 1_048_576), startedAt, finishedAt: new Date().toISOString() });
        operation = { ...operation, checks, phase: 'checks_recorded' }; await this.record(workspace, operation);
        if (result.exitCode === 124) await this.quarantine(candidatePath, 'CHECK_TIMEOUT_CLEANUP_UNKNOWN: inspect descendant processes before archive');
        if (result.exitCode !== 0) throw new Error(`CHECK_FAILED: ${id} (${result.exitCode})`);
        if (await gitOk(candidatePath, ['rev-parse', 'HEAD']) !== candidateHead || !(await sourceCheckoutClean(candidatePath))) throw new Error('CHECK_MODIFIED_CANDIDATE: changes preserved');
      }
      await withMetadataLock(repository.commonGitDir, async () => { await mkdir(path.dirname(reviewPath), { recursive: true }); await gitOk(repository.rootPath, ['worktree', 'add', '--detach', '--', reviewPath, candidateHead]); });
      // Review receives committed Host evidence, never the developer's claims.
      // The full bounded logs remain in the durable Git operation; the prompt
      // carries an explicitly truncated excerpt for each exact candidate check.
      return { integrationId, sourceHead, candidateHead, expectedTargetHead, cwd: reviewPath, checkIds: checks.map(check => check.id), checks: checks.map(check => ({...check,stdout:check.stdout.slice(0,8000),stderr:check.stderr.slice(0,8000),truncated:check.truncated||check.stdout.length>8000||check.stderr.length>8000})) };
    } catch (error) {
      if (operation) await this.record(workspace, { ...operation, phase: 'blocked', reason: String(error) });
      integrationOwners.delete(ownerKey); throw error;
    }
  }
  async publishCandidate(input: GitContext & { candidate: Candidate; review: ReviewResult }): Promise<{ acceptedCommit: string }> {
    const { workspace, workflow, task, candidate } = input;
    const repository = await inspectRepository(workspace.repositoryPath, workflow.baseCommit);
    const ownerKey = `${repository.commonGitDir}:${this.ref(workflow)}`;
    if (integrationOwners.get(ownerKey) !== candidate.integrationId) throw new Error('INTEGRATION_OWNERSHIP');
    let operation = await this.readOperation(workspace, candidate.integrationId);
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
  private verifyCandidate(operation: GitOperation, candidate: Candidate, taskId: string, integrationRef: string): void {
    if (operation.taskId !== taskId || operation.integrationRef !== integrationRef || operation.sourceHead !== candidate.sourceHead || operation.candidateHead !== candidate.candidateHead || operation.expectedTargetHead !== candidate.expectedTargetHead || operation.reviewPath !== candidate.cwd || !operation.checks?.length || operation.checks.some(check => check.candidateHead !== candidate.candidateHead || check.exitCode !== 0) || JSON.stringify(operation.checks.map(check => check.id)) !== JSON.stringify(candidate.checkIds)) throw new Error('CANDIDATE_EVIDENCE_MISMATCH');
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
      if (head === input.candidate.candidateHead && ['publish_planned', 'ref_published', 'completed'].includes(operation.phase)) return 'published';
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
