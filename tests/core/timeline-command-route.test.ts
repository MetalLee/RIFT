import { describe, expect, it, vi } from 'vitest';
import { ApplicationCommands } from '../../src/application/commands.js';
import { resolveHttpCommand } from '../../src/api/command-routes.js';
import type { RiftHostService } from '../../src/api/host-service.js';

describe('timeline pagination through shared application commands', () => {
  it.each(['/ui-api/v1', '/v1'])('preserves timeline query parameters for %s', async prefix => {
    const page = vi.fn(() => ({ timeline: true, messages: [] }));
    const host = { store: { workspace: vi.fn() }, chat: { page } };
    const commands = new ApplicationCommands(host as unknown as RiftHostService);
    const query = new URLSearchParams({ before: 'cursor', limit: '30', view: 'timeline', refresh: JSON.stringify(['message:retained', 'turn-status:turn']) });
    const result = await commands.execute(resolveHttpCommand('GET', `${prefix}/workspaces/ws/conversations/chat/messages?${query}`, {}));
    expect(page).toHaveBeenCalledWith('ws', 'chat', 'cursor', 30, true, ['message:retained', 'turn-status:turn']);
    expect(result).toEqual({ timeline: true, messages: [] });
  });
  it('keeps legacy message pagination defaults', async () => {
    const page = vi.fn();
    const commands = new ApplicationCommands({ store: { workspace: vi.fn() }, chat: { page } } as unknown as RiftHostService);
    await commands.execute(resolveHttpCommand('GET', '/v1/workspaces/ws/conversations/chat/messages', {}));
    expect(page).toHaveBeenCalledWith('ws', 'chat', undefined, 50, false, []);
  });
});
