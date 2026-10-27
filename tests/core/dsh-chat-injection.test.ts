import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { inject } from '../../src/index.js';
import { DshChatRuntime } from '../../src/chat/dsh-runtime.js';
import { createRepositoryShell } from '../../src/agent/repository-shell.js';

vi.mock('../../src/agent/repository-shell.js', () => ({ createRepositoryShell: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('RIFT plugin DSH chat dependencies', () => {
  it.each([true, false])('starts discussion in a real plugin context (repository access: %s)', async repository => {
    const root = new Context();
    const disposeAgent = vi.fn(async () => {}), disposeShell = vi.fn(async () => {});
    const agent = {
      cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {},
      session: { snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ready.' }] } } }] },
    };
    const create = vi.fn(async () => ({ agent, dispose: disposeAgent }));
    root.provide('agents', { create } as never);
    root.provide('subagents', {} as never);
    root.provide('tools', {} as never);
    root.provide('llm', { listProviders: () => [{ id: 'test' }] } as never);
    root.provide('subprocess', { spawn: vi.fn() } as never);
    root.provide('credentials', { resolve: async () => undefined } as never);
    vi.mocked(createRepositoryShell).mockResolvedValue({
      tool: { name: 'exec_command', description: 'Repository command', inputSchema: {}, async execute() { return {}; } },
      dispose: disposeShell,
    });
    // Use the shipped plugin declaration: a plain object or root Context would
    // bypass Cordis's inject guard and miss the production startup failure.
    let scoped!: Context;
    const fiber = await root.plugin({ inject, apply(ctx: Context) { scoped = ctx; } });
    try {
      const handle = await new DshChatRuntime(scoped, 'test').start({
        workspaceId: 'workspace', agentId: 'reviewer', turnId: 'turn', cwd: process.cwd(),
        model: 'test', instructions: 'Reply to the user.', messages: [{ role: 'user', content: 'Hello' }],
        tools: [], signal: new AbortController().signal,
        ...(repository ? { repositoryAccess: { repositoryPaths: [process.cwd()] } } : {}),
      });
      expect(create).toHaveBeenCalledOnce();
      expect(createRepositoryShell).toHaveBeenCalledTimes(repository ? 1 : 0);
      await expect(handle.result).resolves.toMatchObject({ text: 'Ready.', finalText: 'Ready.', stopReason: 'completed' });
      await handle.dispose();
      expect(disposeAgent).toHaveBeenCalledOnce();
      expect(disposeShell).toHaveBeenCalledTimes(repository ? 1 : 0);
    } finally { await fiber.dispose(); }
  });
});
