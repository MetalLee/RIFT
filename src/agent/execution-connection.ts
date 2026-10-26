import type { ProviderBinding } from '../contracts/index.js';
import type { ChatConnection } from '../chat/contracts.js';

export function bindingConnection(binding?: ProviderBinding | null): ChatConnection | null {
  if (binding?.runtime === 'dsh' && binding.spawn) return {
    runtime: 'dsh', provider: binding.spawn.provider, model: binding.spawn.model,
    ...(binding.spawn.reasoningEffort ? { reasoningEffort: binding.spawn.reasoningEffort } : {}),
  };
  if (binding?.runtime === 'codex' && binding.model) return {
    runtime: 'codex', model: binding.model,
    ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}),
  };
  return null;
}
