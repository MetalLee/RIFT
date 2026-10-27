import type { ChatPage, StreamMessage, TurnActivity } from '../../src/chat/contracts';
import type { WorkspaceEvent } from '../../src/events/workspace-events';

/** Apply ordered, redacted SSE deltas. A missing base requires a fresh snapshot. */
export function applyMessageEvent(page: ChatPage, event: WorkspaceEvent): ChatPage | undefined {
  if (event.seq <= page.snapshotCursor) return page;
  if (event.type === 'turn.activity') {
    const payload = event.payload as {turnVersion:number;activity?:TurnActivity;updatesPhase?:number|boolean};
    const activity = payload.activity;
    const turn = page.turns.find(turn => turn.id === event.entityId);
    if (!activity || !turn || activity.turnId !== turn.id) return undefined;
    const activities = [...(turn.activities??[]).filter(item=>item.seq!==activity.seq),activity].sort((a,b)=>a.seq-b.seq);
    const phase = payload.updatesPhase === false || payload.updatesPhase === 0 ? {} : {
      phase:activity.phase,phaseStartedAt:activity.createdAt,lastProgressAt:activity.createdAt,
      currentToolName:activity.phase==='tool'?activity.toolName:null,currentToolCallId:activity.phase==='tool'?activity.toolCallId:null};
    return {...page,snapshotCursor:event.seq,turns:page.turns.map(item=>item.id===turn.id?{...item,version:Math.max(item.version,payload.turnVersion),activities,...phase}:item)};
  }
  if (event.type !== 'turn.message') return undefined;
  const payload = event.payload as {conversationId:string;turnVersion:number;message:Omit<StreamMessage,'text'>;offset:number;delta:string;replace:boolean};
  if (payload.conversationId !== page.conversation.id) return page;
  const turn = page.turns.find(turn => turn.id === event.entityId);
  if (!turn) return undefined;
  if (payload.message.turnId !== turn.id) return undefined;
  const previous = turn.streamMessages?.find(message => message.messageId === payload.message.messageId);
  if (previous && previous.version >= payload.message.version) return page;
  if (!payload.replace && (previous?.text.length ?? 0) !== payload.offset) return undefined;
  const message: StreamMessage = {...payload.message,text:(payload.replace?'':previous?.text??'')+payload.delta};
  const streamMessages = [...(turn.streamMessages??[]).filter(item => item.messageId !== message.messageId), message].sort((a,b)=>a.seq-b.seq);
  return {...page,snapshotCursor:event.seq,turns:page.turns.map(item=>item.id===turn.id?{...item,version:payload.turnVersion,streamMessages}:item)};
}
