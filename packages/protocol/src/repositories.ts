import type { Role } from './workspace.js';
import type { ChatConnection } from './chat.js';

export interface BrowserAgent extends Role { displayName: string; version: number; chatConnection: ChatConnection | null }
export interface Repository { id: string; workspaceId: string; canonicalPath: string; commonGitDir: string; baseRef: string }
export interface WorkspaceWorktree { id: string; workspaceId: string; repositoryId: string; origin: 'managed' | 'external'; path: string; pendingPath?: string | null; baseCommit: string; branch: string | null; status: string; version: number; createdAt: string }
export type RemovalKind = 'user' | 'task' | 'candidate' | 'review';
export interface WorktreeRemovalTarget {
  kind: RemovalKind; recordId: string; repositoryId: string; path: string;
  expectedVersion: string; state: string; canDelete: boolean; reason: string | null;
  error: string | null; canReconcile: boolean;
}
