export interface CheckEvidence { id: string; commandId: string; candidateHead: string; exitCode: number; stdout: string; stderr: string; startedAt: string; finishedAt: string; truncated: boolean; host?: HostCheckAttachment; durationMs?: number }
export interface ReviewFinding { severity: 'critical' | 'high' | 'medium' | 'low'; file: string; line: number; reason: string; suggestion: string }
export interface ReviewReport { schemaVersion: 1; taskId: string; runId: string; verdict: 'approve' | 'changes_requested' | 'blocked'; reviewedCommit: string; findings: ReviewFinding[] }

/** Additive metadata: legacy/developer reports without this are not trusted Host attachments. */
export type BlockerClassification = 'code_defect' | 'evidence_missing' | 'environment_unavailable' | 'optional';
export interface EvidenceBinding { workspaceId: string; repositoryId: string; repositoryFingerprint: string; taskId: string; attempt: number; integrationId: string; candidateHead: string }
export interface HostCheckAttachment extends EvidenceBinding {
  schemaVersion: 1; executionSource: 'host'; command: { executable: string; args: string[]; timeoutMs: number };
  configurationFingerprint: string; environmentFingerprint: string;
  exitStatus: 'passed' | 'failed' | 'environment_unavailable' | 'timed_out';
  logSha256: string; summary: string;
}
export interface EvidenceBlocker { classification: BlockerClassification; commandId: string; reason: string }
export interface EvidenceReadiness {
  status: 'ready' | 'waiting_evidence' | 'failed' | 'environment_unavailable';
  cleanupStatus?: 'unknown' | 'confirmed';
  requiredCheckIds: string[]; missingCheckIds: string[]; blockers: EvidenceBlocker[];
}
export interface TaskEvidenceIntegration { id: string; status: string; candidateHead?: string; checks: CheckEvidence[]; review: ReviewReport | null; evidenceUnavailable: boolean; readiness: EvidenceReadiness; baselines?: BaselineEvidence[]; timings?: StageTimings }
export interface TaskEvidence { taskId: string; acceptedCommit: string | null; currentCandidate?: { integrationId: string; candidateHead: string; sourceHead: string; taskAttempt: number } | null; integrations: TaskEvidenceIntegration[] }
export interface SupplementEvidenceInput { integrationId: string; candidateHead: string; expectedVersion: number; idempotencyKey: string }

/** Historical comparison only; never a candidate check or approval. Host-owned v1 contract. */
export interface BaselineIdentity {
  schemaVersion: 1; workspaceId: string; repositoryId: string; repositoryFingerprint: string; repositoryConfigurationFingerprint: string;
  baselineCommit: string; tree: string; commandId: string; configurationFingerprint: string; planFingerprint: string;
  environmentFingerprint: string; environmentId: string; executableSha256: string;
}
export interface BaselineEvidence {
  key: string; identity?: BaselineIdentity; integrationId?: string;
  status: 'recorded' | 'reused' | 'unavailable'; cleanupStatus: 'confirmed' | 'unknown';
  lookupMs: number; check?: CheckEvidence; failureFingerprint?: string; reason?: string;
}
export interface StageTimings { prepareMs?: number; baselineMs?: number; checksMs?: number }
