import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import type { ActivationBridge } from '../../src/contracts/index.js';

describe('A03/A07/A10 fake official-service boundary (not a native runtime pass)', () => {
  it('requires the exact current live parent and exact registered provider', async () => {
    const parent = { id: 'parent' } as Agent;
    const startActivation = vi.fn();
    const ctx = { agents: { get: () => ({ id: 'parent' }) }, subagents: { getProvider: () => ({}), startActivation } } as unknown as Context;
    const bridge = new DshActivationBridge(ctx, () => parent);
    const input = { signal: new AbortController().signal, task: { id: 'task', title: 'task' }, run: { id: 'run', providerSnapshot: { binding: { providerName: 'configured' } } }, cwd: 'C:/task', prompt: 'work' } as Parameters<ActivationBridge['start']>[0];
    await expect(bridge.start(input)).rejects.toMatchObject({ code: 'LIVE_LEAD_REQUIRED' });
    expect(startActivation).not.toHaveBeenCalled();
    ctx.agents.get = (() => parent) as typeof ctx.agents.get;
    ctx.subagents.getProvider = (() => undefined) as typeof ctx.subagents.getProvider;
    await expect(bridge.start(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(startActivation).not.toHaveBeenCalled();
  });

  it('uses caller delivery, propagates abort and disposes only the returned handle', async () => {
    const parent = { id: 'parent' } as Agent;
    const dispose = vi.fn(async () => undefined);
    const startActivation = vi.fn(async () => ({ childId: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'result' }] }), dispose }));
    const ctx = { agents: { get: () => parent }, subagents: { getProvider: () => ({}), startActivation } } as unknown as Context;
    const bridge = new DshActivationBridge(ctx, () => parent);
    const signal = new AbortController().signal;
    const input = { signal, task: { id: 'task', title: 'task' }, run: { id: 'run', providerSnapshot: { binding: { providerName: 'configured' } } }, cwd: 'C:/中文 任务', prompt: 'work' } as Parameters<ActivationBridge['start']>[0];
    const handle = await bridge.start(input);
    expect(startActivation).toHaveBeenCalledWith({ provider: 'configured', label: 'task (run)', request: { parent, cwd: input.cwd, prompt: [{ type: 'text', text: 'work' }] }, signal, delivery: 'caller' });
    expect(await handle.result).toEqual({ stopReason: 'completed', text: 'result' });
    await handle.dispose(); expect(dispose).toHaveBeenCalledOnce();
    const controller = new AbortController(); controller.abort();
    await expect(bridge.start({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(startActivation).toHaveBeenCalledOnce();
  });
});
