import { describe,expect,it,vi,afterEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ActivationBridge } from '../../src/contracts/index.js';
import { DshActivationBridge } from '../../src/task/activation-bridge.js';
import { createRepositoryShell } from '../../src/agent/repository-shell.js';

vi.mock('../../src/agent/repository-shell.js',()=>({createRepositoryShell:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
describe('DSH development repository capability ownership',()=>{
  it('replaces inherited tools only in the exact child and disposes owned commands before the activation',async()=>{
    const order:string[]=[],definitions:{name:string;execute:(args:unknown,context:unknown)=>Promise<unknown>}[]=[],restrict=vi.fn();
    const execute=vi.fn(async()=>({exitCode:0}));
    vi.mocked(createRepositoryShell).mockResolvedValue({tool:{name:'exec_command',description:'Sandboxed native command',inputSchema:{type:'object'},execute},async dispose(){order.push('shell');}});
    const progress=vi.fn(),events=vi.fn();let streamListener:((event:unknown)=>void)|undefined;
    const parent={id:'parent'} as Agent,child={id:'rift-run-run',ctx:{on:(_event:string,handler:typeof streamListener)=>{streamListener=handler;},tools:{restrict,register:(definition:typeof definitions[number])=>definitions.push(definition)}}} as unknown as Agent;
    let listener:((payload:{agent:Agent})=>unknown)|undefined;
    const ctx={subprocess:{},agents:{get:(id:string)=>id===parent.id?parent:id===child.id?child:undefined},on:(_event:string,handler:typeof listener)=>{listener=handler;return()=>{listener=undefined;};},subagents:{getProvider:()=>({capabilities:{agentOptions:true},prepareContinuable:async()=>({})}),startActivation:async(spec:{childId:string})=>{expect(spec.childId).toBe(child.id);listener?.({agent:{id:'other'} as Agent});expect(restrict).not.toHaveBeenCalled();listener?.({agent:child});return{childId:child.id,result:Promise.resolve({stopReason:'completed',output:[]}),async dispose(){order.push('activation');}};}}} as unknown as Context;
    const controller=new AbortController();
    const input={onEvent:events,onProgress:progress,run:{id:'run',purpose:'develop',providerSnapshot:{binding:{providerName:'spawn',runtime:'dsh',spawn:{provider:'test',model:'test'}}}},task:{id:'task',kind:'change'},role:{},cwd:'/workspace/repo-a',repositoryAccess:{repositoryPaths:['/workspace/repo-a','/workspace/repo-b']},prompt:'Change requested files.',signal:controller.signal,tools:[{name:'rift_send_message',description:'Collaboration',inputSchema:{},async execute(){return{};}}]} as unknown as Parameters<ActivationBridge['start']>[0];
    const handle=await new DshActivationBridge(ctx,()=>parent).start(input);
    streamListener?.({agent:child,frame:{type:'start'}});expect(progress).toHaveBeenCalledWith({phase:'thinking',step:true});
    streamListener?.({agent:child,frame:{type:'chunk',chunk:{type:'text-delta',index:0,text:'正在检查。'}}});
    expect(events).toHaveBeenCalledWith(expect.objectContaining({type:'message.delta',text:'正在检查。'}));
    expect(createRepositoryShell).toHaveBeenCalledWith(ctx.subprocess,input);expect(restrict).toHaveBeenCalledWith({allow:[]});
    expect(definitions.map(tool=>tool.name)).toEqual(['rift_send_message','exec_command']);
    const shell=definitions.find(tool=>tool.name==='exec_command')!;
    await expect(shell.execute({cmd:'git status'},{agent:parent,signal:controller.signal})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    await shell.execute({cmd:'git status'},{agent:child,signal:controller.signal});expect(execute).toHaveBeenCalledOnce();expect(progress.mock.calls.slice(-2).map(call=>call[0])).toEqual([{phase:'tool',toolName:'exec_command'},{phase:'tool_done',toolName:'exec_command'}]);
    controller.abort();await expect(shell.execute({cmd:'git commit'},{agent:child,signal:new AbortController().signal})).rejects.toThrow();
    await handle.dispose();expect(order).toEqual(['shell','activation']);
  });
  it('provides only scoped read/list tools to a formal review even when passed repository roots',async()=>{
    const parent={id:'parent'} as Agent,restrict=vi.fn();
    const child={id:'rift-run-review',ctx:{tools:{restrict,register:vi.fn()}}} as unknown as Agent;
    let listener:((payload:{agent:Agent})=>unknown)|undefined;
    vi.mocked(createRepositoryShell).mockResolvedValue({tool:{name:'exec_command',description:'Read-only command',inputSchema:{},async execute(){return{};}},async dispose(){}});
    const ctx={subprocess:{},agents:{get:()=>parent},on:(_event:string,handler:typeof listener)=>{listener=handler;return()=>{};},subagents:{getProvider:()=>({capabilities:{},prepareContinuable:async()=>({})}),startActivation:async()=>{listener?.({agent:child});return{childId:'review',result:Promise.resolve({stopReason:'completed',output:[]}),async dispose(){}};}}} as unknown as Context;
    const handle=await new DshActivationBridge(ctx,()=>parent).start({run:{id:'review',purpose:'review',providerSnapshot:{binding:{providerName:'spawn',runtime:'dsh'}}},task:{id:'task',kind:'change'},role:{},cwd:'/candidate',repositoryAccess:{repositoryPaths:['/repo']},prompt:'Review.',tools:[{name:'rift_skill_resource',description:'Read immutable assigned Skill bytes',inputSchema:{},async execute(){return{content:'CAPTURED'};}}],signal:new AbortController().signal} as unknown as Parameters<ActivationBridge['start']>[0]);
    expect(createRepositoryShell).not.toHaveBeenCalled();
    expect(vi.mocked(child.ctx.tools.register).mock.calls.map(([tool])=>tool.name)).toEqual(['rift_skill_resource','rift_read_file','rift_list_files']);
    expect(restrict).toHaveBeenCalledWith({allow:[]});await handle.dispose();
  });
});
