/** Runtime boundaries are owned by the Host. Model arguments never choose an identity. */
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown, signal: AbortSignal, context?: { callId: string }): Promise<unknown>;
}

export interface RuntimeTurnInput {
  /** Host-selected persistent thread. Callbacks must commit before continuing. */
  session?: RuntimeSession;
  workspaceId: string;
  agentId: string;
  turnId: string;
  /** Host-selected staging directory or registered repository/worktree cwd. */
  cwd: string;
  /** Host-selected repository roots from this workspace's ledger. Never model
   * arguments. Native execution verifies Git roots and derives exact metadata
   * directories; formal review/analysis modes cannot elevate through this field. */
  repositoryAccess?: { repositoryPaths: string[]; protectedPaths?: string[]; shellHome?:string; skillResources?:string; workspaceDirectory?:string };
  model: string;
  reasoningEffort?: string;
  instructions: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: RuntimeTool[];
  signal: AbortSignal;
  onText?: (text: string) => void;
  /** Preferred stream. Adapters use onText only when this is absent. */
  onEvent?: (event: RuntimeEvent) => void;
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
  diagnostic?: string;
  /** Last assistant message's text, excluding earlier text before tool calls. */
  finalText?: string;
  stopReason: 'completed' | 'cancelled' | 'failed';
  /** Bounded, credential-redacted provider diagnostic, when available. */
  error?: string;
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

export type RuntimeMessageKind = 'assistant' | 'commentary' | 'final' | 'reasoning_summary';
export type RuntimeEvent =
  | { type: 'message.started'; messageId: string; kind: RuntimeMessageKind }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.completed'; messageId: string; kind?: RuntimeMessageKind; text?: string; interrupted?: boolean }
  | { type: 'tool.started' | 'tool.completed' | 'tool.failed'; toolCallId: string; toolName: string }
  | { type: 'status.changed'; status: 'thinking' | 'generating' };
