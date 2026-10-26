import { TurnDetails } from './TurnDetails';
import { Button } from './components/ui/button';
import { useEffect, useState } from 'react';
import type { AgentTurn } from '../../src/chat/contracts';
import { errorText, mutate, request } from './api';
import { Pill, time } from './App';
import { routeHref } from './state';
export function ActivityTurn({ workspaceId, turnId, observedAt, csrf, onChanged }: { workspaceId: string; turnId: string; observedAt: string; csrf: string; onChanged: () => void }) {
  const [turn, setTurn] = useState<AgentTurn | null>(null); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const controller = new AbortController(); request<AgentTurn>(`/workspaces/${encodeURIComponent(workspaceId)}/turns/${encodeURIComponent(turnId)}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted && value.workspaceId === workspaceId) { setTurn(previous => previous && previous.version > value.version ? previous : value); setError(''); } }, e => { if (!controller.signal.aborted) setError(errorText(e)); }); return () => controller.abort(); }, [workspaceId, turnId, observedAt]);
  const labels = { queued: '排队中', running: '回复中', stopping: '正在停止', completed: '回复完成', failed: '回复失败', cancelled: '已停止', interrupted: '已中断' };
  return <div className="run-record"><code>{turnId}</code>{turn && <><p><Pill>{labels[turn.status]}</Pill> · 清理 {turn.cleanupStatus}</p><TurnDetails turn={turn}/><p>创建于 {time(turn.createdAt)}</p><p>{turn.configuration.connection.runtime} / {turn.configuration.connection.model}</p>{turn.error && <p className="form-error">{turn.error}</p>}{turn.cleanupStatus === 'unknown' && <div><p>仅在 Host 能证明执行已退出时恢复资源，不会强制绕过未知清理。</p><Button variant="secondary" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const value = await mutate<AgentTurn>(`/workspaces/${encodeURIComponent(workspaceId)}/turns/${encodeURIComponent(turn.id)}/reconcile`, csrf, { expectedVersion: turn.version }); setTurn(value); onChanged(); } catch(e) { setError(errorText(e)); } finally { setBusy(false); } }}>{busy ? '正在核对退出证据…' : '核对清理并尝试恢复'}</Button></div>}<a className="text-button" href={routeHref(workspaceId, 'chat')} onClick={() => { try { sessionStorage.setItem(`rift:conversation:${encodeURIComponent(workspaceId)}`, turn.conversationId); } catch { /* The conversation remains available in the chooser. */ } }}>打开对应对话</a></>}{error && <p className="form-error">{error}</p>}</div>;
}
