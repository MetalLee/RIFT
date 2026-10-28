import { invariant } from '../contracts/index.js';

export type AgentSandboxMode = 'sandboxed' | 'unrestricted';
/** Operator configuration only; command arguments cannot select execution permissions. */
export function agentSandboxMode(): AgentSandboxMode {
  const mode = process.env.RIFT_AGENT_SANDBOX ?? 'sandboxed';
  invariant(mode === 'sandboxed' || mode === 'unrestricted', 'INVALID_AGENT_SANDBOX', 'RIFT_AGENT_SANDBOX must be sandboxed or unrestricted.');
  return mode;
}
