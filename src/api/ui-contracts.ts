/** Browser wire DTOs. No runtime/server imports and no credential values. */
import type { Role, Task, Workflow, Workspace, Worktree } from '../contracts/index.js';
import type { ChatConnection, Conversation } from '../chat/contracts.js';
import type { BrowserAgent } from '../project/browser-agents.js';
import type { WorkspaceWorktree } from '../project/repositories.js';

export interface UiSession { csrfToken: string; expiresAt: string }
export interface UiCapability { available: boolean; reason: string }
export interface UiCapabilities {
  workspaceCreate: UiCapability;
  chat: UiCapability;
  agentConfiguration: UiCapability;
  skills: UiCapability;
  multipleRepositories: UiCapability;
  worktreeManagement: UiCapability;
  workflowActions: UiCapability;
  events: UiCapability;
  pagination: UiCapability;
}
export interface UiWorkspaceSummary extends Workspace { version: number; leadConnection: ChatConnection | null; defaultConversationId: string | null; workflowCount: number; activeWorkflowId: string | null; taskCount: number }
export interface UiWorkspaceList { workspaces: UiWorkspaceSummary[]; capabilities: UiCapabilities; observedAt: string }
export interface UiBinding {
  id: string; providerName: string; packageVersion: string; configRevision: number;
  capabilities: Record<string, boolean>; runtime: string | null; model: string | null;
  registered: boolean; authentication: 'not-verified'; executionConnection?: ChatConnection | null;
}
export interface UiRepository { id: string; workspaceId: string; canonicalPath: string; commonGitDir: string; baseRef: string }
export interface UiTaskDiagnostics {
  runId: string; attempt: number; status: string; stopReason: string | null;
  error: string | null;
  report: { id: string; content: string; createdAt: string; kind: string } | null;
  coordination: { turnId: string; error: string; createdAt: string } | null;
}
export interface UiTask extends Task { dependsOn: string[]; diagnostics?: UiTaskDiagnostics | null }
export interface UiRun {
  id: string; taskId: string; roleId: string; purpose: string; status: string; version: number;
  cleanupStatus: string; slotReleasedAt: string | null; createdAt: string;
  startedAt: string | null; endedAt: string | null; stopReason: string | null;
}
export interface UiIntegration {
  id: string; taskId: string; status: string; version: number; sourceHead: string;
  candidateHead: string | null; expectedTargetHead: string | null;
  reviewRunId: string | null; checkIds: string[]; error: string | null;
  candidatePath: string | null;
}
export interface UiPresence {
  roleId: string;
  state: 'disabled' | 'unavailable' | 'running' | 'stopping' | 'cleanup_unknown' | 'queued' | 'idle' | 'unknown';
  runIds: string[]; turnIds: string[]; taskIds: string[]; reason: string; observedAt: string;
}
export interface UiWorkspaceDetail {
  leadConfiguration: { source: 'host' | 'workspace'; runtime: 'dsh' | 'codex'; provider: string; model: string };
  workspace: UiWorkspaceSummary; roles: BrowserAgent[]; bindings: UiBinding[];
  repositories: UiRepository[]; workflows: Workflow[]; tasks: UiTask[];
  runs: UiRun[]; worktrees: Worktree[]; integrations: UiIntegration[];
  presence: UiPresence[]; capabilities: UiCapabilities; observedAt: string;
  conversations: Conversation[]; snapshotCursor: number;
  managedWorktrees: WorkspaceWorktree[];
  workflowRepositories: {workflowId:string;repositoryId:string;baseCommit:string;integrationRef:string;status:string}[];
  hostCapacity: { limits: {developers:number;reviewers:number;total:number;lead:number}; occupied: {developers:number;reviewers:number;total:number;lead:number} };
}
export interface UiWorkspaceCreate { name: string; repositoryPath?: string; baseRef?: string; leadConnection?: ChatConnection }
