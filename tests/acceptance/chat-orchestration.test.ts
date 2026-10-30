import { describe,expect,it } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import type { RuntimeTurnInput,RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { seedWorkspace } from './fixtures.js';
import type { AgentTurn } from '../../src/chat/contracts.js';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Condition did not settle');};
async function fixture(execute:(input:RuntimeTurnInput,host:RiftHostService)=>Promise<RuntimeTurnResult>) {
  const home=await mkdtemp(path.join(tmpdir(),'rift-orchestration-'));
  const ctx={agents:{create:async()=>({agent:{id:'parent',followup:()=>{throw new Error('Must not start a second Lead');}},dispose:async()=>{}})},subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context;
  const host=new RiftHostService(ctx,{home,port:0,leadProvider:'fake',leadModel:'fake',checks:[],chatOrchestration:true});
  const {workspace,roles}=seedWorkspace(host.store);
  host.store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'controlled'}),workspace.id);
  host.store.exec('UPDATE roles SET chat_connection=? WHERE workspace_id=?',JSON.stringify({runtime:'codex',model:'controlled'}),workspace.id);
  host.registerChatRuntime('codex',{async start(input){return{result:execute(input,host),dispose:async()=>{}};}},['controlled']);
  host.chat.initialize();host.orchestration.initialize();
  const conversation=host.chat.createConversation(workspace.id,'Controlled orchestration');
  return{host,workspace,roles,conversation,close:async()=>{await host.close();await rm(home,{recursive:true,force:true});}};
}
const invoke=(input:RuntimeTurnInput,name:string,args:unknown={})=>input.tools.find(tool=>tool.name===name)!.execute(args,input.signal);

describe('short durable Lead turns',()=>{
  it.each(['cancelled','completed','failed'])('rebinds the same live Lead after a %s workflow without releasing its lease',async status=>{
    const model=deferred<RuntimeTurnResult>();let received:RuntimeTurnInput|undefined;
    const f=await fixture(async input=>{received=input;return model.promise;});
    try{
      const turn=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'switch',content:'Switch workflow.'}).turn;
      await until(()=>Boolean(received));
      const old=await invoke(received!,'rift_workflow_start',{goal:'Old workflow',mode:'analysis'}) as {id:string};
      const decision=f.host.store.require<{id:string;toolCalls:number}>('SELECT * FROM coordination_decisions WHERE turn_id=?',turn.id);
      f.host.store.exec('UPDATE workflows SET status=? WHERE id=?',status,old.id);
      const next=await invoke(received!,'rift_workflow_start',{goal:'Replacement workflow',mode:'analysis'}) as {id:string};
      expect(next.id).not.toBe(old.id);
      expect(f.host.orchestration.forTurn(turn)?.workflowId).toBe(next.id);
      expect(f.host.store.require<{id:string;toolCalls:number}>('SELECT * FROM coordination_decisions WHERE turn_id=?',turn.id)).toMatchObject({id:decision.id});
      expect(f.host.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',turn.id)).toBeTruthy();
      expect(f.host.store.get("SELECT id FROM coordination_decisions WHERE workflow_id=? AND status='active'",old.id)).toBeUndefined();
      await invoke(received!,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'replacement',kind:'analysis',title:'Replacement',instructions:'Inspect',expectedPaths:[]}]});
      expect(f.host.store.task('replacement').workflowId).toBe(next.id);
      expect(f.host.store.get("SELECT seq FROM turn_activities WHERE turn_id=? AND type='coordination.rebound'",turn.id)).toBeTruthy();
      model.resolve({text:'Replacement planned.',stopReason:'completed'});
      await until(()=>f.host.chat.turn(f.workspace.id,turn.id).status==='completed');
      expect(f.host.store.require<{status:string}>('SELECT status FROM coordination_decisions WHERE turn_id=?',turn.id).status).toBe('completed');
    }finally{model.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });

  it.each(['handoff_requested','interrupted','released'])('does not transfer a %s decision or release its locks',async state=>{
    const model=deferred<RuntimeTurnResult>();let received:RuntimeTurnInput|undefined;
    const f=await fixture(async input=>{received=input;return model.promise;});
    try{
      const turn=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'invalid-switch',content:'Inspect switching.'}).turn;
      await until(()=>Boolean(received));
      const old=await invoke(received!,'rift_workflow_start',{goal:'Old',mode:'analysis'}) as {id:string};
      f.host.store.exec("UPDATE workflows SET status='cancelled' WHERE id=?",old.id);
      if(state==='released')f.host.store.exec("UPDATE execution_leases SET released_at='test' WHERE owner_id=?",turn.id);
      else f.host.store.exec('UPDATE coordination_decisions SET status=? WHERE turn_id=?',state,turn.id);
      const before=f.host.store.all('SELECT id FROM workflows').length;
      await expect(f.host.createChatWorkflow(turn,{workspaceId:f.workspace.id,goal:'Rejected replacement',mode:'analysis',startLead:false})).rejects.toMatchObject({code:state==='released'?'UNAUTHORIZED':'DECISION_EXPIRED'});
      expect(f.host.store.all('SELECT id FROM workflows')).toHaveLength(before);
      expect(f.host.orchestration.forTurn(turn)?.workflowId).toBe(old.id);
      expect(f.host.store.all("SELECT seq FROM turn_activities WHERE type='coordination.rebound'")).toHaveLength(0);
    }finally{model.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });

  it('ends the dispatch turn while development runs, then consumes a real event trigger and finishes acceptance',async()=>{
    const development=deferred<RuntimeTurnResult>();let leadCalls=0,workflowId='';let firstTools:string[]=[];
    const f=await fixture(async input=>{
      if(input.instructions.includes('You are executing a registered read-only analysis task.'))return development.promise;
      leadCalls++;
      if(leadCalls===1){
        firstTools=input.tools.map(tool=>tool.name);
        const workflow=await invoke(input,'rift_workflow_start',{goal:'Analyze supplied text',mode:'analysis'}) as {id:string};workflowId=workflow.id;
        await invoke(input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'analysis',kind:'analysis',title:'Read text',instructions:'Summarize this text.',expectedPaths:[],roleName:'developer-a'}]});
        const operation=await invoke(input,'rift_task_dispatch',{taskId:'analysis',expectedVersion:0,idempotencyKey:'dispatch'}) as {id:string};
        await invoke(input,'rift_yield',{summary:'Task queued',taskIds:['analysis'],requestIds:[operation.id]});
        return{text:'Task registered; continuation is durable.',stopReason:'completed'};
      }
      const status=await invoke(input,'rift_status') as {tasks:{status:string}[]};
      if(status.tasks.every(task=>task.status==='succeeded'))await invoke(input,'rift_workflow_finish',{summary:'Accepted analysis evidence confirmed.'});
      else await invoke(input,'rift_yield',{summary:'Waiting for current task'});
      return{text:'Verified current evidence.',stopReason:'completed'};
    });
    try{
      const first=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'first',content:'Analyze supplied text.'}).turn;
      await until(()=>f.host.chat.turn(f.workspace.id,first.id).status==='completed');
      expect(firstTools).not.toContain('rift_wait');expect(firstTools).toContain('rift_yield');
      expect(f.host.store.task('analysis').status).toBe('running');
      expect(f.host.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',first.id)).toBeUndefined();
      development.resolve({text:'Text analyzed.',stopReason:'completed'});
      await until(()=>f.host.store.workflow(workflowId).status==='completed');
      await until(()=>f.host.store.all<AgentTurn>("SELECT * FROM agent_turns WHERE status IN ('running','queued')").length===0);
      const turns=f.host.store.all<AgentTurn>('SELECT * FROM agent_turns ORDER BY rowid');
      expect(turns.length).toBeGreaterThan(1);expect(turns[1]!.messageId).toBeNull();expect(turns[1]!.triggerId).toBeTruthy();
      expect(f.host.store.all("SELECT id FROM messages WHERE role='user'")).toHaveLength(1);
      expect(f.host.store.all("SELECT id FROM turn_triggers WHERE status='consumed'").length).toBeGreaterThan(0);
      expect(f.host.store.all('SELECT id FROM coordination_receipts').length).toBeGreaterThan(0);
      expect(f.host.store.all("SELECT id FROM coordination_decisions WHERE status IN ('active','handoff_requested','interrupted')")).toHaveLength(0);
    }finally{development.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });

  it('rejects every write after yield, preserves committed work, and stops the model instead of marking success',async()=>{
    const model=deferred<RuntimeTurnResult>();let received:RuntimeTurnInput|undefined;
    const f=await fixture(async input=>{received=input;return model.promise;});
    try{
      const turn=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'yield',content:'Test handoff.'}).turn;
      await until(()=>Boolean(received));
      const workflow=await invoke(received!,'rift_workflow_start',{goal:'handoff',mode:'analysis'}) as {id:string};
      await invoke(received!,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'planned',kind:'analysis',title:'Task',instructions:'Work',expectedPaths:[]}]});
      await invoke(received!,'rift_yield',{summary:'Handoff',taskIds:['planned']});
      await expect(invoke(received!,'rift_task_dispatch',{taskId:'planned',expectedVersion:0,idempotencyKey:'late'})).rejects.toMatchObject({code:'DECISION_EXPIRED'});
      await until(()=>f.host.chat.turn(f.workspace.id,turn.id).status==='cancelled');
      expect(f.host.store.task('planned')).toBeTruthy();expect(f.host.store.all('SELECT id FROM operations')).toHaveLength(0);
      expect(f.host.orchestration.owner(workflow.id)?.blockedReason).toBe('HANDOFF_PROTOCOL_VIOLATION');
    }finally{model.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });

  it('retains legacy wait for an existing workflow even when new-mode creation is enabled',async()=>{
    const model=deferred<RuntimeTurnResult>();let received:RuntimeTurnInput|undefined;
    const f=await fixture(async input=>{received=input;return model.promise;});
    try{
      const workflow=f.host.coordinator.createWorkflow({workspaceId:f.workspace.id,goal:'Legacy',baseCommit:'',integrationRef:'',repositoryFree:true});
      f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'legacy',content:'Read state.'});await until(()=>Boolean(received));
      expect(received!.tools.map(tool=>tool.name)).toContain('rift_wait');expect(f.host.orchestration.owner(workflow.id)).toBeUndefined();
    }finally{model.resolve({text:'Read state.',stopReason:'completed'});await f.close();}
  });

  it('keeps events pending behind the active Lead and atomically retries outbox projection without duplicate receipts',async()=>{
    const model=deferred<RuntimeTurnResult>();let received:RuntimeTurnInput|undefined;
    const f=await fixture(async input=>{received=input;return model.promise;});
    try{
      const first=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'outbox',content:'Inspect event durability.'}).turn;
      await until(()=>Boolean(received));
      const workflow=await invoke(received!,'rift_workflow_start',{goal:'outbox',mode:'analysis'}) as {id:string};
      const store=f.host.store;
      const before=store.require<{eventSeq:number}>("SELECT event_seq FROM coordination_cursors WHERE consumer='chat'").eventSeq;
      store.event(workflow.id,'task.blocked',{reason:'controlled'});
      store.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON coordination_outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END");
      expect(()=>f.host.orchestration.scan()).toThrow('injected outbox failure');
      expect(store.require<{eventSeq:number}>("SELECT event_seq FROM coordination_cursors WHERE consumer='chat'").eventSeq).toBe(before);
      expect(store.all('SELECT id FROM coordination_outbox')).toHaveLength(0);
      store.db.exec('DROP TRIGGER fail_outbox');
      await f.host.orchestration.pump();
      expect(store.all('SELECT id FROM coordination_receipts')).toHaveLength(1);
      expect(store.all("SELECT id FROM turn_triggers WHERE status='pending' AND turn_id IS NULL")).toHaveLength(1);
      expect(store.all('SELECT id FROM agent_turns')).toHaveLength(1);
      // Simulate a lost projection acknowledgement: the unique event/output key
      // returns the already-visible fact and the already-pending trigger.
      store.exec("UPDATE coordination_outbox SET status='pending'");
      await f.host.orchestration.pump();
      expect(store.all('SELECT id FROM coordination_receipts')).toHaveLength(1);
      expect(store.all('SELECT id FROM turn_triggers')).toHaveLength(1);
      expect(f.host.chat.turn(f.workspace.id,first.id).status).toBe('running');
    }finally{model.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });

  it('records a new recovery while paused but waits for explicit workflow resume before starting a fresh decision',async()=>{
    const model=deferred<RuntimeTurnResult>(),next=deferred<RuntimeTurnResult>();const calls:RuntimeTurnInput[]=[];
    const f=await fixture(async input=>{calls.push(input);return calls.length===1?model.promise:next.promise;});
    try{
      const first=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'paused-recovery',content:'Register work.'}).turn;
      await until(()=>calls.length===1);
      const workflow=await invoke(calls[0]!,'rift_workflow_start',{goal:'recovery',mode:'analysis'}) as {id:string};
      await invoke(calls[0]!,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'recovery',kind:'analysis',title:'Recovery',instructions:'Inspect',expectedPaths:[]}]});
      model.resolve({text:'A business action is needed.',stopReason:'completed'});
      await until(()=>f.host.chat.turn(f.workspace.id,first.id).status==='completed');
      expect(f.host.orchestration.owner(workflow.id)?.blockedReason).toBe('COORDINATION_ACTION_REQUIRED');
      f.host.coordinator.pause(workflow.id);
      f.host.store.event(workflow.id,'cleanup.confirmed',{}, {taskId:'recovery'});
      await f.host.orchestration.pump();
      expect(f.host.orchestration.owner(workflow.id)?.blockedReason).toBeNull();
      expect(calls).toHaveLength(1);
      expect(f.host.store.all("SELECT id FROM turn_triggers WHERE status='pending'")).toHaveLength(1);
      f.host.coordinator.resume(workflow.id);await f.host.orchestration.pump();
      await until(()=>calls.length===2);
      expect(f.host.store.all("SELECT id FROM coordination_decisions WHERE status='active'")).toHaveLength(1);
    }finally{model.resolve({text:'',stopReason:'cancelled'});next.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });

  it('does not use a task cleanup fact to release or resume an interrupted Lead decision',async()=>{
    const model=deferred<RuntimeTurnResult>();const calls:RuntimeTurnInput[]=[];
    const f=await fixture(async input=>{calls.push(input);return model.promise;});
    try{
      const first=f.host.chat.send(f.workspace.id,f.conversation.id,{clientMessageId:'unknown-lead',content:'Inspect recovery.'}).turn;
      await until(()=>calls.length===1);
      const workflow=await invoke(calls[0]!,'rift_workflow_start',{goal:'unknown boundary',mode:'analysis'}) as {id:string};
      await invoke(calls[0]!,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'unknown-task',kind:'analysis',title:'Unknown',instructions:'Inspect',expectedPaths:[]}]});
      model.resolve({text:'Business action needed.',stopReason:'completed'});
      await until(()=>f.host.chat.turn(f.workspace.id,first.id).status==='completed');
      // Fault-inject the persisted state of an interrupted decision. A task's
      // cleanup receipt is no evidence about this distinct Lead runtime.
      f.host.store.exec("UPDATE coordination_decisions SET status='interrupted' WHERE turn_id=?",first.id);
      f.host.store.exec("UPDATE execution_leases SET cleanup_status='unknown',released_at=NULL WHERE owner_type='turn' AND owner_id=?",first.id);
      f.host.store.event(workflow.id,'cleanup.confirmed',{}, {taskId:'unknown-task'});
      await f.host.orchestration.pump();
      expect(f.host.orchestration.owner(workflow.id)?.blockedReason).toBe('COORDINATION_ACTION_REQUIRED');
      expect(calls).toHaveLength(1);
      expect(f.host.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',first.id)).toBeTruthy();
      expect(f.host.store.get("SELECT id FROM coordination_decisions WHERE turn_id=? AND status='interrupted'",first.id)).toBeTruthy();
    }finally{model.resolve({text:'',stopReason:'cancelled'});await f.close();}
  });
});
