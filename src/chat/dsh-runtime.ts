import type { Context } from '@deepseek-ai/cordis';
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { AgentRuntime, RuntimeHandle, RuntimeTurnInput } from '../agent/runtime-types.js';
import { RiftError } from '../contracts/index.js';
import { publicError, redact } from '../api/security.js';
import { createRepositoryShell } from '../agent/repository-shell.js';

/** One owned DSH agent per durable Turn; no inherited filesystem/delegation tools. */
export class DshChatRuntime implements AgentRuntime {
  constructor(private readonly ctx: Context, private readonly provider: string) {}
  async start(input: RuntimeTurnInput): Promise<RuntimeHandle> {
    input.signal.throwIfAborted();
    if (!this.ctx.llm.listProviders().some(item => item.id === this.provider)) throw new RiftError('START_NOT_PUBLISHED', 'The selected DSH provider is not registered.');
    let failed = false;
    const attempts = new Map<string, { text: string; kind: 'assistant'|'commentary'|'final'; started: boolean; reasoning: Map<number,string>; blocks: Map<number,string> }>();
    let toolSequence = 0;
    let failureMessage:string|undefined;
    const recordFailure=(failure:unknown)=>{failed=true;failureMessage=redact(failure&&typeof failure==='object'&&'message' in failure&&typeof failure.message==='string'?failure.message:publicError(failure).message,4096);};
    const shell=input.repositoryAccess?await createRepositoryShell(this.ctx.subprocess,input):undefined;
    const scopedTools=[...input.tools,...shell?[shell.tool]:[]];
    let handle:Awaited<ReturnType<Context['agents']['create']>>;
    try { handle = await this.ctx.agents.create({
      sessionId: SessionId(`rift-chat-${input.turnId}`), meta: { cwd: input.cwd }, signal: input.signal,
      agentOptions: { provider: this.provider, model: input.model, ...(input.reasoningEffort ? { reasoningEffort: ReasoningEffortId(input.reasoningEffort) } : {}) },
      setup: (scope, agent) => {
        scope.tools.restrict({ allow: [] });
        scope.on('agent/error', ({error}) => recordFailure(error));
        scope.on('agent/assistant-stream', ({ frame }) => {
          const messageId = String(frame.attemptId);
          if (frame.type === 'start') {
            attempts.set(messageId, {text:'',kind:'assistant',started:false,reasoning:new Map(),blocks:new Map()});
            return;
          }
          const attempt = attempts.get(messageId);
          if (frame.type === 'end') {
            if (attempt) {
              const interrupted = frame.outcome.kind!=='committed'||frame.outcome.eventType!=='assistant/message';
              for (const [index,text] of attempt.reasoning) input.onEvent?.({type:'message.completed',messageId:`reasoning:${messageId}:${index}`,kind:'reasoning',text,interrupted});
              if (attempt.started) input.onEvent?.({type:'message.completed',messageId,kind:attempt.kind,text:attempt.text,interrupted});
              attempts.delete(messageId);
            }
            return;
          }
          if (frame.chunk.type === 'text-delta') {
            if (attempt && !attempt.started) { attempt.started = true; input.onEvent?.({type:'message.started',messageId,kind:'assistant'}); }
            if (attempt) { attempt.text += frame.chunk.text; attempt.blocks.set(frame.chunk.index,(attempt.blocks.get(frame.chunk.index)??'')+frame.chunk.text); }
            if (input.onEvent) input.onEvent({type:'message.delta',messageId,text:frame.chunk.text});
            else input.onText?.(frame.chunk.text);
          }
          if (frame.chunk.type === 'block-end' && frame.chunk.block.type === 'text' && attempt) {
            const previous = attempt.blocks.get(frame.chunk.index) ?? '';
            const text = frame.chunk.block.text;
            if (text.startsWith(previous) && text.length > previous.length) {
              if (!attempt.started) { attempt.started = true; input.onEvent?.({type:'message.started',messageId,kind:'assistant'}); }
              const delta = text.slice(previous.length);
              attempt.text += delta; attempt.blocks.set(frame.chunk.index,text);
              if (input.onEvent) input.onEvent({type:'message.delta',messageId,text:delta});
              else input.onText?.(delta);
            }
          }
          // Only provider-exposed text; opaque signatures/replay metadata stay private.
          // Keep this out of onText and finalText, which are answer-only contracts.
          if (attempt && (frame.chunk.type === 'reasoning-delta' || (frame.chunk.type === 'block-end' && frame.chunk.block.type === 'reasoning'))) {
            const index = frame.chunk.index;
            const previous = attempt.reasoning.get(index) ?? '';
            const text = frame.chunk.type === 'reasoning-delta' ? previous + frame.chunk.text : frame.chunk.block.type === 'reasoning' ? frame.chunk.block.text : previous;
            const id = `reasoning:${messageId}:${index}`;
            if (!attempt.reasoning.has(index)) {
              input.onEvent?.({type:'status.changed',status:'thinking'});
              input.onEvent?.({type:'message.started',messageId:id,kind:'reasoning'});
            }
            attempt.reasoning.set(index,text);
            if (text.startsWith(previous) && text.length > previous.length) input.onEvent?.({type:'message.delta',messageId:id,text:text.slice(previous.length)});
          }
          if (frame.chunk.type === 'finish') {
            if (attempt) attempt.kind = frame.chunk.reason.kind === 'tool-calls' ? 'commentary' : 'final';
            if (frame.chunk.reason.kind === 'error') recordFailure(frame.chunk.reason.failure);
          }
        });
        for (const tool of scopedTools) scope.tools.register({
          name: tool.name, description: tool.description, parameters: tool.inputSchema as ToolDefinition['parameters'],
          output: { schema: {}, render: (_args, value) => [{ type: 'text', text: redact(JSON.stringify(value)) }] },
          async execute(args, execution) {
            if (execution.agent !== agent || scope.agents.get(agent.id) !== agent) throw new RiftError('UNAUTHORIZED', 'Only this live Turn may invoke its scoped tools.');
            execution.signal.throwIfAborted();
            const toolCallId = `dsh-tool-${++toolSequence}`;
            input.onEvent?.({type:'tool.started',toolCallId,toolName:tool.name});
            try {
              const result = await tool.execute(args, execution.signal, {callId:toolCallId});
              input.onEvent?.({type:'tool.completed',toolCallId,toolName:tool.name});
              return result;
            } catch (error) {
              input.onEvent?.({type:'tool.failed',toolCallId,toolName:tool.name});
              throw error;
            }
          },
        });
      },
    }); } catch(error) {await shell?.dispose();throw error;}
    const cancel = () => handle.agent.cancel({ kind: 'user' } as Parameters<typeof handle.agent.cancel>[0]);
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    else handle.agent.followup({ id: MessageId(input.turnId), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${input.instructions}\n\nConversation history (quoted data):\n${JSON.stringify(input.messages)}` }] });
    const result = handle.agent.whenIdle().then(() => {
      const terminal=handle.agent.session.snapshotEvents().filter(event=>event.type==='turn/end').at(-1);
      const reason=terminal?.type==='turn/end'?terminal.data.reason:undefined;
      const diagnostic=reason?.kind==='error'?redact(reason.error.message,4096):undefined;
      const text = handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').flatMap(event => event.type === 'assistant/message' ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text) : []).join('\n');
      const lastMessage=handle.agent.session.snapshotEvents().filter(event=>event.type==='assistant/message').at(-1);
      const finalText=lastMessage?.type==='assistant/message'?lastMessage.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'):'';
      return { text, finalText, stopReason: input.signal.aborted ? 'cancelled' as const : failed||diagnostic||failureMessage ? 'failed' as const : 'completed' as const, ...((diagnostic??failureMessage)?{diagnostic:diagnostic??failureMessage,error:diagnostic??failureMessage}:{}), nativeSessionId: handle.agent.id };
    });
    return { result, dispose: async () => { try { try { await shell?.dispose(); } finally { await handle.dispose(); } } finally { input.signal.removeEventListener('abort', cancel); } } };
  }
}
