import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import type { ActivationBridge } from '../../src/contracts/index.js';

describe('A03/A07/A10 fake official-service boundary (not a native runtime pass)', () => {
  it('retains the owned local child terminal diagnostic without treating it as assistant output',async()=>{
    const parent={id:'parent'} as Agent;
    const child={id:'rift-run-run',ctx:{tools:{restrict:vi.fn(),register:vi.fn()}},session:{snapshotEvents:()=>[
      {type:'user/message',data:{content:'private prompt'}},
      {type:'turn/end',data:{reason:{kind:'error',error:{message:'MISSING_CREDENTIAL: unavailable token=secret-value'}}}},
    ]}} as unknown as Agent;
    let listener:((event:{agent:Agent})=>void)|undefined;
    const ctx={agents:{get:()=>parent},on:(_name:string,callback:typeof listener)=>{listener=callback;return()=>{};},subagents:{getProvider:()=>({prepareContinuable:async()=>{},capabilities:{}}),startActivation:async()=>{
      listener?.({agent:child});return{childId:child.id,result:Promise.resolve({stopReason:'error',output:[]}),dispose:async()=>{}};
    }}} as unknown as Context;
    const handle=await new DshActivationBridge(ctx,()=>parent).start({signal:new AbortController().signal,task:{id:'task',kind:'change'},run:{id:'run',purpose:'review',providerSnapshot:{binding:{providerName:'spawn',runtime:'dsh'}}},cwd:'C:/candidate',prompt:'review'} as Parameters<ActivationBridge['start']>[0]);
    const result=await handle.result;expect(result).toMatchObject({stopReason:'error',text:'',diagnostic:expect.stringContaining('MISSING_CREDENTIAL')});
    expect(JSON.stringify(result)).not.toContain('secret-value');expect(JSON.stringify(result)).not.toContain('private prompt');await handle.dispose();
  });
  it('requires the exact current live parent and exact registered provider', async () => {
    const parent = { id: 'parent' } as Agent;
    const startActivation = vi.fn();
    const ctx = { agents: { get: () => ({ id: 'parent' }) }, subagents: { getProvider: () => ({}), startActivation } } as unknown as Context;
    const bridge = new DshActivationBridge(ctx, () => parent);
    const input = { signal: new AbortController().signal, task: { id: 'task', title: 'task' }, run: { id: 'run', providerSnapshot: { binding: { providerName: 'configured' } } }, cwd: 'C:/task', prompt: 'work' } as Parameters<ActivationBridge['start']>[0];
    await expect(bridge.start(input)).rejects.toMatchObject({ code: 'LIVE_LEAD_REQUIRED' });
    expect(startActivation).not.toHaveBeenCalled();
    ctx.agents.get = (() => parent) as typeof ctx.agents.get;
    ctx.subagents.getProvider = (() => undefined) as typeof ctx.subagents.getProvider;
    await expect(bridge.start(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(startActivation).not.toHaveBeenCalled();
  });

  it('rejects external providers without verified isolation before activation', async () => {
    const parent={id:'parent'} as Agent,startActivation=vi.fn();
    const ctx={agents:{get:()=>parent},subagents:{getProvider:()=>({}),startActivation}} as unknown as Context;
    const input={signal:new AbortController().signal,task:{id:'task',title:'task'},run:{id:'run',providerSnapshot:{binding:{providerName:'external'}}},cwd:'/task',prompt:'work'} as Parameters<ActivationBridge['start']>[0];
    await expect(new DshActivationBridge(ctx,()=>parent).start(input)).rejects.toMatchObject({code:'FILESYSTEM_ISOLATION_UNAVAILABLE'});
    expect(startActivation).not.toHaveBeenCalled();
  });
});
