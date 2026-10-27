import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '../agent/runtime-types.js';
import { redact } from '../api/security.js';
import { now, type RiftStore } from '../storage/database.js';
import type { StreamMessage } from './contracts.js';
import { SafeChatStream } from './safe-stream.js';

type Pending = { stream: SafeChatStream; text: string; raw: string; pending: string; kind: StreamMessage['kind']; status: StreamMessage['status'] };
/** Per-turn ordered stream. Only redacted text enters SQLite or SSE replay. */
export class TurnStream {
  private messages = new Map<string, Pending>();
  private timer?: ReturnType<typeof setTimeout>;
  private size = 0;
  constructor(private store: RiftStore, private turnId: string, private workspaceId: string, private conversationId: string, private onError: (error:unknown)=>void) {}

  accept(event: Extract<RuntimeEvent, {messageId: string}>): void {
    if (!event.messageId || event.messageId.length > 256) throw new Error('STREAM_MESSAGE_ID');
    if (redact(event.messageId) !== event.messageId) event = {...event,messageId:`message-${createHash('sha256').update(event.messageId).digest('hex')}`};
    let message = this.messages.get(event.messageId);
    if (!message) {
      if (this.messages.size >= 1024) throw new Error('STREAM_MESSAGE_LIMIT');
      message = { stream: new SafeChatStream(), raw: '', pending: '', text: '', kind: event.type === 'message.started' ? event.kind : 'assistant', status: 'streaming' };
      this.messages.set(event.messageId, message);
    }
    if (message.status !== 'streaming') return;
    if (event.type === 'message.started') message.kind = event.kind;
    if (event.type === 'message.delta') {
      this.size += event.text.length;
      if (this.size > 256_000) throw new Error('CHAT_TEXT_LIMIT');
      message.raw += event.text;
      message.pending += event.text;
    }
    if (event.type === 'message.completed') {
      this.appendPending(message);
      // Settled provider text is authoritative, including non-streaming fallbacks.
      if (event.text !== undefined) {
        this.size += event.text.length - message.raw.length;
        if (this.size > 256_000) throw new Error('CHAT_TEXT_LIMIT');
        message.text = redact(event.text, 256_000);
      } else message.text = message.stream.finish();
      if (event.kind) message.kind = event.kind;
      message.status = event.interrupted ? 'interrupted' : 'completed';
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => { try { this.flush(); } catch(error) { this.onError(error); } }, 40);
      this.timer.unref();
    }
  }

  private appendPending(message: Pending): void {
    if (!message.pending) return;
    message.text += message.stream.push(message.pending);
    message.pending = '';
  }

  get hasText(): boolean { return [...this.messages.values()].some(message => message.text.length > 0); }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.store.transaction(() => {
      for (const [messageId, message] of this.messages) {
        this.appendPending(message);
        const prior = this.store.get<StreamMessage>('SELECT * FROM turn_stream_messages WHERE turn_id=? AND message_id=?', this.turnId, messageId);
        if (prior && prior.text === message.text && prior.status === message.status && prior.kind === message.kind) continue;
        const timestamp = now();
        this.store.exec(`INSERT INTO turn_stream_messages(turn_id,message_id,kind,text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(turn_id,message_id) DO UPDATE SET kind=excluded.kind,text=excluded.text,status=excluded.status,updated_at=excluded.updated_at,version=turn_stream_messages.version+1`,
          this.turnId, messageId, message.kind, message.text, message.status, timestamp, timestamp);
        const row = this.store.require<StreamMessage>('SELECT * FROM turn_stream_messages WHERE turn_id=? AND message_id=?', this.turnId, messageId);
        this.store.exec("UPDATE agent_turns SET version=version+1,first_visible_text_at=CASE WHEN ?<>'' THEN COALESCE(first_visible_text_at,?) ELSE first_visible_text_at END WHERE id=?", row.text, timestamp, this.turnId);
        const turnVersion = this.store.require<{version:number}>('SELECT version FROM agent_turns WHERE id=?',this.turnId).version;
        const append = row.text.startsWith(prior?.text ?? '');
        const offset = append ? (prior?.text.length ?? 0) : 0;
        this.store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at) VALUES(?,'turn.message',?,?,?)", this.workspaceId, this.turnId,
          JSON.stringify({ turnVersion, conversationId: this.conversationId, message: { ...row, text: undefined }, offset, delta: append ? row.text.slice(offset) : row.text, replace: !append }), timestamp);
      }
    });
  }

  finish(interrupted: boolean): void {
    for (const message of this.messages.values()) if (message.status === 'streaming') {
      this.appendPending(message);
      message.text = message.stream.finish();
      message.status = interrupted ? 'interrupted' : 'completed';
    }
    this.flush();
  }
}
