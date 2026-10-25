import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-subagent';
import type { ActivationBridge, ActivationHandle } from '../contracts/index.js';
import { RiftError } from '../contracts/index.js';

/** A thin adapter over the official service; never owns a Host or native process. */
export class DshActivationBridge implements ActivationBridge {
  constructor(private readonly ctx: Context, private readonly parentForTask: (taskId: string) => Agent | undefined) {}

  async start(input: Parameters<ActivationBridge['start']>[0]): Promise<ActivationHandle> {
    if (input.signal.aborted) throw new RiftError('ABORTED_BEFORE_START', 'Cancelled before calling the provider.');
    const parent = this.parentForTask(input.task.id);
    if (!parent || this.ctx.agents.get(parent.id) !== parent) {
      throw new RiftError('LIVE_LEAD_REQUIRED', 'The workflow needs its current live DSH Lead before dispatch.');
    }
    const binding = input.run.providerSnapshot.binding;
    if (!binding || !this.ctx.subagents.getProvider(binding.providerName)) {
      throw new RiftError('PROVIDER_UNAVAILABLE', 'The exact configured provider instance is not registered.');
    }
    const activation = await this.ctx.subagents.startActivation({
      provider: binding.providerName,
      label: `${input.task.title} (${input.run.id})`,
      request: { parent, cwd: input.cwd, prompt: [{ type: 'text', text: input.prompt }] },
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
