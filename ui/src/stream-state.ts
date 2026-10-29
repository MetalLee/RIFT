import type { ChatMessage, ChatPage, RunStreamMessage, StreamMessage, TurnActivity, WorkspaceEvent } from '@rift/protocol';

/** Apply ordered, redacted SSE deltas. A missing base requires a fresh snapshot. */
export function applyMessageEvent(page: ChatPage, event: WorkspaceEvent): ChatPage | undefined {
  if (event.seq <= page.snapshotCursor) return page;
  if(page.timeline&&(event.type==='turn.message'||event.type==='run.message')){
    const payload=event.payload as {conversationId:string;turnVersion?:number;message:Omit<StreamMessage,'text'>|Omit<RunStreamMessage,'text'>;offset:number;delta:string;replace:boolean};
    if(payload.conversationId!==page.conversation.id)return page;
    const row=payload.message,isRun=event.type==='run.message';
    const id=`${isRun?'run-stream':'stream'}:${event.entityId}:${row.messageId}`;
    const previous=page.messages.find(message=>message.id===id);
    if(previous&&previous.version>=row.version)return page;
    if(!payload.replace&&(previous?.content.length??0)!==payload.offset)return undefined;
    let agentId:string,taskId:string|undefined;
    if(isRun){
      const run=row as Omit<RunStreamMessage,'text'>;
      if(run.runId!==event.entityId||run.workspaceId!==page.conversation.workspaceId||run.conversationId!==page.conversation.id)return undefined;
      agentId=run.roleId;taskId=run.taskId;
    }else{
      const turn=page.turns.find(t=>t.id===event.entityId);
      if(!turn||(row as StreamMessage).turnId!==turn.id)return undefined;
      agentId=turn.agentId;
    }
    const message:ChatMessage={id,workspaceId:page.conversation.workspaceId,conversationId:page.conversation.id,clientMessageId:null,recipientAgentId:null,
      senderType:'agent',senderAgentId:agentId,role:'assistant',kind:'chat',content:(payload.replace?'':previous?.content??'')+payload.delta,
      status:row.status,version:row.version,createdAt:row.createdAt,...isRun?{runId:event.entityId,taskId,runtimeMessageKind:row.kind}:{sourceTurnId:event.entityId}};
    return {...page,snapshotCursor:event.seq,messages:[...page.messages.filter(item=>item.id!==id),message],turns:page.turns.map(turn=>turn.id===event.entityId?{...turn,version:Math.max(turn.version,payload.turnVersion??0)}:turn)};
  }
  if(page.timeline&&event.type==='turn.activity')return {...page,snapshotCursor:event.seq};

  if(event.type==='run.message'){
    const payload=event.payload as {conversationId:string;message:Omit<RunStreamMessage,'text'>;offset:number;delta:string;replace:boolean};
    if(payload.conversationId!==page.conversation.id)return page;
    if(payload.message.workspaceId!==page.conversation.workspaceId||payload.message.conversationId!==page.conversation.id||payload.message.runId!==event.entityId)return undefined;
    const previous=page.runMessages?.find(message=>message.runId===event.entityId&&message.messageId===payload.message.messageId);
    if(previous&&previous.version>=payload.message.version)return page;
    if(!payload.replace&&(previous?.text.length??0)!==payload.offset)return undefined;
    const message:RunStreamMessage={...payload.message,text:(payload.replace?'':previous?.text??'')+payload.delta};
    return {...page,snapshotCursor:event.seq,runMessages:[...(page.runMessages??[]).filter(item=>item.seq!==message.seq),message].sort((a,b)=>a.seq-b.seq)};
  }
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
