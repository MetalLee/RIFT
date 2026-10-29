import type { ChatPage, ContextRef } from '@rift/protocol';
export interface PendingMessage { text: string; recipient: string; clientMessageId: string; key: string; contextRefs?: ContextRef[]; mentions?: {agentId:string;label:string}[] }
export function shouldSendOnKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229;
}
export function pendingKey(workspaceId: string, conversationId: string) { return `rift:pending:${encodeURIComponent(workspaceId)}:${encodeURIComponent(conversationId)}`; }
export function loadPending(workspaceId: string, conversationId: string): PendingMessage | null {
  try { const value = JSON.parse(sessionStorage.getItem(pendingKey(workspaceId, conversationId)) ?? 'null'); return value && ['text', 'recipient', 'clientMessageId', 'key'].every(key => typeof value[key] === 'string') ? value as PendingMessage : null; } catch { return null; }
}
export function persistPending(workspaceId: string, conversationId: string, value: PendingMessage | null) {
  try { if (value) sessionStorage.setItem(pendingKey(workspaceId, conversationId), JSON.stringify(value)); else sessionStorage.removeItem(pendingKey(workspaceId, conversationId)); return true; } catch { return false; }
}
export type ChatHistory = Pick<ChatPage, 'messages' | 'turns' | 'chunks' | 'receipts' | 'refreshedMessages'>;
export function mergeChatHistory(older: ChatHistory, newer: ChatHistory) {
  function latest<T extends { id: string; version: number }>(records: T[]) { const result = new Map<string, T>(); for (const record of records) { const existing = result.get(record.id); if (!existing || (record.version ?? 0) >= (existing.version ?? 0)) result.set(record.id, record); } return [...result.values()]; }
  return {
    messages: latest([...older.messages, ...(older.refreshedMessages ?? []), ...newer.messages, ...(newer.refreshedMessages ?? [])]),
    receipts: [...new Map([...(older.receipts ?? []), ...(newer.receipts ?? [])].map(receipt =>
      [JSON.stringify([receipt.workspaceId, receipt.conversationId, receipt.eventSeq]), receipt])).values()]
      .sort((a, b) => a.eventSeq - b.eventSeq || a.id.localeCompare(b.id)),
    turns: latest([...older.turns, ...newer.turns]),
    chunks: [...new Map([...older.chunks, ...newer.chunks].map(value => [value.seq, value])).values()].sort((a, b) => a.seq - b.seq),
  };
}
/** A cursor gap covers only unseen live arrivals, never the entire old transcript. */
export function needsTimelineBridge(previous:ChatPage|undefined,next:ChatPage):boolean {
  return !!(previous?.timeline&&next.timeline&&next.nextBefore&&previous.messages.length&&next.messages.length&&!next.messages.some(message=>previous.messages.some(old=>old.id===message.id)));
}
