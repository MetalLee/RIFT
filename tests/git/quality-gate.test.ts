import { describe, expect, it } from 'vitest';
import { parseReviewReport } from '../../src/git/quality-gate.js';

const expected = { taskId: 'task', runId: 'review-run', candidateHead: 'a'.repeat(40) };
const report = { schemaVersion: 1, taskId: expected.taskId, runId: expected.runId, reviewedCommit: expected.candidateHead, verdict: 'approve', findings: [] };
describe('review evidence validation', () => {
  it('accepts a bound complete report and a single JSON fence', () => {
    expect(parseReviewReport(JSON.stringify(report), expected).verdict).toBe('approve');
    expect(parseReviewReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``, expected).reviewedCommit).toBe(expected.candidateHead);
  });
  it('rejects unexpected fields, stale run identity and narrated JSON', () => {
    expect(() => parseReviewReport(JSON.stringify({ ...report, bypass: true }), expected)).toThrow('INVALID_RESULT');
    expect(() => parseReviewReport(JSON.stringify({ ...report, runId: 'old-run' }), expected)).toThrow('INVALID_RESULT');
    expect(() => parseReviewReport(`Looks good: ${JSON.stringify(report)}`, expected)).toThrow('INVALID_RESULT');
  });
  it('does not accept an approval with blocking findings', () => {
    const findings = [{ severity: 'high', file: 'source.ts', line: 1, reason: 'unsafe', suggestion: 'fix' }];
    expect(() => parseReviewReport(JSON.stringify({ ...report, findings }), expected)).toThrow('blocking findings');
  });
});
