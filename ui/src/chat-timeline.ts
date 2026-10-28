import type { AgentTurn, ChatMessage, CoordinationReceipt, MessageChunk } from '@rift/protocol';
export interface TimelineUpdate { id:string; content:string; taskId?:string|null; senderAgentId?:string|null; type?:string }
export interface TimelineItem { message:ChatMessage; turns:AgentTurn[]; taskIds:string[]; updates:TimelineUpdate[]; drafts:{turn:AgentTurn;text:string;messageId?:string;kind?:import('@rift/protocol').StreamMessage['kind'];status?:string}[] }
export function messageSender(message:ChatMessage): 'user'|'agent'|'system' { return message.senderType ?? (message.role==='user'?'user':message.role==='system'?'system':'agent'); }
export function messageAuthor(message:ChatMessage):string|null { return messageSender(message)==='agent' ? message.senderAgentId ?? message.recipientAgentId : null; }
function finalStream(turn:AgentTurn,final:ChatMessage) {
  return [...(turn.streamMessages??[])].reverse().find(message=>message.status==='completed' &&
    !['commentary','reasoning','reasoning_summary'].includes(message.kind) && (message.kind==='final'||message.text===final.content));
}
export function buildChatTimeline(messages:ChatMessage[],turns:AgentTurn[],chunks:MessageChunk[],receipts:CoordinationReceipt[] = []) {
  const main=messages.filter(message=>messageSender(message)!=='system' && !['progress','receipt'].includes(message.kind??''));
  const items:TimelineItem[]=main.map(message=>({message,turns:[],taskIds:message.taskId?[message.taskId]:[],updates:[],drafts:[]}));
  const loose:TimelineUpdate[]=[]; const looseTurns:AgentTurn[]=[];
  const find=(reference:{replyToMessageId?:string|null;sourceTurnId?:string|null;taskId?:string|null;createdAt:string}) => {
    return items.find(item=>item.message.id===reference.replyToMessageId)
      ?? (reference.taskId ? [...items].reverse().find(item=>item.taskIds.includes(reference.taskId!)) : undefined)
      ?? (reference.sourceTurnId ? items.find(item=>item.message.sourceTurnId===reference.sourceTurnId) ?? items.find(item=>turns.some(turn=>turn.id===reference.sourceTurnId && turn.messageId===item.message.id)) : undefined)
      ?? [...items].reverse().find(item=>item.message.createdAt<=reference.createdAt) ?? items[0];
  };
  for(const turn of turns) {
    const final=messages.find(message=>message.sourceTurnId===turn.id && (!message.kind || message.kind==='chat') && messageAuthor(message)===turn.agentId) ?? messages.find(message=>message.role==='assistant' && !message.sourceTurnId && !!turn.messageId && message.replyToMessageId===turn.messageId && messageAuthor(message)===turn.agentId);
    const anchor=items.find(item=>item.message.id===final?.id) ?? items.find(item=>item.message.id===turn.messageId) ?? find({createdAt:turn.createdAt});
    if(anchor) {
      anchor.turns.push(turn);
      for(const activity of turn.activities??[]) if(activity.payload.taskId && !anchor.taskIds.includes(activity.payload.taskId)) anchor.taskIds.push(activity.payload.taskId);
      const text=[...new Map(chunks.filter(chunk=>chunk.turnId===turn.id).map(chunk=>[chunk.seq,chunk])).values()].sort((a,b)=>a.seq-b.seq).map(chunk=>chunk.text).join('');
      if (turn.streamMessages?.length) {
        for (const message of turn.streamMessages) {
          if (!message.text) continue;
          if (final && message.messageId === finalStream(turn,final)?.messageId) continue;
          anchor.drafts.push({turn,text:message.text,messageId:message.messageId,kind:message.kind,status:message.status});
        }
      } else if(!final && text)anchor.drafts.push({turn,text});
    } else looseTurns.push(turn);
  }
  for(const message of messages.filter(message=>!main.includes(message))) {
    const update:TimelineUpdate={id:message.id,content:message.content,taskId:message.taskId,senderAgentId:message.senderAgentId};
    const anchor=find(message); if(anchor){anchor.updates.push(update);if(message.taskId&&!anchor.taskIds.includes(message.taskId))anchor.taskIds.push(message.taskId);}else loose.push(update);
  }
  for(const receipt of receipts) {
    if(messages.some(message=>message.dedupeKey===`event:${receipt.eventSeq}:${receipt.conversationId}`))continue;
    const update:TimelineUpdate={id:receipt.id,content:receipt.payload.reason??'',type:receipt.payload.type,taskId:receipt.payload.taskId};
    const anchor=find({taskId:receipt.payload.taskId,createdAt:receipt.createdAt});if(anchor){anchor.updates.push(update);if(receipt.payload.taskId&&!anchor.taskIds.includes(receipt.payload.taskId))anchor.taskIds.push(receipt.payload.taskId);}else loose.push(update);
  }
  return {items,loose,looseTurns};
}

/** Each model message is a peer in the conversation, never a draft inside a user message. */
export function buildConversationTimeline(messages:ChatMessage[],turns:AgentTurn[],chunks:MessageChunk[],receipts:CoordinationReceipt[] = []) {
  const timeline = buildChatTimeline(messages,turns,chunks,receipts);
  const rows:TimelineItem[] = [];
  for (const item of timeline.items) {
    for (const draft of item.drafts) {
      const streamed = draft.turn.streamMessages?.find(message=>message.messageId===draft.messageId);
      const interrupted = draft.status === 'interrupted' || ['cancelled','failed','interrupted'].includes(draft.turn.status);
      const message:ChatMessage = {
        id:`stream:${draft.turn.id}:${draft.messageId??'legacy'}`, workspaceId:draft.turn.workspaceId,
        conversationId:draft.turn.conversationId,clientMessageId:null,recipientAgentId:null,
        senderType:'agent',senderAgentId:draft.turn.agentId,role:'assistant',kind:'chat',
        sourceTurnId:draft.turn.id,content:draft.text,status:interrupted?'interrupted':'completed',
        version:streamed?.version??0,createdAt:streamed?.createdAt??draft.turn.createdAt,
      };
      rows.push({message,turns:[],taskIds:[],updates:[],drafts:[]});
    }
    const owner = item.turns.find(turn=>turn.id===item.message.sourceTurnId && messageAuthor(item.message)===turn.agentId);
    const canonical = owner && finalStream(owner,item.message);
    rows.push({...item,message:canonical?{...item.message,id:`stream:${owner!.id}:${canonical.messageId}`,createdAt:canonical.createdAt}:item.message,turns:[],drafts:[]});
  }
  // Stable sorting preserves per-stream sequence when a batch shares a timestamp.
  rows.sort((a,b)=>a.message.createdAt.localeCompare(b.message.createdAt) ||
    (Number(messageSender(b.message)==='user')-Number(messageSender(a.message)==='user')));
  const looseTurns:AgentTurn[] = [];
  for (const turn of turns) {
    const row = [...rows].reverse().find(item=>item.message.sourceTurnId===turn.id && messageAuthor(item.message)===turn.agentId)
      ?? rows.find(item=>item.message.id===turn.messageId);
    if (row) row.turns.push(turn); else looseTurns.push(turn);
  }
  return {items:rows,loose:timeline.loose,looseTurns};
}
