import { afterEach,describe,expect,it,vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from './fixtures.js';
import { CollaborationService } from '../../src/chat/collaboration.js';
import type { TaskCoordinator } from '../../src/task/coordinator.js';
import { PersistentCodexProvider } from '../../src/agent/codex-provider.js';
import { NativeCodexRuntime } from '../../src/agent/native-codex.js';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import type { RuntimeTurnInput } from '../../src/agent/runtime-types.js';
import type { ActivationBridge } from '../../src/contracts/index.js';

afterEach(()=>vi.restoreAllMocks());
function fixture(){
  const store=new RiftStore(),{workspace,roles,bindings}=seedWorkspace(store);
  const developer=roles.find(role=>role.purpose==='developer')!,lead=roles.find(role=>role.purpose==='lead')!;
  store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('conversation',?,'Run messaging','now')",workspace.id);
  store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Goal','running','ref','head')",workspace.id);
  store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('task','workflow',?,'change','Task','Task','[]','[]','running')",developer.id);
  const collaboration=new CollaborationService(store,{} as TaskCoordinator,{enqueueMessage(){throw new Error('Progress must not create a discussion');}});
  const run=(runId:string,purpose:'develop'|'repair'='develop')=>{
    store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?)',runId,'task',developer.id,purpose,purpose==='repair'?2:1,'running',JSON.stringify({role:developer,binding:bindings[1]}),'later','now');
    const run=store.run(runId);return{run,task:store.task('task'),role:developer,cwd:process.cwd(),prompt:JSON.stringify({runId}),signal:new AbortController().signal,tools:collaboration.runTools(run)} satisfies Parameters<ActivationBridge['start']>[0];
  };
  return{store,workspace,developer,lead,collaboration,run};
}

describe('Run collaboration runtime boundaries',()=>{
  it('resumes the task thread with fresh Codex closures and rejects the old Run tool after cleanup',async()=>{
    const f=fixture();const inputs:RuntimeTurnInput[]=[];
    vi.spyOn(NativeCodexRuntime.prototype,'start').mockImplementation(async input=>{
      inputs.push(input);input.session!.onThread(input.session!.threadId??'task-thread');input.session!.onTurn(`native-${input.turnId}`);
      return{result:Promise.resolve({text:'{}',stopReason:'completed'}),async dispose(){}};
    });
    const provider=new PersistentCodexProvider({providerName:'codex-review',model:'gpt-6.1-sol'},()=>{throw new Error('Controlled runtime expected');});
    try{
      const first=await provider.startTask(f.store,f.run('first'));await first.result;
      const send=inputs[0]!.tools.find(tool=>tool.name==='rift_send_message')!;
      const initial=await send.execute({recipientAgentId:f.lead.id,kind:'progress',content:'First attempt progress',idempotencyKey:'progress'},inputs[0]!.signal) as {messageId:string};
      expect(f.store.require('SELECT sender_agent_id,run_id FROM messages WHERE id=?',initial.messageId)).toEqual({senderAgentId:f.developer.id,runId:'first'});
      await first.dispose();f.store.exec("UPDATE runs SET status='failed',cleanup_status='confirmed',slot_released_at='now' WHERE id='first'");
      const second=await provider.startTask(f.store,f.run('second','repair'));await second.result;
      expect(inputs[1]!.session!.threadId).toBe('task-thread');expect(inputs[1]!.tools[0]!.execute).not.toBe(inputs[0]!.tools[0]!.execute);
      await expect(send.execute({recipientAgentId:f.lead.id,kind:'progress',content:'Late old attempt',idempotencyKey:'late'},inputs[0]!.signal)).rejects.toMatchObject({code:'UNAUTHORIZED'});
      const current=await inputs[1]!.tools[0]!.execute({recipientAgentId:f.lead.id,kind:'progress',content:'Second attempt progress',idempotencyKey:'progress'},inputs[1]!.signal) as {messageId:string};
      expect(f.store.require<{runId:string}>('SELECT run_id FROM messages WHERE id=?',current.messageId).runId).toBe('second');
      expect(f.store.all('SELECT id FROM agent_turns')).toHaveLength(0);
      expect(f.store.all('SELECT id FROM execution_leases WHERE released_at IS NULL')).toHaveLength(1);
      await expect(inputs[1]!.tools[0]!.execute({recipientAgentId:f.lead.id,senderAgentId:f.lead.id,content:'Spoof',idempotencyKey:'spoof'},inputs[1]!.signal)).rejects.toThrow();
      await second.dispose();
    }finally{f.collaboration.close();f.store.close();}
  });

  it('installs DSH messaging on only the exact reserved child and validates its live agent at invocation',async()=>{
    const f=fixture();const definitions:{name:string;execute:(args:unknown,execution:{agent:unknown;signal:AbortSignal})=>Promise<unknown>}[]=[];
    let listener:((payload:{agent:Agent})=>unknown)|undefined;const remove=vi.fn();
    const parent={id:'parent'} as Agent;
    const child={id:'rift-run-local',ctx:{tools:{register:(definition:typeof definitions[number])=>definitions.push(definition)}}} as unknown as Agent;
    const ctx={agents:{get:(agentId:string)=>agentId==='parent'?parent:agentId===child.id?child:undefined},on:(_event:string,handler:typeof listener)=>{listener=handler;return remove;},subagents:{getProvider:()=>({name:'codex-review',capabilities:{},prepareContinuable:async()=>({})}),startActivation:async(spec:{childId:string})=>{expect(spec.childId).toBe(child.id);listener?.({agent:{id:'unrelated'} as Agent});expect(definitions).toHaveLength(0);listener?.({agent:child});return{childId:child.id,result:Promise.resolve({stopReason:'completed',output:[]}),async dispose(){}};}}} as unknown as Context;
    try{
      const handle=await new DshActivationBridge(ctx,()=>parent,f.store).start(f.run('local'));
      expect(remove).toHaveBeenCalledOnce();expect(definitions.map(tool=>tool.name)).toEqual(['rift_send_message']);
      const args={recipientAgentId:f.lead.id,kind:'progress',content:'DSH local progress',idempotencyKey:'local-progress'};
      await expect(definitions[0]!.execute(args,{agent:parent,signal:new AbortController().signal})).rejects.toMatchObject({code:'UNAUTHORIZED'});
      const receipt=await definitions[0]!.execute(args,{agent:child,signal:new AbortController().signal}) as {messageId:string};
      expect(f.store.require<{runId:string}>('SELECT run_id FROM messages WHERE id=?',receipt.messageId).runId).toBe('local');
      f.store.exec("UPDATE runs SET status='cancelled' WHERE id='local'");
      await expect(definitions[0]!.execute({...args,idempotencyKey:'late'},{agent:child,signal:new AbortController().signal})).rejects.toMatchObject({code:'UNAUTHORIZED'});
      await handle.dispose();
    }finally{f.collaboration.close();f.store.close();}
  });
});
