import type { AgentTurn, ChatMessage, ChatPage, Conversation, CoordinationReceipt, RunStreamMessage, StreamMessage } from './contracts.js';
import { redact } from '../api/security.js';
import { invariant } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';

interface Entry { source:'message'|'turn'|'run'|'legacy'; ref:string; at:string; key:string }
interface Cursor { version:1; conversationId:string; at:string; key:string }
/** Page visible entries, not parent turns: one long-running agent may emit thousands of messages. */
export function timelinePage(store:RiftStore,conversation:Conversation,before?:string,limit=30,refresh:string[]=[]):ChatPage {
  invariant(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_PAGE','Message limit must be 1–100.');
  invariant(Array.isArray(refresh)&&refresh.length<=100&&refresh.every(id=>typeof id==='string'&&id.length<=1024),'INVALID_PAGE','Refresh accepts at most 100 message IDs.');
  let cursor:Cursor|undefined;
  if(before){
    try{cursor=JSON.parse(before);}catch{/* Invalid cursors are rejected below. */}
    invariant(cursor?.version===1&&cursor.conversationId===conversation.id&&typeof cursor.at==='string'&&typeof cursor.key==='string'&&before.length<2048,'INVALID_CURSOR','Use the cursor from this conversation.');
  }
  return store.transaction(()=>{
    const candidates:Entry[]=[],refreshEntries:Entry[]=[];
    const collect=(source:Entry['source'],select:string,params:string[])=>{
      candidates.push(...store.all<Entry>(`SELECT ? source,ref,at,key FROM (${select}) WHERE (? IS NULL OR at<? OR (at=? AND key<?)) ORDER BY at DESC,key DESC LIMIT ?`,
        source,...params,cursor?.at??null,cursor?.at??'',cursor?.at??'',cursor?.key??'',limit+1));
      if(refresh.length)refreshEntries.push(...store.all<Entry>(`SELECT ? source,ref,at,key FROM (${select}) WHERE key IN (${refresh.map(()=>'?').join(',')})`,source,...params,...refresh));
    };
    collect('message',`SELECT m.id ref,m.created_at at,'message:'||m.id key FROM messages m
      WHERE m.workspace_id=? AND m.conversation_id=? AND m.visibility='public' AND m.kind<>'conversation_title'
      AND NOT (m.sender_type='agent' AND m.kind='chat' AND EXISTS (
        SELECT 1 FROM turn_stream_messages s JOIN agent_turns t ON t.id=s.turn_id
        WHERE t.id=m.source_turn_id AND t.agent_id=m.sender_agent_id AND s.status='completed'
        AND s.kind IN ('assistant','final') AND (s.kind='final' OR s.text=m.content)))`,[conversation.workspaceId,conversation.id]);
    collect('turn',`SELECT CAST(s.seq AS TEXT) ref,s.created_at at,'stream:'||s.turn_id||':'||s.message_id key FROM turn_stream_messages s
      JOIN agent_turns t ON t.id=s.turn_id WHERE t.workspace_id=? AND t.conversation_id=? AND json_extract(t.configuration,'$.conversationTitle') IS NULL`,[conversation.workspaceId,conversation.id]);
    collect('run',`SELECT CAST(s.seq AS TEXT) ref,s.created_at at,'run-stream:'||s.run_id||':'||s.message_id key FROM run_stream_messages s
      JOIN runs r ON r.id=s.run_id JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id
      JOIN workflow_conversations wc ON wc.workflow_id=w.id AND wc.workspace_id=w.workspace_id
      WHERE w.workspace_id=? AND wc.conversation_id=?`,[conversation.workspaceId,conversation.id]);
    collect('legacy',`SELECT t.id ref,COALESCE(t.started_at,t.created_at) at,'stream:'||t.id||':legacy' key FROM agent_turns t
      WHERE t.workspace_id=? AND t.conversation_id=? AND json_extract(t.configuration,'$.conversationTitle') IS NULL
      AND EXISTS(SELECT 1 FROM message_chunks c WHERE c.turn_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM turn_stream_messages s WHERE s.turn_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.source_turn_id=t.id AND m.sender_type='agent' AND m.kind='chat')`,[conversation.workspaceId,conversation.id]);
    candidates.sort((a,b)=>a.at===b.at?(a.key<b.key?1:a.key>b.key?-1:0):a.at<b.at?1:-1);
    const more=candidates.length>limit,selected=candidates.slice(0,limit).reverse();
    const hydrate=(entry:Entry):ChatMessage=>{
      if(entry.source==='message')return store.require<ChatMessage>(`SELECT m.*,i.status delivery_status,i.scope delivery_scope,i.error delivery_reason FROM messages m LEFT JOIN agent_inbox i ON i.message_id=m.id WHERE m.id=?`,entry.ref);
      let runtimeMessageKind:ChatMessage['runtimeMessageKind'];
      let owner:string,content:string,status:string,version:number,sourceTurnId:string|undefined,runId:string|undefined,taskId:string|undefined;
      if(entry.source==='turn'){
        const s=store.require<StreamMessage&{agentId:string;turnStatus:string}>('SELECT s.*,t.agent_id,t.status turn_status FROM turn_stream_messages s JOIN agent_turns t ON t.id=s.turn_id WHERE s.seq=?',entry.ref);
        owner=s.agentId;content=s.text;status=s.status==='streaming'&&!['queued','running','stopping'].includes(s.turnStatus)?'interrupted':s.status;version=s.version;sourceTurnId=s.turnId;
      }else if(entry.source==='run'){
        const s=store.require<RunStreamMessage&{runStatus:string}>('SELECT s.*,r.role_id,r.task_id,r.status run_status FROM run_stream_messages s JOIN runs r ON r.id=s.run_id WHERE s.seq=?',entry.ref);
        owner=s.roleId;content=s.text;status=s.status==='streaming'&&!['preparing','running'].includes(s.runStatus)?'interrupted':s.status;version=s.version;runId=s.runId;taskId=s.taskId;
        // Preserve raw content and stream kind; clients format only at render time.
        runtimeMessageKind=s.kind;
      }else{
        const t=store.require<AgentTurn>('SELECT id,agent_id,status,version FROM agent_turns WHERE id=?',entry.ref);
        owner=t.agentId;content=store.all<{text:string}>('SELECT text FROM message_chunks WHERE turn_id=? ORDER BY seq',t.id).map(c=>c.text).join('');status=['queued','running','stopping'].includes(t.status)?'streaming':'interrupted';version=t.version;sourceTurnId=t.id;
      }
      return {id:entry.key,workspaceId:conversation.workspaceId,conversationId:conversation.id,clientMessageId:null,recipientAgentId:null,
        role:'assistant',senderType:'agent',senderAgentId:owner,kind:'chat',content,status,version,createdAt:entry.at,sourceTurnId,runId,taskId,...runtimeMessageKind?{runtimeMessageKind}:{}};
    };
    const messages=selected.map(hydrate),refreshedMessages=refreshEntries.map(hydrate);
    const ids=[...new Set([...messages,...refreshedMessages].flatMap(m=>m.sourceTurnId?[m.sourceTurnId]:[]))];
    const messageIds=[...messages,...refreshedMessages].map(message=>message.id);
    const retainedTurns=refresh.filter(key=>key.startsWith('turn-status:')).map(key=>key.slice('turn-status:'.length));
    const turnIds=[...new Set([...ids,...retainedTurns])];
    // Keep only small UI control fields; execution prompts/context/skills are not chat-page data.
    const turns=store.all<AgentTurn>(`SELECT id,workspace_id,conversation_id,message_id,agent_id,status,version,cleanup_status,error,created_at,started_at,ended_at,
      json_object('connection',json_extract(configuration,'$.connection'),'agent',json_object('id',agent_id,'displayName',json_extract(configuration,'$.agent.displayName'),'purpose',json_extract(configuration,'$.agent.purpose'),'prompt','','version',0),
        'request',json_object('contextRefs',json_extract(configuration,'$.request.contextRefs'))) configuration
      FROM agent_turns WHERE workspace_id=? AND conversation_id=? AND json_extract(configuration,'$.conversationTitle') IS NULL
      AND (status IN ('queued','running','stopping') ${turnIds.length?'OR id IN ('+turnIds.map(()=>'?').join(',')+')':''} ${messageIds.length?'OR message_id IN ('+messageIds.map(()=>'?').join(',')+')':''}) ORDER BY created_at`,conversation.workspaceId,conversation.id,...turnIds,...messageIds);
    const receiptMessageIds=[...new Set([...messages,...refreshedMessages]
      .filter(m=>m.kind==='receipt'&&m.senderType==='system'&&m.origin==='host').map(m=>m.id))];
    // Probe the unique (event_seq,conversation_id) index only for selected messages; never load receipt history.
    const receipts:CoordinationReceipt[]=receiptMessageIds.length?store.all<Omit<CoordinationReceipt,'payload'>&{type:string;taskId:string|null;runId:string|null;requestId:string|null;reason:string|null}>(`
      SELECT r.id,r.workspace_id,r.conversation_id,r.workflow_id,r.event_seq,r.created_at,e.type,e.task_id,e.run_id,e.request_id,
        CASE WHEN json_valid(r.payload) THEN COALESCE(
          CASE WHEN json_type(r.payload,'$.reason')='text' THEN json_extract(r.payload,'$.reason') END,
          CASE WHEN json_type(r.payload,'$.error')='text' THEN json_extract(r.payload,'$.error') END) END reason
      FROM messages m JOIN coordination_receipts r ON r.event_seq=CAST(substr(m.dedupe_key,7) AS INTEGER)
        AND r.workspace_id=m.workspace_id AND r.conversation_id=m.conversation_id AND r.workflow_id=m.workflow_id
        AND m.dedupe_key='event:'||r.event_seq||':'||r.conversation_id
      JOIN task_events e ON e.event_seq=r.event_seq AND e.workflow_id=r.workflow_id
        AND e.task_id IS m.task_id AND e.run_id IS m.run_id AND e.request_id IS m.request_id
      JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
      JOIN conversations c ON c.id=r.conversation_id AND c.workspace_id=r.workspace_id
      WHERE m.workspace_id=? AND m.conversation_id=? AND m.id IN (${receiptMessageIds.map(()=>'?').join(',')})
      ORDER BY r.event_seq LIMIT ?`,conversation.workspaceId,conversation.id,...receiptMessageIds,receiptMessageIds.length)
      .map(({type,taskId,runId,requestId,reason,...receipt})=>({...receipt,payload:{eventSeq:receipt.eventSeq,
        workflowId:receipt.workflowId,type:redact(type,200),taskId,runId,requestId,...(reason!==null?{reason:redact(reason,1500)}:{})}})):[];
    const oldest=selected[0];
    return {conversation,messages,turns,chunks:[],receipts,runMessages:[],timeline:true,refreshedMessages,
      nextBefore:more&&oldest?JSON.stringify({version:1,conversationId:conversation.id,at:oldest.at,key:oldest.key} satisfies Cursor):null,
      snapshotCursor:store.require<{cursor:number}>('SELECT COALESCE(MAX(seq),0) cursor FROM workspace_events').cursor};
  });
}

export function parseTimelineRefresh(raw:string|null):string[]{
  if(raw===null)return [];
  let ids:unknown;try{ids=JSON.parse(raw);}catch{/* Validate below. */}
  invariant(Array.isArray(ids)&&ids.length<=100&&ids.every(id=>typeof id==='string'&&id.length<=1024),'INVALID_PAGE','Invalid message refresh IDs.');return ids as string[];
}
