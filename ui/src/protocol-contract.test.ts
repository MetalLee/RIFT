import { afterEach, expect, it, vi } from 'vitest';
import type { ApiErrorBody, UiSession, UiWorkspaceCreate, WorkspaceSseEvents } from '@rift/protocol';
import { api, ApiError, isDefinitiveRejection, request } from './api';
import { subscribeWorkspaceEvents } from './workspace-stream';

afterEach(() => vi.unstubAllGlobals());
it('keeps unknown future error codes uncertain and exposes the Host message', async () => {
  const body: ApiErrorBody = { error: { code: 'FUTURE_HOST_ERROR', message: 'Reload before retrying.' } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
  const error = await request('/session').catch(error => error);
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw error;
  expect(error.message).toBe(body.error.message);
  expect(error.code).toBe(body.error.code);
  expect(isDefinitiveRejection(error)).toBe(false);
});
it('keeps authentication, CSRF and retry identity unchanged for protocol DTOs', async () => {
  const session: UiSession = { csrfToken: 'test-csrf', expiresAt: 'later' };
  const workspace: UiWorkspaceCreate = { name: 'Workspace without a repository' };
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await api.createWorkspace(workspace, session.csrfToken, 'same-command');
  await api.createWorkspace(workspace, session.csrfToken, 'same-command');
  expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  expect(fetch).toHaveBeenCalledWith('/ui-api/v1/workspaces', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(workspace), headers: expect.objectContaining({ 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'same-command' }) }));
});
it('uses stable SSE names, resumes from the snapshot cursor, and closes on session expiry', async () => {
  class Source {
    static instances: Source[] = [];
    listeners = new Map<string, (event: unknown) => void>();
    close = vi.fn();
    constructor(public url: string) { Source.instances.push(this); }
    addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
    emit<K extends keyof WorkspaceSseEvents>(name: K, data: WorkspaceSseEvents[K], lastEventId = '') { this.listeners.get(name)?.({ data: JSON.stringify(data), lastEventId }); }
  }
  vi.stubGlobal('EventSource', Source);
  const changed = vi.fn(), expired = vi.fn(), snapshot = vi.fn().mockResolvedValue(19);
  const close = subscribeWorkspaceEvents('w/id', 7, { changed, expired, snapshot, error: vi.fn() });
  try {
    const first = Source.instances[0];
    expect(first.url).toBe('/ui-api/v1/workspaces/w%2Fid/events?after=7');
    first.emit('workspace', { seq: 8, workspaceId: 'w/id', type: 'future.event', entityId: 'x', entityVersion: 1, payload: {}, occurredAt: 'now' }, '8');
    first.emit('heartbeat', { cursor: 9 }, '9');
    expect(changed).toHaveBeenCalledTimes(1);
    first.emit('resync_required', {});
    await Promise.resolve();
    expect(first.close).toHaveBeenCalled();
    const second = Source.instances[1];
    expect(second.url).toContain('after=19');
    second.emit('session_expired', {});
    expect(expired).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalled();
  } finally { close(); }
});
