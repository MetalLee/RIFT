import { invariant, type TaskEvent } from '../contracts/index.js';
import { id, now, type RiftStore } from '../storage/database.js';
import type { AgentTurn } from './contracts.js';
import { publicError } from '../api/security.js';
import { coordinationWakes as wakes, coordinationRecoveries as recoveries, coordinationReceipts as receipts, eventFacts, eventPriority, eventBatchContent } from './coordination-policy.js';

export interface CoordinationOwner { workflowId:string; workspaceId:string; conversationId:string; agentId:string; version:number; automaticTurns:number; blockedReason:string|null; correlationId:string|null; parentMessageId:string|null }
interface Decision { id:string; workflowId:string; turnId:string; ownerVersion:number; status:string; toolCalls:number; stagnantCalls:number; lastEventSeq:number; error:string|null }
interface Trigger { id:string; workflowId:string; workspaceId:string; conversationId:string; agentId:string; kind:string; payload:unknown; priority:number; correlationId:string|null; parentMessageId:string|null; automaticHops:number; createdAt:string }

/** The durable queue owns decisions; the DSH parent is only an activation identity. */
export class ChatOrchestration {
  private timer?:ReturnType<typeof setInterval>;
  private pumping=false;
  private stopped=false;
  lastError:string|null=null;
  constructor(readonly store:RiftStore, private readonly options:{ enqueue(workspaceId:string,conversationId:string,triggerId:string,content:string):AgentTurn; ensureParent(workflowId:string):Promise<unknown>; stop(turn:AgentTurn):void; projectReceipt?(input:{workspaceId:string;conversationId:string;workflowId:string;eventSeq:number;correlationId?:string|null;parentMessageId?:string|null;automaticHops?:number;payload:{type:string;taskId?:string|null;runId?:string|null;requestId?:string|null;reason?:string}}):unknown; maxTools?:number; maxStagnant?:number; maxAutomaticTurns?:number }) {}
  owner(workflowId:string):CoordinationOwner|undefined { return this.store.get('SELECT * FROM workflow_conversations WHERE workflow_id=?',workflowId); }
  forTurn(turn:AgentTurn):CoordinationOwner|undefined {
    if(turn.configuration.agent.purpose!=='lead'||turn.configuration.conversationTitle)return;
    const decision=this.store.get<{workflowId:string}>('SELECT workflow_id FROM coordination_decisions WHERE turn_id=?',turn.id);
    if(decision)return this.owner(decision.workflowId);
    const trigger=turn.triggerId?this.store.get<{workflowId:string}>('SELECT workflow_id FROM turn_triggers WHERE id=?',turn.triggerId):undefined;
    return trigger?this.owner(trigger.workflowId):this.store.get("SELECT c.* FROM workflow_conversations c JOIN workflows f ON f.id=c.workflow_id WHERE c.workspace_id=? AND f.status NOT IN ('completed','cancelled','failed')",turn.workspaceId);
  }
  bind(workflowId:string,turn:AgentTurn):void {
    this.store.transaction(()=>{
      invariant(this.store.workflow(workflowId).workspaceId===turn.workspaceId,'CROSS_WORKFLOW','Workflow does not belong to this Turn.');
      invariant(!this.owner(workflowId),'COORDINATION_OWNED','Workflow already has a coordination owner.');
      this.store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at,correlation_id,parent_message_id) VALUES(?,?,?,?,'chat',?,?,?)",workflowId,turn.workspaceId,turn.conversationId,turn.agentId,now(),turn.messageId??`workflow:${workflowId}`,turn.messageId);
      this.beforeStart(turn);
    });
  }
  canStart(turn:AgentTurn):boolean {
    const owner=this.forTurn(turn);if(!owner)return true;
    if(this.automatic(turn) && (this.store.workflow(owner.workflowId).status!=='running'||owner.blockedReason))return false;
    if(turn.configuration.messageTrigger&&owner.automaticTurns>=(this.options.maxAutomaticTurns??32)){this.block(owner.workflowId,'AUTOMATIC_COORDINATION_BUDGET');return false;}
    return !this.store.get("SELECT id FROM coordination_decisions WHERE workflow_id=? AND status IN ('active','handoff_requested','interrupted')",owner.workflowId);
  }
  private automatic(turn:AgentTurn):boolean {
    return !!turn.triggerId||!!turn.configuration.messageTrigger||!!(turn.messageId&&this.store.get<{senderType:string}>('SELECT sender_type FROM messages WHERE id=?',turn.messageId)?.senderType!=='user');
  }
  beforeStart(turn:AgentTurn):void {
    const owner=this.forTurn(turn);if(!owner||owner.conversationId!==turn.conversationId)return;
    invariant(owner.agentId===turn.agentId&&owner.workspaceId===turn.workspaceId,'UNAUTHORIZED','Only the assigned Lead may coordinate this Workflow.');
    invariant(this.canStart(turn),'COORDINATION_BUSY','Workflow already has an active or unknown decision.');
    if(!this.automatic(turn))this.store.exec('UPDATE workflow_conversations SET automatic_turns=0,blocked_reason=NULL,correlation_id=?,parent_message_id=? WHERE workflow_id=?',turn.messageId??`turn:${turn.id}`,turn.messageId,owner.workflowId);
    else if(turn.configuration.messageTrigger)this.store.exec('UPDATE workflow_conversations SET automatic_turns=automatic_turns+1 WHERE workflow_id=?',owner.workflowId);
    this.store.exec("INSERT INTO coordination_decisions(id,workflow_id,turn_id,owner_version,plan_revision,status,last_event_seq,created_at) VALUES(?,?,?,?,?,'active',?,?)",id('decision'),owner.workflowId,turn.id,owner.version,this.store.workflow(owner.workflowId).planRevision,this.eventSeq(owner.workflowId),now());
    if(turn.triggerId)this.store.exec("UPDATE turn_triggers SET status='claimed' WHERE id=? AND status='pending'",turn.triggerId);
  }
  private eventSeq(workflowId:string):number {return this.store.require<{seq:number}>('SELECT COALESCE(MAX(event_seq),0) AS seq FROM task_events WHERE workflow_id=?',workflowId).seq;}
  authorize(turn:AgentTurn,write:boolean):void {
    if(write&&turn.configuration.agent.purpose!=='lead')invariant(!this.store.get("SELECT c.workflow_id FROM workflow_conversations c JOIN workflows f ON f.id=c.workflow_id WHERE c.workspace_id=? AND f.status NOT IN ('completed','cancelled','failed')",turn.workspaceId),'COORDINATION_OWNED','Task requests for this Workflow must go through its assigned Lead.');
    const owner=this.forTurn(turn);if(!owner)return;
    if(!write&&owner.conversationId!==turn.conversationId)return;
    invariant(owner.conversationId===turn.conversationId&&owner.agentId===turn.agentId,'COORDINATION_OWNED','Use the Workflow primary conversation for coordination.');
    const decision=this.store.get<Decision>('SELECT * FROM coordination_decisions WHERE turn_id=?',turn.id);
    if(decision?.status==='handoff_requested'){this.store.exec("UPDATE coordination_decisions SET error='HANDOFF_PROTOCOL_VIOLATION' WHERE id=?",decision.id);this.options.stop(turn);}
    invariant(decision&&decision.ownerVersion===owner.version&&decision.status==='active','DECISION_EXPIRED','This decision has yielded, ended, or lost ownership.');
    invariant(this.store.get("SELECT id FROM agent_turns WHERE id=? AND status='running'",turn.id)&&this.store.get("SELECT id FROM execution_leases WHERE owner_type='turn' AND owner_id=? AND released_at IS NULL",turn.id),'UNAUTHORIZED','This decision no longer owns a running execution lease.');
    const seq=this.eventSeq(owner.workflowId),stagnant=seq===decision.lastEventSeq?decision.stagnantCalls+1:0;
    this.store.exec('UPDATE coordination_decisions SET tool_calls=tool_calls+1,stagnant_calls=?,last_event_seq=? WHERE id=?',stagnant,seq,decision.id);
    if(decision.toolCalls+1>(this.options.maxTools??48)||stagnant>(this.options.maxStagnant??12)) {
      this.store.exec('UPDATE coordination_decisions SET error=? WHERE id=?','COORDINATION_TOOL_BUDGET',decision.id);
      this.options.stop(turn);
      invariant(false,'COORDINATION_TOOL_BUDGET','This coordination turn exceeded its tool or no-progress budget.');
    }
  }
  yield(turn:AgentTurn,input:{summary:string;taskIds:string[];requestIds:string[]}):unknown {
    const owner=this.forTurn(turn);invariant(owner,'CONTINUATION_REQUIRED','A durable Workflow continuation must exist before yielding.');
    for(const taskId of input.taskIds)invariant(this.store.task(taskId).workflowId===owner.workflowId,'CROSS_WORKFLOW','Handoff task belongs to another Workflow.');
    for(const requestId of input.requestIds)invariant(this.store.task(this.store.operation(requestId).entityId).workflowId===owner.workflowId,'CROSS_WORKFLOW','Handoff request belongs to another Workflow.');
    this.store.exec("UPDATE coordination_decisions SET status='handoff_requested',handoff=? WHERE turn_id=? AND status='active'",JSON.stringify(input),turn.id);
    return {workflowId:owner.workflowId,conversationId:owner.conversationId,handoffRequested:true,taskIds:input.taskIds,requestIds:input.requestIds,continuation:'durable-task-events',instruction:'Finish this model turn now. Handoff does not confirm runtime cleanup.'};
  }
  settled(turn:AgentTurn):void {
    this.scan();
    this.store.transaction(()=>{
      const decision=this.store.get<Decision>('SELECT * FROM coordination_decisions WHERE turn_id=?',turn.id);
      if(!decision){if(turn.triggerId&&turn.status==='cancelled'){this.store.exec("UPDATE turn_triggers SET status='failed',error='COORDINATION_TURN_CANCELLED',ended_at=? WHERE turn_id=?",now(),turn.id);const owner=this.forTurn(turn);if(owner)this.block(owner.workflowId,'COORDINATION_TURN_CANCELLED');}return;}
      if(turn.cleanupStatus==='confirmed'&&this.owner(decision.workflowId)?.blockedReason==='COORDINATION_CLEANUP_UNKNOWN')this.store.exec('UPDATE workflow_conversations SET blocked_reason=NULL WHERE workflow_id=?',decision.workflowId);
      const unknown=turn.cleanupStatus!=='confirmed',status=unknown?'interrupted':turn.status==='completed'?'completed':'failed';
      this.store.exec('UPDATE coordination_decisions SET status=?,ended_at=?,error=COALESCE(error,?) WHERE id=?',status,now(),turn.error,decision.id);
      if(turn.triggerId)this.store.exec('UPDATE turn_triggers SET status=?,ended_at=?,error=? WHERE turn_id=?',unknown?'interrupted':turn.status==='completed'?'consumed':'failed',now(),turn.error,turn.id);
      if(status!=='completed')this.block(decision.workflowId,unknown?'COORDINATION_CLEANUP_UNKNOWN':decision.error??'COORDINATION_TURN_FAILED');
      else if(this.store.workflow(decision.workflowId).status==='running') {
        const pending=this.store.get("SELECT o.id FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? AND o.phase IN ('queued','started')",decision.workflowId);
        const unfinished=this.store.get("SELECT id FROM tasks WHERE workflow_id=? AND status<>'succeeded'",decision.workflowId);
        if(!pending) {
          const pendingEvent=this.store.get("SELECT id FROM coordination_outbox WHERE workflow_id=? AND kind='wake' AND status='pending' UNION ALL SELECT id FROM turn_triggers WHERE workflow_id=? AND status='pending' LIMIT 1",decision.workflowId,decision.workflowId)
            // scan() is deliberately bounded globally. Another workspace's
            // backlog must not turn this workflow's unscanned wake into a
            // permanent no-action blocker at the end of its current turn.
            ??this.store.get(`SELECT event_seq FROM task_events WHERE workflow_id=? AND event_seq>(SELECT event_seq FROM coordination_cursors WHERE consumer='chat') AND type IN (${[...wakes].map(()=>'?').join(',')}) LIMIT 1`,decision.workflowId,...wakes);
          const hasTasks=this.store.get('SELECT id FROM tasks WHERE workflow_id=? LIMIT 1',decision.workflowId);
          if((unfinished||!hasTasks)&&!pendingEvent)this.block(decision.workflowId,'COORDINATION_ACTION_REQUIRED');
          else if(!unfinished&&hasTasks)this.wake(decision.workflowId,`settled:${turn.id}`,'All registered work is settled. Inspect acceptance evidence and finish the Workflow if every gate passes.');
        }
      }
    });
    void this.pump();
  }
  private block(workflowId:string,reason:string):void {
    if(this.owner(workflowId)?.blockedReason===reason)return;
    this.store.exec('UPDATE workflow_conversations SET blocked_reason=? WHERE workflow_id=?',reason,workflowId);
    this.store.event(workflowId,'coordination.blocked',{reason});
  }
  wake(workflowId:string,key:string,reason:string,manual=false):string {
    const owner=this.owner(workflowId);invariant(owner,'COORDINATION_REQUIRED','Workflow uses legacy coordination.');
    if(manual&&!this.store.get("SELECT id FROM coordination_decisions WHERE workflow_id=? AND status IN ('active','handoff_requested','interrupted')",workflowId))this.store.exec('UPDATE workflow_conversations SET blocked_reason=NULL,automatic_turns=0 WHERE workflow_id=?',workflowId);
    const triggerId=`trigger-${key}`;
    this.store.exec("INSERT OR IGNORE INTO turn_triggers(id,workflow_id,workspace_id,conversation_id,agent_id,kind,dedupe_key,payload,created_at,priority,correlation_id,parent_message_id,automatic_hops) VALUES(?,?,?,?,?,'manual_wake',?,?,?,?,?,?,?)",triggerId,workflowId,owner.workspaceId,owner.conversationId,owner.agentId,`${workflowId}:${key}`,JSON.stringify({reason}),now(),manual?90:70,manual?`manual:${key}`:owner.correlationId,owner.parentMessageId,manual?0:owner.automaticTurns+1);
    return this.store.require<{id:string}>('SELECT id FROM turn_triggers WHERE dedupe_key=?',`${workflowId}:${key}`).id;
  }
  initialize():void {
    // Never replay a claimed decision, even when a Host restart proves nothing about its runtime.
    for(const decision of this.store.all<Decision>("SELECT * FROM coordination_decisions WHERE status IN ('active','handoff_requested')"))this.settled(this.store.require<AgentTurn>('SELECT * FROM agent_turns WHERE id=?',decision.turnId));
    this.store.transaction(()=>{
      // Only an orphan without any runtime execution record is provably not
      // started. Accepted or unknown runtime work is never put back for replay.
      for(const trigger of this.store.all<{id:string;turnId:string|null}>("SELECT t.id,t.turn_id FROM turn_triggers t LEFT JOIN agent_turns a ON a.id=t.turn_id WHERE t.status='claimed' AND t.kind IN ('task_event','manual_wake') AND a.id IS NULL")) {
        const accepted=trigger.turnId&&this.store.get('SELECT execution_id FROM native_executions WHERE execution_id=?',trigger.turnId);
        this.store.exec('UPDATE turn_triggers SET status=?,turn_id=?,error=? WHERE id=?',accepted?'interrupted':'pending',accepted?trigger.turnId:null,accepted?'RECOVERY_EXECUTION_UNKNOWN':'RECOVERY_NOT_STARTED',trigger.id);
      }
    });
    this.timer=setInterval(()=>void this.pump(),100);this.timer.unref();void this.pump();
  }
  scan():void {
    this.store.transaction(()=>{
      const cursor=this.store.require<{eventSeq:number}>("SELECT event_seq FROM coordination_cursors WHERE consumer='chat'").eventSeq;
      const events=this.store.all<TaskEvent>('SELECT * FROM task_events WHERE event_seq>? ORDER BY event_seq LIMIT 100',cursor);
      for(const event of events) {
        const owner=this.owner(event.workflowId);if(!owner||!receipts.has(event.type))continue;
        if(owner.blockedReason==='COORDINATION_ACTION_REQUIRED'&&recoveries.has(event.type)) {
          const blocked=this.store.get<{eventSeq:number}>("SELECT event_seq FROM task_events WHERE workflow_id=? AND type='coordination.blocked' AND json_extract(payload,'$.reason')='COORDINATION_ACTION_REQUIRED' ORDER BY event_seq DESC LIMIT 1",event.workflowId);
          // New ledger evidence may make an earlier business blocker actionable.
          // It never establishes cleanup of an unknown Lead decision and never
          // replays the old trigger. Paused workflows remain gated by pump().
          if(blocked&&event.eventSeq>blocked.eventSeq&&!this.store.get("SELECT id FROM coordination_decisions WHERE workflow_id=? AND status='interrupted'",event.workflowId))this.store.exec("UPDATE workflow_conversations SET blocked_reason=NULL WHERE workflow_id=? AND blocked_reason='COORDINATION_ACTION_REQUIRED'",event.workflowId);
        }
        const sourceBoundary=event.runId?this.store.run(event.runId).createdAt:event.occurredAt;
        const source=event.taskId?this.store.get<{id:string;correlationId:string|null;automaticHops:number}>("SELECT id,correlation_id,automatic_hops FROM messages WHERE task_id=? AND kind='delegation' AND created_at<=? ORDER BY rowid DESC LIMIT 1",event.taskId,sourceBoundary):undefined;
        const correlationId=source?.correlationId??owner.correlationId??`workflow:${event.workflowId}`,parentMessageId=source?.id??owner.parentMessageId,automaticHops=(source?.automaticHops??owner.automaticTurns)+1;
        const payload=JSON.stringify({...eventFacts(this.store,event),correlationId,parentMessageId,automaticHops});
        for(const kind of wakes.has(event.type)?['receipt','wake']:['receipt'])this.store.exec('INSERT OR IGNORE INTO coordination_outbox(id,event_seq,workflow_id,conversation_id,kind,payload,created_at,priority,correlation_id,parent_message_id,automatic_hops) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id('outbox'),event.eventSeq,event.workflowId,owner.conversationId,kind,payload,now(),eventPriority(event.type),correlationId,parentMessageId,automaticHops);
      }
      if(events.length)this.store.exec("UPDATE coordination_cursors SET event_seq=? WHERE consumer='chat'",events.at(-1)!.eventSeq);
    });
  }
  async pump():Promise<void> {
    if(this.stopped||this.pumping)return;this.pumping=true;
    try {
      this.scan();
      // Terminal workflows cannot strand queued automatic turns forever. No
      // running/unknown execution is released by this queue-only cancellation.
      for(const turn of this.store.all<AgentTurn>("SELECT a.* FROM agent_turns a JOIN turn_triggers t ON t.id=a.trigger_id JOIN workflows f ON f.id=t.workflow_id WHERE a.status='queued' AND f.status IN ('completed','cancelled','failed')"))this.options.stop(turn);
      this.store.exec("UPDATE turn_triggers SET status='failed',error='WORKFLOW_TERMINAL',ended_at=? WHERE status='pending' AND workflow_id IN (SELECT id FROM workflows WHERE status IN ('completed','cancelled','failed'))",now());
      for(const row of this.store.all<{id:string;workflowId:string;conversationId:string;eventSeq:number;kind:string;payload:{type:string;taskId?:string|null;runId?:string|null;requestId?:string|null;reason?:string};attempt:number;priority:number;correlationId:string|null;parentMessageId:string|null;automaticHops:number}>("SELECT * FROM coordination_outbox WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY priority DESC,event_seq,kind LIMIT 100",now())){try{this.store.transaction(()=>{
        const owner=this.owner(row.workflowId)!;
        if(row.kind==='receipt') {
          this.store.exec('INSERT OR IGNORE INTO coordination_receipts(id,workspace_id,conversation_id,workflow_id,event_seq,payload,created_at) VALUES(?,?,?,?,?,?,?)',row.id,owner.workspaceId,row.conversationId,row.workflowId,row.eventSeq,JSON.stringify(row.payload),now());
          this.options.projectReceipt?.({workspaceId:owner.workspaceId,conversationId:row.conversationId,workflowId:row.workflowId,eventSeq:row.eventSeq,payload:row.payload,correlationId:row.correlationId,parentMessageId:row.parentMessageId,automaticHops:row.automaticHops});
        } else this.store.exec("INSERT OR IGNORE INTO turn_triggers(id,workflow_id,workspace_id,conversation_id,agent_id,kind,dedupe_key,payload,created_at,priority,correlation_id,parent_message_id,automatic_hops) VALUES(?,?,?,?,?,'task_event',?,?,?,?,?,?,?)",`trigger-${row.id}`,row.workflowId,owner.workspaceId,row.conversationId,owner.agentId,`event:${row.eventSeq}:${row.conversationId}`,JSON.stringify(row.payload),now(),row.priority,row.correlationId,row.parentMessageId,row.automaticHops);
        this.store.exec("UPDATE coordination_outbox SET status='delivered',attempt=attempt+1,error=NULL,next_retry_at=NULL WHERE id=?",row.id);
      });}catch(error){this.store.exec('UPDATE coordination_outbox SET attempt=attempt+1,error=?,next_retry_at=? WHERE id=?',publicError(error).message,new Date(Date.now()+Math.min(30000,1000*2**Math.min(row.attempt,5))).toISOString(),row.id);}}
      for(const owner of this.store.all<CoordinationOwner>("SELECT c.* FROM workflow_conversations c JOIN workflows f ON f.id=c.workflow_id WHERE f.status='running' AND c.blocked_reason IS NULL")) {
        if(this.store.get('SELECT id FROM execution_leases WHERE workspace_id=? AND capacity=\'lead\' AND released_at IS NULL',owner.workspaceId)||this.store.get("SELECT id FROM agent_turns WHERE workspace_id=? AND agent_id=? AND status='queued' AND trigger_id IS NOT NULL",owner.workspaceId,owner.agentId))continue;
        const batch=this.store.all<Trigger>("SELECT * FROM turn_triggers WHERE workflow_id=? AND agent_id=? AND kind IN ('task_event','manual_wake') AND status='pending' AND turn_id IS NULL ORDER BY (priority+MIN(100,CAST((julianday('now')-julianday(created_at))*1440 AS INTEGER))) DESC,rowid LIMIT 50",owner.workflowId,owner.agentId);if(!batch.length)continue;
        if(owner.automaticTurns >= (this.options.maxAutomaticTurns??32)){this.block(owner.workflowId,'AUTOMATIC_COORDINATION_BUDGET');continue;}
        try {
          if(this.store.workflow(owner.workflowId).baseCommit)await this.options.ensureParent(owner.workflowId);
          if(this.stopped)break;
          this.store.transaction(()=>{
            // ensureParent is asynchronous. Recheck every admission boundary
            // after it; user input, pause, cancellation or cleanup can race it.
            const current=this.owner(owner.workflowId)!;
            if(this.store.workflow(owner.workflowId).status!=='running'||current.blockedReason||current.version!==owner.version||this.store.get("SELECT id FROM execution_leases WHERE workspace_id=? AND capacity='lead' AND released_at IS NULL",owner.workspaceId)||this.store.get("SELECT id FROM coordination_decisions WHERE workflow_id=? AND status IN ('active','handoff_requested','interrupted')",owner.workflowId))return;
            const trigger=batch[0]!;
            const content=eventBatchContent(owner.workflowId,batch.map(item=>item.payload));
            const turn=this.options.enqueue(owner.workspaceId,owner.conversationId,trigger.id,content);
            this.store.exec('UPDATE turn_triggers SET turn_id=?,payload=?,automatic_hops=? WHERE id=?',turn.id,JSON.stringify({events:batch.map(item=>item.payload),correlationId:trigger.correlationId,parentMessageId:trigger.parentMessageId}),Math.max(current.automaticTurns+1,...batch.map(item=>item.automaticHops)),trigger.id);
            for(const merged of batch.slice(1))this.store.exec("UPDATE turn_triggers SET status='claimed',turn_id=? WHERE id=?",turn.id,merged.id);
            this.store.exec('UPDATE workflow_conversations SET automatic_turns=automatic_turns+1 WHERE workflow_id=?',owner.workflowId);
          });
        }catch(error){if(!this.stopped)this.block(owner.workflowId,publicError(error).code);}
      }
      this.lastError=null;
    }catch(error){this.lastError=publicError(error).message;/* Leave durable intents pending; polling retries projection without replaying decisions. */}
    finally{this.pumping=false;}
  }
  close():void {this.stopped=true;if(this.timer)clearInterval(this.timer);}
}
