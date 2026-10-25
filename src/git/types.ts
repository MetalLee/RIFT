export interface RepositoryInfo { rootPath: string; commonGitDir: string; baseCommit: string }
export interface CheckCommand { id: string; executable: string; args: readonly string[]; timeoutMs?: number }
export interface CheckEvidence { id: string; commandId: string; candidateHead: string; exitCode: number; stdout: string; stderr: string; startedAt: string; finishedAt: string; truncated: boolean }
export interface ReviewFinding { severity: 'critical' | 'high' | 'medium' | 'low'; file: string; line: number; reason: string; suggestion: string }
export interface ReviewReport { schemaVersion: 1; taskId: string; runId: string; verdict: 'approve' | 'changes_requested' | 'blocked'; reviewedCommit: string; findings: ReviewFinding[] }
export type GitOperationPhase = 'candidate_planned' | 'candidate_created' | 'checks_recorded' | 'review_recorded' | 'publish_planned' | 'ref_published' | 'completed' | 'blocked';
export interface GitOperation { integrationId: string; taskId: string; integrationRef: string; sourceHead: string; expectedTargetHead: string; candidateHead?: string; candidatePath: string; reviewPath: string; phase: GitOperationPhase; checks?: CheckEvidence[]; review?: ReviewReport; reason?: string }
