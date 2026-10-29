import { useEffect, useState } from 'react';
import { errorText } from './api';
import { Copy, Pill, time } from './App';
import { Button } from './components/ui/button';
import { readTaskEvidence, type TaskEvidenceView } from './task-evidence';

const readinessLabels = { ready: '检查就绪', waiting_evidence: '等待必需证据', failed: '检查失败', environment_unavailable: '检查环境不可用' };
const blockerLabels = { code_defect: '代码缺陷 · 阻断', evidence_missing: '缺失证据 · 阻断', environment_unavailable: '环境不可用 · 阻断', optional: '可选建议 · 不阻断' };
const exitLabels = { passed: '执行通过', failed: '执行失败', environment_unavailable: '环境不可用', timed_out: '执行超时', skipped: '已跳过', cancelled: '已取消' };

function checkLabel(check: TaskEvidenceView['integrations'][number]['checks'][number], candidateHead: string | null) {
  if (check.candidateHead !== candidateHead) return '候选不匹配 · 不可用于此候选';
  if (!check.host) return check.exitCode === 0 ? '退出码 0 · Host 来源未确认' : `记录失败 · 退出码 ${check.exitCode}`;
  if (!check.bindingMatches) return 'Host 绑定不匹配 · 不可用于此候选';
  if (!check.currentHost) return 'Host 历史或尝试不匹配 · 非当前结果';
  if (check.passed) return '当前 Host 检查通过';
  return check.host.exitStatus === 'passed' ? 'Host 状态不一致 · 不视为通过' : `当前 Host ${exitLabels[check.host.exitStatus]} · 退出码 ${check.exitCode}`;
}

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
      <p className="muted">成员声明不等于 Host 检查通过；历史候选的结果不代表当前候选。检查就绪仅表示配置检查就绪，不代表审核批准、任务验收或允许发布。</p>
      {state.evidence.currentCandidate ? <div className="current-evidence">
        <h4>Host 指定的当前候选</h4><Copy value={state.evidence.currentCandidate.candidateHead} />
        <p>源提交：<code>{state.evidence.currentCandidate.sourceHead}</code> · 任务尝试：{state.evidence.currentCandidate.taskAttempt}</p>
        <p>集成：<code>{state.evidence.currentCandidate.integrationId}</code></p>
        {!state.evidence.integrations.some(integration => integration.isCurrent) && <p className="form-error">当前候选没有唯一匹配的集成记录，当前证据就绪状态未知。</p>}
      </div> : <p className="muted">当前候选绑定未知；不按记录顺序或时间推断当前候选。</p>}
      {!state.evidence.integrations.length ? <p className="muted">还没有候选集成检查记录。证据未就绪，不能据此进入通过状态。</p> : state.evidence.integrations.map(integration => <div className="integration-evidence" key={integration.id}>
        <strong>{integration.isCurrent ? '当前候选提交' : '历史或未确认当前的候选提交'}</strong><Copy value={integration.candidateHead ?? '尚未记录'} />
        <p>集成记录：<code>{integration.id}</code> · 状态：{integration.status}</p>
        {integration.readiness ? <div className="readiness-evidence">
          <p>审核前证据就绪：{integration.isCurrent ? integration.readiness.status === 'ready' && !integration.readyConfirmed ? '未知（就绪报告缺少一致的当前 Host 证据）' : readinessLabels[integration.readiness.status] : '非当前候选，不用于当前就绪判断'}</p>
          <p>Host 报告状态：{readinessLabels[integration.readiness.status]} · 仅对应这条集成记录</p>
          <p>配置必需检查：{integration.readiness.requiredCheckIds.join('、') || '无配置项'}</p>
          <p>缺失必需项：{integration.readiness.missingCheckIds.join('、') || '报告未列出缺失项'}</p>
          {integration.readiness.blockers.length ? <ul>{integration.readiness.blockers.map((blocker, index) => <li key={index}><strong>{blockerLabels[blocker.classification]}</strong> · <code>{blocker.commandId}</code><p className="preserve-lines">{blocker.reason}</p></li>)}</ul> : <p>报告未列出阻塞项；不替代独立审核。</p>}
        </div> : <p>审核前证据就绪：未知。缺失必需项与阻塞分类：旧记录未提供或格式不可用，不能推断为无阻塞。</p>}
        {integration.evidenceUnavailable && <p className="form-error">证据文件当前无法读取或记录不完整，不据此声称检查通过。</p>}
        {!integration.checks.length && <p className="muted">没有可用的实际检查记录。</p>}
        {integration.checks.map(check => <details className="check-evidence" key={check.id}>
          <summary><span>{check.commandId}</span><Pill>{checkLabel(check, integration.candidateHead)}</Pill></summary>
          <p>执行来源：{check.host ? 'Host 执行附件' : '未知（未记录或附件格式不可用）'} · 开始于 {time(check.startedAt)} · 完成于 {time(check.finishedAt)}</p>
          {check.host && <div className="host-evidence">
            <p>执行结果：{exitLabels[check.host.exitStatus]} · 退出码 {check.exitCode} · 尝试 {check.host.attempt}</p>
            {check.host.exitStatus === 'passed' && check.exitCode !== 0 && <p className="form-error">执行状态与退出码不一致，不视为通过。</p>}
            <p className="preserve-lines">{check.host.summary}</p>
            <p>附件绑定：工作区 <code>{check.host.workspaceId}</code> · 任务 <code>{check.host.taskId}</code> · 集成 <code>{check.host.integrationId}</code> · 候选 <code>{check.host.candidateHead}</code></p>
            <p>仓库：<code>{check.host.repositoryId}</code> · 指纹 <code>{check.host.repositoryFingerprint}</code></p>
            <p>命令（仅展示）：<code>{check.host.command.executable} {JSON.stringify(check.host.command.args)}</code> · 超时 {check.host.command.timeoutMs} ms</p>
            <p>配置指纹：<code>{check.host.configurationFingerprint}</code></p><p>环境指纹：<code>{check.host.environmentFingerprint}</code></p><p>日志 SHA-256：<code>{check.host.logSha256}</code></p>
          </div>}
          <p>验证提交：<code>{check.candidateHead}</code></p>
          {check.truncated && <p>输出已截断，以下为保留的证据。</p>}<pre>{check.stdout || '无标准输出'}</pre>{check.stderr && <pre className="stderr">{check.stderr}</pre>}
        </details>)}
        {integration.review ? <div className="review-evidence">
          <h4>审核记录：{integration.review.verdict === 'approve' ? '批准记录（非当前验收结论）' : integration.review.verdict === 'changes_requested' ? '要求修改' : '阻塞'}</h4>
          <p>审查提交：<code>{integration.review.reviewedCommit}</code></p>
          {integration.review.reviewedCommit !== integration.candidateHead && <p className="form-error">审查提交与此候选不匹配，不适用于此候选。</p>}
          {!integration.isCurrent && <p>历史或未确认当前的审核记录，不代表当前候选审核通过。</p>}
          <p>审核 Run：<code>{integration.review.runId}</code> · 复审上下文：未记录</p>
          {integration.review.findings.map((finding, index) => <div key={index}><strong>{finding.severity} · {finding.file}:{finding.line}</strong><p>{finding.reason}</p><p>{finding.suggestion}</p></div>)}
        </div> : <p className="muted">审核状态：没有可用的独立审核报告。</p>}
      </div>)}
    </>}
  </section>;
}
