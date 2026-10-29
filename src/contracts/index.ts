import type { ErrorCode, Workspace, Role, Workflow, Task, Worktree } from '@rift/protocol';
export type { RoleName, RolePurpose, TaskStatus, WorkflowStatus, Workspace, Role, Workflow, Task, Worktree } from '@rift/protocol';
export type RunStatus = 'preparing' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type RunPurpose = 'develop' | 'repair' | 'review';
export interface ProviderBinding { id: string; providerName: string; packageVersion: string; configRevision: number; capabilities: Record<string, boolean>; credentialRefs: string[]; runtime?:'dsh'|'codex'|'claude'|null; model?:string|null; reasoningEffort?:string|null; spawn?:{provider:string;model:string;reasoningEffort?:string;agentPreset?:string;maxTokens?:number}|null }
export interface ProviderSnapshot { role: Role; binding: ProviderBinding | null; skills?: unknown[]; skillInstructions?: string }
export interface Run { id: string; taskId: string; roleId: string; purpose: RunPurpose; taskAttempt: number; status: RunStatus; providerSnapshot: ProviderSnapshot; dshChildId: string | null; dshRunId: string | null; stopReason: string | null; cleanupStatus: 'pending' | 'confirmed' | 'unknown' | 'failed'; slotReleasedAt: string | null; deadline: string; result: unknown; resultArtifactId?:string|null; createdAt: string; startedAt: string | null; endedAt: string | null }
export interface Operation { id: string; kind: 'dispatch' | 'integration'; dedupeKey: string; entityId: string; phase: 'queued' | 'started' | 'completed' | 'blocked' | 'cancelled'; payload: { expectedVersion: number; planRevision: number; roleId?: string; sourceHead?: string; runId?: string; integrationId?: string; error?: string }; createdAt: string }
export interface TaskEvent { eventSeq: number; workflowId: string; taskId: string | null; runId: string | null; requestId: string | null; type: string; payload: unknown; occurredAt: string }
export interface PlanTask { id?: string; repositoryId?: string; kind: 'change' | 'analysis'; title: string; instructions: string; expectedPaths?: string[]; acceptanceCriteria?: string[]; roleName?:string; dependsOn?: string[]; priority?:number; analysisItems?:{id:string;prompt:string}[] }
export interface DevelopmentResult { schemaVersion: 1; taskId: string; runId: string; outcome: 'completed' | 'blocked'; summary: string; changedPaths: string[]; checksClaimed: string[]; blockingReasons: string[] }
export interface ReviewResult { schemaVersion: 1; taskId: string; runId: string; verdict: 'approve' | 'changes_requested' | 'blocked'; reviewedCommit: string; findings: { severity: string; file: string; line: number; reason: string; suggestion: string }[] }
export interface ActivationResult { stopReason: string; text: string; diagnostic?: string; dshRunId?: string }
export interface ActivationHandle { childId: string; result: Promise<ActivationResult>; dispose(): Promise<void> }
/** Owns only DSH activation handles. A live parent is supplied by the host bridge. */
export interface ActivationBridge { start(input: { run: Run; task: Task; role: Role; cwd: string; repositoryAccess?: import('../agent/repository-access.js').RepositoryAccess; prompt: string; signal: AbortSignal; tools?: import('../agent/runtime-types.js').RuntimeTool[]; onEvent?:(event:import('../agent/runtime-types.js').RuntimeEvent)=>void; onProgress?:(event:import('../task/run-progress.js').RunActivity)=>void; onAccepted?():void }): Promise<ActivationHandle> }
export interface GitContext { workspace: Workspace; workflow: Workflow; task: Task }
export interface Candidate { baselines?: import('@rift/protocol').BaselineEvidence[]; timings?: import('@rift/protocol').StageTimings; taskAttempt?: number; integrationId: string; sourceHead: string; candidateHead: string; expectedTargetHead: string; cwd: string; checkIds: string[]; checks?: import('../git/types.js').CheckEvidence[]; readiness?: import('@rift/protocol').EvidenceReadiness }
/** Git facts are determined by the implementation, never by model claims. */
export interface GitService {
  prepareTask(input: GitContext & { run: Run }): Promise<Worktree>;
  collectSource(input: GitContext & { run: Run; worktree: Worktree; priorSource?: { sourceHead: string; baseCommit: string } }): Promise<{ sourceHead: string; diff: string; changedPaths: string[] }>;
  /** Production Git implementation proves analysis did not change HEAD or any checkout content. */
  verifyAnalysis?(input: GitContext & { run: Run; worktree: Worktree }): Promise<{headCommit:string}>;
  prepareCandidate(input: GitContext & { sourceHead: string; integrationId: string }): Promise<Candidate>;
  compareCandidates?(input: GitContext & { candidate: Candidate; previousCandidateHead: string }): Promise<{ fromCommit: string; toCommit: string; diff: string; changedPaths: string[]; truncated: boolean }>;
  resumeCandidate?(input: GitContext & { integrationId: string; candidateHead: string; idempotencyKey: string }): Promise<Candidate>;
  reconcileCandidateCleanup?(input: GitContext & { candidate: Candidate; previousBootId: string | null; currentBootId: string | null }): Promise<boolean>;
  reconcileCandidateEvidence?(input: GitContext & { candidate: Candidate; allowEvidenceRefresh: boolean }): Promise<Candidate>;
  candidateReadiness?(input: GitContext & { candidate: Candidate }): Promise<import('@rift/protocol').EvidenceReadiness>;
  publishCandidate(input: GitContext & { candidate: Candidate; review: ReviewResult }): Promise<{ acceptedCommit: string }>;
  containsCommit?(input: { workspace: Workspace; workflow: Workflow; commit: string }): Promise<boolean>;
  currentHead?(input: { workspace: Workspace; workflow: Workflow }): Promise<string>;
  recoverPublication?(input: GitContext & { candidate: Candidate }): Promise<'published' | 'not-published' | 'unknown'>;
  abandonCandidate?(input: GitContext & { candidate: Candidate; reason: string }): Promise<void>;
}
export class RiftError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) { super(message); this.name = 'RiftError'; }
}
export function invariant(condition: unknown, code: ErrorCode, message: string): asserts condition { if (!condition) throw new RiftError(code, message); }
