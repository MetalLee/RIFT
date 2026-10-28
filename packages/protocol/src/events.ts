export interface WorkspaceEvent { seq: number; workspaceId: string; type: string; entityId: string; entityVersion: number; payload: Record<string,unknown>; occurredAt: string }
export interface WorkspaceEventPage { events: WorkspaceEvent[]; cursor: number; nextAfter: number; highWatermark: number; hasMore: boolean; resyncRequired: boolean }

/** SSE names are stable; payload event.type remains extensible. */
export interface WorkspaceSseEvents {
  workspace: WorkspaceEvent;
  heartbeat: { cursor: number };
  resync_required: { cursor?: number };
  session_expired: Record<string, never>;
}
export type WorkspaceSseEventName = keyof WorkspaceSseEvents;
