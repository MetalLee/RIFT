import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, consumeBootstrap, isDefinitiveRejection, request } from './api';

describe('browser API boundary', () => {
  it.each(['127.0.0.1', '100.64.0.10'])('automatically connects %s after an expired session', async hostname => {
    const value = { csrfToken: 'csrf', expiresAt: 'later' };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify(value)));
    vi.stubGlobal('location', { hostname }); vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await api.session(null)).toEqual(value);
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/ui-api/v1/session/connect', expect.objectContaining({ method: 'POST', body: '{}', credentials: 'same-origin', cache: 'no-store' }));
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([403, 500])('does not retry source or server failure %s as a new session', async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    try { await expect(api.session(null)).rejects.toMatchObject({ status }); expect(fetchMock).toHaveBeenCalledTimes(1); }
    finally { vi.unstubAllGlobals(); }
  });
  it('removes bootstrap credentials before networking and leaves ordinary routes intact', () => {
    const replaceState = vi.fn();
    const code = consumeBootstrap({ hash: '#bootstrap=secret%2Bcode', pathname: '/', search: '' }, { replaceState });
    expect(code).toBe('secret+code');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    replaceState.mockClear();
    expect(consumeBootstrap({ hash: '#/workspace/ws/chat', pathname: '/', search: '' }, { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
  it('exchanges only a POST body and uses same-origin cookies without cached responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ csrfToken: 'csrf', expiresAt: 'later' })));
    vi.stubGlobal('fetch', fetchMock);
    try { await api.session('bootstrap-code'); expect(fetchMock).toHaveBeenCalledWith('/ui-api/v1/session', expect.objectContaining({ method: 'POST', body: '{"code":"bootstrap-code"}', credentials: 'same-origin', cache: 'no-store' })); } finally { vi.unstubAllGlobals(); }
  });
  it('preserves the caller idempotency key and CSRF for a workspace retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await api.createWorkspace({ name: 'test', repositoryPath: 'C:/repo', baseRef: 'main' }, 'csrf-value', 'retry-key');
      expect(fetchMock).toHaveBeenCalledWith('/ui-api/v1/workspaces', expect.objectContaining({ headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-value', 'Idempotency-Key': 'retry-key' }) }));
    } finally { vi.unstubAllGlobals(); }
  });
  it('surfaces authentication errors even if the server response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('expired', { status: 401 })));
    try { await expect(request('/session')).rejects.toMatchObject({ status: 401 }); await expect(request('/session')).rejects.toBeInstanceOf(ApiError); } finally { vi.unstubAllGlobals(); }
  });
  it('distinguishes acknowledged precondition refusal from uncertain side-effect outcomes', () => {
    expect(isDefinitiveRejection(new ApiError(409, 'Busy', 'CONFIG_IN_USE'))).toBe(true);
    expect(isDefinitiveRejection(new ApiError(409, 'Unknown', 'OUTCOME_UNKNOWN'))).toBe(false);
    expect(isDefinitiveRejection(new ApiError(400, 'Unexpected exception', 'INVALID_REQUEST'))).toBe(false);
    expect(isDefinitiveRejection(new TypeError('Connection dropped'))).toBe(false);
  });
});
