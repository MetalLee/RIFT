import { describe, expect, it } from 'vitest';
import { parseReviewReport } from '../../src/git/quality-gate.js';

const expected = { taskId: 'task-acceptance', runId: 'review-acceptance', candidateHead: 'a'.repeat(40) };
const report = { schemaVersion: 1, taskId: expected.taskId, runId: expected.runId, verdict: 'approve', reviewedCommit: expected.candidateHead, findings: [] };

describe('A05 independent review result acceptance', () => {
  it('accepts only a report bound to the exact task, run and candidate', () => {
    expect(parseReviewReport(JSON.stringify(report), expected).reviewedCommit).toBe(expected.candidateHead);
    for (const override of [{ taskId: 'other' }, { runId: 'old-review' }, { reviewedCommit: 'b'.repeat(40) }, { verdict: 'success' }, { schemaVersion: 2 }]) {
      expect(() => parseReviewReport(JSON.stringify({ ...report, ...override }), expected)).toThrow(/INVALID_RESULT/);
    }
  });

  it('rejects malformed, surrounding narrative, excess fields and oversized output', () => {
    for (const text of ['approved', `Here is my approval: ${JSON.stringify(report)}`, JSON.stringify({ ...report, overrideGate: true }), JSON.stringify({ ...report, findings: null }), ' '.repeat(1_048_577)]) {
      expect(() => parseReviewReport(text, expected)).toThrow(/INVALID_RESULT/);
    }
  });

  it('does not allow approve to conceal blocking findings', () => {
    const finding = { severity: 'high', file: 'src/example.ts', line: 1, reason: 'Incorrect result', suggestion: 'Correct the result' };
    expect(() => parseReviewReport(JSON.stringify({ ...report, findings: [finding] }), expected)).toThrow(/INVALID_RESULT/);
    expect(parseReviewReport(JSON.stringify({ ...report, verdict: 'changes_requested', findings: [finding] }), expected).verdict).toBe('changes_requested');
    expect(() => parseReviewReport(JSON.stringify({ ...report, verdict: 'changes_requested', findings: [{ ...finding, line: 0 }] }), expected)).toThrow(/INVALID_RESULT/);
  });
});
