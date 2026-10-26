import type { CoordinationReceipt as Receipt } from '../../src/chat/contracts';
import { time } from './App';
import { routeHref } from './state';
const labels: Record<string,string> = {
  'dispatch.queued': '任务已入队，等待调度',
  activation_accepted: '成员已开始执行任务',
  'source.collected': '开发结果已收集，等待检查与审查',
  'task.blocked': '任务受阻，需要进一步处理',
  'task.succeeded': '任务已完成',
  'integration.accepted': '任务已通过验收并接受',
  'integration.recovered': '集成状态已恢复',
  'integration.reconciled': '集成状态已核对',
  'cleanup.confirmed': '运行时清理已确认',
  'cleanup.unknown': '清理尚未确认，执行资源仍被占用',
  'cleanup.failed': '清理失败，需要核对执行状态',
  'publication.uncertain': 'Git 发布状态未知，需要恢复核查',
  'workflow.running': '流程已恢复运行',
  'workflow.completed': '流程已完成',
  'workflow.cancel_requested': '已请求取消流程',
  'coordination.blocked': '自动协调已暂停，需要处理阻塞',
};
const reasons: Record<string,string> = {
  COORDINATION_ACTION_REQUIRED: '本轮未安排后续可执行操作，需要协调者继续处理。',
  COORDINATION_TOOL_BUDGET: '本轮工具调用或无进展调用达到限制。',
  COORDINATION_AUTOMATIC_BUDGET: '连续自动协调已达到限制，需要用户确认下一步。',
  COORDINATION_AUTO_BUDGET: '连续自动协调已达到限制，需要用户确认下一步。',
  COORDINATION_CLEANUP_UNKNOWN: '上一轮运行时清理未确认，资源仍被占用。',
  COORDINATION_TURN_FAILED: '上一轮协调未成功结束，请查看回复与执行记录。',
};
export function CoordinationReceipt({ receipt }: { receipt: Receipt }) {
  return <article className="message system coordination-receipt">
    <div className="message-heading"><strong>系统回执</strong><time>{time(receipt.createdAt)}</time></div>
    <p>{labels[receipt.payload.type] ?? '流程状态已更新'}</p>
    {receipt.payload.reason && <p>{reasons[receipt.payload.reason] ?? '需要核对执行记录中的阻塞原因。'}</p>}
    {receipt.payload.taskId && <a className="text-button" href={routeHref(receipt.workspaceId,'tasks')}>查看任务与验收证据</a>}
    <details><summary>查看关联记录</summary><small>事件：{receipt.payload.type}{receipt.payload.reason && <><br/>原因：{receipt.payload.reason}</>}<br/>流程：<code>{receipt.workflowId}</code>{receipt.payload.taskId && <><br/>任务：<code>{receipt.payload.taskId}</code></>}{receipt.payload.runId && <><br/>执行：<code>{receipt.payload.runId}</code></>}{receipt.payload.requestId && <><br/>请求：<code>{receipt.payload.requestId}</code></>}</small></details>
  </article>;
}

export function receiptLabel(type: string): string { return labels[type] ?? '流程状态已更新'; }
