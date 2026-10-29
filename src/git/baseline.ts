import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BaselineIdentity, CheckEvidence } from '@rift/protocol';
import { configurationFingerprint, environmentFingerprint, fingerprint } from './evidence.js';
import { gitOk } from './process.js';
import type { CheckPlan, CheckCommand } from './types.js';

/** environmentId is a Host attestation of immutable tools/external inputs, not agent input. */
export async function baselineIdentity(input: { workspaceId: string; repositoryId: string; commonGitDir: string; repositoryPath: string; baselineCommit: string; planFingerprint: string; command: CheckCommand; checkPlan?: CheckPlan; commands?: readonly CheckCommand[] }): Promise<BaselineIdentity> {
  const { command } = input;
  const candidates = path.isAbsolute(command.executable) ? [command.executable] : command.executable.includes('/') ? [] : ['/usr/local/bin', '/usr/bin', '/bin'].map(directory => path.join(directory, command.executable));
  let executable: string | undefined;
  for (const candidate of candidates) {
    try { executable = await realpath(candidate); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!executable || !['/usr/', '/bin/'].some(root => executable!.startsWith(root)) || !(await stat(executable)).isFile()) throw new Error('BASELINE_ENVIRONMENT_UNVERIFIABLE');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  return {
    schemaVersion: 1, workspaceId: input.workspaceId, repositoryId: input.repositoryId,
    repositoryFingerprint: fingerprint(input.commonGitDir),
    repositoryConfigurationFingerprint: fingerprint(await gitOk(input.repositoryPath, ['config', '--no-includes', '--null', '--list'])),
    baselineCommit: input.baselineCommit, tree: await gitOk(input.repositoryPath, ['rev-parse', `${input.baselineCommit}^{tree}`]),
    commandId: command.id, configurationFingerprint: configurationFingerprint(command, input.checkPlan, input.commands), planFingerprint: input.planFingerprint,
    environmentFingerprint: environmentFingerprint(), environmentId: command.baseline!.environmentId, executableSha256: hash.digest('hex'),
  };
}
export const baselineFailureFingerprint = (check: CheckEvidence): string | undefined => check.host?.exitStatus === 'failed' ? fingerprint({ exitCode: check.exitCode, exitStatus: check.host.exitStatus, logSha256: check.host.logSha256, truncated: check.truncated }) : undefined;
