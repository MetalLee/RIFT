import { randomId } from './browser-platform';
import type { ApiConnectionCreate, ErrorCode, UiSession, UiWorkspaceCreate, UiWorkspaceDetail, UiWorkspaceList } from '@rift/protocol';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: ErrorCode) { super(message); }
}

export type { ApiConnectionCreate } from '@rift/protocol';

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
  deleteConnection: (id: string, csrf: string, key: string) => mutate<{id:string;deleted:true}>(`/connections/${encodeURIComponent(id)}`,csrf,{},'DELETE',key),
  // Caller retains only the command key, never a serialized secret fingerprint.
  createConnection: <T>(value: ApiConnectionCreate, csrf: string, key: string) => mutate<T>('/connections',csrf,value,'POST',key),
  session: async (code: string | null): Promise<UiSession> => {
    if (code !== null) return request<UiSession>('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    try { return await request<UiSession>('/session'); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      return request<UiSession>('/session/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
  },
  workspaces: (signal?: AbortSignal) => request<UiWorkspaceList>('/workspaces', { signal }),
  detail: (id: string, signal?: AbortSignal) => request<UiWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}`, { signal }),
  createWorkspace: (value: UiWorkspaceCreate, csrf: string, key: string) => request<UiWorkspaceDetail['workspace']>('/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key }, body: JSON.stringify(value),
  }),
  logout: (csrf: string) => request<void>('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': randomId() }, body: '{}' }),
};

export function mutate<T>(path: string, csrf: string, body: unknown, method = 'POST', idempotencyKey: string = randomId()) {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
}

const errorMessages: Record<string, string> = {
  VERSION_CONFLICT: '配置已更新。请刷新最新记录，核对保留的输入后重试。',
  STALE_CONFIG: '配置已过期。请刷新记录后重新选择连接。',
  PROVIDER_UNAVAILABLE: '运行连接暂不可用。请检查 Host 与连接配置，然后重试。',
  API_CONFIGURATION_UNAVAILABLE: 'Host 尚未启用 API 配置。请检查模型服务后刷新连接目录。',
  API_VERIFICATION_FAILED: '本次连接验证未通过。请检查端点、模型与凭据后重新验证。',
  API_REPLY_NOT_OBSERVED: '未观测到对话回复。请检查模型支持情况后重新验证。',
  API_TOOL_NOT_OBSERVED: '未观测到工具调用。请确认模型支持工具，再重新验证。',
  CONNECTION_REQUIRED: '尚未配置连接。请在 Agent 设置中选择可用连接后重试。',
  CONNECTION_IN_USE: '连接仍被引用。请先更换对应连接，等待运行清理完成后再删除。',
  CONFIG_IN_USE: '配置仍在使用中。请等待当前执行清理完成后重试。',
  AGENT_DISABLED: '接收成员已停用。请启用该成员或明确选择其他接收者。',
  SKILL_ARCHIVED: 'Skill 已归档。请移除或替换引用；再次使用需重新导入。',
  SKILL_PREVIEW_EXPIRED: '导入预览已过期。请保留目录输入并重新预览。',
  SKILL_ENTRY_MISSING: '目录中缺少 SKILL.md。请检查目录后重新预览。',
  INVALID_SKILL_PATH: 'Skill 目录无效。请填写包含 SKILL.md 的本机绝对路径。',
  SKILL_INCOMPATIBLE: 'Skill 与运行连接不兼容。请更换 Skill 或受支持的连接。',
  SKILL_NAME_CONFLICT: '存在同名 Skill 冲突。请明确选择一个来源后重试。',
  SKILL_UNSAFE_RESOURCE: 'Skill 包含不安全资源。请移除凭据或受限文件后重新预览。',
  INVALID_ENDPOINT: 'API 端点无效。请检查基础地址和协议后重试。',
  INVALID_INPUT: '输入不符合要求。请核对表单内容后重试。',
  OUTCOME_UNKNOWN: '请求结果尚未确认。请先刷新记录，避免重复提交。',
  WORKTREE_IN_USE: '工作目录仍在使用。请等待执行与清理完成后重试。',
  WORKTREE_DIRTY: '工作目录有未提交内容。请先保存改动，再确认删除。',
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '浏览器会话已过期，请重新连接 RIFT。';
    const reason = errorMessages[error.code ?? ''] ?? (error.status === 403 ? '没有执行此操作的权限。请检查当前会话与 Host 授权。' : error.status >= 500 ? 'Host 暂时无法完成请求。请检查服务状态后重试。' : '请求未完成。请核对输入并刷新最新记录后重试。');
    // Only stable diagnostics are displayed: upstream messages can contain credentials.
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? ` · ${error.code}` : '';
    return `${reason}（HTTP ${error.status}${code}）`;
  }
  if (error instanceof TypeError) return '无法连接本机 Host。请确认服务仍在运行，然后重试。';
  return error instanceof Error ? error.message : '请求未完成，请重试。';
}

/** These guards reject before changing state; unknown/transport failures retain their command identity. */
export function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof ApiError && ['VERSION_CONFLICT','CONFIG_IN_USE','CONNECTION_IN_USE','WORKSPACE_ACTIVE','WORKTREE_DIRTY','WORKTREE_IN_USE','WORKTREE_EXISTS','INVALID_STATE','CONNECTION_REQUIRED','AGENT_DISABLED','SKILL_INCOMPATIBLE','SKILL_NAME_CONFLICT','SKILL_ARCHIVED','PROVIDER_UNAVAILABLE','MODEL_UNAVAILABLE','OWNERSHIP_CONFIRMATION_REQUIRED'].includes(error.code ?? '');
}
