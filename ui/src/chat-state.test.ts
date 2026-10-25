import { describe, expect, it, vi } from 'vitest';
import { loadPending, mergeChatHistory, persistPending, shouldSendOnKey } from './chat-state';
import type { ChatMessage, AgentTurn, MessageChunk } from '../../src/chat/contracts';
describe('conversation continuity', () => {
  it('never sends while an IME composition is active or reports legacy key code 229', () => {
    expect(shouldSendOnKey({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true, keyCode: 13 })).toBe(false);
    expect(shouldSendOnKey({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });
  it('leaves ordinary Enter available for multiline drafts', () => {
    expect(shouldSendOnKey({ key: 'Enter', ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13 })).toBe(false);
    expect(shouldSendOnKey({ key: 'a', ctrlKey: true, metaKey: false, isComposing: false })).toBe(false);
  });
  it('sends only the deliberate Control/Command Enter shortcut outside composition', () => {
    expect(shouldSendOnKey({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, keyCode: 13 })).toBe(true);
    expect(shouldSendOnKey({ key: 'Enter', ctrlKey: false, metaKey: true, isComposing: false, keyCode: 13 })).toBe(true);
  });
  it('retains an old queued turn and its chunks while replacing newer versions by stable ID', () => {
    const oldMessage = { id: 'old' } as ChatMessage;
    const current = { id: 'new' } as ChatMessage;
    const oldTurn = { id: 'old-turn', status: 'queued' } as AgentTurn;
    const result = mergeChatHistory({ messages: [oldMessage], turns: [oldTurn], chunks: [{ seq: 2, text: 'two' } as MessageChunk] }, { messages: [current], turns: [{ ...oldTurn, status: 'completed' }], chunks: [{ seq: 1, text: 'one' } as MessageChunk, { seq: 2, text: 'two' } as MessageChunk] });
    expect(result.messages.map(m => m.id)).toEqual(['old', 'new']);
    expect(result.turns).toHaveLength(1); expect(result.turns[0]?.status).toBe('completed');
    expect(result.chunks.map(c => c.seq)).toEqual([1, 2]);
  });
  it('preserves uncertain-send identity across remount and isolates it by workspace and conversation', () => {
    const values = new Map<string, string>(); vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    try { const input = { text: 'Request', recipient: 'agent-a', clientMessageId: 'same-message', key: 'same-key' }; persistPending('workspace-a', 'conversation-a', input); expect(loadPending('workspace-a', 'conversation-a')).toEqual(input); expect(loadPending('workspace-b', 'conversation-a')).toBeNull(); expect(loadPending('workspace-a', 'conversation-b')).toBeNull(); persistPending('workspace-a', 'conversation-a', null); expect(loadPending('workspace-a', 'conversation-a')).toBeNull(); } finally { vi.unstubAllGlobals(); }
  });
  it('never rolls a completed Turn backwards when a late history request returns an older version', () => {
    const completed = { id: 'turn', version: 3, status: 'completed' } as AgentTurn;
    const stale = { id: 'turn', version: 1, status: 'running' } as AgentTurn;
    const result = mergeChatHistory({ messages: [], turns: [completed], chunks: [] }, { messages: [], turns: [stale], chunks: [] });
    expect(result.turns[0]).toEqual(completed);
  });
});
