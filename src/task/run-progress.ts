import { createHash } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RuntimeEvent } from '../agent/runtime-types.js';
import { redact } from '../api/security.js';
import { now, type RiftStore } from '../storage/database.js';

export interface RunActivity { phase:'thinking'|'generating'|'tool'|'tool_done'|'tool_failed'; toolName?:string; step?:boolean }
export interface RunProgressView {
  runId:string;taskId:string;roleId:string;title:string;purpose:string;status:string;taskStatus:string;
  cleanupStatus:string;startedAt:string|null;endedAt:string|null;
  phase:string|null;toolName:string|null;toolCalls:number;modelSteps:number;updatedAt:string|null;
}
/** Observability only: no prompts, reasoning, tool arguments/results or automatic Lead wakeups. */
export function recordRunProgress(store:RiftStore,runId:string,event:RunActivity):void {
  store.transaction(()=>{
    const owned=store.get<{workspaceId:string}>(`SELECT w.workspace_id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id
      WHERE r.id=? AND r.status IN ('preparing','running') AND r.slot_released_at IS NULL
      AND EXISTS(SELECT 1 FROM execution_leases l WHERE l.owner_type='run' AND l.owner_id=r.id AND l.released_at IS NULL)`,runId);
    if(!owned)return;
    const prior=store.get<{phase:string;updatedAt:string}>('SELECT phase,updated_at FROM run_progress WHERE run_id=?',runId);
    const timestamp=now();
    if(!event.step&&!event.toolName&&prior?.phase===event.phase&&Date.parse(timestamp)-Date.parse(prior.updatedAt)<2000)return;
    const tool=event.toolName?redact(event.toolName,120):null;
    store.exec(`INSERT INTO run_progress(run_id,phase,tool_name,tool_calls,model_steps,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET phase=excluded.phase,tool_name=excluded.tool_name,
      tool_calls=run_progress.tool_calls+excluded.tool_calls,model_steps=run_progress.model_steps+excluded.model_steps,updated_at=excluded.updated_at`,
      runId,event.phase,tool,event.phase==='tool'?1:0,event.step?1:0,timestamp);
    store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at) VALUES(?,'run.progress',?,'{}',?)",owned.workspaceId,runId,timestamp);
  });
}
export function conversationRunProgress(store:RiftStore,workspaceId:string,conversationId:string):RunProgressView[] {
  return store.all<RunProgressView>(`SELECT r.id run_id,r.task_id,r.role_id,t.title,r.purpose,r.status,t.status task_status,r.cleanup_status,r.started_at,r.ended_at,
    p.phase,p.tool_name,COALESCE(p.tool_calls,0) tool_calls,COALESCE(p.model_steps,0) model_steps,p.updated_at
    FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id
    JOIN workflow_conversations wc ON wc.workflow_id=w.id LEFT JOIN run_progress p ON p.run_id=r.id
    WHERE w.workspace_id=? AND wc.workspace_id=? AND wc.conversation_id=?
    ORDER BY CASE WHEN r.slot_released_at IS NULL THEN 0 ELSE 1 END,r.rowid DESC`,workspaceId,workspaceId,conversationId).filter((run,index)=>['preparing','running','stopping'].includes(run.status)||run.cleanupStatus!=='confirmed'||index<30);
}
export function observeDshRun(agent:Agent,emit:((event:RunActivity)=>void)|undefined,onEvent?: (event:RuntimeEvent)=>void):void {
  if((!emit&&!onEvent)||typeof agent.ctx.on!=='function')return;
  const attempts=new Map<string,{id:string;blocks:Map<number,string>;started:boolean;kind:'assistant'|'commentary'|'final'}>();
  agent.ctx.on('agent/assistant-stream',({agent:source,frame})=>{
    if(source!==agent)return;
    const key=String(frame.attemptId);
    if(frame.type==='start'){
      emit?.({phase:'thinking',step:true});
      if(onEvent)attempts.set(key,{id:createHash('sha256').update(String(agent.id)+':'+key).digest('hex'),blocks:new Map(),started:false,kind:'assistant'});
      return;
    }
    const attempt=attempts.get(key);
    if(frame.type==='end'){
      if(attempt?.started)onEvent?.({type:'message.completed',messageId:attempt.id,kind:attempt.kind,text:[...attempt.blocks.values()].join(''),interrupted:frame.outcome.kind!=='committed'||frame.outcome.eventType!=='assistant/message'});
      attempts.delete(key);return;
    }
    if(frame.chunk.type==='reasoning-delta')emit?.({phase:'thinking'});
    if(frame.chunk.type==='text-delta'||(frame.chunk.type==='block-end'&&frame.chunk.block.type==='text')){
      emit?.({phase:'generating'});
      if(!attempt)return;
      if(!attempt.started){attempt.started=true;onEvent?.({type:'message.started',messageId:attempt.id,kind:'assistant'});}
      const previous=attempt.blocks.get(frame.chunk.index)??'';
      const text=frame.chunk.type==='text-delta'?previous+frame.chunk.text:frame.chunk.block.type==='text'?frame.chunk.block.text:previous;
      attempt.blocks.set(frame.chunk.index,text);
      if(text.startsWith(previous)&&text.length>previous.length)onEvent?.({type:'message.delta',messageId:attempt.id,text:text.slice(previous.length)});
    }
    if(attempt&&frame.chunk.type==='finish')attempt.kind=frame.chunk.reason.kind==='tool-calls'?'commentary':'final';
  });
}
export function observeNativeRun(emit:((event:RunActivity)=>void)|undefined,onEvent?:(event:RuntimeEvent)=>void):(event:RuntimeEvent)=>void {
  const phases=new Map<string,'thinking'|'generating'>();
  return event=>{
    // RunChatStream owns channel filtering and persistence for every runtime.
    onEvent?.(event);
    if(event.type==='status.changed')emit?.({phase:event.status});
    if(event.type==='message.started'){const phase=event.kind==='reasoning'||event.kind==='reasoning_summary'?'thinking':'generating';phases.set(event.messageId,phase);emit?.({phase});}
    if(event.type==='message.delta')emit?.({phase:phases.get(event.messageId)??'generating'});
    if(event.type==='message.completed')phases.delete(event.messageId);
    if(event.type==='tool.started')emit?.({phase:'tool',toolName:event.toolName});
    if(event.type==='tool.completed'||event.type==='tool.failed')emit?.({phase:event.type==='tool.failed'?'tool_failed':'tool_done',toolName:event.toolName});
  };
}
