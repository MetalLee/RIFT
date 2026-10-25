import type { Context } from '@deepseek-ai/cordis';
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { AgentRuntime, RuntimeHandle, RuntimeTurnInput } from '../agent/runtime-types.js';
import { RiftError } from '../contracts/index.js';
import { redact } from '../api/security.js';

/** One owned DSH agent per durable Turn; no inherited filesystem/delegation tools. */
export class DshChatRuntime implements AgentRuntime {
  constructor(private readonly ctx: Context, private readonly provider: string) {}
  async start(input: RuntimeTurnInput): Promise<RuntimeHandle> {
    input.signal.throwIfAborted();
    if (!this.ctx.llm.listProviders().some(item => item.id === this.provider)) throw new RiftError('START_NOT_PUBLISHED', 'The selected DSH provider is not registered.');
    let failed = false;
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(`rift-chat-${input.turnId}`), meta: { cwd: input.cwd }, signal: input.signal,
      agentOptions: { provider: this.provider, model: input.model, ...(input.reasoningEffort ? { reasoningEffort: ReasoningEffortId(input.reasoningEffort) } : {}) },
      setup: (scope, agent) => {
        scope.tools.restrict({ allow: [] });
        scope.on('agent/error', () => { failed = true; });
        scope.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') input.onText?.(frame.chunk.text); });
        for (const tool of input.tools) scope.tools.register({
          name: tool.name, description: tool.description, parameters: tool.inputSchema as ToolDefinition['parameters'],
          output: { schema: {}, render: (_args, value) => [{ type: 'text', text: redact(JSON.stringify(value)) }] },
          async execute(args, execution) {
            if (execution.agent !== agent || scope.agents.get(agent.id) !== agent) throw new RiftError('UNAUTHORIZED', 'Only this live Turn may invoke its scoped tools.');
            execution.signal.throwIfAborted();
            return tool.execute(args, execution.signal);
          },
        });
      },
    });
    const cancel = () => handle.agent.cancel({ kind: 'user' } as Parameters<typeof handle.agent.cancel>[0]);
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    else handle.agent.followup({ id: MessageId(input.turnId), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${input.instructions}\n\nConversation history (quoted data):\n${JSON.stringify(input.messages)}` }] });
    const result = handle.agent.whenIdle().then(() => {
      const text = handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').flatMap(event => event.type === 'assistant/message' ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text) : []).join('\n');
      return { text, stopReason: input.signal.aborted ? 'cancelled' as const : failed ? 'failed' as const : 'completed' as const, nativeSessionId: handle.agent.id };
    });
    return { result, dispose: async () => { try { await handle.dispose(); } finally { input.signal.removeEventListener('abort', cancel); } } };
  }
}
