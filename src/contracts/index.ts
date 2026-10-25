export type RoleName = string;
export type RolePurpose = 'lead' | 'developer' | 'reviewer';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'validating' | 'integrating' | 'succeeded' | 'blocked' | 'failed' | 'cancelled';
export type WorkflowStatus = 'created' | 'planning' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'preparing' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type RunPurpose = 'develop' | 'repair' | 'review';
export interface Workspace { id: string; version?: number; defaultRepositoryId?: string | null; defaultConversationId?: string | null; leadConnection?: import('../chat/contracts.js').ChatConnection | null; name: string; rootPath: string; repositoryPath: string; commonGitDir: string; baseRef: string; status: string }
export interface ProviderBinding { id: string; providerName: string; packageVersion: string; configRevision: number; capabilities: Record<string, boolean>; credentialRefs: string[]; runtime?:'dsh'|'codex'|'claude'|null; model?:string|null; spawn?:{provider:string;model:string;reasoningEffort?:string;agentPreset?:string;maxTokens?:number}|null }
export interface Role { id: string; workspaceId: string; name: RoleName; purpose?:RolePurpose; enabled?:number; kind: 'dsh-lead' | 'subagent'; providerBindingId: string | null; prompt: string; revision: number }
export interface ProviderSnapshot { role: Role; binding: ProviderBinding | null; skills?: unknown[]; skillInstructions?: string }
export interface Workflow { id: string; workspaceId: string; goal: string; leadSessionId: string | null; planRevision: number; version: number; status: WorkflowStatus; integrationRef: string; baseCommit: string; summary: string | null }
export interface Task { id: string; workflowId: string; roleId: string | null; repositoryId?: string | null; kind: 'change' | 'analysis'; title: string; instructions: string; expectedPaths: string[]; acceptanceCriteria: string[]; priority?:number; analysisItems?:{id:string;prompt:string}[]|null; status: TaskStatus; attempt: number; version: number; acceptedCommit: string | null; sourceHead: string | null; blockingReason: string | null }
export interface Run { id: string; taskId: string; roleId: string; purpose: RunPurpose; taskAttempt: number; status: RunStatus; providerSnapshot: ProviderSnapshot; dshChildId: string | null; dshRunId: string | null; stopReason: string | null; cleanupStatus: 'pending' | 'confirmed' | 'unknown' | 'failed'; slotReleasedAt: string | null; deadline: string; result: unknown; resultArtifactId?:string|null; createdAt: string; startedAt: string | null; endedAt: string | null }
export interface Worktree { id: string; taskId: string; attempt: number; kind: 'task' | 'review' | 'candidate'; path: string; branch?: string; baseCommit: string; headCommit?: string; writerRunId?: string | null; status?: string }
export interface Operation { id: string; kind: 'dispatch' | 'integration'; dedupeKey: string; entityId: string; phase: 'queued' | 'started' | 'completed' | 'blocked' | 'cancelled'; payload: { expectedVersion: number; planRevision: number; roleId?: string; sourceHead?: string; runId?: string; integrationId?: string; error?: string }; createdAt: string }
export interface TaskEvent { eventSeq: number; workflowId: string; taskId: string | null; runId: string | null; requestId: string | null; type: string; payload: unknown; occurredAt: string }
export interface PlanTask { id?: string; repositoryId?: string; kind: 'change' | 'analysis'; title: string; instructions: string; expectedPaths: string[]; acceptanceCriteria?: string[]; roleName?:string; dependsOn?: string[]; priority?:number; analysisItems?:{id:string;prompt:string}[] }
export interface DevelopmentResult { schemaVersion: 1; taskId: string; runId: string; outcome: 'completed' | 'blocked'; summary: string; changedPaths: string[]; checksClaimed: string[]; blockingReasons: string[] }
export interface ReviewResult { schemaVersion: 1; taskId: string; runId: string; verdict: 'approve' | 'changes_requested' | 'blocked'; reviewedCommit: string; findings: { severity: string; file: string; line: number; reason: string; suggestion: string }[] }
export interface ActivationResult { stopReason: string; text: string; dshRunId?: string }
export interface ActivationHandle { childId: string; result: Promise<ActivationResult>; dispose(): Promise<void> }
/** Owns only DSH activation handles. A live parent is supplied by the host bridge. */
export interface ActivationBridge { start(input: { run: Run; task: Task; role: Role; cwd: string; prompt: string; signal: AbortSignal }): Promise<ActivationHandle> }
export interface GitContext { workspace: Workspace; workflow: Workflow; task: Task }
export interface Candidate { integrationId: string; sourceHead: string; candidateHead: string; expectedTargetHead: string; cwd: string; checkIds: string[] }
/** Git facts are determined by the implementation, never by model claims. */
export interface GitService {
  prepareTask(input: GitContext & { run: Run }): Promise<Worktree>;
  collectSource(input: GitContext & { run: Run; worktree: Worktree }): Promise<{ sourceHead: string; diff: string; changedPaths: string[] }>;
  /** Production Git implementation proves analysis did not change HEAD or any checkout content. */
  verifyAnalysis?(input: GitContext & { run: Run; worktree: Worktree }): Promise<{headCommit:string}>;
  prepareCandidate(input: GitContext & { sourceHead: string; integrationId: string }): Promise<Candidate>;
  publishCandidate(input: GitContext & { candidate: Candidate; review: ReviewResult }): Promise<{ acceptedCommit: string }>;
  containsCommit?(input: { workspace: Workspace; workflow: Workflow; commit: string }): Promise<boolean>;
  currentHead?(input: { workspace: Workspace; workflow: Workflow }): Promise<string>;
  recoverPublication?(input: GitContext & { candidate: Candidate }): Promise<'published' | 'not-published' | 'unknown'>;
  abandonCandidate?(input: GitContext & { candidate: Candidate; reason: string }): Promise<void>;
}
export class RiftError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'RiftError'; }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new RiftError(code, message); }
