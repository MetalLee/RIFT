import type { AgentTurn, TurnPhase } from '../../src/chat/contracts';
import { time } from './App';
const phases: Record<TurnPhase, string> = { queued: '等待执行', starting: '正在启动', generating: '模型生成中', tool: '工具执行中', handoff: '已登记交接，等待本轮结束', cleanup: '正在清理运行时', cleanup_unknown: '清理待确认，占用已保留', settled: '本轮执行已结束' };
const statuses: Record<AgentTurn['status'], string> = { queued: '排队中', running: '正在回复', stopping: '正在停止', completed: '回复完成', failed: '回复失败', cancelled: '已停止', interrupted: '执行中断' };
export function turnPhaseLabel(turn: AgentTurn): string {
  if (turn.phase === 'cleanup' && turn.modelEndedAt) return '回复已结束，正在清理';
  if (turn.phase === 'cleanup_unknown' && turn.modelEndedAt) return '回复已结束，清理待确认';
  if (turn.phase === 'generating' && turn.activities?.at(-1)?.type === 'model.status') return turn.activities.at(-1)!.summary;
  return (turn.phase ? phases[turn.phase] : undefined) ?? statuses[turn.status] ?? '状态待同步';
}
export function TurnDetails({ turn, view = 'diagnostics' }: { turn: AgentTurn; view?: 'chat' | 'diagnostics' }) {
  const compact = view === 'chat';
  const activities = compact ? turn.activities?.filter(activity => activity.type.startsWith('tool.')) : turn.activities;
  return <div className="turn-diagnostics">
    {!compact && <><p>{turnPhaseLabel(turn)}{turn.currentToolName ? ` · ${turn.currentToolName}` : ''}</p>
      <small>阶段开始：{time(turn.phaseStartedAt ?? turn.createdAt)} · 最后有效进展：{time(turn.lastProgressAt ?? turn.createdAt)}</small></>}
    {compact && turn.phase === 'cleanup' && turn.modelEndedAt && <p>回复已结束，正在清理。</p>}
    {turn.cleanupStatus === 'unknown' && <p>执行资源仍被占用；需要核对清理证据后恢复。</p>}
    {!!activities?.length && <details open={['running','stopping'].includes(turn.status)}><summary>执行活动 · {activities.length}</summary><ol>{activities.map(activity => <li key={activity.seq}>{!compact && <><time>{time(activity.createdAt)}</time> · </>}{activity.summary}{Object.entries(activity.payload).map(([key,value]) => <span key={key}> · {key}: <code>{value}</code></span>)}</li>)}</ol></details>}
  </div>;
}
