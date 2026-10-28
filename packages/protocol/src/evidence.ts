export interface CheckEvidence { id: string; commandId: string; candidateHead: string; exitCode: number; stdout: string; stderr: string; startedAt: string; finishedAt: string; truncated: boolean }
export interface ReviewFinding { severity: 'critical' | 'high' | 'medium' | 'low'; file: string; line: number; reason: string; suggestion: string }
export interface ReviewReport { schemaVersion: 1; taskId: string; runId: string; verdict: 'approve' | 'changes_requested' | 'blocked'; reviewedCommit: string; findings: ReviewFinding[] }
