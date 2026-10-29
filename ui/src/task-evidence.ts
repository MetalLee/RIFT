import type { CheckEvidence, ReviewReport } from '@rift/protocol';
import { request } from './api';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => !!text(item));
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function currentCandidate(value: unknown) {
  const item = record(value);
  const integrationId = text(item.integrationId), candidateHead = text(item.candidateHead), sourceHead = text(item.sourceHead);
  return integrationId && candidateHead && sourceHead && positiveInteger(item.taskAttempt)
    ? { integrationId, candidateHead, sourceHead, taskAttempt: item.taskAttempt } : null;
}
function hostAttachment(value: unknown) {
  const host = record(value), command = record(host.command);
  const workspaceId = text(host.workspaceId), repositoryId = text(host.repositoryId), repositoryFingerprint = text(host.repositoryFingerprint);
  const taskId = text(host.taskId), integrationId = text(host.integrationId), candidateHead = text(host.candidateHead);
  const configurationFingerprint = text(host.configurationFingerprint), environmentFingerprint = text(host.environmentFingerprint), logSha256 = text(host.logSha256);
  const exitStatus = host.exitStatus;
  if (host.schemaVersion !== 1 || host.executionSource !== 'host' || !workspaceId || !repositoryId || !repositoryFingerprint || !taskId ||
      !integrationId || !candidateHead || !positiveInteger(host.attempt) || !configurationFingerprint || !environmentFingerprint ||
      !logSha256 || !/^[a-f0-9]{64}$/i.test(logSha256) || typeof host.summary !== 'string' || !text(command.executable) ||
      !Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string') || !positiveInteger(command.timeoutMs) ||
      (exitStatus !== 'passed' && exitStatus !== 'failed' && exitStatus !== 'environment_unavailable' && exitStatus !== 'timed_out')) return null;
  return { workspaceId, repositoryId, repositoryFingerprint, taskId, integrationId, candidateHead, attempt: host.attempt,
    configurationFingerprint, environmentFingerprint, logSha256, summary: host.summary, exitStatus,
    command: { executable: command.executable as string, args: command.args as string[], timeoutMs: command.timeoutMs } } as const;
}
function readinessView(value: unknown) {
  const item = record(value), status = item.status;
  if ((status !== 'ready' && status !== 'waiting_evidence' && status !== 'failed' && status !== 'environment_unavailable') ||
      !strings(item.requiredCheckIds) || !strings(item.missingCheckIds) || !Array.isArray(item.blockers)) return null;
  const blockers = item.blockers.map(value => {
    const blocker = record(value), classification = blocker.classification;
    return (classification === 'code_defect' || classification === 'evidence_missing' || classification === 'environment_unavailable' || classification === 'optional') &&
      text(blocker.commandId) && text(blocker.reason) ? { classification, commandId: blocker.commandId as string, reason: blocker.reason as string } as const : null;
  });
  // Unknown/malformed blockers must not disappear into a false "ready" result.
  if (blockers.some(blocker => !blocker)) return null;
  return { status, requiredCheckIds: item.requiredCheckIds, missingCheckIds: item.missingCheckIds, blockers: blockers.filter(blocker => blocker !== null) } as const;
}

// A browser projection, not a second wire contract. Only explicit Host bindings identify the current candidate.
export function adaptTaskEvidence(value: unknown, taskId: string, workspaceId: string) {
  const root = record(value);
  if (root.taskId !== taskId || !Array.isArray(root.integrations)) throw new Error('证据响应与当前任务不匹配或格式不可用，请刷新重试。');
  const current = currentCandidate(root.currentCandidate);
  const uniqueCurrent = current && root.integrations.filter(value => record(value).id === current.integrationId).length === 1;
  return {
    taskId, acceptedCommit: text(root.acceptedCommit), currentCandidate: current,
    integrations: root.integrations.map((value, index) => {
      const integration = record(value), id = text(integration.id), candidateHead = text(integration.candidateHead);
      const isCurrent = !!uniqueCurrent && id === current.integrationId && candidateHead === current.candidateHead;
      const validChecks = Array.isArray(integration.checks) ? integration.checks.filter(isCheck) : [];
      const checks = validChecks.map(check => {
        const host = hostAttachment(record(check).host);
        const bindingMatches = !!host && host.workspaceId === workspaceId && host.taskId === taskId && host.integrationId === id &&
          host.candidateHead === candidateHead && check.candidateHead === candidateHead;
        const currentHost = bindingMatches && isCurrent && host.attempt === current.taskAttempt;
        const passed = !!host && host.exitStatus === 'passed' && check.exitCode === 0;
        return { ...check, host, bindingMatches, currentHost, passed };
      });
      const review = isReview(integration.review, taskId) ? integration.review : null;
      const evidenceUnavailable = integration.evidenceUnavailable !== false || !Array.isArray(integration.checks) || checks.length !== integration.checks.length || (integration.review != null && !review);
      const readiness = readinessView(integration.readiness);
      const readyConfirmed = isCurrent && !evidenceUnavailable && readiness?.status === 'ready' && !readiness.missingCheckIds.length &&
        !readiness.blockers.some(blocker => blocker.classification !== 'optional') &&
        readiness.requiredCheckIds.every(commandId => {
          const results = checks.filter(check => check.commandId === commandId && check.currentHost);
          return results.length > 0 && results.every(check => check.passed);
        });
      return { id: id ?? `unavailable-${index}`, status: text(integration.status) ?? 'unknown', candidateHead, isCurrent,
        checks, review, evidenceUnavailable, readiness, readyConfirmed };
    }),
  };
}
export type TaskEvidenceView = ReturnType<typeof adaptTaskEvidence>;

function isCheck(value: unknown): value is CheckEvidence {
  const check = record(value);
  return ['id','commandId','candidateHead','startedAt','finishedAt'].every(key => !!text(check[key])) &&
    typeof check.exitCode === 'number' && Number.isInteger(check.exitCode) &&
    typeof check.stdout === 'string' && typeof check.stderr === 'string' && typeof check.truncated === 'boolean';
}
function isReview(value: unknown, taskId: string): value is ReviewReport {
  const review = record(value);
  return review.schemaVersion === 1 && review.taskId === taskId && !!text(review.runId) && !!text(review.reviewedCommit) &&
    ['approve','changes_requested','blocked'].includes(String(review.verdict)) && Array.isArray(review.findings) && review.findings.every(value => {
      const finding = record(value);
      return ['critical','high','medium','low'].includes(String(finding.severity)) && typeof finding.file === 'string' && typeof finding.line === 'number' && typeof finding.reason === 'string' && typeof finding.suggestion === 'string';
    });
}

export async function readTaskEvidence(workspaceId: string, taskId: string, signal: AbortSignal) {
  const value = await request<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/evidence`, { signal });
  signal.throwIfAborted();
  return adaptTaskEvidence(value, taskId, workspaceId);
}
