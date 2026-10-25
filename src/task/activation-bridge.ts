import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-subagent';
import type { ActivationBridge, ActivationHandle } from '../contracts/index.js';
import { RiftError } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import { startAnalysisBatch } from './analysis-reuse.js';

/** A thin adapter over the official service; never owns a Host or native process. */
export class DshActivationBridge implements ActivationBridge {
  constructor(private readonly ctx: Context, private readonly parentForTask: (taskId: string) => Agent | undefined, private readonly store?:RiftStore) {}

  async start(input: Parameters<ActivationBridge['start']>[0]): Promise<ActivationHandle> {
    if (input.signal.aborted) throw new RiftError('ABORTED_BEFORE_START', 'Cancelled before calling the provider.');
    const parent = this.parentForTask(input.task.id);
    if (!parent || this.ctx.agents.get(parent.id) !== parent) {
      throw new RiftError('LIVE_LEAD_REQUIRED', 'The workflow needs its current live DSH Lead before dispatch.');
    }
    const binding = input.run.providerSnapshot.binding;
    const provider=binding && this.ctx.subagents.getProvider(binding.providerName);
    if (!binding || !provider) {
      throw new RiftError('PROVIDER_UNAVAILABLE', 'The exact configured provider instance is not registered.');
    }
    const spawn=binding.spawn;
    if(spawn && (binding.runtime!=='dsh' || !provider.capabilities.agentOptions || (spawn.agentPreset&&!provider.capabilities.agentPreset)))throw new RiftError('START_NOT_PUBLISHED','Configured DSH spawn options are not supported by the exact registered provider.');
    const agentOptions:AgentOptions|undefined=spawn?{provider:spawn.provider,model:spawn.model,...spawn.reasoningEffort?{reasoningEffort:ReasoningEffortId(spawn.reasoningEffort)}:{},...spawn.maxTokens?{maxTokens:spawn.maxTokens}:{}}:undefined;
    if(input.task.analysisItems != null)return startAnalysisBatch(this.ctx,this.store,parent,input,agentOptions);
    const activation = await this.ctx.subagents.startActivation({
      provider: binding.providerName,
      label: `${input.task.title} (${input.run.id})`,
      request: { parent, cwd: input.cwd, prompt: [{ type: 'text', text: input.prompt }],...agentOptions?{agentOptions}:{},...spawn?.agentPreset?{agentPreset:spawn.agentPreset}:{} },
      signal: input.signal,
      delivery: 'caller',
    });
    return {
      childId: activation.childId,
      result: activation.result.then(result => ({
        stopReason: result.stopReason,
        text: result.output.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      })),
      dispose: () => activation.dispose(),
    };
  }
}
