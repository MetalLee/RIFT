import type { UiTask } from '@rift/protocol';

const stopLabels: Record<string,string> = {
  TIMEOUT: '执行超时，任务已停止', CANCELLED: '执行已取消',
  TURN_CANCELLED: '执行已停止', NATIVE_START_FAILED: '运行时启动失败',
};
export function taskIssueSummary(task: UiTask): string | null {
  const detail = task.diagnostics;
  if (detail && ['cancelled','failed','interrupted'].includes(detail.status)) {
    return (detail.stopReason && (stopLabels[detail.stopReason] ?? detail.stopReason)) || detail.error || '执行未完成';
  }
  if (detail?.coordination) return '后续协调失败';
  return task.blockingReason;
}

export function TaskDiagnostics({ task }: { task: UiTask }) {
  const detail = task.diagnostics;
  if (!detail) return task.blockingReason ? <section><h3>任务问题</h3><p className="form-error preserve-lines">{task.blockingReason}</p></section> : null;
  const issue = taskIssueSummary(task);
  return <section aria-label="执行诊断">
    <h3>执行诊断 · 尝试 {detail.attempt}</h3>
    {issue && <p className="form-error preserve-lines">{issue}</p>}
    {detail.stopReason && <p>停止原因：<code>{detail.stopReason}</code></p>}
    {detail.error && <p className="preserve-lines">运行错误：{detail.error}</p>}
    {task.blockingReason && task.blockingReason !== issue && task.blockingReason !== detail.stopReason && <p className="preserve-lines">任务状态原因：{task.blockingReason}</p>}
    {detail.report && <div className="run-record">
      <strong>最近成员报告 · 未经独立验证</strong>
      <p className="preserve-lines">{detail.report.content}</p>
      <small>{new Date(detail.report.createdAt).toLocaleString()}</small>
    </div>}
    {detail.coordination && <div className="run-record">
      <strong>后续协调失败</strong>
      <p className="form-error preserve-lines">{detail.coordination.error}</p>
      <p className="muted">这是处理本次运行结果时发生的错误，与运行停止原因分别记录。</p>
    </div>}
    <p className="muted">运行记录：<code>{detail.runId}</code></p>
  </section>;
}
