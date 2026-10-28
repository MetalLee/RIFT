import type { RemovalKind, WorktreeRemovalTarget } from '@rift/protocol';
export type { RemovalKind, WorktreeRemovalTarget } from '@rift/protocol';
import type { AgentTurn } from '../chat/contracts.js';
import { realpathSync } from 'node:fs';
import { containsPath } from '../api/workspace-paths.js';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { invariant, type Task, type Worktree, type Workspace } from '../contracts/index.js';
import type { LocalGitService } from '../git/integration.js';
import { gitOk, worktreePorcelain } from '../git/process.js';
import { key, managedPath, withMetadataLock } from '../git/worktree-binding.js';
import { provesPreviousBootExited } from '../agent/boot-identity.js';
import { now, type RiftStore } from '../storage/database.js';
import { redact } from '../api/security.js';
import type { Repository, WorkspaceWorktree } from './repositories.js';

/** Host-bound execution identity; never accepted from a command JSON body. */
export interface WorktreeRemovalActor { turnId: string; agentId: string }

interface Receipt {
  kind: RemovalKind; recordId: string; workspaceId: string; repositoryId: string; path: string;
  state: string; version: number; sourceFingerprint: string; cleanupStatus: string;
  runtimeBootId: string | null; error: string | null;
}
interface Target {
  kind: RemovalKind; recordId: string; repo: Repository; workspace: Workspace;
  tree: Worktree; task?: Task; user?: WorkspaceWorktree; fingerprint: string; metadataFingerprint: string; operationPhase?: string;
}
interface IntegrationRecord { taskId: string; sourceHead: string; expectedTargetHead: string | null; candidateHead: string | null; status: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uncertain = (error: unknown) => /\(124\)|timed out|cleanup.*unconfirmed/i.test(String(error));

/** Record IDs, never caller-supplied paths, select disposable managed checkouts. */
export class WorktreeRemovalService {
  private bootIdentity: string | null = null;
  constructor(private readonly store: RiftStore, private readonly git: LocalGitService) {}
  setBootIdentity(identity: string | null): void { this.bootIdentity = identity; }
  private receipt(kind: RemovalKind, recordId: string): Receipt | undefined {
    return this.store.get('SELECT * FROM worktree_removals WHERE kind=? AND record_id=?', kind, recordId);
  }
  private metadata(workspaceId: string, kind: RemovalKind, recordId: string) {
    const workspace = this.store.workspace(workspaceId);
    const source = kind === 'user'
      ? this.store.require<WorkspaceWorktree>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND id=?', workspaceId, recordId)
      : kind === 'task'
        ? this.store.require<Worktree>('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? AND w.id=?', workspaceId, recordId)
        : this.store.require<IntegrationRecord>('SELECT i.* FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? AND i.id=?', workspaceId, recordId);
    const task = kind === 'user' ? undefined : this.store.task((source as Worktree | IntegrationRecord).taskId);
    const repositoryId = kind === 'user' ? (source as WorkspaceWorktree).repositoryId : task!.repositoryId ?? workspace.defaultRepositoryId;
    const repo = this.store.require<Repository>('SELECT * FROM repositories WHERE workspace_id=? AND id=?', workspaceId, repositoryId ?? '');
    return { workspace, source, task, repo, fingerprint: hash([source, task, task && this.store.workflow(task.workflowId), repo]) };
  }
  private assertCurrent(target: Target): void {
    invariant(this.metadata(target.workspace.id, target.kind, target.recordId).fingerprint === target.metadataFingerprint,
      'VERSION_CONFLICT', '目录或任务在删除核对期间发生变化，请刷新。');
  }
  private async resolve(workspaceId: string, kind: RemovalKind, recordId: string): Promise<Target> {
    const { workspace, source, task, repo, fingerprint: metadataFingerprint } = this.metadata(workspaceId, kind, recordId);
    let user: WorkspaceWorktree | undefined, operation: unknown, tree: Worktree, operationPhase: string | undefined;
    if (kind === 'user') {
      user = source as WorkspaceWorktree;
      tree = { id: recordId, taskId: '', attempt: 0, kind: 'task', path: user.path, baseCommit: user.baseCommit };
    } else {
      tree = source as Worktree;
    }
    const scopedWorkspace = { ...workspace, repositoryPath: repo.canonicalPath, commonGitDir: repo.commonGitDir, baseRef: repo.baseRef };
    if (kind === 'task') {
      const expected = path.join(this.git.managedRoot, key(workspaceId), 'worktrees', key(tree.id));
      invariant(tree.kind === 'task' && await managedPath(this.git.managedRoot, tree.path) === await managedPath(this.git.managedRoot, expected), 'WORKTREE_OWNERSHIP', 'Task path does not match its managed record ID.');
    }
    if (kind === 'candidate' || kind === 'review') {
      const saved = await this.git.readOperation(scopedWorkspace, recordId);
      invariant(saved.integrationId === recordId && saved.taskId === task!.id && saved.sourceHead === (source as { sourceHead: string }).sourceHead, 'WORKTREE_OWNERSHIP', 'Candidate operation does not match its integration record.');
      const integration = source as IntegrationRecord;
      // Publication deliberately ends at ref_published; business acceptance is
      // committed separately. Never mistake a still-publishing journal for an
      // accepted integration, or treat accepted rows alone as operation proof.
      if (integration.status === 'accepted') {
        invariant(['ref_published','completed'].includes(saved.phase) && saved.candidateHead === integration.candidateHead && saved.expectedTargetHead === integration.expectedTargetHead,
          'CLEANUP_UNKNOWN', '候选发布与接受证据不一致，必须先核对。');
        operationPhase = 'completed';
      } else operationPhase = saved.phase;
      operation = saved;
      tree = { id: recordId, taskId: task!.id, attempt: task!.attempt, kind, path: kind === 'candidate' ? saved.candidatePath : saved.reviewPath, baseCommit: saved.expectedTargetHead };
      const expected = path.join(this.git.managedRoot, key(workspaceId), kind === 'candidate' ? 'candidates' : 'reviews', key(recordId));
      invariant(await managedPath(this.git.managedRoot, tree.path) === await managedPath(this.git.managedRoot, expected), 'WORKTREE_OWNERSHIP', 'Candidate path does not match its managed record ID.');
    }
    return { kind, recordId, repo, workspace: scopedWorkspace, tree, task, user, operationPhase, metadataFingerprint,
      fingerprint: hash([metadataFingerprint, operation]) };
  }
  private version(target: Target, receipt = this.receipt(target.kind, target.recordId)): string {
    return hash([target.fingerprint, receipt?.version ?? 0]);
  }
  async versionFor(workspaceId: string, kind: RemovalKind, recordId: string): Promise<string> {
    return this.version(await this.resolve(workspaceId, kind, recordId));
  }
  private initiatingLead(target: Target, actor?: WorktreeRemovalActor): { turnId: string; leaseId: string } {
    if (!actor) return { turnId: '', leaseId: '' };
    const turn = this.store.get<AgentTurn>('SELECT * FROM agent_turns WHERE id=? AND workspace_id=? AND agent_id=?', actor.turnId, target.workspace.id, actor.agentId);
    invariant(turn?.status === 'running' && turn.configuration.agent.purpose === 'lead' && !turn.configuration.conversationTitle,
      'UNAUTHORIZED', 'Worktree cleanup requires this workspace’s live Lead execution.');
    const role = this.store.role(actor.agentId);
    invariant(role.workspaceId === target.workspace.id && role.purpose === 'lead' && role.enabled !== 0, 'UNAUTHORIZED', 'The current workspace Lead must own this request.');
    const lease = this.store.get<{id:string}>("SELECT id FROM execution_leases WHERE owner_type='turn' AND owner_id=? AND workspace_id=? AND agent_id=? AND capacity='lead' AND released_at IS NULL AND cleanup_status='pending'", turn.id, target.workspace.id, actor.agentId);
    invariant(lease, 'UNAUTHORIZED', 'The requesting Lead no longer holds its live execution lease.');
    const decision = this.store.get<{status:string;ownerVersion:number;currentVersion:number}>(`SELECT d.status,d.owner_version,c.version current_version FROM coordination_decisions d JOIN workflow_conversations c ON c.workflow_id=d.workflow_id WHERE d.turn_id=?`, turn.id);
    invariant(!decision || decision.status === 'active' && decision.ownerVersion === decision.currentVersion, 'DECISION_EXPIRED', 'The requesting Lead decision has ended or yielded.');
    const cwd = turn.configuration.runtimeAccess?.cwd;
    invariant(cwd && path.isAbsolute(cwd), 'UNAUTHORIZED', 'The Lead execution directory must be known before worktree cleanup.');
    invariant(!containsPath(target.tree.path, realpathSync(cwd)), 'WORKTREE_IN_USE', 'The Lead cannot remove its own execution directory.');
    return { turnId: turn.id, leaseId: lease.id };
  }
  private guard(target: Target, actor?: WorktreeRemovalActor): void {
    const requester = this.initiatingLead(target, actor);
    const { repo, task, user, tree } = target;
    if (target.operationPhase) invariant(['completed','blocked'].includes(target.operationPhase), 'CLEANUP_UNKNOWN', '候选 Git 操作尚未终结，必须先核对执行清理。');
    if (user) {
      invariant(user.origin === 'managed', 'WORKTREE_OWNERSHIP', '外部目录只能解除关联，不会删除磁盘目录。');
      invariant(user.status === 'active' && !user.pendingPath, 'WORKTREE_STATE_UNKNOWN', '目录已删除或创建/移动操作尚未完成，请先核对。');
    }
    if (task) {
      invariant(tree.status !== 'archived', 'INVALID_STATE', '磁盘目录已删除，任务证据已保留。');
      invariant(['completed','failed','cancelled'].includes(this.store.workflow(task.workflowId).status), 'WORKTREE_IN_USE', '流程尚未终结，目录仍可能用于执行或恢复。');
      invariant(['succeeded','failed','cancelled'].includes(task.status), 'WORKTREE_IN_USE', '任务尚未终结，目录仍可能用于执行或恢复。');
      invariant(!tree.writerRunId, 'WORKTREE_IN_USE', '目录仍有关联写入者。');
      invariant(!this.store.get("SELECT id FROM runs WHERE task_id=? AND (cleanup_status<>'confirmed' OR slot_released_at IS NULL OR status NOT IN ('succeeded','failed','cancelled','interrupted'))", task.id), 'CLEANUP_UNKNOWN', '任务执行尚未确认清理。');
    }
    // Conservative repository-wide exclusion includes other workspace aliases,
    // discussion writers, legacy Runs, finalizers and unconfirmed integrations.
    invariant(!this.store.get(`SELECT l.id FROM execution_leases l JOIN repositories r ON r.workspace_id=l.workspace_id WHERE r.common_git_dir=? AND (l.released_at IS NULL OR l.cleanup_status<>'confirmed') AND l.id<>?`, repo.commonGitDir, requester.leaseId), 'WORKTREE_IN_USE', '仓库仍有执行租约或未确认的清理。');
    invariant(!this.store.get(`SELECT a.id FROM agent_turns a JOIN repositories r ON r.workspace_id=a.workspace_id WHERE r.common_git_dir=? AND a.status IN ('queued','running','stopping') AND a.id<>?`, repo.commonGitDir, requester.turnId), 'WORKTREE_IN_USE', '仓库仍有排队或活跃的讨论执行。');
    invariant(!this.store.get(`SELECT run.id FROM runs run JOIN tasks t ON t.id=run.task_id JOIN workflows f ON f.id=t.workflow_id JOIN repositories r ON r.workspace_id=f.workspace_id WHERE r.common_git_dir=? AND (run.cleanup_status<>'confirmed' OR run.slot_released_at IS NULL OR run.status IN ('preparing','running','cancelling'))`, repo.commonGitDir), 'CLEANUP_UNKNOWN', '仓库执行清理尚未确认。');
    invariant(!this.store.get(`SELECT o.id FROM operations o JOIN tasks t ON t.id=o.entity_id JOIN workflows f ON f.id=t.workflow_id JOIN repositories r ON r.workspace_id=f.workspace_id WHERE r.common_git_dir=? AND o.phase IN ('queued','started')`, repo.commonGitDir), 'WORKTREE_IN_USE', '仓库仍有未完成的任务操作或结果收集。');
    invariant(!this.store.get(`SELECT i.id FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows f ON f.id=t.workflow_id JOIN repositories r ON r.workspace_id=f.workspace_id WHERE r.common_git_dir=? AND i.status NOT IN ('accepted','blocked')`, repo.commonGitDir), 'CLEANUP_UNKNOWN', '仓库仍有未完成或清理未知的集成。');
    const blocked = this.store.all<{error:string|null}>(`SELECT i.error FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows f ON f.id=t.workflow_id JOIN repositories r ON r.workspace_id=f.workspace_id WHERE r.common_git_dir=? AND i.status='blocked'`, repo.commonGitDir);
    invariant(!blocked.some(row => row.error && uncertain(row.error)), 'CLEANUP_UNKNOWN', '仓库集成曾超时，子进程清理尚未确认。');
    invariant(!this.store.get(`SELECT w.id FROM worktrees w JOIN tasks t ON t.id=w.task_id JOIN workflows f ON f.id=t.workflow_id JOIN repositories r ON r.workspace_id=f.workspace_id WHERE r.common_git_dir=? AND w.writer_run_id IS NOT NULL`, repo.commonGitDir), 'WORKTREE_IN_USE', '仓库目录仍有写入者。');
    invariant(!this.store.get(`SELECT w.id FROM workspace_worktrees w JOIN repositories r ON r.id=w.repository_id WHERE r.common_git_dir=? AND (w.pending_path IS NOT NULL OR w.status IN ('creating','creation_unknown','moving','move_unknown'))`, repo.commonGitDir), 'WORKTREE_IN_USE', '请先核对仓库中未完成的目录操作。');
    invariant(!this.store.get(`SELECT d.record_id FROM worktree_removals d JOIN repositories r ON r.id=d.repository_id WHERE r.common_git_dir=? AND d.state IN ('deleting','unknown') AND NOT (d.kind=? AND d.record_id=?)`, repo.commonGitDir, target.kind, target.recordId), 'WORKTREE_IN_USE', '仓库有正在删除或清理未知的目录。');
    invariant(!this.store.get("SELECT id FROM workspace_worktrees WHERE path=? AND status='active' AND NOT (id=? AND ?='user')", tree.path, target.recordId, target.kind), 'WORKTREE_IN_USE', '此目录仍有其他活跃关联。');
  }
  private async targetView(target: Target, actor?: WorktreeRemovalActor): Promise<WorktreeRemovalTarget> {
    const receipt = this.receipt(target.kind, target.recordId);
    let reason: string | null = null;
    let state = receipt?.state ?? (target.user?.status === 'archived' || target.tree.status === 'archived' ? 'deleted' : 'available');
    try {
      // A manual cleanup is not a successful deletion receipt. Report absence
      // separately, and never hide an uncertain removal that needs reconciliation.
      if (!receipt && state === 'available') {
        try { await lstat(target.tree.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const registered = await worktreePorcelain(target.repo.canonicalPath);
          const samePath = (value: string) => path.resolve(value) === path.resolve(target.tree.path);
          if (!registered.split('\0').some(field => field.startsWith('worktree ') && samePath(field.slice(9)))) {
            state = 'missing';
            invariant(false, 'NOT_FOUND', '目录已不存在；任务和集成历史仍保留。');
          }
        }
      }
      invariant(!['deleting','unknown','deleted'].includes(state), 'WORKTREE_STATE_UNKNOWN', state === 'deleted' ? '磁盘目录已删除；分支、提交与记录已保留。' : '删除操作未完成，必须先核对清理证据。');
      this.guard(target, actor);
      await this.git.inspectWorktreeRemoval(target.workspace, target.tree);
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    return { kind: target.kind, recordId: target.recordId, repositoryId: target.repo.id, path: target.tree.path,
      expectedVersion: this.version(target, receipt), state, canDelete: reason === null, reason,
      error: receipt?.error ?? null, canReconcile: ['deleting','unknown','failed'].includes(state) };
  }
  async list(workspaceId: string, repositoryId: string, actor?: WorktreeRemovalActor): Promise<WorktreeRemovalTarget[]> {
    this.store.require('SELECT id FROM repositories WHERE workspace_id=? AND id=?', workspaceId, repositoryId);
    const ids: { kind: RemovalKind; id: string }[] = this.store.all<{id:string}>('SELECT id FROM workspace_worktrees WHERE workspace_id=? AND repository_id=?', workspaceId, repositoryId).map(row => ({ kind: 'user', id: row.id }));
    const tasks = this.store.all<{id:string}>(`SELECT t.id FROM tasks t JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? AND COALESCE(t.repository_id,(SELECT default_repository_id FROM workspaces WHERE id=?))=?`, workspaceId, workspaceId, repositoryId);
    for (const task of tasks) {
      ids.push(...this.store.all<{id:string}>('SELECT id FROM worktrees WHERE task_id=?', task.id).map(row => ({ kind: 'task' as const, id: row.id })));
      for (const row of this.store.all<{id:string}>('SELECT id FROM integrations WHERE task_id=?', task.id)) ids.push({ kind: 'candidate', id: row.id }, { kind: 'review', id: row.id });
    }
    const result: WorktreeRemovalTarget[] = [];
    for (const item of ids) {
      try { result.push(await this.targetView(await this.resolve(workspaceId, item.kind, item.id), actor)); }
      catch (error) {
        // Missing/corrupt operation evidence is never permission to infer a path.
        result.push({ kind: item.kind, recordId: item.id, repositoryId, path: '', expectedVersion: '', state: 'unavailable', canDelete: false, canReconcile: false, reason: `无法核对目录证据：${String(error)}`, error: null });
      }
    }
    return result;
  }
  async remove(workspaceId: string, kind: RemovalKind, recordId: string, input: { expectedVersion: string; confirmDelete: true }, actor?: WorktreeRemovalActor): Promise<WorktreeRemovalTarget> {
    invariant(input.confirmDelete === true, 'CONFIRMATION_REQUIRED', '必须明确确认删除磁盘目录。');
    const target = await this.resolve(workspaceId, kind, recordId);
    this.store.transaction(() => {
      this.assertCurrent(target);
      const prior = this.receipt(kind, recordId);
      invariant(this.version(target, prior) === input.expectedVersion, 'VERSION_CONFLICT', '目录状态已变化，请刷新后重新确认。');
      invariant(!prior || prior.state === 'failed', 'WORKTREE_IN_USE', '目录已删除或上次删除尚未确认。');
      this.guard(target, actor);
      this.store.exec(`INSERT INTO worktree_removals(kind,record_id,workspace_id,repository_id,task_id,path,state,source_fingerprint,cleanup_status,runtime_boot_id,updated_at) VALUES(?,?,?,?,?,?,'deleting',?,'pending',?,?) ON CONFLICT(kind,record_id) DO UPDATE SET state='deleting',version=version+1,repository_id=excluded.repository_id,task_id=excluded.task_id,path=excluded.path,head_commit=NULL,preservation_ref=NULL,source_fingerprint=excluded.source_fingerprint,cleanup_status='pending',runtime_boot_id=excluded.runtime_boot_id,error=NULL,updated_at=excluded.updated_at`, kind, recordId, workspaceId, target.repo.id, target.task?.id ?? null, target.tree.path, target.fingerprint, this.bootIdentity, now());
    });
    try {
      await this.git.archiveWorktree({ workspace: target.workspace, worktree: target.tree, active: false, cleanupConfirmed: true, artifactsSaved: true,
        beforeRemove: async evidence => {
          const current = await this.resolve(workspaceId, kind, recordId);
          this.store.transaction(() => {
            this.assertCurrent(current);
            invariant(current.fingerprint === target.fingerprint, 'VERSION_CONFLICT', '目录或任务在删除核对期间发生变化。');
            invariant(this.receipt(kind, recordId)?.state === 'deleting', 'WORKTREE_IN_USE', '删除操作已失去所有权。');
            this.guard(current, actor);
            this.store.exec('UPDATE worktree_removals SET head_commit=?,preservation_ref=?,updated_at=? WHERE kind=? AND record_id=?', evidence.headCommit, evidence.preservationRef, now(), kind, recordId);
          });
        } });
      this.complete(target);
    } catch (error) {
      const unknown = uncertain(error);
      this.store.exec('UPDATE worktree_removals SET state=?,cleanup_status=?,error=?,version=version+1,updated_at=? WHERE kind=? AND record_id=?', unknown ? 'unknown' : 'failed', unknown ? 'unknown' : 'confirmed', redact(String(error)), now(), kind, recordId);
      throw error;
    }
    return this.targetView(await this.resolve(workspaceId, kind, recordId), actor);
  }
  private complete(target: Target): void {
    this.store.transaction(() => {
      this.store.exec("UPDATE worktree_removals SET state='deleted',cleanup_status='confirmed',version=version+1,updated_at=? WHERE kind=? AND record_id=?", now(), target.kind, target.recordId);
      if (target.kind === 'user') this.store.exec("UPDATE workspace_worktrees SET status='archived',version=version+1 WHERE id=?", target.recordId);
      if (target.kind === 'task') this.store.exec("UPDATE worktrees SET status='archived' WHERE id=?", target.recordId);
      if (target.task) this.store.event(target.task.workflowId, 'worktree.deleted', { kind: target.kind, recordId: target.recordId, path: target.tree.path }, { taskId: target.task.id });
    });
  }
  async reconcile(workspaceId: string, kind: RemovalKind, recordId: string, expectedVersion: string): Promise<WorktreeRemovalTarget> {
    const target = await this.resolve(workspaceId, kind, recordId), receipt = this.receipt(kind, recordId);
    invariant(this.version(target, receipt) === expectedVersion, 'VERSION_CONFLICT', '目录状态已变化，请刷新。');
    invariant(receipt && ['deleting','unknown','failed'].includes(receipt.state), 'INVALID_STATE', '此目录不需要核对删除结果。');
    invariant(receipt.cleanupStatus === 'confirmed' || provesPreviousBootExited(receipt.runtimeBootId, this.bootIdentity), 'CLEANUP_UNKNOWN', '缺少进程退出证明；同一次系统启动或仅重启 Host 不能确认清理。');
    return withMetadataLock(target.repo.commonGitDir, async () => {
      const directory = await managedPath(this.git.managedRoot, receipt.path);
      invariant(receipt.repositoryId === target.repo.id && receipt.sourceFingerprint === target.fingerprint, 'VERSION_CONFLICT', '保存的删除对象或证据已变化，不能推断删除结果。');
      invariant(directory === await managedPath(this.git.managedRoot, target.tree.path), 'WORKTREE_OWNERSHIP', '保存的目标目录已变化。');
      const registered = await worktreePorcelain(target.repo.canonicalPath);
      const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      const found = registered.split('\0').some(field => field.startsWith('worktree ') && normalize(field.slice(9)) === normalize(directory));
      let exists = true;
      try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
      invariant(this.version(await this.resolve(workspaceId, kind, recordId)) === expectedVersion, 'VERSION_CONFLICT', '核对期间目录状态发生变化。');
      if (!exists && !found) {
        const evidence = this.store.require<{headCommit:string|null;preservationRef:string|null}>('SELECT head_commit,preservation_ref FROM worktree_removals WHERE kind=? AND record_id=?', kind, recordId);
        invariant(evidence.headCommit && evidence.preservationRef && await gitOk(target.repo.canonicalPath, ['rev-parse','--verify',evidence.preservationRef]) === evidence.headCommit,
          'CLEANUP_UNKNOWN', '缺少删除前已保存的提交证明，保留现场。');
        this.store.transaction(() => { this.assertCurrent(target); this.complete(target); });
      }
      else {
        invariant(exists && found, 'WORKTREE_STATE_UNKNOWN', '目录与 Git 注册状态不一致，保留现场。');
        await this.git.inspectWorktreeRemoval(target.workspace, target.tree);
        invariant(this.version(await this.resolve(workspaceId, kind, recordId)) === expectedVersion, 'VERSION_CONFLICT', '核对期间目录状态发生变化。');
        this.store.exec("UPDATE worktree_removals SET state='failed',cleanup_status='confirmed',version=version+1,updated_at=? WHERE kind=? AND record_id=?", now(), kind, recordId);
      }
      return this.targetView(await this.resolve(workspaceId, kind, recordId));
    });
  }
}
