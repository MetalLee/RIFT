/** Replay event IDs, and recover a retained-history gap only after a fresh snapshot succeeds. */
export function subscribeWorkspaceEvents(workspaceId: string, after: number, callbacks: {
  changed(event: MessageEvent): void;
  snapshot(signal: AbortSignal): Promise<number>;
  error(message: string): void;
  expired(): void;
}) {
  let source: EventSource | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false, cursor = after;
  const controller = new AbortController();
  const remember = (event: Event) => {
    const value = Number((event as MessageEvent).lastEventId);
    if (!Number.isSafeInteger(value) || value <= cursor) return false;
    cursor = value; return true;
  };
  const recover = async () => {
    try {
      const snapshotCursor = await callbacks.snapshot(controller.signal);
      if (closed) return;
      cursor = snapshotCursor;
      connect();
    } catch (error) {
      if ((error as {status?:number})?.status === 401) { close(); callbacks.expired(); return; }
      if (!closed) { callbacks.error('正在重试完整同步；保留上次已知状态。'); retry = setTimeout(() => void recover(), 1000); }
    }
  };
  const connect = () => {
    if (closed) return;
    const connection = new EventSource(`/ui-api/v1/workspaces/${encodeURIComponent(workspaceId)}/events?after=${cursor}`);
    source = connection;
    connection.addEventListener('workspace', event => { if (!closed && source === connection && remember(event)) callbacks.changed(event as MessageEvent); });
    connection.addEventListener('heartbeat', event => { if (!closed && source === connection) remember(event); });
    connection.addEventListener('resync_required', () => { if (closed || source !== connection) return; connection.close(); source = undefined; callbacks.error('正在恢复完整快照…'); void recover(); });
    connection.addEventListener('session_expired', () => { if (closed || source !== connection) return; close(); callbacks.expired(); });
    connection.onopen = () => { if (!closed && source === connection) callbacks.error(''); };
    connection.onerror = () => { if (!closed && source === connection) callbacks.error('实时连接中断，正在重连；当前继续定时同步。'); };
  };
  const close = () => { closed = true; source?.close(); controller.abort(); if (retry) clearTimeout(retry); };
  connect(); return close;
}
