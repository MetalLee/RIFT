import type { UiSession, UiWorkspaceCreate, UiWorkspaceDetail, UiWorkspaceList } from '../../src/api/ui-contracts';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/ui-api/v1${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.message ?? body?.message ?? `请求未完成（${response.status}）`, body?.error?.code);
  return body as T;
}

/** The bootstrap code never reaches a request URL, persistent storage or a route. */
export function consumeBootstrap(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get('bootstrap');
  if (code !== null) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return code;
}

export const api = {
  session: (code: string | null) => request<UiSession>('/session', code === null ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }),
  workspaces: (signal?: AbortSignal) => request<UiWorkspaceList>('/workspaces', { signal }),
  detail: (id: string, signal?: AbortSignal) => request<UiWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}`, { signal }),
  createWorkspace: (value: UiWorkspaceCreate, csrf: string, key: string) => request<UiWorkspaceDetail['workspace']>('/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key }, body: JSON.stringify(value),
  }),
  logout: (csrf: string) => request<void>('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() }, body: '{}' }),
};

export function mutate<T>(path: string, csrf: string, body: unknown, method = 'POST', idempotencyKey: string = crypto.randomUUID()) {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return '浏览器会话已过期，请从终端重新打开 RIFT。';
  if (error instanceof TypeError) return '无法连接本机 Host。请确认服务仍在运行，然后重试。';
  return error instanceof Error ? error.message : '请求未完成，请重试。';
}

/** These guards reject before changing state; unknown/transport failures retain their command identity. */
export function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof ApiError && ['VERSION_CONFLICT','CONFIG_IN_USE','WORKSPACE_ACTIVE','WORKTREE_DIRTY','WORKTREE_IN_USE','WORKTREE_EXISTS','INVALID_STATE','CONNECTION_REQUIRED','AGENT_DISABLED','SKILL_INCOMPATIBLE','SKILL_NAME_CONFLICT','SKILL_ARCHIVED','PROVIDER_UNAVAILABLE','MODEL_UNAVAILABLE','OWNERSHIP_CONFIRMATION_REQUIRED'].includes(error.code ?? '');
}
