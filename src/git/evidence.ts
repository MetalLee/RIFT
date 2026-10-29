import { createHash } from 'node:crypto';
import { release } from 'node:os';
import type { BaselineEvidence, CheckEvidence, EvidenceBinding, EvidenceReadiness } from '@rift/protocol';
import type { Candidate, Task } from '../contracts/index.js';
import type { CheckCommand, GitOperation } from './types.js';

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const commandConfiguration = (command: CheckCommand) => ({ executable: command.executable, args: [...command.args], timeoutMs: command.timeoutMs ?? 120_000 });
export const configurationFingerprint = (command: CheckCommand): string => fingerprint({ ...commandConfiguration(command), required: command.required !== false, ...(command.baseline ? { baseline: command.baseline } : {}) });
// Sandbox policy is versioned explicitly; never fingerprint credential-bearing Host environment values.
export const environmentFingerprint = (): string => fingerprint({ sandbox: 'rift-bwrap-v1', platform: process.platform, arch: process.arch, release: release(), node: process.version });
export const previewCheck = (check: CheckEvidence): CheckEvidence => ({ ...check, stdout: check.stdout.slice(0, 8000), stderr: check.stderr.slice(0, 8000), truncated: check.truncated || check.stdout.length > 8000 || check.stderr.length > 8000 });
export const previewBaseline = (baseline: BaselineEvidence): BaselineEvidence => ({ ...baseline, ...(baseline.check ? { check: previewCheck(baseline.check) } : {}) });
export function evidenceReadiness(operation: GitOperation, commands: readonly CheckCommand[]): EvidenceReadiness {
  const required = commands.filter(command => command.required !== false);
  const blockers: EvidenceReadiness['blockers'] = [], missingCheckIds: string[] = [];
  if (candidateCleanupUnknown(operation)) blockers.push({ classification: 'environment_unavailable', commandId: '', reason: 'CLEANUP_UNKNOWN: Host check descendants have no cleanup proof.' });
  if (!required.length) blockers.push({ classification: 'evidence_missing', commandId: '', reason: 'No required checks configured.' });
  for (const command of commands) {
    const check = operation.checks?.findLast(check => check.commandId === command.id);
    const valid = check?.host?.executionSource === 'host' && check.host.schemaVersion === 1 && operation.binding && fingerprint(bindingOf(check.host)) === fingerprint(operation.binding) && check.candidateHead === operation.candidateHead && check.host.configurationFingerprint === configurationFingerprint(command) && check.host.environmentFingerprint === environmentFingerprint();
    if (!valid) {
      if (command.required !== false) { missingCheckIds.push(command.id); blockers.push({ classification: 'evidence_missing', commandId: command.id, reason: 'Missing or stale Host attachment for this candidate/configuration/environment.' }); }
    } else if (check!.exitCode !== 0 || check!.host!.exitStatus !== 'passed') {
      blockers.push({ classification: command.required === false ? 'optional' : check!.host!.exitStatus === 'environment_unavailable' || check!.host!.exitStatus === 'timed_out' ? 'environment_unavailable' : 'code_defect', commandId: command.id, reason: check!.host!.summary });
    }
  }
  const status = candidateCleanupUnknown(operation) ? 'environment_unavailable' : blockers.some(item => item.classification === 'code_defect') ? 'failed' : blockers.some(item => item.classification === 'environment_unavailable') ? 'environment_unavailable' : blockers.some(item => item.classification === 'evidence_missing') ? 'waiting_evidence' : 'ready';
  return { status, cleanupStatus: candidateCleanupUnknown(operation) ? 'unknown' : operation.checkCleanup, requiredCheckIds: required.map(command => command.id), missingCheckIds, blockers };
}
export function bindingOf(value: EvidenceBinding): EvidenceBinding {
  const { workspaceId, repositoryId, repositoryFingerprint, taskId, attempt, integrationId, candidateHead } = value;
  return { workspaceId, repositoryId, repositoryFingerprint, taskId, attempt, integrationId, candidateHead };
}
export function candidateCleanupUnknown(operation: GitOperation): boolean {
  return operation.checkCleanup === 'unknown' || operation.checkCleanup === undefined && !!operation.checks?.some(check => check.exitCode === 124 || check.host?.exitStatus === 'timed_out');
}
export function candidateMatchesTask(candidate: Candidate | null, task: Task): boolean {
  const attempt = candidate?.taskAttempt ?? candidate?.checks?.find(check => check.host?.taskId === task.id)?.host?.attempt;
  return !!candidate && attempt === task.attempt && !!task.sourceHead && candidate.sourceHead === task.sourceHead;
}
export class CandidateEvidenceError extends Error {
  constructor(readonly candidate: Candidate, readonly readiness: EvidenceReadiness, readonly cleanupUnknown = readiness.cleanupStatus === 'unknown') {
    super(`${readiness.status === 'failed' ? 'CHECK_FAILED' : 'EVIDENCE_NOT_READY'}: ${readiness.blockers.map(item => `${item.commandId}: ${item.reason}`).join('; ')}`);
  }
}
