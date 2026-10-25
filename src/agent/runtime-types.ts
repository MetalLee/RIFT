/** Runtime boundaries are owned by the Host. Model arguments never choose an identity. */
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface RuntimeTurnInput {
  /** Host-selected persistent thread. Callbacks must commit before continuing. */
  session?: RuntimeSession;
  workspaceId: string;
  agentId: string;
  turnId: string;
  /** Host-owned staging directory; native discussion never runs in a repository. */
  cwd: string;
  model: string;
  reasoningEffort?: string;
  instructions: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: RuntimeTool[];
  signal: AbortSignal;
  onText?: (text: string) => void;
}

export interface RuntimeSession {
  threadId?: string;
  runtimeHome: string;
  onThread(threadId: string): void;
  onTurn(turnId: string): void;
  onSettled(status: string): void;
}

export interface RuntimeTurnResult {
  text: string;
  stopReason: 'completed' | 'cancelled' | 'failed';
  nativeSessionId?: string;
}

export interface RuntimeHandle {
  result: Promise<RuntimeTurnResult>;
  /** Resolves only after the runtime's complete process/scope is quiescent. */
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  readonly persistentSessions?: boolean;
  start(input: RuntimeTurnInput): Promise<RuntimeHandle>;
}
