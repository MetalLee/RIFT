import { describe, expect, it } from 'vitest';
import { RiftStore } from '../../src/storage/database.js';
import { readWorkspaceEvents } from '../../src/events/workspace-events.js';
import { ChatService } from '../../src/chat/service.js';
import { seedWorkspace } from './fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import type { AgentTurn } from '../../src/chat/contracts.js';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
const until=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Acceptance condition did not settle');};

const watermark = (store: RiftStore) => store.require<{seq:number}>('SELECT COALESCE(MAX(seq),0) AS seq FROM workspace_events').seq;
const appendEvent = (store: RiftStore, workspaceId: string, entityId: string) => {
  store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at) VALUES(?,'review.receipt',?,'{}',?)",workspaceId,entityId,new Date().toISOString());
};

describe('Independent C1 acceptance: durable browser delivery', () => {
  it('delivers every receipt across three pages despite interleaved foreign workspace events', () => {
    const store = new RiftStore();
    try {
      const a = seedWorkspace(store,'review-events-a').workspace;
      const b = seedWorkspace(store,'review-events-b').workspace;
      let after = watermark(store);
      store.transaction(() => {
        for (let i=0;i<205;i++) {
          appendEvent(store,a.id,`receipt-${i}`);
          appendEvent(store,b.id,`foreign-${i}`);
        }
      });
      const seen:string[] = [];
      let pageCount = 0;
      do {
        const page = readWorkspaceEvents(store,a.id,after);
        expect(page.resyncRequired).toBe(false);
        expect(page.events.every(event => event.workspaceId===a.id && event.seq>after)).toBe(true);
        if (page.hasMore) expect(page.nextAfter).toBe(page.events.at(-1)!.seq);
        else expect(page.nextAfter).toBe(page.highWatermark);
        expect(page.cursor).toBe(page.nextAfter);
        seen.push(...page.events.map(event=>event.entityId));
        after=page.nextAfter; pageCount++;
        if (!page.hasMore) break;
        expect(pageCount).toBeLessThan(4);
      } while (true);
      expect(pageCount).toBe(3);
      expect(seen).toEqual(Array.from({length:205},(_,i)=>`receipt-${i}`));
      appendEvent(store,b.id,'foreign-tail');
      const empty=readWorkspaceEvents(store,a.id,after);
      expect(empty.events).toEqual([]);
      expect(empty.nextAfter).toBe(watermark(store));
      appendEvent(store,a.id,'late-receipt');
      expect(readWorkspaceEvents(store,a.id,empty.nextAfter).events.map(event=>event.entityId)).toEqual(['late-receipt']);
    } finally { store.close(); }
  });

  it('requires a snapshot beyond retention and delivers events arriving after the snapshot boundary', () => {
    const store=new RiftStore();
    try {
      const {workspace}=seedWorkspace(store,'review-events-retention');
      const chat=new ChatService({store,home:process.cwd(),defaultConnection:()=>({runtime:'codex',model:'unused'}),validateConnection(){},runtime(){throw new Error('No runtime should start');},tools:()=>[]});
      const conversation=chat.createConversation(workspace.id,'Retention review');
      const old=watermark(store);
      store.transaction(()=>{for(let i=0;i<10005;i++)appendEvent(store,workspace.id,`retained-${i}`);});
      const stale=readWorkspaceEvents(store,workspace.id,old);
      expect(stale).toMatchObject({resyncRequired:true,events:[],nextAfter:old});
      const snapshot=chat.page(workspace.id,conversation.id);
      expect(snapshot.snapshotCursor).toBe(stale.highWatermark);
      appendEvent(store,workspace.id,'after-snapshot');
      expect(readWorkspaceEvents(store,workspace.id,snapshot.snapshotCursor).events.map(event=>event.entityId)).toEqual(['after-snapshot']);
    } finally {store.close();}
  });
});

describe('Independent C1 acceptance: factual activities and cleanup',()=>{
  it('publishes a committed tool receipt before model completion while buffering secrets and retaining the cleanup lease',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-c1-review-'));
    const store=new RiftStore(); const {workspace}=seedWorkspace(store,'review-activities');
    const model=deferred<RuntimeTurnResult>(),cleanup=deferred<void>(),receipt=deferred<unknown>();
    let input:RuntimeTurnInput|undefined;
    const secret='sk-c1-review-credential-not-for-public-output';
    const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY=secret;
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'controlled'}),validateConnection(){},runtime:()=>({async start(value){input=value;return{result:model.promise,dispose:()=>cleanup.promise};}}),tools:()=>[
      {name:'rift_task_dispatch',description:'Controlled receipt',inputSchema:{},execute:()=>receipt.promise},
      {name:'rift_review_failure',description:'Controlled failure',inputSchema:{},async execute(){throw new Error(secret);}},
    ]});
    try{
      const conversation=chat.createConversation(workspace.id,'Activity acceptance');
      const turn=chat.send(workspace.id,conversation.id,{clientMessageId:'activities',content:'Run the controlled review'}).turn;
      await until(()=>Boolean(input));
      input!.onText?.(`Credential ${secret.slice(0,15)}`); input!.onText?.(secret.slice(15));
      expect(store.all<{text:string}>('SELECT * FROM message_chunks').map(chunk=>chunk.text).join('')).toBe('Credential ');
      const pending=input!.tools[0]!.execute({credential:secret},input!.signal);
      expect(chat.turn(workspace.id,turn.id)).toMatchObject({status:'running',phase:'tool',currentToolName:'rift_task_dispatch'});
      expect(JSON.stringify(chat.turn(workspace.id,turn.id).activities)).not.toContain(secret);
      receipt.resolve({workflowId:'workflow-review',taskId:'task-review',requestId:'request-review',privateDetails:secret});
      await pending;
      const visible=chat.turn(workspace.id,turn.id);
      expect(visible.status).toBe('running');
      expect(visible.activities?.find(activity=>activity.type==='tool.completed')?.payload).toEqual({workflowId:'workflow-review',taskId:'task-review',requestId:'request-review'});
      expect(readWorkspaceEvents(store,workspace.id,0).events.some(event=>event.type==='turn.activity')).toBe(true);
      await expect(input!.tools[1]!.execute({credential:secret},input!.signal)).rejects.toThrow(secret);
      expect(JSON.stringify(chat.turn(workspace.id,turn.id).activities)).not.toContain(secret);
      model.resolve({text:`Credential ${secret}`,stopReason:'completed'});
      await until(()=>chat.turn(workspace.id,turn.id).phase==='cleanup');
      expect(chat.turn(workspace.id,turn.id)).toMatchObject({status:'running',cleanupStatus:'pending',modelEndedAt:expect.any(String),cleanupStartedAt:expect.any(String)});
      expect(store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',turn.id)).toBeTruthy();
      cleanup.resolve();
      await until(()=>chat.turn(workspace.id,turn.id).status==='completed');
      const final=chat.page(workspace.id,conversation.id);
      expect(JSON.stringify(final)).not.toContain(secret);
      expect(final.messages.find(message=>message.role==='assistant')?.content).toContain('[REDACTED]');
      expect(final.turns.find(item=>item.id===turn.id)).toMatchObject({phase:'settled',cleanupStatus:'confirmed'});
      expect(store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',turn.id)).toBeUndefined();
    }finally{
      model.resolve({text:'',stopReason:'cancelled'});cleanup.resolve();await chat.close();store.close();
      if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;
      await rm(home,{recursive:true,force:true});
    }
  });

  it('does not regress a settled cancellation phase when a noncooperating tool returns late',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-c1-late-review-'));const store=new RiftStore();
    const {workspace}=seedWorkspace(store,'review-late-activity');
    const receipt=deferred<unknown>();let input:RuntimeTurnInput|undefined;
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'controlled'}),validateConnection(){},runtime:()=>({async start(value){input=value;return{result:new Promise<RuntimeTurnResult>(()=>{}),async dispose(){}};}}),tools:()=>[{name:'rift_status',description:'Controlled delayed read',inputSchema:{},execute:()=>receipt.promise}]});
    try{
      const conversation=chat.createConversation(workspace.id,'Late activity');
      const turn=chat.send(workspace.id,conversation.id,{clientMessageId:'late',content:'Read state'}).turn;
      await until(()=>Boolean(input));
      const pending=input!.tools[0]!.execute({},input!.signal);
      chat.stop(workspace.id,turn.id);
      await until(()=>chat.turn(workspace.id,turn.id).status==='cancelled');
      receipt.resolve({});await pending;
      expect(chat.turn(workspace.id,turn.id)).toMatchObject({status:'cancelled',cleanupStatus:'confirmed',phase:'settled'});
    }finally{receipt.resolve({});await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });
});

describe('Independent C1 acceptance: existing history upgrade',()=>{
  it('preserves reply, chunk, native receipt and active turn references when upgrading the pre-orchestration schema',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-c1-upgrade-review-')),file=path.join(home,'rift.db');
    const legacy=new DatabaseSync(file);
    try{
      legacy.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
      for(const migration of (await readdir('migrations')).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&Number(name.slice(0,4))<=11).sort())legacy.exec(await readFile(path.join('migrations',migration),'utf8'));
      legacy.exec(`
        INSERT INTO workspaces(id,name,root_path) VALUES('upgrade-workspace','Upgrade','review');
        INSERT INTO roles(id,workspace_id,name,kind,prompt,revision,purpose) VALUES('upgrade-lead','upgrade-workspace','lead','dsh-lead','Plan',1,'lead');
        INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('upgrade-conversation','upgrade-workspace','Historical conversation','2026-10-25T00:00:00Z');
        INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES('upgrade-input','upgrade-workspace','upgrade-conversation','upgrade-lead','user','Preserve this history','running','2026-10-25T00:00:00Z');
        INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at,reply_to_message_id) VALUES('upgrade-reply','upgrade-workspace','upgrade-conversation','upgrade-lead','assistant','Historical reply','completed','2026-10-25T00:00:01Z','upgrade-input');
        INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('upgrade-turn','upgrade-workspace','upgrade-conversation','upgrade-input','upgrade-lead','running','{}','2026-10-25T00:00:00Z');
        INSERT INTO message_chunks(turn_id,text,created_at) VALUES('upgrade-turn','Historical reply','2026-10-25T00:00:01Z');
        INSERT INTO native_sessions(id,workspace_id,scope,scope_id,agent_id,configuration_key,thread_id,runtime_home,cwd,created_at) VALUES('upgrade-session','upgrade-workspace','chat','upgrade-conversation','upgrade-lead','configuration','native-thread','runtime-home','cwd','2026-10-25T00:00:00Z');
        INSERT INTO native_message_receipts(session_id,message_id,message_version) VALUES('upgrade-session','upgrade-reply',0);
        INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('upgrade-lease','turn','upgrade-turn','upgrade-workspace','upgrade-lead','lead','2026-10-25T00:00:00Z');
      `);
    }finally{legacy.close();}
    try{
      const store=new RiftStore(file);
      try{
        expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
        expect(store.require('SELECT reply_to_message_id FROM messages WHERE id=?','upgrade-reply')).toEqual({replyToMessageId:'upgrade-input'});
        expect(store.require('SELECT turn_id,text FROM message_chunks')).toEqual({turnId:'upgrade-turn',text:'Historical reply'});
        expect(store.require('SELECT message_id FROM native_message_receipts')).toEqual({messageId:'upgrade-reply'});
        expect(store.require('SELECT message_id,trigger_id,status,phase FROM agent_turns')).toEqual({messageId:'upgrade-input',triggerId:null,status:'running',phase:'generating'});
        expect(store.require('SELECT released_at FROM execution_leases')).toEqual({releasedAt:null});
      }finally{store.close();}
    }finally{await rm(home,{recursive:true,force:true});}
  });
});

async function controlledHost() {
  const home=await mkdtemp(path.join(tmpdir(),'rift-c1-host-review-'));
  const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[],chatOrchestration:true});
  const calls:{input:RuntimeTurnInput;finish:(value:RuntimeTurnResult)=>void}[]=[];
  host.registerChatRuntime('codex',{async start(input){const result=deferred<RuntimeTurnResult>();calls.push({input,finish:result.resolve});return{result:result.promise,async dispose(){}};}},['review-model']);
  await host.initialize();
  const workspace=await host.handleBrowser('POST','/ui-api/v1/workspaces',{name:'Review workspace',leadConnection:{runtime:'codex',model:'review-model'}},'review-workspace') as {id:string};
  const developer=await host.handleBrowser('POST',`/ui-api/v1/workspaces/${workspace.id}/agents`,{displayName:'Reviewer analyst',name:'analyst',purpose:'developer',prompt:'Analyze supplied text',chatConnection:{runtime:'codex',model:'review-model'}},'review-developer') as {id:string};
  const conversation=host.chat.createConversation(workspace.id,'Independent orchestration acceptance');
  return {host,home,workspace,developer,conversation,calls};
}
const invoke=async<T=unknown>(input:RuntimeTurnInput,name:string,args:unknown)=>input.tools.find(tool=>tool.name===name)!.execute(args,input.signal) as Promise<T>;

describe('Independent C1 acceptance: Host orchestration boundaries',()=>{
  it('finishes the initial turn while development continues, then resumes from real task events to acceptance without a synthetic user message',async()=>{
    const {host,home,workspace,conversation,calls}=await controlledHost();
    try{
      const initial=host.chat.send(workspace.id,conversation.id,{clientMessageId:'initial-review',content:'Analyze the supplied text and report the result'}).turn;
      await until(()=>calls.length===1);const first=calls[0]!;
      expect(first.input.tools.map(tool=>tool.name)).not.toContain('rift_wait');
      const workflow=await invoke<{id:string}>(first.input,'rift_workflow_start',{goal:'Review supplied text',mode:'analysis'});
      await invoke(first.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'review-analysis',kind:'analysis',title:'Review text',instructions:'Compare alpha with beta',expectedPaths:[],roleName:'analyst'}]});
      const dispatch=await invoke<{id:string}>(first.input,'rift_task_dispatch',{taskId:'review-analysis',expectedVersion:0,idempotencyKey:'review-dispatch'});
      await until(()=>calls.some(call=>call.input.instructions.startsWith('You are executing a registered text-only')));
      const development=calls.find(call=>call.input.instructions.startsWith('You are executing a registered text-only'))!;
      await invoke(first.input,'rift_yield',{summary:'Task is dispatched',taskIds:['review-analysis'],requestIds:[dispatch.id]});
      expect(host.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',initial.id)).toBeTruthy();
      first.finish({text:'Task dispatched; results will follow.',stopReason:'completed'});
      await until(()=>host.chat.turn(workspace.id,initial.id).status==='completed');
      expect(host.store.task('review-analysis').status).toBe('running');
      expect(host.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',initial.id)).toBeUndefined();
      development.finish({text:'Alpha and beta have different requirements.',stopReason:'completed'});
      await until(()=>calls.filter(call=>call.input.agentId===first.input.agentId).length===2);
      const resumed=calls.filter(call=>call.input.agentId===first.input.agentId)[1]!;
      const resumedTurn=host.chat.turn(workspace.id,resumed.input.turnId);
      expect(resumedTurn.messageId).toBeNull();expect(resumedTurn.triggerId).toBeTruthy();
      expect(resumed.input.instructions).toContain('Host event trigger');
      expect(host.store.all("SELECT id FROM messages WHERE conversation_id=? AND role='user' AND kind='chat'",conversation.id)).toHaveLength(1);
      await invoke(resumed.input,'rift_status',{});
      await invoke(resumed.input,'rift_workflow_finish',{summary:'Analysis acceptance confirmed from the recorded successful run.'});
      resumed.finish({text:'The registered analysis passed.',stopReason:'completed'});
      await until(()=>host.chat.turn(workspace.id,resumed.input.turnId).status==='completed');
      expect(host.store.workflow(workflow.id).status).toBe('completed');
      await host.orchestration.pump();
      const receipts=host.chat.page(workspace.id,conversation.id).receipts??[];
      expect(receipts.some(receipt=>receipt.payload.type==='task.succeeded')).toBe(true);
      expect(new Set(receipts.map(receipt=>receipt.eventSeq)).size).toBe(receipts.length);
      expect(host.store.all("SELECT id FROM execution_leases WHERE workspace_id=? AND capacity='lead' AND released_at IS NULL",workspace.id)).toEqual([]);
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });

  it('rejects foreign tasks and a member bypass of the chat owner, and rejects stale tools after cancellation',async()=>{
    const {host,home,workspace,developer,conversation,calls}=await controlledHost();
    try{
      const initial=host.chat.send(workspace.id,conversation.id,{clientMessageId:'owner',content:'Coordinate this workflow'}).turn;
      await until(()=>calls.length===1);const lead=calls[0]!;
      await invoke(lead.input,'rift_workflow_start',{goal:'Owned analysis',mode:'analysis'});
      const foreign=seedWorkspace(host.store,'review-foreign');
      const other=host.coordinator.createWorkflow({workspaceId:foreign.workspace.id,goal:'Foreign',repositoryFree:true,baseCommit:'',integrationRef:''});
      host.coordinator.submitPlan({workflowId:other.id,expectedRevision:0,tasks:[{id:'foreign-review-task',kind:'analysis',title:'Foreign task',instructions:'Foreign data',expectedPaths:[]}]});
      await expect(invoke(lead.input,'rift_task_dispatch',{taskId:'foreign-review-task',expectedVersion:0,idempotencyKey:'foreign-dispatch'})).rejects.toMatchObject({code:'CROSS_WORKFLOW'});
      host.chat.send(workspace.id,conversation.id,{clientMessageId:'member-bypass',recipientAgentId:developer.id,content:'Please register an independent task'});
      await until(()=>calls.length===2);const member=calls.find(call=>call.input.agentId===developer.id)!;
      await expect(invoke(member.input,'rift_task_request',{goal:'Bypass owner',kind:'analysis',title:'Unauthorized task',instructions:'Attempt to modify owned workflow',expectedPaths:[]})).rejects.toMatchObject({code:'COORDINATION_OWNED'});
      await invoke(lead.input,'rift_yield',{summary:'Await further coordination'});
      await expect(invoke(lead.input,'rift_plan_submit',{expectedRevision:0,tasks:[]})).rejects.toMatchObject({code:'DECISION_EXPIRED'});
      host.chat.stop(workspace.id,initial.id);await until(()=>host.chat.turn(workspace.id,initial.id).status==='cancelled');
      await expect(invoke(lead.input,'rift_plan_submit',{expectedRevision:0,tasks:[]})).rejects.toThrow();
      expect(host.store.get('SELECT id FROM tasks WHERE title=?','Unauthorized task')).toBeUndefined();
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });

  it('coalesces concurrent CLI wakes behind the current Lead and retains unknown claimed triggers across a Host restart',async()=>{
    const {host,home,workspace,conversation,calls}=await controlledHost();
    const recoveredHome=await mkdtemp(path.join(tmpdir(),'rift-c1-restart-review-'));
    let recovered:RiftHostService|undefined;let originalClosed=false;
    try{
      const initial=host.chat.send(workspace.id,conversation.id,{clientMessageId:'restart-owner',content:'Coordinate restart acceptance'}).turn;
      await until(()=>calls.length===1);const first=calls[0]!;
      const workflow=await invoke<{id:string}>(first.input,'rift_workflow_start',{goal:'Restart boundary',mode:'analysis'});
      await invoke(first.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'restart-pending-task',kind:'analysis',title:'Pending analysis',instructions:'Keep registered work pending',expectedPaths:[]}]});
      await Promise.all([host.startLead(workflow.id,'First explicit wake'),host.startLead(workflow.id,'Second explicit wake')]);
      expect(calls).toHaveLength(1);
      expect(host.store.all("SELECT id FROM execution_leases WHERE workspace_id=? AND capacity='lead' AND released_at IS NULL",workspace.id)).toHaveLength(1);
      expect(host.store.all("SELECT id FROM turn_triggers WHERE status='pending'")).toHaveLength(2);
      first.finish({text:'Awaiting the queued coordination batch.',stopReason:'completed'});
      await until(()=>calls.length===2);
      const executing=calls[1]!;
      const active=host.chat.turn(workspace.id,executing.input.turnId);
      expect(active.triggerId).toBeTruthy();expect(active.messageId).toBeNull();
      expect(host.store.all("SELECT id FROM turn_triggers WHERE status='claimed' AND turn_id=?",active.id)).toHaveLength(2);
      await invoke(executing.input,'rift_status',{});
      await backup(host.store.db,path.join(recoveredHome,'rift.db'));
      await host.close();originalClosed=true;
      let restartedCalls=0;
      recovered=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home:recoveredHome,port:0,leadProvider:'unused',leadModel:'unused',checks:[],chatOrchestration:true});
      recovered.registerChatRuntime('codex',{async start(){restartedCalls++;return{result:Promise.resolve({text:'Must not replay',stopReason:'completed' as const}),async dispose(){}};}},['review-model']);
      await recovered.initialize();
      const interrupted=recovered.chat.turn(workspace.id,active.id);
      expect(interrupted).toMatchObject({status:'interrupted',cleanupStatus:'unknown'});
      expect(recovered.store.all("SELECT id FROM turn_triggers WHERE status='interrupted' AND turn_id=?",active.id)).toHaveLength(2);
      expect(recovered.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',active.id)).toBeTruthy();
      expect(()=>recovered!.chat.reconcile(workspace.id,active.id,interrupted.version)).toThrow('Cleanup is not verified');
      const current=recovered.store.workflow(workflow.id);
      recovered.coordinator.resume(workflow.id,current.version);
      await recovered.startLead(workflow.id,'Do not bypass unknown execution');
      recovered.chat.send(workspace.id,conversation.id,{clientMessageId:'queued-after-restart',content:'What is the recovery status?'});
      await recovered.orchestration.pump();recovered.chat.pump();
      expect(restartedCalls).toBe(0);
      expect(recovered.store.task('restart-pending-task').status).toBe('pending');
      expect(recovered.chat.page(workspace.id,conversation.id).receipts?.some(receipt=>receipt.payload.type==='coordination.blocked')).toBe(true);
      expect(recovered.store.all("SELECT id FROM coordination_decisions WHERE status='interrupted'")).toHaveLength(1);
    }finally{
      if(!originalClosed)await host.close();await recovered?.close();
      await rm(home,{recursive:true,force:true});await rm(recoveredHome,{recursive:true,force:true});
    }
  });

  it('stops repeated no-progress tool reads and persists the budget reason even before a workflow exists',async()=>{
    const {host,home,workspace,conversation,calls}=await controlledHost();
    try{
      const turn=host.chat.send(workspace.id,conversation.id,{clientMessageId:'budget-owner',content:'Inspect bounded coordination'}).turn;
      await until(()=>calls.length===1);
      for(let i=0;i<12;i++)await invoke(calls[0]!.input,'rift_status',{});
      await expect(invoke(calls[0]!.input,'rift_status',{})).rejects.toMatchObject({code:'COORDINATION_TOOL_BUDGET'});
      await until(()=>host.chat.turn(workspace.id,turn.id).status==='cancelled');
      expect(host.chat.turn(workspace.id,turn.id).activities?.find(activity=>activity.type==='coordination.limit')?.payload).toEqual({reason:'COORDINATION_TOOL_BUDGET'});
      expect(host.store.all('SELECT id FROM workflows')).toEqual([]);
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });

  it('does not strand a necessary wake behind more than one scan page when the initial turn settles',async()=>{
    const {host,home,workspace,conversation,calls}=await controlledHost();
    try{
      const first=host.chat.send(workspace.id,conversation.id,{clientMessageId:'scan-backlog-owner',content:'Coordinate the durable backlog'}).turn;
      await until(()=>calls.length===1);
      const workflow=await invoke<{id:string}>(calls[0]!.input,'rift_workflow_start',{goal:'Backlog',mode:'analysis'});
      await invoke(calls[0]!.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'backlog-task',kind:'analysis',title:'Await recovery',instructions:'Investigate blocker',expectedPaths:[]}]});
      host.store.transaction(()=>{
        for(let i=0;i<110;i++)host.store.event(workflow.id,'review.unrelated',{index:i});
        host.store.exec("UPDATE tasks SET status='blocked',blocking_reason='CONTROLLED_BLOCKER',version=version+1 WHERE id='backlog-task'");
        host.store.event(workflow.id,'task.blocked',{reason:'CONTROLLED_BLOCKER'},{taskId:'backlog-task'});
      });
      calls[0]!.finish({text:'Continue from the recorded task result.',stopReason:'completed'});
      await until(()=>host.chat.turn(workspace.id,first.id).status==='completed');
      await until(()=>calls.length===2);
      expect(host.orchestration.owner(workflow.id)?.blockedReason).toBeNull();
      expect(host.chat.turn(workspace.id,calls[1]!.input.turnId).triggerId).toBeTruthy();
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });

  it('resumes after a new cleanup recovery fact without clearing unknown Lead or budget blockers',async()=>{
    const {host,home,workspace,conversation,calls}=await controlledHost();
    try{
      host.chat.send(workspace.id,conversation.id,{clientMessageId:'recovery-owner',content:'Coordinate cleanup recovery'});
      await until(()=>calls.length===1);
      const workflow=await invoke<{id:string}>(calls[0]!.input,'rift_workflow_start',{goal:'Recover a task cleanup blocker',mode:'analysis'});
      await invoke(calls[0]!.input,'rift_plan_submit',{expectedRevision:0,tasks:[{id:'recovery-task',kind:'analysis',title:'Recover analysis',instructions:'Continue after cleanup is confirmed',expectedPaths:[]}]});
      host.store.transaction(()=>{
        host.store.exec("UPDATE tasks SET status='blocked',blocking_reason='CLEANUP_UNKNOWN',version=version+1 WHERE id='recovery-task'");
        host.store.event(workflow.id,'cleanup.unknown',{}, {taskId:'recovery-task'});
      });
      calls[0]!.finish({text:'The task result needs coordination.',stopReason:'completed'});
      await until(()=>calls.length===2);
      calls[1]!.finish({text:'Task cleanup is unconfirmed. The workflow is explicitly blocked.',stopReason:'completed'});
      await until(()=>host.orchestration.owner(workflow.id)?.blockedReason==='COORDINATION_ACTION_REQUIRED');
      const blockedAt=host.store.require<{seq:number}>("SELECT MAX(event_seq) AS seq FROM task_events WHERE workflow_id=? AND type='coordination.blocked'",workflow.id).seq;
      host.store.event(workflow.id,'cleanup.confirmed',{}, {taskId:'recovery-task'});
      expect(host.store.require<{seq:number}>('SELECT MAX(event_seq) AS seq FROM task_events').seq).toBeGreaterThan(blockedAt);
      await host.orchestration.pump();
      await until(()=>calls.length===3);
      expect(host.orchestration.owner(workflow.id)?.blockedReason).toBeNull();
      calls[2]!.finish({text:'Recovery is now available; inspect the task before retrying.',stopReason:'completed'});
      await until(()=>host.orchestration.owner(workflow.id)?.blockedReason==='COORDINATION_ACTION_REQUIRED');
      for(const reason of ['COORDINATION_CLEANUP_UNKNOWN','COORDINATION_TOOL_BUDGET','HANDOFF_PROTOCOL_VIOLATION','COORDINATION_TURN_FAILED']){
        host.store.exec('UPDATE workflow_conversations SET blocked_reason=? WHERE workflow_id=?',reason,workflow.id);
        host.store.event(workflow.id,'cleanup.confirmed',{}, {taskId:'recovery-task'});
        await host.orchestration.pump();host.chat.pump();
        expect(host.orchestration.owner(workflow.id)?.blockedReason).toBe(reason);
        expect(calls).toHaveLength(3);
      }
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });
});

describe('Independent C1 acceptance: native event context',()=>{
  it('delivers an event reply to another member once while preserving the Lead thread and its own reply receipts',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-c1-event-context-'));const store=new RiftStore();
    const {workspace,roles}=seedWorkspace(store,'review-event-context');
    const lead=roles.find(role=>role.purpose==='lead')!,developer=roles.find(role=>role.purpose==='developer')!;
    store.exec('UPDATE roles SET chat_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'controlled'}),developer.id);
    const calls:{input:RuntimeTurnInput;finish:(text:string)=>void}[]=[];
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'controlled'}),validateConnection(){},tools:()=>[],runtime:()=>({persistentSessions:true,async start(input){
      input.session!.onThread(input.session!.threadId??`thread-${input.agentId}`);input.session!.onTurn(`native-${input.turnId}`);
      const model=deferred<RuntimeTurnResult>();calls.push({input,finish(text){input.session!.onSettled('completed');model.resolve({text,stopReason:'completed'});}});
      return{result:model.promise,async dispose(){}};
    }})});
    try{
      const conversation=chat.createConversation(workspace.id,'Event context');
      const initial=chat.send(workspace.id,conversation.id,{clientMessageId:'context-first',content:'Initial user goal'}).turn;
      await until(()=>calls.length===1);calls[0]!.finish('Lead initial reply');await until(()=>chat.turn(workspace.id,initial.id).status==='completed');
      store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('context-workflow',?,'Context','running','','')",workspace.id);
      store.exec("INSERT INTO turn_triggers(id,workflow_id,workspace_id,conversation_id,agent_id,kind,dedupe_key,payload,created_at) VALUES('context-trigger','context-workflow',?,?,?,'task_event','context-trigger','{}',?)",workspace.id,conversation.id,lead.id,new Date().toISOString());
      const event=chat.enqueueTrigger(workspace.id,conversation.id,'context-trigger','Recorded task result');
      await until(()=>calls.length===2);
      expect(calls[1]!.input.session!.threadId).toBe(`thread-${lead.id}`);
      expect(calls[1]!.input.messages).toHaveLength(1);
      expect(calls[1]!.input.messages[0]!.content).toContain('Host trigger context-trigger');
      expect(calls[1]!.input.messages[0]!.content).toContain('not a new user instruction');
      calls[1]!.finish('Event-driven acceptance reply');await until(()=>chat.turn(workspace.id,event.id).status==='completed');
      const member=chat.send(workspace.id,conversation.id,{clientMessageId:'context-member',recipientAgentId:developer.id,content:'Review the shared result'}).turn;
      await until(()=>calls.length===3);
      const memberContext=calls[2]!.input.messages.map(message=>message.content);
      expect(memberContext.filter(message=>message.includes('Event-driven acceptance reply'))).toEqual([expect.stringContaining(`Source agent ${lead.id}`)]);
      calls[2]!.finish('Member has read the event result');await until(()=>chat.turn(workspace.id,member.id).status==='completed');
      const memberAgain=chat.send(workspace.id,conversation.id,{clientMessageId:'context-member-next',recipientAgentId:developer.id,content:'Continue member discussion'}).turn;
      await until(()=>calls.length===4);expect(calls[3]!.input.messages.map(message=>message.content)).toEqual(['Continue member discussion']);
      calls[3]!.finish('Member continued');await until(()=>chat.turn(workspace.id,memberAgain.id).status==='completed');
      const leadAgain=chat.send(workspace.id,conversation.id,{clientMessageId:'context-lead-next',content:'Continue Lead discussion'}).turn;
      await until(()=>calls.length===5);
      expect(calls[4]!.input.session!.threadId).toBe(`thread-${lead.id}`);
      expect(calls[4]!.input.messages.some(message=>message.content.includes('Event-driven acceptance reply'))).toBe(false);
      expect(calls[4]!.input.messages.some(message=>message.content.includes('Member has read the event result'))).toBe(true);
      calls[4]!.finish('Lead continued');await until(()=>chat.turn(workspace.id,leadAgain.id).status==='completed');
    }finally{await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });
});
