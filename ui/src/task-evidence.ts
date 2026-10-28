import type { CheckEvidence, ReviewReport } from '@rift/protocol';
import { request } from './api';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;

// A browser projection, not a second wire contract. Legacy evidence has no Host provenance.
export function adaptTaskEvidence(value: unknown, taskId: string) {
  const root = record(value);
  if (root.taskId !== taskId || !Array.isArray(root.integrations)) throw new Error('证据响应与当前任务不匹配或格式不可用，请刷新重试。');
  return {
    taskId, acceptedCommit: text(root.acceptedCommit),
    integrations: root.integrations.map((value, index) => {
      const integration = record(value);
      const checks = Array.isArray(integration.checks) ? integration.checks.filter(isCheck) : [];
      const review = isReview(integration.review, taskId) ? integration.review : null;
      return {
        id: text(integration.id) ?? `unavailable-${index}`, status: text(integration.status) ?? 'unknown',
        candidateHead: text(integration.candidateHead), checks, review,
        evidenceUnavailable: integration.evidenceUnavailable !== false || !Array.isArray(integration.checks) || checks.length !== integration.checks.length || (integration.review != null && !review),
      };
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
  return adaptTaskEvidence(value, taskId);
}
