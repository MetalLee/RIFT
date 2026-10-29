import React from 'react';
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatPage, UiWorkspaceDetail } from '@rift/protocol';
import { RiftHostService } from '../../src/api/host-service.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { seedWorkspace } from './fixtures.js';
import { request } from '../../ui/src/api';
import { mergeChatHistory, needsTimelineBridge, type ChatHistory } from '../../ui/src/chat-state';
import { buildConversationTimeline } from '../../ui/src/chat-timeline';
import { ChatTimeline } from '../../ui/src/ChatTimeline';

// Real SQLite + orchestration + authenticated HTTP; only supply the browser's origin/cookie in Node.
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'rift-timeline-ui-'));
  const host = new RiftHostService({ subagents: { list: () => [] } } as unknown as Context, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
  const { workspace, roles } = seedWorkspace(host.store);
  const conversation = host.chat.createConversation(workspace.id, 'UI receipts');
  const workflow = host.coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'UI receipts', repositoryFree: true, baseCommit: '', integrationRef: '' });
  // Planning workflow projects committed events without launching any agent.
  host.store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES(?,?,?,?,'chat','now')", workflow.id, workspace.id, conversation.id, roles.find(r => r.purpose === 'lead')!.id);
  host.store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES('task',?,?,'analysis','Audit','Audit','[]','[]','running',1)", workflow.id, roles.find(r => r.purpose === 'developer')!.id);
  const api = await startLocalApi(host, host.config), origin = `http://127.0.0.1:${api.port}`;
  const nativeFetch = globalThis.fetch;
  const source = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const session = await nativeFetch(`${origin}/ui-api/v1/session/connect`, { method: 'POST', headers: source, body: '{}' });
  expect(session.status).toBe(200);
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => nativeFetch(new URL(url, origin), { ...init, headers: { ...source, Cookie: cookie, ...init?.headers } })));
  const page = (query: Record<string, string> = {}) => request<ChatPage>(`/workspaces/${workspace.id}/conversations/${conversation.id}/messages?${new URLSearchParams({ view: 'timeline', limit: '2', ...query })}`);
  const emit = async (type: string, payload: Record<string, unknown> = {}, at?: string) => {
    host.store.event(workflow.id, type, payload, { taskId: 'task' });
    const { seq } = host.store.require<{ seq: number }>('SELECT MAX(event_seq) seq FROM task_events');
    await host.orchestration.pump();
    expect(host.orchestration.lastError).toBeNull();
    const { id } = host.store.require<{ id: string }>('SELECT id FROM messages WHERE dedupe_key=?', `event:${seq}:${conversation.id}`);
    if (at) host.store.exec('UPDATE messages SET created_at=? WHERE id=?', at, id);
    return { seq, id };
  };
  const data = { workspace, roles, tasks: [{ id: 'task', title: 'Audit' }] } as unknown as UiWorkspaceDetail;
  const render = (history: ChatHistory) => renderToStaticMarkup(<ChatTimeline {...history} data={data} stale={false} onStop={() => {}} />);
  return { host, page, emit, render, close: async () => { vi.unstubAllGlobals(); await api.close(); await host.close(); await rm(home, { recursive: true, force: true }); } };
}

it('consumes real timeline pages through the UI client/cache/render path without losing routine classifications or decisions', async () => {
  const f = await fixture();
  try {
    await f.emit('source.collected', {}, '2026-01-01');
    const reason = '完整公开决策依据。'.repeat(50) + '<script>not executable</script>';
    const decision = await f.emit('coordination.blocked', { reason }, '2026-01-02');
    await f.emit('dispatch.blocked', { error: 'CHECK FAILED: retry after repair' }, '2026-01-03');
    await f.emit('source.collected', { reason: '必须先修复，不能折叠此原因' }, '2026-01-04');
    const unknown = await f.emit('task.blocked', {}, '2026-01-05');
    f.host.store.exec("UPDATE task_events SET type='future.unknown' WHERE event_seq=?", unknown.seq);
    await f.emit('cleanup.confirmed', {}, '2026-01-06');

    const latest = await f.page();
    const middle = await f.page({ before: latest.nextBefore! });
    const oldest = await f.page({ before: middle.nextBefore! });
    expect(oldest.nextBefore).toBeNull();
    // These are the same merge calls used by acceptSnapshot, loadEarlier and the render projection.
    const empty = { messages: [], turns: [], chunks: [] };
    const earlier = mergeChatHistory(oldest, mergeChatHistory(middle, empty));
    let history = mergeChatHistory(earlier, latest);
    const before = f.render(history);
    const details = before.match(/<details[^>]*>[\s\S]*?<\/details>/g) ?? [];
    expect(details).toHaveLength(0);
    expect(before).not.toContain('例行协作进展');
    for (const text of ['CHECK FAILED', '必须先修复', 'future.unknown', reason.replace('<script>not executable</script>', '')]) {
      expect(before).not.toContain(text);
    }
    expect(before).not.toContain('<script>');
    expect(before).not.toContain('&lt;script&gt;');
    expect(JSON.stringify(history.receipts)).toContain('完整公开决策依据');
    expect(buildConversationTimeline(history.messages, history.turns, history.chunks, history.receipts).loose).toHaveLength(6);

    f.host.store.exec('UPDATE messages SET content=?,version=version+1 WHERE id=?', '决策消息已更新', decision.id);
    const refreshed = await f.page({ limit: '1', refresh: JSON.stringify([`message:${decision.id}`, `message:${decision.id}`]) });
    expect(refreshed.messages).toHaveLength(1);
    expect(refreshed.refreshedMessages?.map(m => m.id)).toEqual([decision.id]);
    const initialRefreshed = mergeChatHistory(empty, refreshed);
    expect(initialRefreshed.messages).toHaveLength(2);
    expect(f.render(initialRefreshed)).not.toContain('决策消息已更新');
    history = mergeChatHistory(history, refreshed);
    expect(history.receipts).toHaveLength(6);
    const refreshedHtml = f.render(history);
    expect(refreshedHtml).not.toContain('决策消息已更新');
    // Overlapping pages and a late older reply cannot roll back the message or duplicate any event.
    const overlap = await f.page({ limit: '3' });
    history = mergeChatHistory(overlap, mergeChatHistory(oldest, history));
    history = mergeChatHistory({ ...middle, receipts: [...middle.receipts!].reverse() }, history);
    expect(f.render(history)).toBe(refreshedHtml);

    // Live snapshots can jump multiple pages; gap filling must also retain their receipts.
    for (let n = 0; n < 5; n++) await f.emit('source.collected', {}, `2026-02-0${n + 1}`);
    const next = await f.page();
    expect(needsTimelineBridge(latest, next)).toBe(true);
    history = mergeChatHistory(history, next);
    let cursor = next.nextBefore;
    while (cursor) {
      const gap = await f.page({ before: cursor });
      history = mergeChatHistory(gap, history);
      if (gap.messages.some(m => latest.messages.some(old => old.id === m.id))) break;
      cursor = gap.nextBefore;
    }
    expect(history.receipts).toHaveLength(11);
    expect(buildConversationTimeline(history.messages, history.turns, history.chunks, history.receipts).loose).toHaveLength(11);
    expect(f.render(history)).not.toContain('例行协作进展 · Audit · 7');
    expect(f.render(history)).not.toContain('决策消息已更新');
    expect(f.render(history)).not.toContain('CHECK FAILED');
  } finally { await f.close(); }
});

it('hides legacy system messages even when structured receipt metadata is unavailable', async () => {
  const f = await fixture();
  try {
    const event = await f.emit('source.collected');
    f.host.store.exec('DELETE FROM coordination_receipts WHERE event_seq=?', event.seq);
    const page = await f.page();
    expect(page.receipts).toEqual([]);
    const html = f.render(mergeChatHistory({ messages: [], turns: [], chunks: [] }, page));
    expect(html).not.toContain('开发结果已收集');
    expect(html).not.toContain('需要关注的协作事件');
    expect(html).not.toContain('<details');
  } finally { await f.close(); }
});
