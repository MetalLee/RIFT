import type { ReviewFinding, ReviewReport } from './types.js';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESULT: expected object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !(key in result))) throw new Error('INVALID_RESULT: unexpected or missing fields');
  return result;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
/** Accept a complete JSON document or one complete JSON fence, never text around a report. */
export function parseReviewReport(text: string, expected: { taskId: string; runId: string; candidateHead: string }): ReviewReport {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('INVALID_RESULT: review too large');
  const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  let parsed: unknown;
  try { parsed = JSON.parse(clean); } catch { throw new Error('INVALID_RESULT: review must be JSON'); }
  const r = object(parsed, ['schemaVersion', 'taskId', 'runId', 'verdict', 'reviewedCommit', 'findings']);
  if (r.schemaVersion !== 1 || r.taskId !== expected.taskId || r.runId !== expected.runId || r.reviewedCommit !== expected.candidateHead || !['approve', 'changes_requested', 'blocked'].includes(String(r.verdict)) || !Array.isArray(r.findings) || r.findings.length > 1000) throw new Error('INVALID_RESULT: review binding mismatch');
  const findings: ReviewFinding[] = r.findings.map(value => {
    const f = object(value, ['severity', 'file', 'line', 'reason', 'suggestion']);
    if (!['critical', 'high', 'medium', 'low'].includes(String(f.severity)) || !nonempty(f.file) || !Number.isInteger(f.line) || Number(f.line) < 1 || !nonempty(f.reason) || !nonempty(f.suggestion)) throw new Error('INVALID_RESULT: finding');
    return f as unknown as ReviewFinding;
  });
  if (r.verdict === 'approve' && findings.some(f => f.severity === 'critical' || f.severity === 'high')) throw new Error('INVALID_RESULT: approval contains blocking findings');
  return { schemaVersion: 1, taskId: expected.taskId, runId: expected.runId, verdict: r.verdict as ReviewReport['verdict'], reviewedCommit: expected.candidateHead, findings };
}
