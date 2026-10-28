import type { CheckEvidence, ReviewReport } from '@rift/protocol';
export type { CheckEvidence, ReviewFinding, ReviewReport } from '@rift/protocol';
export interface RepositoryInfo { rootPath: string; commonGitDir: string; baseCommit: string }
export interface CheckCommand { id: string; executable: string; args: readonly string[]; timeoutMs?: number; required?: boolean }
export type GitOperationPhase = 'candidate_planned' | 'candidate_created' | 'checks_recorded' | 'review_recorded' | 'publish_planned' | 'ref_published' | 'completed' | 'blocked';
export interface GitOperation { integrationId: string; taskId: string; integrationRef: string; sourceHead: string; expectedTargetHead: string; candidateHead?: string; candidatePath: string; reviewPath: string; phase: GitOperationPhase; checks?: CheckEvidence[]; review?: ReviewReport; reason?: string; binding?: import('@rift/protocol').EvidenceBinding; readiness?: import('@rift/protocol').EvidenceReadiness; evidenceRequests?: Record<string, { candidateHead: string; complete: boolean }> }
