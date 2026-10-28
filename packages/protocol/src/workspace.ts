import type { ChatConnection } from './chat.js';

export type RoleName = string;
export type RolePurpose = 'lead' | 'developer' | 'reviewer';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'validating' | 'integrating' | 'succeeded' | 'blocked' | 'failed' | 'cancelled';
export type WorkflowStatus = 'created' | 'planning' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export interface Workspace { id: string; version?: number; defaultRepositoryId?: string | null; defaultConversationId?: string | null; leadConnection?: ChatConnection | null; name: string; rootPath: string; repositoryPath: string; commonGitDir: string; baseRef: string; status: string }
export interface Role { id: string; workspaceId: string; name: RoleName; purpose?:RolePurpose; enabled?:number; kind: 'dsh-lead' | 'subagent'; providerBindingId: string | null; prompt: string; revision: number }
export interface Workflow { id: string; workspaceId: string; goal: string; leadSessionId: string | null; planRevision: number; version: number; status: WorkflowStatus; integrationRef: string; baseCommit: string; summary: string | null }
export interface Task { id: string; workflowId: string; roleId: string | null; repositoryId?: string | null; kind: 'change' | 'analysis'; title: string; instructions: string; expectedPaths: string[]; acceptanceCriteria: string[]; priority?:number; analysisItems?:{id:string;prompt:string}[]|null; status: TaskStatus; attempt: number; version: number; acceptedCommit: string | null; sourceHead: string | null; blockingReason: string | null }
export interface Worktree { id: string; taskId: string; attempt: number; kind: 'task' | 'review' | 'candidate'; path: string; branch?: string; baseCommit: string; headCommit?: string; writerRunId?: string | null; status?: string }
