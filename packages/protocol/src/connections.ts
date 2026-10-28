/** Authentication is request-only: supply exactly one secret or Host reference. */
export type ApiConnectionCreate = Pick<ApiConnection, 'name' | 'protocol' | 'endpoint' | 'model'> & { parentId?: string } & (
  | { apiKey: string; credentialRef?: never }
  | { credentialRef: string; apiKey?: never }
);

export interface ApiConnection {
  id: string; name: string; protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; endpoint: string; model: string;
  provider: string; revision: number; parentId: string | null; createdAt: string; verifiedAt: string | null;
  verificationStatus: 'not-verified' | 'passed' | 'failed'; verificationError: string | null; available: boolean;
  verification?: ConnectionVerification | null;
}

export interface ConnectionChoice { id: string; runtime: 'dsh' | 'codex'; provider?: string; available: boolean; executionAvailable?: boolean; authentication: string; tools: boolean; streaming: boolean; modelSelection: string; models: string[]; disabledReason?: string }

export interface ConnectionVerification {
  method: 'conversation-and-tool'; conversation: boolean; toolCalls: number; reply: string;
  stopReason: string | null; cleanupConfirmed: boolean; error: string | null;
}
