import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {RiftStore} from '../../src/storage/database.js';
import {configureRoles,type RoleConfiguration} from '../../src/project/agent-roles.js';
import {validateBinding,validateInstanceModels} from '../../src/project/provider-bindings.js';
import {seedWorkspace} from '../acceptance/fixtures.js';
import {DshActivationBridge} from '../../src/task/activation-bridge.js';
import {TaskCoordinator} from '../../src/task/coordinator.js';
import type {ActivationBridge,GitService,ProviderBinding,Run} from '../../src/contracts/index.js';
const stores:RiftStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
const binding:ProviderBinding={id:'spawn',providerName:'spawn',runtime:'dsh',packageVersion:'test',configRevision:1,capabilities:{agentOptions:true,agentPreset:true},credentialRefs:[],spawn:{provider:'deepseek',model:'model-a',reasoningEffort:'high',agentPreset:'coding',maxTokens:2048}};
describe('free role and official execution options',()=>{
  it('keeps legacy defaults and soft-disables removed custom roles without losing history',()=>{
    const store=new RiftStore();stores.push(store);const seeded=seedWorkspace(store);const roles:RoleConfiguration[]=[{name:'captain',purpose:'lead',kind:'dsh-lead',prompt:'Lead',revision:1},{name:'writer',purpose:'developer',kind:'subagent',providerBindingId:seeded.bindings[0]!.id,prompt:'Write',revision:1},{name:'security',purpose:'reviewer',kind:'subagent',providerBindingId:seeded.bindings[1]!.id,prompt:'Review',revision:1}];
    const configured=configureRoles(store,seeded.workspace.id,seeded.bindings,roles,new Set(['claude-code-dev','codex-review']));expect(configured.map(role=>role.name)).toEqual(['captain','security','writer']);expect(store.role(`${seeded.workspace.id}:developer-a`).enabled).toBe(0);expect(configured.find(role=>role.name==='writer')?.purpose).toBe('developer');
    expect(()=>configureRoles(store,seeded.workspace.id,seeded.bindings,roles.map(role=>role.name==='security'?{...role,purpose:undefined}:role),new Set(['claude-code-dev','codex-review']))).toThrow(/purpose/);
  });
  it('requires separate external instances for known different models while permitting old unknown metadata',()=>{
    const external={...binding,providerName:'codex',runtime:'codex' as const,spawn:null,model:'sol'};
    expect(()=>validateInstanceModels([{...external,model:null,runtime:null},external])).not.toThrow();
    expect(()=>validateInstanceModels([external,{...external,id:'astra',model:'astra'}])).toThrow(/distinct/);
    expect(()=>validateInstanceModels([external,{...external,id:'astra',providerName:'codex-astra',model:'astra'}])).not.toThrow();
    expect(()=>validateBinding({...external,spawn:binding.spawn},new Set(['codex']))).toThrow(/Only DSH/);
  });
  it('forwards only official spawn options and rejects live capability mismatch before publication',async()=>{
    const parent={id:'lead'} as Agent,startActivation=vi.fn(async(_input:unknown)=>({childId:'child',result:Promise.resolve({stopReason:'completed',output:[]}),dispose:vi.fn(async()=>{})}));
    const ctx={agents:{get:()=>parent},subagents:{getProvider:()=>({capabilities:{agentOptions:true,agentPreset:true}}),startActivation}} as unknown as Context;
    const input={signal:new AbortController().signal,task:{id:'task',title:'Task'},run:{id:'run',providerSnapshot:{binding}},cwd:'C:/task',prompt:'Work'} as Parameters<ActivationBridge['start']>[0];
    const bridge=new DshActivationBridge(ctx,()=>parent);await bridge.start(input);
    expect(startActivation.mock.calls[0]?.[0]).toMatchObject({provider:'spawn',request:{cwd:'C:/task',agentOptions:{provider:'deepseek',model:'model-a',reasoningEffort:'high',maxTokens:2048},agentPreset:'coding'}});
    ctx.subagents.getProvider=(()=>({capabilities:{agentOptions:false}})) as unknown as typeof ctx.subagents.getProvider;
    await expect(bridge.start(input)).rejects.toMatchObject({code:'START_NOT_PUBLISHED'});expect(startActivation).toHaveBeenCalledOnce();
  });
});
describe('analysis reuse ledger and cleanup boundary (controlled service)',()=>{
  function fixture(cleanupFailure=false,itemFailure=false){
    const store=new RiftStore();stores.push(store);seedWorkspace(store,'ws');const parent={id:'lead'} as Agent;
    const workflowDispose=vi.fn(async()=>{if(cleanupFailure)throw new Error('unknown cleanup');}),parentDispose=vi.fn(async()=>{}),removeGuard=vi.fn(),removeListener=vi.fn();
    const start=vi.fn((request:any)=>({id:'official-workflow-id',result:Promise.resolve({stopReason:'completed',value:request.args.items.map((item:{id:string})=>({id:item.id,text:itemFailure?null:'analysis'})),agentsStarted:request.args.items.length}),dispose:workflowDispose}));
    const ctx={get:(name:string)=>name==='workflowEngine'?{start}:undefined,agents:{get:()=>parent,create:vi.fn(async()=>({agent:{id:'scoped-parent'},dispose:parentDispose}))},tools:{guard:()=>removeGuard},on:()=>removeListener,subagents:{getProvider:()=>({capabilities:{}})}} as unknown as Context;
    const git:GitService={async prepareTask({task,run}){return{id:`wt-${run.id}`,taskId:task.id,attempt:task.attempt,kind:'task',path:`C:/managed/${run.id}`,baseCommit:'a'.repeat(40),writerRunId:run.id};},async collectSource(){throw new Error('no write collection');},async prepareCandidate(){throw new Error('no integration');},async publishCandidate(){throw new Error('no publication');},async verifyAnalysis(){return{headCommit:'a'.repeat(40)};}};
    const coordinator=new TaskCoordinator({store,git,bridge:new DshActivationBridge(ctx,()=>parent,store)});coordinator.createWorkflow({id:'workflow',workspaceId:'ws',goal:'Analyze',baseCommit:'a'.repeat(40),integrationRef:'refs/heads/rift/test'});coordinator.submitPlan({workflowId:'workflow',expectedRevision:0,tasks:[{id:'task',title:'Batch',kind:'analysis',instructions:'Analyze input',expectedPaths:[],analysisItems:[{id:'first',prompt:'a'},{id:'second',prompt:'b'}]}]});
    return{store,coordinator,ctx,start,workflowDispose,parentDispose,removeGuard,removeListener};
  }
  const settled=async(store:RiftStore)=>{for(let n=0;n<100;n++){if(['succeeded','blocked'].includes(store.task('task').status))return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('not settled');};
  it('reuses one engine run with fixed script and persists all item results through the original ledger',async()=>{
    const f=fixture();f.coordinator.dispatch({taskId:'task',idempotencyKey:'dispatch',expectedVersion:f.store.task('task').version});await settled(f.store);
    expect(f.store.task('task').status).toBe('succeeded');const run=f.store.require<Run>('SELECT * FROM runs');expect(run.dshRunId).toBe('official-workflow-id');expect((run.result as {summary:string}).summary).toContain('second');expect(run.cleanupStatus).toBe('confirmed');expect(f.start).toHaveBeenCalledOnce();expect(f.start.mock.calls[0]![0]).toMatchObject({maxTotalAgents:2,subagentProvider:'claude-code-dev'});expect(f.workflowDispose).toHaveBeenCalledOnce();expect(f.parentDispose).toHaveBeenCalledOnce();await f.coordinator.shutdown();
  });
  it('a failed item blocks the task even when the official script completed',async()=>{const f=fixture(false,true);f.coordinator.dispatch({taskId:'task',idempotencyKey:'dispatch',expectedVersion:f.store.task('task').version});await settled(f.store);expect(f.store.task('task').status).toBe('blocked');expect(f.store.task('task').blockingReason).toContain('first');await f.coordinator.shutdown();});
  it('retains the business slot and scope guards when Workflow cleanup fails',async()=>{const f=fixture(true);f.coordinator.dispatch({taskId:'task',idempotencyKey:'dispatch',expectedVersion:f.store.task('task').version});await settled(f.store);expect(f.store.require<Run>('SELECT * FROM runs').slotReleasedAt).toBeNull();expect(f.removeGuard).not.toHaveBeenCalled();expect(f.removeListener).not.toHaveBeenCalled();expect(f.parentDispose).toHaveBeenCalledOnce();await f.coordinator.shutdown();});
  it('refuses a fabricated batch outside the durable ledger before engine startup',async()=>{
    const parent={id:'lead'} as Agent,start=vi.fn(),ctx={agents:{get:()=>parent},subagents:{getProvider:()=>({capabilities:{}})},get:()=>({start})} as unknown as Context;
    const input={signal:new AbortController().signal,task:{id:'not-registered',analysisItems:[{id:'a',prompt:'Analyze'}]},run:{providerSnapshot:{binding:{providerName:'configured'}}}} as Parameters<ActivationBridge['start']>[0];
    await expect(new DshActivationBridge(ctx,()=>parent).start(input)).rejects.toMatchObject({code:'START_NOT_PUBLISHED'});expect(start).not.toHaveBeenCalled();
  });
});
