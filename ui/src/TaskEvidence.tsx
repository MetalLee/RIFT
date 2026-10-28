import { useEffect, useState } from 'react';
import { errorText } from './api';
import { Copy, Pill, time } from './App';
import { Button } from './components/ui/button';
import { readTaskEvidence, type TaskEvidenceView } from './task-evidence';

type EvidenceState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'loaded'; evidence: TaskEvidenceView };
export function TaskEvidence({ workspaceId, taskId, revision }: { workspaceId: string; taskId: string; revision: string }) {
  const [state, setState] = useState<EvidenceState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  // Key the view by request identity as well as aborting; old evidence must never flash under a new task/revision.
  const identity = JSON.stringify([workspaceId, taskId, revision, retry]);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoadedIdentity(identity); setState({ status: 'loading' });
    readTaskEvidence(workspaceId, taskId, controller.signal)
      .then(evidence => { if (!controller.signal.aborted) setState({ status: 'loaded', evidence }); })
      .catch(error => { if (!controller.signal.aborted) setState({ status: 'error', error: errorText(error) }); });
    return () => controller.abort();
  }, [workspaceId, taskId, revision, retry, identity]);
  return <EvidenceContent state={loadedIdentity === identity ? state : { status: 'loading' }} onRetry={() => setRetry(value => value + 1)} />;
}

export function EvidenceContent({ state, onRetry }: { state: EvidenceState; onRetry: () => void }) {
  return <section className="task-evidence" aria-label="实际检查与审查证据" aria-busy={state.status === 'loading'}>
    <h3>实际检查与审查证据</h3>
    {state.status === 'loaded' && <Button variant="ghost" onClick={onRetry}>刷新证据</Button>}
    {state.status === 'loading' ? <p className="muted" role="status">正在读取证据…</p> : state.status === 'error' ? <><p className="form-error" role="alert">{state.error}</p><Button variant="secondary" onClick={onRetry}>重试读取证据</Button></> : <>
      <p className="muted">成员声明不等于 Host 检查通过；历史候选的结果不代表当前候选。</p>
      {!state.evidence.integrations.length ? <p className="muted">还没有候选集成检查记录。证据未就绪，不能据此进入通过状态。</p> : state.evidence.integrations.map(integration => <div className="integration-evidence" key={integration.id}>
        <strong>记录中的候选提交 · 当前候选绑定未知</strong><Copy value={integration.candidateHead ?? '尚未记录'} />
        <p>集成记录：<code>{integration.id}</code> · 状态：{integration.status}</p>
        <p>执行来源：旧协议未记录 · 审核前证据就绪：未知</p>
        <p>缺失必需项与阻塞分类：旧记录未提供，不能推断为无阻塞。</p>
        {integration.evidenceUnavailable && <p className="form-error">证据文件当前无法读取或记录不完整，不据此声称检查通过。</p>}
        {!integration.checks.length && <p className="muted">没有可用的实际检查记录。</p>}
        {integration.checks.map(check => <details className="check-evidence" key={check.id}>
          <summary><span>{check.commandId}</span><Pill>{check.candidateHead !== integration.candidateHead ? '候选不匹配 · 不可用于此候选' : check.exitCode === 0 ? '退出码 0 · Host 来源未确认' : `记录失败 · 退出码 ${check.exitCode}`}</Pill></summary>
          <p>执行来源：未记录 · 开始于 {time(check.startedAt)} · 完成于 {time(check.finishedAt)}</p>
          <p>验证提交：<code>{check.candidateHead}</code></p>
          {check.truncated && <p>输出已截断，以下为保留的证据。</p>}<pre>{check.stdout || '无标准输出'}</pre>{check.stderr && <pre className="stderr">{check.stderr}</pre>}
        </details>)}
        {integration.review ? <div className="review-evidence">
          <h4>审核记录：{integration.review.verdict === 'approve' ? '批准记录（非当前验收结论）' : integration.review.verdict === 'changes_requested' ? '要求修改' : '阻塞'}</h4>
          <p>审查提交：<code>{integration.review.reviewedCommit}</code></p>
          {integration.review.reviewedCommit !== integration.candidateHead && <p className="form-error">审查提交与此候选不匹配，不适用于此候选。</p>}
          <p>审核 Run：<code>{integration.review.runId}</code> · 复审上下文：未记录</p>
          {integration.review.findings.map((finding, index) => <div key={index}><strong>{finding.severity} · {finding.file}:{finding.line}</strong><p>{finding.reason}</p><p>{finding.suggestion}</p></div>)}
        </div> : <p className="muted">审核状态：没有可用的独立审核报告。</p>}
      </div>)}
    </>}
  </section>;
}
