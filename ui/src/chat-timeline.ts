import type { AgentTurn, ChatMessage, CoordinationReceipt, MessageChunk } from '../../src/chat/contracts.js';
export interface TimelineUpdate { id:string; content:string; taskId?:string|null; senderAgentId?:string|null; type?:string }
export interface TimelineItem { message:ChatMessage; turns:AgentTurn[]; taskIds:string[]; updates:TimelineUpdate[]; drafts:{turn:AgentTurn;text:string}[] }
export function messageSender(message:ChatMessage): 'user'|'agent'|'system' { return message.senderType ?? (message.role==='user'?'user':message.role==='system'?'system':'agent'); }
export function messageAuthor(message:ChatMessage):string|null { return messageSender(message)==='agent' ? message.senderAgentId ?? message.recipientAgentId : null; }
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
      if(!final && text)anchor.drafts.push({turn,text});
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
