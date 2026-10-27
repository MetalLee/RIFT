import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { seedWorkspace } from './fixtures.js';
import { SafeChatStream } from '../../src/chat/safe-stream.js';
import { redact, registerCredentialRedaction } from '../../src/api/security.js';
import { buildChatTimeline } from '../../ui/src/chat-timeline.js';
import { backup, DatabaseSync } from 'node:sqlite';
import { RiftStore } from '../../src/storage/database.js';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Independent collaboration acceptance did not settle');};
interface Call {input:RuntimeTurnInput;finish:(value:RuntimeTurnResult)=>void}
const invoke=async<T=unknown>(input:RuntimeTurnInput,name:string,args:unknown)=>{
  const tool=input.tools.find(item=>item.name===name);expect(tool,`Host exposes ${name}`).toBeTruthy();
  return tool!.execute(args,input.signal) as Promise<T>;
};
interface Delegation {workflowId:string;taskId:string;requestId:string;messageId:string;receiptMessageId:string;recipientAgentId:string;state:string}
interface Delivery {messageId:string;inboxId:string;state:string}
const taskCall=(calls:Call[],taskId:string)=>calls.find(call=>call.input.instructions.startsWith('You are executing a registered text-only')&&JSON.parse(call.input.messages[0]!.content).taskId===taskId);

async function fixture(mode:boolean=true) {
  const home=await mkdtemp(path.join(tmpdir(),'rift-collaboration-review-'));
  const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[],chatOrchestration:mode});
  const {workspace,roles}=seedWorkspace(host.store,'collaboration-review');
  host.store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'controlled-review'}),workspace.id);
  host.store.exec('UPDATE roles SET chat_connection=? WHERE workspace_id=?',JSON.stringify({runtime:'codex',model:'controlled-review'}),workspace.id);
  const calls:Call[]=[];
  host.registerChatRuntime('codex',{persistentSessions:true,async start(input){
    input.session?.onThread(input.session.threadId??`thread-${input.turnId}`);input.session?.onTurn(`native-${input.turnId}`);
    const model=deferred<RuntimeTurnResult>();calls.push({input,finish(value){input.session?.onSettled(value.stopReason);model.resolve(value);}});
    return{result:model.promise,async dispose(){}};
  }},['controlled-review']);
  await host.initialize();
  const conversation=host.chat.createConversation(workspace.id,'Independent collaboration review');
  const first=host.chat.send(workspace.id,conversation.id,{clientMessageId:'review-first',content:'Coordinate the registered collaboration review'}).turn;
  await until(()=>calls.length===1);
  const workflow=await invoke<{id:string}>(calls[0]!.input,'rift_workflow_start',{goal:'Verify collaboration boundaries',mode:'analysis'});
  return{host,home,workspace,roles,conversation,first,workflow,calls,lead:calls[0]!,developers:roles.filter(role=>role.purpose==='developer'),close:async()=>{await host.close();await rm(home,{recursive:true,force:true});}};
}

describe('Independent C2 acceptance: atomic delegation',()=>{
  it('commits one task, request, attributed delegation and receipt for a repeated logical command and rejects changed input',async()=>{
    const f=await fixture();
    try{
      const input={taskDraft:{id:'delegate-once',kind:'analysis',title:'Compare text',instructions:'Compare alpha and beta',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'Explain each relevant distinction.',idempotencyKey:'same-command'};
      const first=await invoke<Delegation>(f.lead.input,'rift_delegate',input);
      const repeated=await invoke<Delegation>(f.lead.input,'rift_delegate',{idempotencyKey:input.idempotencyKey,message:input.message,recipientAgentId:input.recipientAgentId,expectedPlanRevision:0,taskDraft:{expectedPaths:[],instructions:input.taskDraft.instructions,title:input.taskDraft.title,kind:'analysis',id:'delegate-once'}});
      expect(repeated).toEqual(first);
      expect(f.host.store.all('SELECT id FROM tasks WHERE workflow_id=?',f.workflow.id)).toHaveLength(1);
      expect(f.host.store.all('SELECT id FROM operations WHERE entity_id=?',first.taskId)).toHaveLength(1);
      expect(f.host.store.require('SELECT sender_type,sender_agent_id,recipient_agent_id,kind,origin,task_id,request_id,source_turn_id FROM messages WHERE id=?',first.messageId)).toEqual({senderType:'agent',senderAgentId:f.lead.input.agentId,recipientAgentId:f.developers[0]!.id,kind:'delegation',origin:'model',taskId:first.taskId,requestId:first.requestId,sourceTurnId:f.first.id});
      expect(f.host.store.require('SELECT sender_type,sender_agent_id,kind,origin FROM messages WHERE id=?',first.receiptMessageId)).toEqual({senderType:'system',senderAgentId:null,kind:'receipt',origin:'host'});
      await expect(invoke(f.lead.input,'rift_delegate',{...input,message:'A different instruction using the same key'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
      expect(f.host.store.all("SELECT id FROM messages WHERE kind='delegation' AND task_id=?",first.taskId)).toHaveLength(1);
    }finally{await f.close();}
  });

  it('rolls back the plan, queue, message and idempotency receipt together when delegation publication fails',async()=>{
    const f=await fixture();
    try{
      const input={taskDraft:{id:'atomic-failed',kind:'analysis',title:'Atomic failure',instructions:'No side effect before commit',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'This must commit atomically.',idempotencyKey:'atomic-command'};
      f.host.store.db.exec("CREATE TRIGGER reject_review_delegation BEFORE INSERT ON messages WHEN NEW.kind='delegation' AND NEW.task_id='atomic-failed' BEGIN SELECT RAISE(ABORT,'independent delegation fault'); END");
      await expect(invoke(f.lead.input,'rift_delegate',input)).rejects.toThrow('independent delegation fault');
      expect(f.host.store.get('SELECT id FROM tasks WHERE id=?','atomic-failed')).toBeUndefined();
      expect(f.host.store.all('SELECT id FROM operations')).toEqual([]);
      expect(f.host.store.all("SELECT id FROM messages WHERE kind IN ('delegation','receipt')")).toEqual([]);
      expect(f.host.store.all('SELECT operation_key FROM collaboration_operations')).toEqual([]);
      expect(f.host.store.workflow(f.workflow.id).planRevision).toBe(0);
      expect(f.host.store.all('SELECT id FROM runs')).toEqual([]);
      expect(f.calls).toHaveLength(1);
      f.host.store.db.exec('DROP TRIGGER reject_review_delegation');
      const committed=await invoke<Delegation>(f.lead.input,'rift_delegate',input);
      expect(committed.taskId).toBe('atomic-failed');
      expect(f.host.store.get('SELECT id FROM messages WHERE id=?',committed.messageId)).toBeTruthy();
      await until(()=>f.calls.length===2);
      expect(f.host.store.all('SELECT id FROM runs WHERE task_id=?','atomic-failed')).toHaveLength(1);
    }finally{await f.close();}
  });
});

describe('Independent C4 acceptance: safe incremental text',()=>{
  it('never publishes credentials split at any boundary, including quoted whitespace and escaped structured values',()=>{
    const registered='registered-secret alpha\nregistered-secret-omega';
    registerCredentialRedaction('RIFT_INDEPENDENT_STREAM_SECRET',registered);
    const samples=[
      {value:'Bearer bearer-credential-unique',hidden:['bearer-credential-unique']},
      {value:'Bearer\r\n newline-credential-unique',hidden:['newline-credential-unique']},
      {value:'sk-super-sensitive-stream-token',hidden:['super-sensitive-stream-token']},
      {value:'{"password":"quoted-alpha quoted-omega"}',hidden:['quoted-alpha','quoted-omega']},
      {value:'{"api_key":"escaped-alpha \\" escaped-omega"}',hidden:['escaped-alpha','escaped-omega']},
      {value:"secret='single-alpha\nsingle-omega'",hidden:['single-alpha','single-omega']},
      {value:registered,hidden:['registered-secret-omega']},
    ];
    const prefix='Safe incremental context. '.repeat(5),suffix=' Safe continuation after the sensitive value. '.repeat(6);
    for(const sample of samples)for(let split=0;split<=sample.value.length;split++){
      const stream=new SafeChatStream();let published='';
      for(const delta of [prefix,sample.value.slice(0,split),sample.value.slice(split),suffix]){
        published+=stream.push(delta);
        for(const hidden of sample.hidden)expect(published,`${sample.value} split ${split}`).not.toContain(hidden);
      }
      const final=stream.finish();
      for(const hidden of sample.hidden)expect(final).not.toContain(hidden);
      expect(final).toBe(redact(prefix+sample.value+suffix,256000));
      expect(final.startsWith(published)).toBe(true);
      expect(published.length).toBeGreaterThan(0);
    }
  });

  it('retains an arbitrarily long unfinished secret token and enforces the cumulative input limit',()=>{
    const stream=new SafeChatStream();let published=stream.push('Public text before a token. '.repeat(4));
    const marker='LONGSECRETSEGMENT';
    published+=stream.push('Bearer ');
    for(let i=0;i<20;i++){
      published+=stream.push(marker.repeat(30));
      expect(published).not.toContain(marker);
    }
    published+=stream.push(' end of token. '.repeat(10));
    expect(published).not.toContain(marker);expect(stream.finish()).not.toContain(marker);
    const limited=new SafeChatStream();limited.push('x'.repeat(256000));
    expect(()=>limited.push('x')).toThrow('CHAT_TEXT_LIMIT');
  });

  it('shows a live draft after delegation, replaces it with one final reply, and projects each event receipt once',async()=>{
    const f=await fixture();
    try{
      const delegation=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:'draft-after-delegate',kind:'analysis',title:'Independent task',instructions:'Continue in background',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'Delegate without hiding the Lead draft.',idempotencyKey:'draft-delegate'});
      const body='A unique live explanation after the task was committed. '.repeat(8);
      f.lead.input.onText?.(body);
      const live=f.host.chat.page(f.workspace.id,f.conversation.id);
      const timeline=buildChatTimeline(live.messages,live.turns,live.chunks,live.receipts);
      expect(timeline.items.flatMap(item=>item.drafts).filter(draft=>draft.turn.id===f.first.id)).toEqual([expect.objectContaining({text:expect.stringContaining('A unique live explanation')})]);
      expect(f.host.chat.turn(f.workspace.id,f.first.id).status).toBe('running');
      f.host.store.event(f.workflow.id,'coordination.blocked',{reason:'INDEPENDENT_RECEIPT_MARKER'},{taskId:delegation.taskId});
      await f.host.orchestration.pump();
      const receiptPage=f.host.chat.page(f.workspace.id,f.conversation.id);
      const receipt=receiptPage.receipts!.find(item=>item.payload.type==='coordination.blocked')!;
      const projected=receiptPage.messages.find(message=>message.dedupeKey===`event:${receipt.eventSeq}:${f.conversation.id}`)!;
      expect(projected).toBeTruthy();
      expect(projected.content).toContain('INDEPENDENT_RECEIPT_MARKER');
      const receiptTimeline=buildChatTimeline(receiptPage.messages,receiptPage.turns,receiptPage.chunks,receiptPage.receipts);
      expect([...receiptTimeline.items.flatMap(item=>item.updates),...receiptTimeline.loose].filter(item=>item.id===projected.id||item.id===receipt.id)).toHaveLength(1);
      f.lead.finish({text:body,stopReason:'completed'});
      await until(()=>f.host.chat.turn(f.workspace.id,f.first.id).status==='completed');
      const final=f.host.chat.page(f.workspace.id,f.conversation.id),settled=buildChatTimeline(final.messages,final.turns,final.chunks,final.receipts);
      expect(settled.items.flatMap(item=>item.drafts).filter(draft=>draft.turn.id===f.first.id)).toEqual([]);
      expect(settled.items.filter(item=>item.message.sourceTurnId===f.first.id&&item.message.kind==='chat'&&item.message.content===body)).toHaveLength(1);
      expect(final.messages.filter(message=>message.sourceTurnId===f.first.id&&message.kind==='chat')).toHaveLength(1);
    }finally{await f.close();}
  });

  it.each(['failed','cancelled'] as const)('keeps a %s partial response visibly incomplete and never acknowledges it as a completed native reply',async status=>{
    const f=await fixture();
    try{
      const secret='sk-partial-response-never-public';
      f.lead.input.onText?.('Safe partial reasoning. '.repeat(8));
      f.lead.input.onText?.(`Authorization: Bearer ${secret.slice(0,12)}`);
      f.lead.input.onText?.(`${secret.slice(12)} trailing context. `.repeat(1));
      if(status==='cancelled')f.host.chat.stop(f.workspace.id,f.first.id);
      else f.lead.finish({text:`Safe partial reasoning. Authorization: Bearer ${secret}`,stopReason:'failed'});
      await until(()=>f.host.chat.turn(f.workspace.id,f.first.id).status===status);
      const page=f.host.chat.page(f.workspace.id,f.conversation.id);
      expect(JSON.stringify(page)).not.toContain(secret);
      const reply=page.messages.find(message=>message.sourceTurnId===f.first.id&&message.kind==='chat')!;
      expect(reply).toBeTruthy();expect(reply.status).toBe(status);
      expect(f.host.store.all('SELECT message_id FROM native_message_receipts WHERE message_id=?',reply.id)).toEqual([]);
      const timeline=buildChatTimeline(page.messages,page.turns,page.chunks,page.receipts);
      expect(timeline.items.some(item=>item.message.id===reply.id&&item.message.status!=='completed')).toBe(true);
      expect(timeline.items.flatMap(item=>item.drafts).filter(draft=>draft.turn.id===f.first.id)).toEqual([]);
    }finally{await f.close();}
  });
});

describe('Independent C2 acceptance: Run messages and immutable inboxes',()=>{
  it('keeps parallel member results attributed when they finish out of order and admits a successor only after both gates settle',async()=>{
    const f=await fixture();
    try{
      const delegate=(taskId:string,revision:number,member:number,dependsOn:string[]=[])=>invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:taskId,kind:'analysis',title:taskId,instructions:`Analyze ${taskId}`,expectedPaths:[],dependsOn},expectedPlanRevision:revision,recipientAgentId:f.developers[member]!.id,message:`Evidence for ${taskId}`,idempotencyKey:`dispatch-${taskId}`});
      const a=await delegate('parallel-first',0,0),b=await delegate('parallel-second',1,1),c=await delegate('parallel-successor',2,0,[a.taskId,b.taskId]);
      await until(()=>Boolean(taskCall(f.calls,a.taskId)&&taskCall(f.calls,b.taskId)));
      expect(taskCall(f.calls,c.taskId)).toBeUndefined();
      const runA=taskCall(f.calls,a.taskId)!,runB=taskCall(f.calls,b.taskId)!;
      const send=async(call:Call,content:string)=>invoke<Delivery>(call.input,'rift_send_message',{recipientAgentId:f.lead.input.agentId,kind:'progress',content,idempotencyKey:'own-result'});
      const bMessage=await send(runB,'The second member result arrived first.');
      runB.finish({text:'Second analysis independently complete.',stopReason:'completed'});
      await until(()=>f.host.store.task(b.taskId).status==='succeeded'&&f.host.store.run(runB.input.turnId).cleanupStatus==='confirmed');
      expect(f.host.store.task(a.taskId).status).toBe('running');
      expect(f.host.store.all('SELECT id FROM runs WHERE task_id=?',c.taskId)).toEqual([]);
      const aMessage=await send(runA,'The first member result arrived second.');
      runA.finish({text:'First analysis independently complete.',stopReason:'completed'});
      await until(()=>Boolean(taskCall(f.calls,c.taskId)));
      const runC=taskCall(f.calls,c.taskId)!;
      expect(f.host.store.task(a.taskId).status).toBe('succeeded');
      expect(f.host.store.run(runA.input.turnId).cleanupStatus).toBe('confirmed');
      for(const [message,run,task,agent] of [[aMessage,runA,a,f.developers[0]!],[bMessage,runB,b,f.developers[1]!]] as const){
        expect(f.host.store.require('SELECT sender_agent_id,recipient_agent_id,task_id,run_id FROM messages WHERE id=?',message.messageId)).toEqual({senderAgentId:agent.id,recipientAgentId:f.lead.input.agentId,taskId:task.taskId,runId:run.input.turnId});
      }
      expect(JSON.parse(runC.input.messages[0]!.content).collaborationMessages.map((message:{messageId:string})=>message.messageId)).toEqual([c.messageId]);
      expect(f.host.store.all('SELECT id FROM runs WHERE task_id=?',c.taskId)).toHaveLength(1);
    }finally{await f.close();}
  });

  it('reports from the existing Run lease, queues a busy recipient, and delivers task supplements only on a repair boundary',async()=>{
    const f=await fixture();
    try{
      const a=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:'member-task-a',kind:'analysis',title:'A analysis',instructions:'Analyze A',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'Use the A acceptance constraints.',idempotencyKey:'delegate-a'});
      const b=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:'member-task-b',kind:'analysis',title:'B analysis',instructions:'Analyze B',expectedPaths:[]},expectedPlanRevision:1,recipientAgentId:f.developers[1]!.id,message:'Use the B acceptance constraints.',idempotencyKey:'delegate-b'});
      await until(()=>Boolean(taskCall(f.calls,a.taskId)&&taskCall(f.calls,b.taskId)));
      const runA=taskCall(f.calls,a.taskId)!,runB=taskCall(f.calls,b.taskId)!;
      const originalA=runA.input.messages[0]!.content,originalB=runB.input.messages[0]!.content;
      expect(JSON.parse(originalA).collaborationMessages).toEqual([expect.objectContaining({messageId:a.messageId,senderAgentId:f.lead.input.agentId,content:'Use the A acceptance constraints.'})]);
      const progress=await invoke<Delivery>(runA.input,'rift_send_message',{recipientAgentId:f.lead.input.agentId,kind:'progress',content:'A is processing the supplied evidence.',idempotencyKey:'run-progress'});
      expect(f.host.store.require('SELECT sender_agent_id,run_id,task_id,origin FROM messages WHERE id=?',progress.messageId)).toEqual({senderAgentId:f.developers[0]!.id,runId:runA.input.turnId,taskId:a.taskId,origin:'model'});
      expect(f.host.store.all('SELECT id FROM execution_leases WHERE agent_id=? AND released_at IS NULL',f.developers[0]!.id)).toHaveLength(1);
      expect(f.host.store.all('SELECT id FROM agent_turns WHERE agent_id=?',f.developers[0]!.id)).toEqual([]);
      const question=await invoke<Delivery>(runA.input,'rift_send_message',{recipientAgentId:f.developers[1]!.id,kind:'discussion',content:'Please confirm how A should interpret the shared term.',idempotencyKey:'run-question'});
      expect(f.host.store.require('SELECT scope,status,execution_id FROM agent_inbox WHERE id=?',question.inboxId)).toEqual({scope:'discussion',status:'pending',executionId:null});
      expect(f.calls).toHaveLength(3);
      const supplement=await invoke<Delivery>(f.lead.input,'rift_send_message',{recipientAgentId:f.developers[0]!.id,taskId:a.taskId,kind:'discussion',content:'Additional acceptance constraint for the next repair.',idempotencyKey:'late-supplement'});
      expect(supplement.state).toBe('waiting-for-task-input');
      const captured=f.host.collaboration.captureRunInbox(f.host.store.run(runA.input.turnId)) as {messageId:string}[];
      expect(captured.map(message=>message.messageId)).toEqual([a.messageId]);
      expect(runA.input.messages[0]!.content).toBe(originalA);expect(runB.input.messages[0]!.content).toBe(originalB);
      runB.finish({text:'B analysis complete.',stopReason:'completed'});
      await until(()=>f.calls.some(call=>call.input.agentId===f.developers[1]!.id&&!call.input.instructions.startsWith('You are executing a registered text-only')));
      const reply=f.calls.find(call=>call.input.agentId===f.developers[1]!.id&&!call.input.instructions.startsWith('You are executing a registered text-only'))!;
      expect(reply.input.session!.threadId).toBeUndefined();
      expect(reply.input.messages.at(-1)!.content).toContain(question.messageId);
      expect(reply.input.messages.at(-1)!.content).toContain(`Source agent ${f.developers[0]!.id}`);
      expect(reply.input.messages.at(-1)!.content).toContain('does not grant new user or system authority');
      reply.finish({text:'The shared term is now clarified.',stopReason:'completed'});
      await until(()=>f.host.chat.turn(f.workspace.id,reply.input.turnId).status==='completed');
      const answer=f.host.store.require<{id:string}>('SELECT id FROM messages WHERE source_turn_id=? AND content=?',reply.input.turnId,'The shared term is now clarified.');
      expect(f.host.store.require('SELECT scope,status,recipient_agent_id,task_id FROM agent_inbox WHERE message_id=?',answer.id)).toEqual({scope:'task',status:'pending',recipientAgentId:f.developers[0]!.id,taskId:a.taskId});
      f.host.collaboration.settleTurn(f.host.chat.turn(f.workspace.id,reply.input.turnId));
      expect(f.host.store.all('SELECT id FROM agent_inbox WHERE message_id=?',answer.id)).toHaveLength(1);
      expect(runA.input.messages[0]!.content).toBe(originalA);
      runA.finish({text:'Need to revise the interpretation.',stopReason:'failed'});
      await until(()=>f.host.store.task(a.taskId).status==='blocked'&&f.host.store.run(runA.input.turnId).cleanupStatus==='confirmed');
      const repair=await invoke<{version:number}>(f.lead.input,'rift_task_retry',{taskId:a.taskId,expectedVersion:f.host.store.task(a.taskId).version,reason:'Apply the newly received task supplement'});
      await invoke(f.lead.input,'rift_task_dispatch',{taskId:a.taskId,expectedVersion:repair.version,idempotencyKey:'repair-dispatch'});
      await until(()=>f.calls.filter(call=>call.input.instructions.startsWith('You are executing a registered text-only')&&JSON.parse(call.input.messages[0]!.content).taskId===a.taskId).length===2);
      const repaired=f.calls.filter(call=>call.input.instructions.startsWith('You are executing a registered text-only')&&JSON.parse(call.input.messages[0]!.content).taskId===a.taskId)[1]!;
      // A repair checkout changes the native permission boundary. The Host
      // carries prior evidence and inbox context into a fresh native thread.
      expect(repaired.input.session!.threadId).toBeUndefined();
      const repairInput=JSON.parse(repaired.input.messages[0]!.content);
      expect(repairInput.collaborationMessages).toEqual([expect.objectContaining({messageId:supplement.messageId,content:'Additional acceptance constraint for the next repair.'}),expect.objectContaining({messageId:answer.id,content:'The shared term is now clarified.'})]);
      expect(f.host.store.require('SELECT status,execution_id FROM agent_inbox WHERE id=?',supplement.inboxId)).toEqual({status:'consumed',executionId:repaired.input.turnId});
      expect(f.host.store.all('SELECT r.message_id FROM native_message_receipts r JOIN native_sessions s ON s.id=r.session_id WHERE s.scope=? AND r.message_id=?','task',supplement.messageId)).toEqual([]);
      await expect(invoke(runA.input,'rift_send_message',{recipientAgentId:f.lead.input.agentId,content:'Late stale report',idempotencyKey:'stale-run'})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    }finally{await f.close();}
  });

  it('rejects foreign recipients, foreign task references and spoofed authors without persisting a message',async()=>{
    const f=await fixture();
    try{
      const foreign=seedWorkspace(f.host.store,'collaboration-foreign');
      const taskOwner=f.host.coordinator.createWorkflow({workspaceId:foreign.workspace.id,goal:'Foreign analysis',baseCommit:'',integrationRef:'',repositoryFree:true});
      f.host.coordinator.submitPlan({workflowId:taskOwner.id,expectedRevision:0,tasks:[{id:'foreign-collaboration-task',kind:'analysis',title:'Foreign',instructions:'Not shared',expectedPaths:[]}]});
      const count=()=>f.host.store.require<{count:number}>('SELECT COUNT(*) AS count FROM messages').count;
      const before=count();
      await expect(invoke(f.lead.input,'rift_send_message',{recipientAgentId:foreign.roles[0]!.id,content:'Cross workspace attempt',idempotencyKey:'foreign-recipient'})).rejects.toMatchObject({code:'NOT_FOUND'});
      await expect(invoke(f.lead.input,'rift_send_message',{recipientAgentId:f.developers[0]!.id,taskId:'foreign-collaboration-task',content:'Cross task attempt',idempotencyKey:'foreign-task'})).rejects.toMatchObject({code:'CROSS_WORKFLOW'});
      await expect(invoke(f.lead.input,'rift_send_message',{recipientAgentId:f.developers[0]!.id,senderAgentId:f.developers[1]!.id,content:'Spoofed author attempt',idempotencyKey:'spoof'})).rejects.toThrow();
      expect(count()).toBe(before);
      expect(f.host.store.all('SELECT id FROM agent_inbox')).toEqual([]);
      await invoke(f.lead.input,'rift_yield',{summary:'Handoff has ended this decision'});
      await expect(invoke(f.lead.input,'rift_send_message',{recipientAgentId:f.developers[0]!.id,content:'Late yielded message',idempotencyKey:'yielded-send'})).rejects.toMatchObject({code:'DECISION_EXPIRED'});
      expect(count()).toBe(before);
    }finally{await f.close();}
  });
});

describe('Independent C3 acceptance: causality, ordering and recovery',()=>{
  it('attributes a delayed old Run event to its original delegation after a new attempt has been delegated',async()=>{
    const f=await fixture();
    try{
      const first=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:'causal-repair',kind:'analysis',title:'Causal repair',instructions:'Keep attempt ancestry',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'Original delegated question.',idempotencyKey:'causal-first'});
      await until(()=>Boolean(taskCall(f.calls,first.taskId)));const original=taskCall(f.calls,first.taskId)!;
      original.finish({text:'The first attempt needs a repair.',stopReason:'failed'});
      await until(()=>f.host.store.task(first.taskId).status==='blocked'&&f.host.store.run(original.input.turnId).cleanupStatus==='confirmed');
      const retry=await invoke<{version:number}>(f.lead.input,'rift_task_retry',{taskId:first.taskId,expectedVersion:f.host.store.task(first.taskId).version,reason:'Create a second attempt'});
      const second=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskId:first.taskId,expectedTaskVersion:retry.version,recipientAgentId:f.developers[0]!.id,message:'A new delegated repair instruction.',idempotencyKey:'causal-second'});
      expect(second.messageId).not.toBe(first.messageId);
      f.host.store.event(f.workflow.id,'cleanup.confirmed',{reason:'Delayed callback for old attempt'},{taskId:first.taskId,runId:original.input.turnId});
      const event=f.host.store.require<{eventSeq:number}>('SELECT MAX(event_seq) AS event_seq FROM task_events WHERE workflow_id=?',f.workflow.id);
      await f.host.orchestration.pump();
      const projected=f.host.store.require<{parentMessageId:string;correlationId:string;payload:{parentMessageId:string}}>('SELECT parent_message_id,correlation_id,payload FROM coordination_outbox WHERE event_seq=? AND kind=?',event.eventSeq,'receipt');
      expect(projected.parentMessageId).toBe(first.messageId);expect(projected.payload.parentMessageId).toBe(first.messageId);expect(projected.correlationId).toBe(f.first.messageId);
      expect(f.host.store.require('SELECT reply_to_message_id FROM messages WHERE dedupe_key=?',`event:${event.eventSeq}:${f.conversation.id}`)).toEqual({replyToMessageId:first.messageId});
    }finally{await f.close();}
  });

  it('rolls back both receipt projections on a message fault and retries one visible result without recreating the delegated task',async()=>{
    const f=await fixture();
    try{
      const delegation=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:'outbox-existing-task',kind:'analysis',title:'Existing delegated work',instructions:'Wait while projection is recovered',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'Create the task exactly once.',idempotencyKey:'outbox-delegate'});
      f.host.store.event(f.workflow.id,'coordination.blocked',{reason:'INDEPENDENT_PUBLICATION_FAULT'},{taskId:delegation.taskId});
      const event=f.host.store.require<{eventSeq:number}>('SELECT event_seq FROM task_events WHERE workflow_id=? AND type=? ORDER BY event_seq DESC LIMIT 1',f.workflow.id,'coordination.blocked');
      const key=`event:${event.eventSeq}:${f.conversation.id}`;
      f.host.store.db.exec(`CREATE TRIGGER reject_review_projection BEFORE INSERT ON messages WHEN NEW.dedupe_key='${key}' BEGIN SELECT RAISE(ABORT,'independent publication fault'); END`);
      await f.host.orchestration.pump();
      expect(f.host.store.require('SELECT status,attempt,error FROM coordination_outbox WHERE event_seq=? AND kind=?',event.eventSeq,'receipt')).toEqual({status:'pending',attempt:1,error:'independent publication fault'});
      expect(f.host.store.all('SELECT id FROM coordination_receipts WHERE event_seq=?',event.eventSeq)).toEqual([]);
      expect(f.host.store.all('SELECT id FROM messages WHERE dedupe_key=?',key)).toEqual([]);
      f.host.store.db.exec('DROP TRIGGER reject_review_projection');
      f.host.store.exec('UPDATE coordination_outbox SET next_retry_at=NULL WHERE event_seq=?',event.eventSeq);
      await f.host.orchestration.pump();await f.host.orchestration.pump();
      expect(f.host.store.require('SELECT status,attempt,error FROM coordination_outbox WHERE event_seq=? AND kind=?',event.eventSeq,'receipt')).toEqual({status:'delivered',attempt:2,error:null});
      expect(f.host.store.all('SELECT id FROM coordination_receipts WHERE event_seq=?',event.eventSeq)).toHaveLength(1);
      expect(f.host.store.all('SELECT id FROM messages WHERE dedupe_key=?',key)).toHaveLength(1);
      expect(f.host.store.all('SELECT id FROM tasks WHERE workflow_id=?',f.workflow.id)).toHaveLength(1);
      expect(f.host.store.all("SELECT id FROM messages WHERE kind='delegation' AND task_id=?",delegation.taskId)).toHaveLength(1);
      const page=f.host.chat.page(f.workspace.id,f.conversation.id),timeline=buildChatTimeline(page.messages,page.turns,page.chunks,page.receipts);
      const projection=page.messages.find(message=>message.dedupeKey===key)!,receipt=page.receipts!.find(item=>item.eventSeq===event.eventSeq)!;
      expect([...timeline.items.flatMap(item=>item.updates),...timeline.loose].filter(item=>item.id===projection.id||item.id===receipt.id)).toHaveLength(1);
    }finally{await f.close();}
  });

  it('bounds an automatic member conversation chain and preserves its user-root correlation without recursive replies',async()=>{
    const f=await fixture();
    try{
      await invoke(f.lead.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'chain-task',kind:'analysis',title:'Chain context',instructions:'Keep the workflow open',expectedPaths:[]}]});
      let delivery=await invoke<Delivery>(f.lead.input,'rift_send_message',{recipientAgentId:f.developers[0]!.id,content:'Begin the bounded member discussion.',kind:'discussion',idempotencyKey:'chain-0'});
      for(let hop=1;hop<=8;hop++){
        await until(()=>f.calls.some(call=>f.host.store.get<{messageId:string}>('SELECT message_id FROM agent_turns WHERE id=?',call.input.turnId)?.messageId===delivery.messageId));
        const current=f.calls.find(call=>f.host.store.get<{messageId:string}>('SELECT message_id FROM agent_turns WHERE id=?',call.input.turnId)?.messageId===delivery.messageId)!;
        const recipient=f.developers.find(role=>role.id!==current.input.agentId)!.id;
        const next=await invoke<Delivery>(current.input,'rift_send_message',{recipientAgentId:recipient,content:`Automatic follow-up at hop ${hop}.`,kind:'discussion',replyToMessageId:delivery.messageId,idempotencyKey:`chain-${hop}`});
        current.finish({text:`Member response at hop ${hop}.`,stopReason:'completed'});
        if(hop===8){
          expect(next.state).toBe('blocked');
          expect(f.host.store.require('SELECT status,error FROM agent_inbox WHERE id=?',next.inboxId)).toEqual({status:'failed',error:'AUTOMATIC_MESSAGE_BUDGET'});
        }
        delivery=next;
      }
      f.host.collaboration.pump();f.host.chat.pump();
      expect(f.calls).toHaveLength(9);
      const chain=f.host.store.all<{automaticHops:number;correlationId:string}>("SELECT automatic_hops,correlation_id FROM messages WHERE kind='discussion' ORDER BY rowid");
      expect(chain.map(message=>message.automaticHops)).toEqual([1,2,3,4,5,6,7,8,9]);
      expect(new Set(chain.map(message=>message.correlationId))).toEqual(new Set([f.first.messageId]));
      expect(f.host.store.get("SELECT id FROM messages WHERE sender_type='system' AND kind='blocker' AND content LIKE '%自动对话%'")).toBeTruthy();
    }finally{await f.close();}
  });

  it('keeps member requests behind an exhausted Lead budget until an actual user message resumes coordination',async()=>{
    const f=await fixture();
    try{
      const delegated=await invoke<Delegation>(f.lead.input,'rift_delegate',{taskDraft:{id:'budget-member-task',kind:'analysis',title:'Budget task',instructions:'Keep working',expectedPaths:[]},expectedPlanRevision:0,recipientAgentId:f.developers[0]!.id,message:'Run with the existing lease.',idempotencyKey:'budget-delegate'});
      await until(()=>Boolean(taskCall(f.calls,delegated.taskId)));const worker=taskCall(f.calls,delegated.taskId)!;
      f.lead.finish({text:'Task delegated.',stopReason:'completed'});await until(()=>f.host.chat.turn(f.workspace.id,f.first.id).status==='completed');
      f.host.store.exec("UPDATE workflow_conversations SET blocked_reason='AUTOMATIC_COORDINATION_BUDGET',automatic_turns=32 WHERE workflow_id=?",f.workflow.id);
      const request=await invoke<Delivery>(worker.input,'rift_send_message',{recipientAgentId:f.lead.input.agentId,kind:'discussion',content:'Please make one more automatic decision.',idempotencyKey:'member-after-budget'});
      f.host.collaboration.pump();f.host.chat.pump();await new Promise(resolve=>setTimeout(resolve,40));
      expect(f.calls.filter(call=>call.input.agentId===f.lead.input.agentId)).toHaveLength(1);
      expect(f.host.orchestration.owner(f.workflow.id)).toMatchObject({blockedReason:'AUTOMATIC_COORDINATION_BUDGET',automaticTurns:32});
      expect(f.host.store.require<{status:string}>('SELECT status FROM agent_inbox WHERE id=?',request.inboxId).status).not.toBe('consumed');
      const user=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'explicit-budget-reset',content:'I explicitly authorize the next coordination step.'});
      await until(()=>f.calls.filter(call=>call.input.agentId===f.lead.input.agentId).length===2);
      const resumed=f.calls.filter(call=>call.input.agentId===f.lead.input.agentId)[1]!;
      expect(resumed.input.turnId).toBe(user.turn.id);
      expect(f.host.orchestration.owner(f.workflow.id)).toMatchObject({blockedReason:null,automaticTurns:0});
    }finally{await f.close();}
  });

  it('prioritizes a queued user input, then merges out-of-order ledger facts into one attributed event decision',async()=>{
    const f=await fixture();
    try{
      await invoke(f.lead.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'ordering-task',kind:'analysis',title:'Order facts',instructions:'Await a coordination decision',expectedPaths:[]}]});
      f.host.store.event(f.workflow.id,'cleanup.confirmed',{}, {taskId:'ordering-task'});
      f.host.store.event(f.workflow.id,'task.blocked',{reason:'ORDERING_BLOCKER'},{taskId:'ordering-task'});
      await f.host.orchestration.pump();
      const queued=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'priority-user',content:'User correction takes precedence over routine progress.'});
      f.lead.finish({text:'Current coordination batch ended.',stopReason:'completed'});
      await until(()=>f.calls.length===2);
      expect(f.calls[1]!.input.turnId).toBe(queued.turn.id);
      expect(f.calls[1]!.input.messages.at(-1)!.content).toBe('User correction takes precedence over routine progress.');
      f.calls[1]!.finish({text:'Correction recorded.',stopReason:'completed'});
      await until(()=>f.calls.length===3);
      const automatic=f.calls[2]!,turn=f.host.chat.turn(f.workspace.id,automatic.input.turnId);
      expect(turn.messageId).toBeNull();expect(turn.configuration.trigger?.correlationId).toBe(f.first.messageId);
      expect(turn.configuration.trigger?.automaticHops).toBeGreaterThan(0);
      const trigger=f.host.store.require<{payload:{events:{type:string}[]};priority:number}>('SELECT payload,priority FROM turn_triggers WHERE id=?',turn.triggerId!);
      expect(trigger.priority).toBe(100);
      expect(trigger.payload.events.map(event=>event.type)).toEqual(['task.blocked','cleanup.confirmed']);
      expect(f.host.store.all("SELECT id FROM turn_triggers WHERE status='claimed' AND turn_id=?",turn.id)).toHaveLength(2);
      expect(automatic.input.messages.at(-1)!.content).toContain('earlier statuses may already be superseded');
      expect(f.host.store.all("SELECT id FROM execution_leases WHERE workspace_id=? AND capacity='lead' AND released_at IS NULL",f.workspace.id)).toHaveLength(1);
    }finally{await f.close();}
  });

  it('recovers a natively accepted member inbox as interrupted without replaying it or releasing its lease',async()=>{
    const f=await fixture(),recoveredHome=await mkdtemp(path.join(tmpdir(),'rift-collaboration-recovery-'));
    let recovered:RiftHostService|undefined,closed=false;
    try{
      await invoke(f.lead.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'recovery-member-task',kind:'analysis',title:'Pending recovery',instructions:'No dispatch needed',expectedPaths:[]}]});
      const message=await invoke<Delivery>(f.lead.input,'rift_send_message',{recipientAgentId:f.developers[0]!.id,kind:'discussion',content:'Please inspect the recorded task.',idempotencyKey:'accepted-inbox'});
      await until(()=>f.calls.length===2);
      const member=f.calls[1]!,memberTurn=f.host.chat.turn(f.workspace.id,member.input.turnId);
      expect(f.host.store.require('SELECT status,execution_id FROM agent_inbox WHERE id=?',message.inboxId)).toEqual({status:'delivered',executionId:memberTurn.id});
      expect(f.host.store.require<{status:string}>('SELECT status FROM native_executions WHERE execution_id=?',memberTurn.id).status).toBe('running');
      await backup(f.host.store.db,path.join(recoveredHome,'rift.db'));
      await f.close();closed=true;
      let replayed=0;
      recovered=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home:recoveredHome,port:0,leadProvider:'unused',leadModel:'unused',checks:[]});
      recovered.registerChatRuntime('codex',{async start(){replayed++;return{result:Promise.resolve({text:'Forbidden replay',stopReason:'completed' as const}),async dispose(){}};}},['controlled-review']);
      await recovered.initialize();
      expect(recovered.store.require('SELECT status,execution_id FROM agent_inbox WHERE id=?',message.inboxId)).toEqual({status:'interrupted',executionId:memberTurn.id});
      expect(recovered.chat.turn(f.workspace.id,memberTurn.id)).toMatchObject({status:'interrupted',cleanupStatus:'unknown'});
      expect(recovered.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',memberTurn.id)).toBeTruthy();
      recovered.coordinator.resume(f.workflow.id,recovered.store.workflow(f.workflow.id).version);
      recovered.collaboration.pump();recovered.chat.pump();await recovered.orchestration.pump();
      expect(replayed).toBe(0);
      expect(recovered.store.all('SELECT id FROM messages WHERE id=?',message.messageId)).toHaveLength(1);
    }finally{if(!closed)await f.close();await recovered?.close();await rm(recoveredHome,{recursive:true,force:true});}
  });
});

describe('Independent release acceptance: defaults and history',()=>{
  it('honors an explicit legacy-mode override and does not silently bind an old workflow to chat coordination',async()=>{
    const f=await fixture(false);
    try{
      expect(f.lead.input.tools.map(tool=>tool.name)).toContain('rift_wait');
      expect(f.lead.input.tools.map(tool=>tool.name)).not.toContain('rift_yield');
      expect(f.host.orchestration.owner(f.workflow.id)).toBeUndefined();
      expect(f.host.store.all('SELECT id FROM coordination_decisions')).toEqual([]);
    }finally{await f.close();}
  });

  it('enables short coordination by default while leaving an ordinary consultation task-free',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-collaboration-default-'));
    const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[]});
    const calls:Call[]=[];
    const {workspace}=seedWorkspace(host.store,'default-collaboration-review');
    host.store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'default-review'}),workspace.id);
    host.registerChatRuntime('codex',{async start(input){const model=deferred<RuntimeTurnResult>();calls.push({input,finish:model.resolve});return{result:model.promise,async dispose(){}};}},['default-review']);
    try{
      await host.initialize();const conversation=host.chat.createConversation(workspace.id,'Default mode review');
      const question=host.chat.send(workspace.id,conversation.id,{clientMessageId:'ordinary-consultation',content:'Explain what a dependency means.'}).turn;
      await until(()=>calls.length===1);
      expect(calls[0]!.input.tools.map(tool=>tool.name)).toContain('rift_delegate');expect(calls[0]!.input.tools.map(tool=>tool.name)).not.toContain('rift_wait');
      calls[0]!.finish({text:'A dependency is work that must finish before another task can proceed.',stopReason:'completed'});
      await until(()=>host.chat.turn(workspace.id,question.id).status==='completed');
      expect(host.store.all('SELECT id FROM workflows')).toEqual([]);expect(host.store.all('SELECT id FROM tasks')).toEqual([]);
      host.chat.send(workspace.id,conversation.id,{clientMessageId:'real-execution',content:'Now register a supplied-text analysis.'});
      await until(()=>calls.length===2);
      const workflow=await invoke<{id:string}>(calls[1]!.input,'rift_workflow_start',{goal:'Real requested work',mode:'analysis'});
      expect(host.orchestration.owner(workflow.id)).toMatchObject({conversationId:conversation.id,workspaceId:workspace.id});
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });

  it('upgrades a C1 database without losing authors, reply links, native receipts or retained execution ownership',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-collaboration-upgrade-')),file=path.join(home,'rift.db');
    const old=new DatabaseSync(file);
    try{
      old.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
      for(const migration of (await readdir('migrations')).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&Number(name.slice(0,4))<=13).sort())old.exec(await readFile(path.join('migrations',migration),'utf8'));
      old.exec(`
        INSERT INTO workspaces(id,name,root_path) VALUES('history-workspace','History','review');
        INSERT INTO roles(id,workspace_id,name,kind,prompt,revision,purpose) VALUES('history-lead','history-workspace','lead','dsh-lead','Lead',1,'lead');
        INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('history-conversation','history-workspace','Historical conversation','2026-10-25T00:00:00Z');
        INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES('history-user','history-workspace','history-conversation','history-lead','user','Prior goal','running','2026-10-25T00:00:00Z');
        INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at,reply_to_message_id) VALUES('history-reply','history-workspace','history-conversation','history-lead','assistant','Prior reply','completed','2026-10-25T00:00:01Z','history-user');
        INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at,kind) VALUES('history-title','history-workspace','history-conversation','history-lead','user','Private title input','completed','2026-10-25T00:00:00Z','conversation_title');
        INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('history-turn','history-workspace','history-conversation','history-user','history-lead','running','{}','2026-10-25T00:00:00Z');
        INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('history-lease','turn','history-turn','history-workspace','history-lead','lead','2026-10-25T00:00:00Z');
        INSERT INTO native_sessions(id,workspace_id,scope,scope_id,agent_id,configuration_key,thread_id,runtime_home,cwd,created_at) VALUES('history-session','history-workspace','chat','history-conversation','history-lead','fingerprint','persisted-thread','home','cwd','2026-10-25T00:00:00Z');
        INSERT INTO native_message_receipts(session_id,message_id,message_version) VALUES('history-session','history-reply',0);
      `);
    }finally{old.close();}
    try{
      const migrated=new RiftStore(file);
      try{
        expect(migrated.all('PRAGMA foreign_key_check')).toEqual([]);
        expect(migrated.require('SELECT sender_type,sender_agent_id,recipient_agent_id,origin,reply_to_message_id FROM messages WHERE id=?','history-reply')).toEqual({senderType:'agent',senderAgentId:'history-lead',recipientAgentId:'history-lead',origin:'model',replyToMessageId:'history-user'});
        expect(migrated.require('SELECT sender_type,visibility FROM messages WHERE id=?','history-title')).toEqual({senderType:'user',visibility:'internal'});
        expect(migrated.require('SELECT message_id FROM native_message_receipts')).toEqual({messageId:'history-reply'});
        expect(migrated.require('SELECT released_at FROM execution_leases')).toEqual({releasedAt:null});
        expect(migrated.require('SELECT status FROM agent_turns')).toEqual({status:'running'});
        expect(migrated.all('SELECT version FROM schema_migrations WHERE version>=14 ORDER BY version')).toEqual([{version:14},{version:15},{version:16},{version:17},{version:18},{version:19},{version:20},{version:21}]);
      }finally{migrated.close();}
    }finally{await rm(home,{recursive:true,force:true});}
  });
});
