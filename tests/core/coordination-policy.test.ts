import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { ChatOrchestration } from '../../src/chat/orchestration.js';
import { coordinationWakes, needsCoordination } from '../../src/chat/coordination-policy.js';
import { seedWorkspace } from '../acceptance/fixtures.js';
import type { AgentTurn } from '../../src/chat/contracts.js';
import type { ActivationBridge, GitService } from '../../src/contracts/index.js';

const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
function fixture(database?:string) {
  const store=new RiftStore(database);cleanups.push(()=>store.close());
  const {workspace,roles}=seedWorkspace(store);
  const coordinator=new TaskCoordinator({store,bridge:{} as ActivationBridge,git:{} as GitService});
  const workflow=coordinator.createWorkflow({workspaceId:workspace.id,goal:'Event policy',integrationRef:'refs/heads/rift/events',baseCommit:'a'.repeat(40)});
  coordinator.submitPlan({workflowId:workflow.id,expectedRevision:0,tasks:[{id:'task',kind:'change',title:'Task',instructions:'Implement task',expectedPaths:[]},{id:'successor',kind:'analysis',title:'Next',instructions:'Follow up',dependsOn:['task']}]});
  store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('conversation',?,'Events','now')",workspace.id);
  store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES(?,?,'conversation',?,'chat','now')",workflow.id,workspace.id,roles.find(role=>role.purpose==='lead')!.id);
  const enqueue=vi.fn(()=>({id:'decision-turn'} as AgentTurn));
  const orchestration=new ChatOrchestration(store,{enqueue,ensureParent:async()=>{},stop(){}});cleanups.push(()=>orchestration.close());
  const event=(type:string)=>{store.event(workflow.id,type,{}, {taskId:'task'});return store.events(workflow.id).at(-1)!;};
  const state=(status:string)=>store.exec('UPDATE tasks SET status=? WHERE id=?',status,'task');
  return {store,workflow,orchestration,enqueue,event,state};
}

describe('durable decision event policy',()=>{
  it('keeps routine source/cleanup facts as receipts without two unnecessary wakes, including replay',async()=>{
    const f=fixture();f.state('integrating');
    const progress=[f.event('source.collected'),f.event('cleanup.confirmed')];
    expect({before:progress.filter(event=>coordinationWakes.has(event.type)).length,after:progress.filter(event=>needsCoordination(f.store,event)).length}).toEqual({before:2,after:0});
    await f.orchestration.pump();expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.store.all('SELECT * FROM coordination_receipts')).toHaveLength(2);
    f.store.exec("UPDATE coordination_cursors SET event_seq=0 WHERE consumer='chat'");
    await f.orchestration.pump();
    expect(f.store.all('SELECT * FROM coordination_receipts')).toHaveLength(2);
    expect(f.store.all("SELECT * FROM coordination_outbox WHERE kind='wake'")).toHaveLength(0);
    expect(f.store.events(f.workflow.id).filter(event=>progress.some(item=>item.eventSeq===event.eventSeq))).toHaveLength(2);
    f.state('succeeded');f.event('integration.accepted');await f.orchestration.pump();
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.store.task('successor').status).toBe('pending');
  });

  it.each(['cleanup.unknown','cleanup.failed','evidence.cleanup_unknown','evidence.waiting','evidence.failed','task.blocked','task.cancel_requested','integration.accepted','task.succeeded','integration.recovered','integration.reconciled'])('retains the decision boundary %s',async type=>{
    const f=fixture();f.state(['integration.accepted','task.succeeded','integration.recovered','integration.reconciled'].includes(type)?'succeeded':type==='task.cancel_requested'?'cancelled':'blocked');
    const event=f.event(type);expect(needsCoordination(f.store,event)).toBe(true);
    await f.orchestration.pump();expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.store.all('SELECT * FROM coordination_receipts')).toHaveLength(1);
  });

  it('retires superseded pending triggers durably but never merges an unknown cleanup decision',async()=>{
    const f=fixture();f.state('blocked');f.event('cleanup.confirmed');
    f.store.exec("UPDATE workflow_conversations SET blocked_reason='COORDINATION_TOOL_BUDGET'");
    await f.orchestration.pump();
    expect(f.store.get<{status:string}>("SELECT status FROM turn_triggers WHERE kind='task_event'")?.status).toBe('pending');
    f.state('integrating');await f.orchestration.pump();
    expect(f.store.get<{status:string}>("SELECT status FROM turn_triggers WHERE kind='task_event'")?.status).toBe('consumed');
    f.event('cleanup.unknown');await f.orchestration.pump();
    expect(f.store.all("SELECT * FROM turn_triggers WHERE status='pending'")).toHaveLength(1);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.orchestration.owner(f.workflow.id)?.blockedReason).toBe('COORDINATION_TOOL_BUDGET');
  });

  it('rechecks progress after asynchronous parent preparation while retaining cancellation',async()=>{
    const f=fixture();f.state('blocked');f.event('cleanup.confirmed');
    f.orchestration.close();
    const orchestration=new ChatOrchestration(f.store,{enqueue:f.enqueue,ensureParent:async()=>{f.state('integrating');},stop(){}});cleanups.push(()=>orchestration.close());
    await orchestration.pump();expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.store.get<{status:string}>("SELECT status FROM turn_triggers WHERE kind='task_event'")?.status).toBe('consumed');
    f.state('cancelled');f.event('task.cancel_requested');await orchestration.pump();expect(f.enqueue).toHaveBeenCalledOnce();
  });

  it('persists coalescing and decision triggers across storage restart without replaying an assigned batch',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'rift-decision-events-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
    const database=join(directory,'rift.db'),f=fixture(database);f.state('integrating');
    f.event('source.collected');f.event('cleanup.confirmed');await f.orchestration.pump();
    f.state('blocked');f.event('cleanup.unknown');f.event('task.blocked');await f.orchestration.pump();
    expect(f.enqueue).toHaveBeenCalledOnce();
    f.orchestration.close();f.store.close();
    // Remove the already closed handles before reopening the real on-disk database.
    cleanups.splice(-2,2);
    const reopened=new RiftStore(database);cleanups.push(()=>reopened.close());
    const enqueue=vi.fn(()=>({id:'must-not-replay'} as AgentTurn));
    const recovered=new ChatOrchestration(reopened,{enqueue,ensureParent:async()=>{},stop(){}});cleanups.push(()=>recovered.close());
    reopened.exec("UPDATE coordination_cursors SET event_seq=0 WHERE consumer='chat'");
    await recovered.pump();expect(enqueue).not.toHaveBeenCalled();
    expect(reopened.all('SELECT * FROM coordination_receipts')).toHaveLength(4);
    expect(reopened.all("SELECT * FROM coordination_outbox WHERE kind='wake'")).toHaveLength(2);
    expect(reopened.all("SELECT * FROM turn_triggers WHERE turn_id='decision-turn'")).toHaveLength(2);
  });
});
