import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, now, type RiftStore } from '../storage/database.js';
import { invariant, type Operation, type PlanTask, type Role, type Run, type Task } from '../contracts/index.js';
import type { TaskCoordinator, DispatchInput } from '../task/coordinator.js';
import type { AgentTurn } from './contracts.js';
import type { RuntimeTool } from '../agent/runtime-types.js';
import { planTaskSchema } from '../api/schemas.js';
import { redact, publicError } from '../api/security.js';

const boundedId=z.string().min(1).max(160);
export const sendCollaborationMessageSchema=z.object({recipientAgentId:boundedId,content:z.string().trim().min(1).max(16000),kind:z.enum(['discussion','progress','blocker']).default('discussion'),taskId:boundedId.optional(),replyToMessageId:boundedId.optional(),idempotencyKey:boundedId}).strict();
export const delegateSchema=z.object({taskId:boundedId.optional(),expectedTaskVersion:z.number().int().nonnegative().optional(),taskDraft:planTaskSchema.optional(),expectedPlanRevision:z.number().int().nonnegative().optional(),recipientAgentId:boundedId,message:z.string().trim().min(1).max(16000),idempotencyKey:boundedId}).strict().refine(input=>input.taskId!==undefined&&input.expectedTaskVersion!==undefined&&input.taskDraft===undefined&&input.expectedPlanRevision===undefined||input.taskDraft!==undefined&&input.expectedPlanRevision!==undefined&&input.taskId===undefined&&input.expectedTaskVersion===undefined,'Use taskId + expectedTaskVersion OR taskDraft + expectedPlanRevision.');
export type CollaborationExecution={type:'turn'|'run';id:string};
interface Identity {workspaceId:string;conversationId:string;agentId:string;workflowId:string|null;taskId:string|null;runId:string|null;turnId:string|null;purpose:string;correlationId:string;automaticHops:number}
interface Inbox {id:string;messageId:string;workspaceId:string;conversationId:string;recipientAgentId:string;taskId:string|null;scope:string;status:string;executionId:string|null}
interface Message {id:string;workspaceId:string;conversationId:string;senderType:string;senderAgentId:string|null;recipientAgentId:string|null;content:string;kind:string;origin:string;visibility:string;workflowId:string|null;taskId:string|null;runId:string|null;sourceTurnId:string|null;requestId:string|null;replyToMessageId:string|null;version:number;correlationId:string|null;automaticHops:number}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** Public messages and their delivery intent commit with the corresponding business write. */
export class CollaborationService {
  private timer?:ReturnType<typeof setInterval>;
  private stopped=false;
  private pumping=false;
  constructor(readonly store:RiftStore,private readonly coordinator:TaskCoordinator,private readonly options:{enqueueMessage(workspaceId:string,conversationId:string,messageId:string):AgentTurn;validateRecipient?(role:Role,workflowId:string):void;validateDiscussion?(workspaceId:string,agentId:string):void}) {}
  private identity(execution:CollaborationExecution):Identity {
    invariant(!this.stopped,'HOST_CLOSING','Collaboration is shutting down.');
    const lease=this.store.get<{agentId:string;workspaceId:string}>('SELECT agent_id,workspace_id FROM execution_leases WHERE owner_type=? AND owner_id=? AND released_at IS NULL',execution.type,execution.id);
    invariant(lease,'UNAUTHORIZED','Collaboration requires the current execution lease.');
    if(execution.type==='turn') {
      const turn=this.store.require<AgentTurn>('SELECT * FROM agent_turns WHERE id=?',execution.id);
      invariant(turn.status==='running'&&turn.agentId===lease.agentId&&turn.workspaceId===lease.workspaceId&&!turn.configuration.conversationTitle,'UNAUTHORIZED','This conversation execution is no longer active.');
      const decision=this.store.get<{workflowId:string;status:string;ownerVersion:number}>('SELECT workflow_id,status,owner_version FROM coordination_decisions WHERE turn_id=?',turn.id);
      if(decision)invariant(decision.status==='active'&&this.store.get('SELECT workflow_id FROM workflow_conversations WHERE workflow_id=? AND conversation_id=? AND agent_id=? AND version=?',decision.workflowId,turn.conversationId,turn.agentId,decision.ownerVersion),'DECISION_EXPIRED','This coordination decision has yielded or lost ownership.');
      const workflowId=decision?.workflowId??this.store.get<{id:string}>("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','cancelled','failed')",turn.workspaceId)?.id??null;
      const source=turn.messageId?this.store.get<Message>('SELECT * FROM messages WHERE id=?',turn.messageId):undefined;
      const trigger=turn.triggerId?this.store.get<{correlationId?:string;automaticHops?:number}>('SELECT * FROM turn_triggers WHERE id=?',turn.triggerId):undefined;
      return{workspaceId:turn.workspaceId,conversationId:turn.conversationId,agentId:turn.agentId,workflowId,taskId:null,runId:null,turnId:turn.id,purpose:turn.configuration.agent.purpose,correlationId:source?.correlationId??source?.id??trigger?.correlationId??turn.id,automaticHops:source?.senderType==='user'?0:source?.automaticHops??trigger?.automaticHops??0};
    }
    const run=this.store.run(execution.id),task=this.store.task(run.taskId),workflow=this.store.workflow(task.workflowId);
    invariant(['preparing','running'].includes(run.status)&&run.slotReleasedAt===null&&run.roleId===lease.agentId&&workflow.workspaceId===lease.workspaceId&&!['cancelled','failed','completed'].includes(workflow.status)&&!['cancelled','succeeded'].includes(task.status),'UNAUTHORIZED','This Run no longer owns an active task execution.');
    const owner=this.store.get<{conversationId:string;correlationId:string|null}>('SELECT conversation_id,correlation_id FROM workflow_conversations WHERE workflow_id=?',workflow.id);
    const conversationId=owner?.conversationId??this.store.get<{id:string}>('SELECT id FROM conversations WHERE workspace_id=? ORDER BY rowid LIMIT 1',workflow.workspaceId)?.id;
    invariant(conversationId,'CONVERSATION_REQUIRED','A public workspace conversation is required for collaboration.');
    const source=this.store.get<Message>("SELECT * FROM messages WHERE task_id=? AND kind='delegation' AND created_at<=? ORDER BY rowid DESC LIMIT 1",task.id,run.createdAt);
    return{workspaceId:workflow.workspaceId,conversationId,agentId:run.roleId,workflowId:workflow.id,taskId:task.id,runId:run.id,turnId:null,purpose:run.providerSnapshot.role.purpose??'developer',correlationId:source?.correlationId??source?.id??owner?.correlationId??run.id,automaticHops:source?.automaticHops??0};
  }
  private scope(identity:Identity):string {return `${identity.workspaceId}:${identity.agentId}:${identity.workflowId??identity.conversationId}${identity.runId?`:run:${identity.runId}`:''}`;}
  private once<T>(identity:Identity,key:string,input:unknown,action:()=>T):T {
    const scope=this.scope(identity),fingerprint=createHash('sha256').update(canonical(input)).digest('hex');
    const prior=this.store.get<{fingerprint:string;response:string}>('SELECT fingerprint,response FROM collaboration_operations WHERE scope=? AND operation_key=?',scope,key);
    if(prior){invariant(prior.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT','This collaboration key was used with different input.');return JSON.parse(prior.response) as T;}
    const result=action();this.store.exec('INSERT INTO collaboration_operations(scope,operation_key,fingerprint,response,created_at) VALUES(?,?,?,?,?)',scope,key,fingerprint,JSON.stringify(result),now());return result;
  }
  private recipient(workspaceId:string,agentId:string):Role {return this.store.require<Role>('SELECT * FROM roles WHERE id=? AND workspace_id=? AND enabled=1',agentId,workspaceId);}
  private message(identity:Identity,values:{content:string;kind:string;recipientAgentId?:string|null;taskId?:string|null;requestId?:string|null;replyToMessageId?:string;dedupeKey?:string;system?:boolean}):Message {
    const messageId=id('message');
    this.store.exec('INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at,kind,sender_type,sender_agent_id,origin,visibility,workflow_id,task_id,run_id,source_turn_id,request_id,reply_to_message_id,correlation_id,dedupe_key,automatic_hops) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',messageId,identity.workspaceId,identity.conversationId,values.recipientAgentId??null,values.system?'system':'assistant',redact(values.content,16000),'completed',now(),values.kind,values.system?'system':'agent',values.system?null:identity.agentId,values.system?'host':'model','public',identity.workflowId,values.taskId??identity.taskId,identity.runId,identity.turnId,values.requestId??null,values.replyToMessageId??null,identity.correlationId,values.dedupeKey??null,identity.automaticHops+1);
    return this.store.require<Message>('SELECT * FROM messages WHERE id=?',messageId);
  }
  projectReceipt(input:{workspaceId:string;conversationId:string;workflowId:string;eventSeq:number;correlationId?:string|null;parentMessageId?:string|null;automaticHops?:number;payload:{type:string;taskId?:string|null;runId?:string|null;requestId?:string|null;reason?:string}}):{messageId:string} {
    return this.store.transaction(()=>{
      invariant(this.store.workflow(input.workflowId).workspaceId===input.workspaceId,'CROSS_WORKFLOW','Receipt Workflow belongs to another workspace.');
      const dedupe=`event:${input.eventSeq}:${input.conversationId}`,prior=this.store.get<{id:string}>('SELECT id FROM messages WHERE workspace_id=? AND dedupe_key=?',input.workspaceId,dedupe);if(prior)return{messageId:prior.id};
      const labels:Record<string,string>={'dispatch.queued':'任务已入队','activation_accepted':'成员已开始处理','source.collected':'开发结果已收集，等待检查与审查','task.blocked':'任务需要处理阻塞','task.succeeded':'分析任务已完成','integration.accepted':'任务已通过检查与审查','cleanup.confirmed':'执行清理已确认','cleanup.unknown':'执行清理待确认','cleanup.failed':'执行清理待确认','publication.uncertain':'发布结果待核实','workflow.completed':'流程已完成','workflow.cancel_requested':'流程已取消','integration.reconciled':'集成恢复已核实','integration.recovered':'集成恢复已核实','workflow.running':'流程已恢复','coordination.blocked':'流程等待下一步处理'};
      const reasons:Record<string,string>={COORDINATION_ACTION_REQUIRED:'需要补充决策',COORDINATION_CLEANUP_UNKNOWN:'Lead 执行清理尚未确认',COORDINATION_TOOL_BUDGET:'本轮工具调用达到限制',AUTOMATIC_COORDINATION_BUDGET:'自动协调达到限制',AUTOMATIC_MESSAGE_BUDGET:'成员自动对话达到限制',HANDOFF_PROTOCOL_VIOLATION:'交接后仍调用工具，已停止本轮',COORDINATION_TURN_FAILED:'协调回复未能完成',COORDINATION_TURN_CANCELLED:'协调回复已停止',PUBLICATION_REQUIRES_RECOVERY:'发布结果需要核实'};
      const reason=input.payload.reason?redact(reasons[input.payload.reason]??input.payload.reason,320):'';
      const content=`${labels[input.payload.type]??'流程状态已更新'}${reason?`：${reason}`:''}`;
      const messageId=id('message');
      this.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at,kind,sender_type,origin,visibility,workflow_id,task_id,run_id,request_id,dedupe_key,correlation_id,reply_to_message_id,automatic_hops) VALUES(?,?,?,'system',?,'completed',?,'receipt','system','host','public',?,?,?,?,?,?,?,?)",messageId,input.workspaceId,input.conversationId,redact(content,2000),now(),input.workflowId,input.payload.taskId??null,input.payload.runId??null,input.payload.requestId??null,dedupe,input.correlationId??null,input.parentMessageId??null,input.automaticHops??0);
      return{messageId};
    });
  }
  send(execution:CollaborationExecution,input:z.infer<typeof sendCollaborationMessageSchema>):unknown {
    const result=this.store.transaction(()=>{
      const identity=this.identity(execution),recipient=this.recipient(identity.workspaceId,input.recipientAgentId);
      invariant(recipient.id!==identity.agentId,'SELF_MESSAGE','Send collaboration messages to a different workspace member.');
      if(recipient.purpose==='lead'&&identity.workflowId){const owner=this.store.get<{conversationId:string;agentId:string}>('SELECT conversation_id,agent_id FROM workflow_conversations WHERE workflow_id=?',identity.workflowId);invariant(!owner||owner.agentId===recipient.id&&owner.conversationId===identity.conversationId,'COORDINATION_OWNED','Address Workflow coordination messages in its primary conversation.');}
      const taskId=input.taskId??identity.taskId;
      invariant(!identity.runId||taskId===identity.taskId,'CROSS_TASK','A Run may publish only under its own task identity.');
      if(taskId)invariant(this.store.task(taskId).workflowId===identity.workflowId,'CROSS_WORKFLOW','Message task belongs to another Workflow.');
      if(input.replyToMessageId)invariant(this.store.get('SELECT id FROM messages WHERE id=? AND workspace_id=? AND conversation_id=?',input.replyToMessageId,identity.workspaceId,identity.conversationId),'CROSS_CONVERSATION','Reply target belongs to another conversation.');
      return this.once(identity,input.idempotencyKey,{operation:'send',...input,taskId},()=>{
        const message=this.message(identity,{...input,taskId});
        const task=taskId?this.store.task(taskId):undefined;
        const activeRole=taskId?this.store.get<{roleId:string}>('SELECT role_id FROM runs WHERE task_id=? AND slot_released_at IS NULL ORDER BY rowid DESC LIMIT 1',taskId)?.roleId:undefined;
        const plannedRole=taskId?this.store.get<{roleId:string}>("SELECT json_extract(payload,'$.roleId') AS role_id FROM operations WHERE entity_id=? AND kind='dispatch' AND phase='queued' ORDER BY rowid DESC LIMIT 1",taskId)?.roleId:undefined;
        const taskScope=task&&recipient.purpose==='developer'&&(task.roleId===recipient.id||activeRole===recipient.id||plannedRole===recipient.id);
        const inboxId=id('inbox');
        // Progress is visible context; only an actual question/blocker schedules
        // a decision. Task-scoped supplements wait for the next immutable input.
        const exceeded=message.automaticHops>8,status=exceeded?'failed':input.kind==='progress'&&!taskScope?'consumed':'pending';
        this.store.exec('INSERT INTO agent_inbox(id,message_id,workspace_id,conversation_id,recipient_agent_id,task_id,scope,status,created_at,consumed_at,automatic_hops,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',inboxId,message.id,identity.workspaceId,identity.conversationId,recipient.id,taskId,taskScope?'task':'discussion',status,now(),status==='consumed'?now():null,message.automaticHops,exceeded?'AUTOMATIC_MESSAGE_BUDGET':null);
        if(exceeded)this.message(identity,{content:'成员自动对话达到本轮限制，请用户确认下一步。',kind:'blocker',taskId,system:true});
        if(identity.workflowId)this.store.event(identity.workflowId,'collaboration.message',{messageId:message.id,inboxId,kind:input.kind,recipientAgentId:recipient.id},{...(taskId?{taskId}:{}),...(identity.runId?{runId:identity.runId}:{})});
        return{messageId:message.id,inboxId,recipientAgentId:recipient.id,workflowId:identity.workflowId,taskId,state:exceeded?'blocked':status==='consumed'?'recorded':taskScope?'waiting-for-task-input':'queued'};
      });
    });
    this.pump();return result;
  }
  delegate(turn:AgentTurn,input:z.infer<typeof delegateSchema>):unknown {
    const result=this.store.transaction(()=>{
      const identity=this.identity({type:'turn',id:turn.id});
      invariant(identity.purpose==='lead'&&identity.workflowId,'UNAUTHORIZED','Only the assigned Lead may delegate Workflow tasks.');
      const owner=this.store.get<{conversationId:string;agentId:string}>('SELECT conversation_id,agent_id FROM workflow_conversations WHERE workflow_id=?',identity.workflowId);
      invariant(!owner||owner.conversationId===identity.conversationId&&owner.agentId===identity.agentId,'COORDINATION_OWNED','Use the Workflow primary conversation.');
      const role=this.recipient(identity.workspaceId,input.recipientAgentId);
      invariant(role.purpose==='developer'&&role.providerBindingId,'ROLE_UNAVAILABLE','Delegation requires an enabled executable developer.');
      this.options.validateRecipient?.(role,identity.workflowId);
      return this.once(identity,input.idempotencyKey,{kind:'delegate',...input},()=>{
        let task:Task;
        if(input.taskDraft){
          invariant(!input.taskDraft.roleName||input.taskDraft.roleName===role.name,'RECIPIENT_MISMATCH','Task draft and recipient name disagree.');
          const taskId=input.taskDraft.id??id('task');
          this.coordinator.submitPlan({workflowId:identity.workflowId!,expectedRevision:input.expectedPlanRevision!,tasks:[{...input.taskDraft,id:taskId,roleName:role.name}]});
          task=this.store.task(taskId);
        }else{task=this.store.task(input.taskId!);invariant(task.workflowId===identity.workflowId,'CROSS_WORKFLOW','Delegation task belongs to another Workflow.');invariant(!task.roleId||task.roleId===role.id,'RECIPIENT_MISMATCH','Task is assigned to another member.');}
        const request=this.coordinator.dispatch({taskId:task.id,expectedVersion:input.expectedTaskVersion??task.version,idempotencyKey:`collaboration:${createHash('sha256').update(this.scope(identity)+':'+input.idempotencyKey).digest('hex')}`,roleName:role.name},true);
        const message=this.message(identity,{content:input.message,kind:'delegation',recipientAgentId:role.id,taskId:task.id,requestId:request.id});
        this.store.exec("INSERT INTO agent_inbox(id,message_id,workspace_id,conversation_id,recipient_agent_id,task_id,scope,status,automatic_hops,created_at) VALUES(?,?,?,?,?,?,'task','pending',?,?)",id('inbox'),message.id,identity.workspaceId,identity.conversationId,role.id,task.id,message.automaticHops,now());
        const receipt=this.message(identity,{content:'任务已入队',kind:'receipt',recipientAgentId:role.id,taskId:task.id,requestId:request.id,system:true});
        const waits=this.store.get("SELECT t.id FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND t.status<>'succeeded'",task.id);
        return{workflowId:identity.workflowId,taskId:task.id,requestId:request.id,messageId:message.id,receiptMessageId:receipt.id,recipientAgentId:role.id,state:waits?'waiting-dependency':'queued'};
      });
    });
    this.coordinator.wake();return result;
  }
  plan(turn:AgentTurn,input:{workflowId:string;expectedRevision:number;tasks:PlanTask[]}):Task[] {
    return this.store.transaction(()=>{const identity=this.identity({type:'turn',id:turn.id});invariant(input.workflowId===identity.workflowId,'CROSS_WORKFLOW','Plan belongs to another Workflow.');const prior=new Set(this.store.all<{id:string}>('SELECT id FROM tasks WHERE workflow_id=?',input.workflowId).map(task=>task.id));const tasks=this.coordinator.submitPlan(input);for(const task of tasks)if(!prior.has(task.id))this.message(identity,{content:'任务已登记',kind:'receipt',taskId:task.id,recipientAgentId:task.roleId,system:true});return tasks;});
  }
  dispatch(turn:AgentTurn,input:DispatchInput):Operation {
    const result=this.store.transaction(()=>{const identity=this.identity({type:'turn',id:turn.id});const task=this.store.task(input.taskId);invariant(task.workflowId===identity.workflowId,'CROSS_WORKFLOW','Dispatch task belongs to another Workflow.');return this.once(identity,input.idempotencyKey,{kind:'dispatch',...input},()=>{const request=this.coordinator.dispatch({...input,idempotencyKey:`chat:${createHash('sha256').update(this.scope(identity)+':'+input.idempotencyKey).digest('hex')}`},true);this.message(identity,{content:'任务已入队',kind:'receipt',recipientAgentId:request.payload.roleId??task.roleId,taskId:task.id,requestId:request.id,system:true});return request;});});this.coordinator.wake();return result;
  }
  runTools(run:Run):RuntimeTool[] {return[{name:'rift_send_message',description:'Send a scoped collaboration message to one workspace member. The Host supplies your identity and task; sending does not start another execution for you. Use progress for updates, discussion for questions, blocker for a decision request. Task assignment and acceptance require their separate gates.',inputSchema:JSON.parse(JSON.stringify(z.toJSONSchema(sendCollaborationMessageSchema,{io:'input'}))),execute:async(args,signal)=>{signal.throwIfAborted();return this.send({type:'run',id:run.id},sendCollaborationMessageSchema.parse(args));}}];}
  captureRunInbox(run:Run):unknown[] {
    return this.store.transaction(()=>{
      const captured=this.store.get('SELECT run_id FROM run_input_boundaries WHERE run_id=?',run.id);
      if(!captured){this.store.exec('INSERT INTO run_input_boundaries(run_id,captured_at) VALUES(?,?)',run.id,now());for(const inbox of this.store.all<Inbox>("SELECT * FROM agent_inbox WHERE scope='task' AND task_id=? AND recipient_agent_id=? AND status='pending' ORDER BY rowid",run.taskId,run.roleId)){
        const message=this.store.require<Message>('SELECT * FROM messages WHERE id=?',inbox.messageId);
        this.store.exec('INSERT OR IGNORE INTO run_inbox_receipts(run_id,inbox_id,message_id,message_version) VALUES(?,?,?,?)',run.id,inbox.id,message.id,message.version);
      }}
      const messages=this.store.all<Message>('SELECT m.* FROM messages m JOIN run_inbox_receipts r ON r.message_id=m.id WHERE r.run_id=? ORDER BY m.rowid',run.id);
      invariant(messages.reduce((size,message)=>size+message.content.length,0)<=64000,'CONTEXT_LIMIT','Pending task collaboration exceeds the immutable input budget; review pending messages before retry.');
      return messages.map(({id,senderType,senderAgentId,recipientAgentId,kind,origin,content,taskId,runId,replyToMessageId})=>({messageId:id,senderType,senderAgentId,recipientAgentId,kind,origin,content,taskId,runId,replyToMessageId,authority:'quoted-collaboration-data'}));
    });
  }
  acceptRunInbox(runId:string):void {this.store.transaction(()=>{this.store.exec("UPDATE agent_inbox SET status='consumed',execution_id=?,consumed_at=? WHERE id IN (SELECT inbox_id FROM run_inbox_receipts WHERE run_id=?) AND status='pending'",runId,now(),runId);this.store.exec("UPDATE run_inbox_receipts SET status='accepted' WHERE run_id=?",runId);});}
  settleTurn(turn:AgentTurn):void {
    this.store.transaction(()=>{
      const status=turn.cleanupStatus!=='confirmed'?'interrupted':turn.status==='completed'?'consumed':'failed';
      this.store.exec('UPDATE agent_inbox SET status=?,error=?,consumed_at=? WHERE execution_id=? AND scope=\'discussion\' AND status IN (\'delivered\',\'interrupted\')',status,turn.error,now(),turn.id);
      if(turn.status==='completed'&&turn.messageId)for(const reply of this.store.all<Message>("SELECT * FROM messages WHERE source_turn_id=? AND reply_to_message_id=? AND sender_type='agent' AND status='completed' AND task_id IS NOT NULL AND recipient_agent_id IS NOT NULL",turn.id,turn.messageId)){
        const task=this.store.task(reply.taskId!);
        const recipient=this.store.get<Role>("SELECT * FROM roles WHERE id=? AND workspace_id=? AND purpose='developer'",reply.recipientAgentId!,reply.workspaceId);
        const assigned=this.store.get('SELECT id FROM runs WHERE task_id=? AND role_id=? LIMIT 1',task.id,reply.recipientAgentId!);
        if(!recipient||task.roleId!==recipient.id&&!assigned)continue;
        const exceeded=reply.automaticHops>8;
        // A natural final answer to a Run's question is selected task context,
        // not a new conversational trigger. Deliver only at the next Run input.
        this.store.exec("INSERT OR IGNORE INTO agent_inbox(id,message_id,workspace_id,conversation_id,recipient_agent_id,task_id,scope,status,automatic_hops,error,created_at) VALUES(?,?,?,?,?,?,'task',?,?,?,?)",id('inbox'),reply.id,reply.workspaceId,reply.conversationId,recipient.id,task.id,exceeded?'failed':'pending',reply.automaticHops,exceeded?'AUTOMATIC_MESSAGE_BUDGET':null,now());
      }
    });
    this.pump();
  }
  retryDelivery(workspaceId:string,messageId:string):{messageId:string;inboxId:string;state:string} {
    invariant(!this.stopped,'HOST_CLOSING','Collaboration is shutting down.');
    const result=this.store.transaction(()=>{
      const inbox=this.store.require<Inbox>('SELECT * FROM agent_inbox WHERE workspace_id=? AND message_id=?',workspaceId,messageId);
      const message=this.store.require<Message>("SELECT * FROM messages WHERE id=? AND workspace_id=? AND visibility='public'",messageId,workspaceId);
      // Repeated retries only return the existing delivery; they never replay it.
      if(['pending','delivered','consumed'].includes(inbox.status))return{messageId,inboxId:inbox.id,state:inbox.status};
      invariant(inbox.status==='failed'&&!inbox.executionId&&!this.store.get('SELECT id FROM agent_turns WHERE message_id=?',messageId)&&!this.store.get('SELECT run_id FROM run_inbox_receipts WHERE message_id=?',messageId),'DELIVERY_ALREADY_STARTED','This message may already have reached an execution; inspect its evidence rather than replaying it.');
      invariant(this.store.workspace(workspaceId).status==='active','WORKSPACE_ARCHIVED','Archived workspace cannot retry delivery.');
      const recipient=this.recipient(workspaceId,inbox.recipientAgentId);
      invariant(message.automaticHops<=8,'AUTOMATIC_MESSAGE_BUDGET','This automatic message chain requires a new user decision.');
      if(message.workflowId)invariant(this.store.workflow(message.workflowId).workspaceId===workspaceId&&this.store.workflow(message.workflowId).status==='running','WORKFLOW_NOT_RUNNING','Resume a live Workflow before retrying this message.');
      if(inbox.scope==='discussion')this.options.validateDiscussion?.(workspaceId,recipient.id);
      else {invariant(message.workflowId&&inbox.taskId,'TASK_REQUIRED','Task delivery requires its original task.');invariant(!['succeeded','cancelled','failed'].includes(this.store.task(inbox.taskId).status),'TASK_TERMINAL','This task no longer accepts new input.');this.options.validateRecipient?.(recipient,message.workflowId);}
      this.store.exec("UPDATE agent_inbox SET status='pending',error=NULL,consumed_at=NULL WHERE id=?",inbox.id);
      return{messageId,inboxId:inbox.id,state:'pending'};
    });
    queueMicrotask(()=>this.pump());return result;
  }
  initialize():void {for(const turn of this.store.all<AgentTurn>("SELECT a.* FROM agent_turns a JOIN agent_inbox i ON i.execution_id=a.id WHERE i.scope='discussion' AND i.status='delivered' AND a.status IN ('completed','cancelled','failed','interrupted')"))this.settleTurn(turn);this.timer=setInterval(()=>this.pump(),100);this.timer.unref();this.pump();}
  pump():void {
    if(this.stopped||this.pumping)return;this.pumping=true;
    try{
      this.store.exec("UPDATE agent_inbox SET status='failed',error='WORKFLOW_TERMINAL' WHERE status='pending' AND message_id IN (SELECT m.id FROM messages m JOIN workflows f ON f.id=m.workflow_id WHERE f.status IN ('completed','cancelled','failed'))");
      for(const inbox of this.store.all<Inbox>("SELECT i.* FROM agent_inbox i JOIN messages m ON m.id=i.message_id WHERE i.scope='discussion' AND i.status='pending' AND NOT EXISTS(SELECT 1 FROM execution_leases l WHERE l.agent_id=i.recipient_agent_id AND l.released_at IS NULL) AND NOT EXISTS(SELECT 1 FROM agent_turns a WHERE a.agent_id=i.recipient_agent_id AND a.status='queued') AND (m.workflow_id IS NULL OR EXISTS(SELECT 1 FROM workflows f WHERE f.id=m.workflow_id AND f.status='running')) ORDER BY CASE m.kind WHEN 'blocker' THEN 0 ELSE 1 END,i.rowid LIMIT 50")){
      if(this.store.get('SELECT id FROM execution_leases WHERE agent_id=? AND released_at IS NULL',inbox.recipientAgentId)||this.store.get("SELECT id FROM agent_turns WHERE agent_id=? AND status='queued'",inbox.recipientAgentId))continue;
      const message=this.store.require<Message>('SELECT * FROM messages WHERE id=?',inbox.messageId);
      if(message.workflowId&&this.store.workflow(message.workflowId).status!=='running')continue;
      try{this.store.transaction(()=>{const turn=this.options.enqueueMessage(inbox.workspaceId,inbox.conversationId,inbox.messageId);this.store.exec("UPDATE agent_inbox SET status='delivered',execution_id=? WHERE id=? AND status='pending'",turn.id,inbox.id);});}catch(error){this.store.exec("UPDATE agent_inbox SET status='failed',error=? WHERE id=?",publicError(error).message,inbox.id);}
    }}finally{this.pumping=false;}
  }
  close():void {this.stopped=true;if(this.timer)clearInterval(this.timer);}
}
