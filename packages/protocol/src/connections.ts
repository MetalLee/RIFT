/** The secret exists only in the authenticated create request, never a response DTO. */
export interface ApiConnectionCreate {
  name: string; protocol: 'openai-completions'|'openai-responses'|'anthropic-messages'; endpoint: string; model: string;
  apiKey: string; parentId?: string;
}

export interface ApiConnection {
  id: string; name: string; protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; endpoint: string; model: string;
  provider: string; revision: number; parentId: string | null; createdAt: string; verifiedAt: string | null;
  verificationStatus: 'not-verified' | 'passed' | 'failed'; verificationError: string | null; available: boolean;
  verification?: { method: 'conversation-and-tool'; conversation: boolean; toolCalls: number; reply: string; stopReason: string | null; cleanupConfirmed: boolean; error: string | null } | null;
}

export interface ConnectionChoice { id: string; runtime: 'dsh' | 'codex'; provider?: string; available: boolean; executionAvailable?: boolean; authentication: string; tools: boolean; streaming: boolean; modelSelection: string; models: string[]; disabledReason?: string }
