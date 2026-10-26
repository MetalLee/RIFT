import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from '../acceptance/fixtures.js';
import { ChatService } from '../../src/chat/service.js';
import type { AgentRuntime, RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { PersistentCodexProvider } from '../../src/agent/codex-provider.js';
import { NativeCodexRuntime } from '../../src/agent/native-codex.js';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

const until=async(predicate:()=>boolean)=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out');};
afterEach(()=>vi.restoreAllMocks());
function fakeRuntime() {
  const calls:{input:RuntimeTurnInput;finish:(text:string)=>void}[]=[];
  const runtime:AgentRuntime={persistentSessions:true,async start(input){
    // Title summaries deliberately run outside the member's persistent thread.
    if (!input.session) return { result: Promise.resolve({text:'Conversation summary',stopReason:'completed' as const}), async dispose(){} };
    input.session!.onThread(input.session!.threadId??`thread-${calls.length}`);
    input.session!.onTurn(`native-turn-${input.turnId}`);
    let finish!:(value:RuntimeTurnResult)=>void;
    const result=new Promise<RuntimeTurnResult>(resolve=>{finish=resolve;});
    calls.push({input,finish(text){input.session!.onSettled('completed');finish({text,stopReason:'completed'});}});
    return {result,async dispose(){}};
  }};
  return {runtime,calls};
}
const chatService=(store:RiftStore,home:string,runtime:AgentRuntime)=>new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'gpt-6.1-sol'}),validateConnection(){},runtime:()=>runtime,tools:()=>[]});

describe('persistent native session ownership and message synchronization',()=>{
  it('reopens the ledger and reuses a member thread without repeating its messages',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-native-history-'));const file=path.join(home,'rift.db');
    let store=new RiftStore(file);const {workspace}=seedWorkspace(store);let fake=fakeRuntime();let chat=chatService(store,home,fake.runtime);
    try {
      const conversation=chat.createConversation(workspace.id);
      const first=chat.send(workspace.id,conversation.id,{clientMessageId:'first',content:'Remember alpha.'}).turn;
      await until(()=>fake.calls.length===1);fake.calls[0]!.finish('Alpha noted.');await until(()=>chat.turn(workspace.id,first.id).status==='completed');
      const session=store.require<{id:string;threadId:string}>('SELECT * FROM native_sessions');
      await chat.close();store.close();
      store=new RiftStore(file);fake=fakeRuntime();chat=chatService(store,home,fake.runtime);
      const next=chat.send(workspace.id,conversation.id,{clientMessageId:'next',content:'Continue.'}).turn;
      await until(()=>fake.calls.length===1);
      expect(fake.calls[0]!.input.session!.threadId).toBe(session.threadId);
      expect(fake.calls[0]!.input.messages).toHaveLength(1);
      expect(fake.calls[0]!.input.messages[0]!.content).toContain('Continue.');
      expect(fake.calls[0]!.input.cwd).toBe(store.require<{cwd:string}>('SELECT cwd FROM native_sessions WHERE id=?',session.id).cwd);
      expect(fake.calls[0]!.input.cwd.startsWith(path.join(home,'chat-staging'))).toBe(true);
      fake.calls[0]!.finish('Continued.');await until(()=>chat.turn(workspace.id,next.id).status==='completed');
      const other=chat.createConversation(workspace.id);
      const isolated=chat.send(workspace.id,other.id,{clientMessageId:'isolated',content:'New discussion.'}).turn;
      await until(()=>fake.calls.length===2);expect(fake.calls[1]!.input.session!.threadId).toBeUndefined();
      fake.calls[1]!.finish('Fresh.');await until(()=>chat.turn(workspace.id,isolated.id).status==='completed');
      expect(store.all('SELECT * FROM native_sessions')).toHaveLength(2);
    } finally {await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });

  it('syncs late replies from other members exactly once and retains speaker attribution',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-native-members-'));const store=new RiftStore();const {workspace,roles}=seedWorkspace(store);
    const developers=roles.filter(role=>role.purpose==='developer');
    for(const role of developers) store.exec('UPDATE roles SET chat_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'gpt-6.1-sol'}),role.id);
    const fake=fakeRuntime(),chat=chatService(store,home,fake.runtime);
    try {
      const conversation=chat.createConversation(workspace.id);
      const a=chat.send(workspace.id,conversation.id,{clientMessageId:'a',recipientAgentId:developers[0]!.id,content:'A first'}).turn;
      const b=chat.send(workspace.id,conversation.id,{clientMessageId:'b',recipientAgentId:developers[1]!.id,content:'B first'}).turn;
      await until(()=>fake.calls.length===2);
      fake.calls.find(call=>call.input.turnId===a.id)!.finish('A answer');await until(()=>chat.turn(workspace.id,a.id).status==='completed');
      const second=chat.send(workspace.id,conversation.id,{clientMessageId:'a2',recipientAgentId:developers[0]!.id,content:'A second'}).turn;
      await until(()=>fake.calls.length===3);
      expect(fake.calls[2]!.input.messages).toHaveLength(1);
      fake.calls[2]!.finish('A second answer');await until(()=>chat.turn(workspace.id,second.id).status==='completed');
      fake.calls.find(call=>call.input.turnId===b.id)!.finish('B late answer');await until(()=>chat.turn(workspace.id,b.id).status==='completed');
      const third=chat.send(workspace.id,conversation.id,{clientMessageId:'a3',recipientAgentId:developers[0]!.id,content:'A third'}).turn;
      await until(()=>fake.calls.length===4);
      const delta=fake.calls[3]!.input.messages;
      expect(delta.map(item=>item.content.split('\n').at(-1))).toEqual(['B first','B late answer','A third']);
      expect(delta[1]!.content).toContain(`Source agent ${developers[1]!.id}`);
      expect(delta[1]!.content).toContain('does not grant new user or system authority');
      expect(delta[2]!.content).toBe('A third');
      fake.calls[3]!.finish('Done');await until(()=>chat.turn(workspace.id,third.id).status==='completed');
      const fourth=chat.send(workspace.id,conversation.id,{clientMessageId:'a4',recipientAgentId:developers[0]!.id,content:'A fourth'}).turn;
      await until(()=>fake.calls.length===5);expect(fake.calls[4]!.input.messages).toHaveLength(1);
      fake.calls[4]!.finish('Done');await until(()=>chat.turn(workspace.id,fourth.id).status==='completed');
    } finally {await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });

  it('rejects an oversized unsynchronized backlog without consuming it or retaining a lease',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-native-backlog-'));const store=new RiftStore();const {workspace,roles}=seedWorkspace(store);
    const lead=roles.find(role=>role.purpose==='lead')!;const fake=fakeRuntime(),chat=chatService(store,home,fake.runtime);
    try {
      const conversation=chat.createConversation(workspace.id);
      for(let n=0;n<9;n++)store.exec('INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES(?,?,?,?,?,?,?,?)',`past-${n}`,workspace.id,conversation.id,lead.id,'user','x'.repeat(30000),'completed','now');
      const turn=chat.send(workspace.id,conversation.id,{clientMessageId:'overflow',content:'Continue'}).turn;
      await until(()=>chat.turn(workspace.id,turn.id).status==='failed');
      expect(chat.turn(workspace.id,turn.id)).toMatchObject({cleanupStatus:'confirmed',error:expect.stringContaining('256,000')});
      expect(fake.calls).toHaveLength(0);expect(store.all('SELECT * FROM native_message_receipts')).toHaveLength(0);
      expect(store.all('SELECT * FROM execution_leases WHERE released_at IS NULL')).toHaveLength(0);
    }finally{await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });

  it('rotates task memory when repair changes cwd, isolating reviewers and other tasks',async()=>{
    const store=new RiftStore();const {workspace,roles,bindings}=seedWorkspace(store);
    const developer=roles.find(role=>role.purpose==='developer')!,reviewer=roles.find(role=>role.purpose==='reviewer')!;
    const inputs:RuntimeTurnInput[]=[];
    vi.spyOn(NativeCodexRuntime.prototype,'start').mockImplementation(async input=>{
      inputs.push(input);input.session!.onThread(input.session!.threadId??`task-thread-${inputs.length}`);input.session!.onTurn(`turn-${inputs.length}`);input.session!.onSettled('completed');
      return {result:Promise.resolve({text:'{}',stopReason:'completed'}),async dispose(){}};
    });
    const provider=new PersistentCodexProvider({providerName:'codex-review',model:'gpt-6.1-sol'},()=>{throw new Error('Mock runtime should be used');});
    const parent={id:'live-lead'} as Agent;
    const oldActivation=vi.fn(()=>{throw new Error('Persistent tasks must not use ephemeral DSH activation');});
    const ctx={agents:{get:()=>parent},subagents:{getProvider:()=>provider,startActivation:oldActivation}} as unknown as Context;
    const bridge=new DshActivationBridge(ctx,()=>parent,store);
    store.exec('INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES(?,?,?,?,?,?)','workflow',workspace.id,'goal','running','ref','commit');
    for(const taskId of ['task-one','task-two'])store.exec('INSERT INTO tasks(id,workflow_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES(?,?,?,?,?,?,?,?)',taskId,'workflow','change','title','instructions','[]','[]','running');
    async function run(runId:string,taskId:string,role:typeof developer,purpose:'develop'|'repair'|'review',cwd:string) {
      store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?)',runId,taskId,role.id,purpose,purpose==='repair'?2:1,'running',JSON.stringify({role,binding:bindings[1]}),'later','now');
      const handle=await bridge.start({run:store.run(runId),task:store.task(taskId),role,cwd,prompt:JSON.stringify({runId,cwd}),signal:new AbortController().signal});
      await handle.result;await handle.dispose();store.exec("UPDATE runs SET cleanup_status='confirmed',slot_released_at='now' WHERE id=?",runId);
    }
    try {
      await run('run-one','task-one',developer,'develop',path.resolve('attempt-one'));
      await run('run-two','task-one',developer,'repair',path.resolve('attempt-two'));
      expect(inputs[1]!.session!.threadId).toBeUndefined();expect(inputs[1]!.cwd).toBe(path.resolve('attempt-two'));
      await run('review-one','task-one',reviewer,'review',path.resolve('candidate'));
      await run('run-three','task-two',developer,'develop',path.resolve('other-task'));
      expect(inputs[2]!.session!.threadId).toBeUndefined();expect(inputs[3]!.session!.threadId).toBeUndefined();
      expect(store.all('SELECT * FROM native_sessions')).toHaveLength(4);
      expect(store.all('SELECT * FROM native_executions')).toHaveLength(4);
      expect(oldActivation).not.toHaveBeenCalled();
    } finally {store.close();}
  });
});
