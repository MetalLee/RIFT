import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatService } from '../../src/chat/service.js';
import type { AgentTurn } from '../../src/chat/contracts.js';
import type { RuntimeTurnInput } from '../../src/agent/runtime-types.js';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from './fixtures.js';

async function fixture(titleResult = '优化会话标题与界面') {
  const home = await mkdtemp(path.join(tmpdir(), 'rift-conversation-title-'));
  const store = new RiftStore();
  const { workspace, roles } = seedWorkspace(store);
  const lead = roles.find(role => role.kind === 'dsh-lead')!;
  const developer = roles.find(role => role.name === 'developer-a')!;
  const leadConnection = { runtime: 'dsh' as const, provider: 'lead-provider', model: 'lead-model' };
  store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?', JSON.stringify(leadConnection), workspace.id);
  store.exec('UPDATE roles SET chat_connection=? WHERE id=?', JSON.stringify({ runtime: 'dsh', provider: 'developer-provider', model: 'developer-model' }), developer.id);
  const inputs: RuntimeTurnInput[] = [];
  const toolTurns: string[] = [];
  const chat: ChatService = new ChatService({
    store, home, defaultConnection: () => ({ runtime: 'dsh', model: 'default' }), validateConnection: () => {},
    tools: turn => { toolTurns.push(turn.id); return []; },
    runtime: () => ({ persistentSessions: true, async start(input) {
      inputs.push(input);
      const isTitle = !!chat.turn(workspace.id, input.turnId).configuration.conversationTitle;
      return { result: Promise.resolve({ text: isTitle ? titleResult : '正常回复', stopReason: titleResult === 'FAIL' && isTitle ? 'failed' as const : 'completed' as const }), async dispose() {} };
    } }),
  });
  const titleTurns = () => store.all<AgentTurn>('SELECT * FROM agent_turns').filter(turn => turn.configuration.conversationTitle);
  const close = async () => { await chat.close(); store.close(); await rm(home, { recursive: true, force: true }); };
  return { store, chat, workspace, lead, developer, inputs, toolTurns, titleTurns, close };
}

describe('Lead conversation titles', () => {
  it('summarizes only the first input with the workspace Lead, including a message addressed to another Agent', async () => {
    const f = await fixture();
    try {
      const conversation = f.chat.createConversation(f.workspace.id);
      const input = { clientMessageId: 'first', recipientAgentId: f.developer.id, content: '请优化会话标题与界面，标题由主 Agent 根据首条消息总结。' };
      const first = f.chat.send(f.workspace.id, conversation.id, input);
      expect(f.chat.send(f.workspace.id, conversation.id, input).turn.id).toBe(first.turn.id);
      await expect.poll(() => f.chat.conversation(f.workspace.id, conversation.id).title).toBe('优化会话标题与界面');
      const titleTurn = f.titleTurns()[0]!;
      const titleInput = f.inputs.find(value => value.turnId === titleTurn.id)!;
      expect(titleInput).toMatchObject({ agentId: f.lead.id, model: 'lead-model', messages: [{ role: 'user', content: input.content }], tools: [] });
      expect(titleInput.session).toBeUndefined();
      expect(f.toolTurns).not.toContain(titleTurn.id);
      expect(titleTurn.configuration.connection.provider).toBe('lead-provider');
      const second = f.chat.send(f.workspace.id, conversation.id, { ...input, clientMessageId: 'second', content: '现在改为讨论别的主题' });
      await expect.poll(() => f.chat.turn(f.workspace.id, second.turn.id).status).toBe('completed');
      expect(f.titleTurns()).toHaveLength(1);
      expect(f.chat.list(f.workspace.id)[0]!.title).toBe('优化会话标题与界面');
      const page = f.chat.page(f.workspace.id, conversation.id, undefined, 2);
      expect(page.messages).toHaveLength(2);
      expect(page.turns.every(turn => !turn.configuration.conversationTitle)).toBe(true);
      const older = f.chat.page(f.workspace.id, conversation.id, page.nextBefore!, 2);
      expect(older.messages.map(message => message.content)).toEqual([input.content, '正常回复']);
      expect(older.nextBefore).toBeNull();
      expect(f.inputs.find(value => value.turnId === second.turn.id)!.messages.some(message => message.content.includes('优化会话标题与界面') && message.role === 'assistant')).toBe(false);
      expect(f.store.all("SELECT * FROM workspace_events WHERE type='conversation.updated'")).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(['FAIL', '标题\n这是多余的解释', '长'.repeat(61), ''])('keeps a useful preview and successful chat when title output is invalid: %s', async output => {
    const f = await fixture(output);
    try {
      const c = f.chat.createConversation(f.workspace.id);
      const { turn } = f.chat.send(f.workspace.id, c.id, { clientMessageId: 'first', content: '修复黑色下拉框' });
      await expect.poll(() => f.titleTurns()[0]?.cleanupStatus).toBe('confirmed');
      expect(f.chat.turn(f.workspace.id, turn.id).status).toBe('completed');
      expect(f.chat.conversation(f.workspace.id, c.id).title).toBe('修复黑色下拉框');
      expect(f.chat.page(f.workspace.id, c.id).messages.map(message => message.content)).toEqual(['修复黑色下拉框', '正常回复']);
    } finally { await f.close(); }
  });

  it('preserves explicit titles and isolates generated titles between conversations', async () => {
    const f = await fixture();
    try {
      const named = f.chat.createConversation(f.workspace.id, '用户指定标题');
      const automatic = f.chat.createConversation(f.workspace.id);
      const { turn } = f.chat.send(f.workspace.id, named.id, { clientMessageId: 'named', content: '不要改变我的标题' });
      await expect.poll(() => f.chat.turn(f.workspace.id, turn.id).status).toBe('completed');
      expect(f.titleTurns()).toHaveLength(0);
      f.chat.send(f.workspace.id, automatic.id, { clientMessageId: 'automatic', content: '优化会话标题与界面' });
      await expect.poll(() => f.chat.conversation(f.workspace.id, automatic.id).title).toBe('优化会话标题与界面');
      expect(f.chat.conversation(f.workspace.id, named.id).title).toBe('用户指定标题');
      expect(f.chat.conversation(f.workspace.id, named.id).version).toBe(0);
    } finally { await f.close(); }
  });
});
