import type { WorkspaceEvent, WorkspaceEventPage } from '@rift/protocol';
export type { WorkspaceEvent, WorkspaceEventPage } from '@rift/protocol';
import type { RiftStore } from '../storage/database.js';
import { invariant } from '../contracts/index.js';
export function readWorkspaceEvents(store: RiftStore, workspaceId: string, after: number): WorkspaceEventPage {
  invariant(Number.isSafeInteger(after) && after >= 0, 'INVALID_CURSOR', 'Event cursor must be a nonnegative safe integer.');
  return store.transaction(() => {
    store.workspace(workspaceId);
    const cursor = store.require<{cursor:number}>('SELECT COALESCE(MAX(seq),0) AS cursor FROM workspace_events').cursor;
    const floor = Math.max(0, cursor - 10000);
    if (after < floor || after > cursor) return { events: [], cursor: after, nextAfter: after, highWatermark: cursor, hasMore: false, resyncRequired: true };
    const events = store.all<WorkspaceEvent>('SELECT * FROM workspace_events WHERE workspace_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 101', workspaceId, after, cursor);
    const hasMore = events.length > 100; events.splice(100);
    const nextAfter = hasMore ? events.at(-1)!.seq : cursor;
    return { events, cursor: nextAfter, nextAfter, highWatermark: cursor, hasMore, resyncRequired: false };
  });
}
