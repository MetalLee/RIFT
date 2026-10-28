import type { RuntimeEvent } from '../../src/agent/runtime-types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { inject } from '../../src/index.js';
import { DshChatRuntime } from '../../src/chat/dsh-runtime.js';
import { createRepositoryShell } from '../../src/agent/repository-shell.js';

vi.mock('../../src/agent/repository-shell.js', () => ({ createRepositoryShell: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('RIFT plugin DSH chat dependencies', () => {
  it.each([true, false])('starts discussion in a real plugin context (repository access: %s)', async repository => {
    const root = new Context();
    const disposeAgent = vi.fn(async () => {}), disposeShell = vi.fn(async () => {});
    const agent = {
      cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {},
      session: { snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ready.' }] } } }] },
    };
    const create = vi.fn(async () => ({ agent, dispose: disposeAgent }));
    root.provide('agents', { create } as never);
    root.provide('subagents', {} as never);
    root.provide('tools', {} as never);
    root.provide('llm', { listProviders: () => [{ id: 'test' }] } as never);
    root.provide('subprocess', { spawn: vi.fn() } as never);
    root.provide('credentials', { resolve: async () => undefined } as never);
    vi.mocked(createRepositoryShell).mockResolvedValue({
      tool: { name: 'exec_command', description: 'Repository command', inputSchema: {}, async execute() { return {}; } },
      dispose: disposeShell,
    });
    // Use the shipped plugin declaration: a plain object or root Context would
    // bypass Cordis's inject guard and miss the production startup failure.
    let scoped!: Context;
    const fiber = await root.plugin({ inject, apply(ctx: Context) { scoped = ctx; } });
    try {
      const handle = await new DshChatRuntime(scoped, 'test').start({
        workspaceId: 'workspace', agentId: 'reviewer', turnId: 'turn', cwd: process.cwd(),
        model: 'test', instructions: 'Reply to the user.', messages: [{ role: 'user', content: 'Hello' }],
        tools: [], signal: new AbortController().signal,
        ...(repository ? { repositoryAccess: { repositoryPaths: [process.cwd()] } } : {}),
      });
      expect(create).toHaveBeenCalledOnce();
      expect(createRepositoryShell).toHaveBeenCalledTimes(repository ? 1 : 0);
      await expect(handle.result).resolves.toMatchObject({ text: 'Ready.', finalText: 'Ready.', stopReason: 'completed' });
      await handle.dispose();
      expect(disposeAgent).toHaveBeenCalledOnce();
      expect(disposeShell).toHaveBeenCalledTimes(repository ? 1 : 0);
    } finally { await fiber.dispose(); }
  });
});


describe('DSH structured stream adapter',()=>{
  it.each(['我先检查代码。', 'I will inspect the code.'])('publishes separate commentary, final text and repository tool events: %s',async text=>{
    const listeners:Record<string,(value:any)=>void>={};
    const registered:any[]=[];const events:RuntimeEvent[]=[];let settle!:()=>void;
    const idle=new Promise<void>(resolve=>{settle=resolve;});
    const agent={id:'agent',cancel:vi.fn(),followup:vi.fn(),whenIdle:()=>idle,
      session:{snapshotEvents:()=>[{type:'assistant/message',data:{message:{content:[{type:'text',text}]}}},{type:'assistant/message',data:{message:{content:[{type:'text',text:'Done.'}]}}}]}};
    const scope={tools:{restrict:vi.fn(),register:(tool:unknown)=>registered.push(tool)},agents:{get:()=>agent},on:(name:string,callback:(value:any)=>void)=>{listeners[name]=callback;}};
    const ctx={llm:{listProviders:()=>[{id:'test'}]},agents:{create:async(options:any)=>{options.setup(scope,agent);return{agent,dispose:async()=>{}};}},subprocess:{}} as unknown as Context;
    vi.mocked(createRepositoryShell).mockResolvedValue({tool:{name:'exec_command',description:'Command',inputSchema:{},async execute(){return{ok:true};}},dispose:async()=>{}});
    const handle=await new DshChatRuntime(ctx,'test').start({workspaceId:'ws',agentId:'lead',turnId:'turn',cwd:process.cwd(),model:'test',instructions:'Inspect',messages:[],tools:[],signal:new AbortController().signal,repositoryAccess:{repositoryPaths:[process.cwd()]},onEvent:event=>events.push(event)});
    const emit=(frame:any)=>listeners['agent/assistant-stream']!({frame});
    emit({type:'start',attemptId:'pre'});
    emit({type:'chunk',attemptId:'pre',chunk:{type:'reasoning-delta',index:0,text:'正在核对代码。Checking the code.'}});
    for(const chunk of text)emit({type:'chunk',attemptId:'pre',chunk:{type:'text-delta',index:1,text:chunk}});
    emit({type:'chunk',attemptId:'pre',chunk:{type:'finish',reason:{kind:'tool-calls'}}});
    emit({type:'end',attemptId:'pre',outcome:{kind:'committed',eventType:'assistant/message'}});
    await registered[0].execute({}, {agent,signal:new AbortController().signal});
    expect(events.filter(event=>event.type==='message.delta'&&event.messageId==='pre').map(event=>'text' in event?event.text:'').join('')).toBe(text);
    expect(events).toContainEqual({type:'message.completed',messageId:'pre',kind:'commentary',text,interrupted:false});
    expect(events).toContainEqual({type:'tool.started',toolCallId:'dsh-tool-1',toolName:'exec_command'});
    expect(events).toContainEqual({type:'tool.completed',toolCallId:'dsh-tool-1',toolName:'exec_command'});
    expect(events).toContainEqual({type:'status.changed',status:'thinking'});
    expect(events).toContainEqual({type:'message.started',messageId:'reasoning:pre:0',kind:'reasoning'});
    expect(events).toContainEqual({type:'message.completed',messageId:'reasoning:pre:0',kind:'reasoning',text:'正在核对代码。Checking the code.',interrupted:false});
    expect(events.findIndex(event=>event.type==='message.started'&&event.kind==='reasoning')).toBeLessThan(events.findIndex(event=>event.type==='message.started'&&event.messageId==='pre'));
    emit({type:'start',attemptId:'answer'});
    emit({type:'chunk',attemptId:'answer',chunk:{type:'text-delta',index:0,text:'Do'}});
    emit({type:'chunk',attemptId:'answer',chunk:{type:'block-end',index:0,block:{type:'text',text:'Done.'}}});
    expect(events.filter(event=>event.type==='message.delta'&&event.messageId==='answer').map(event=>'text' in event?event.text:'').join('')).toBe('Done.');
    emit({type:'chunk',attemptId:'answer',chunk:{type:'finish',reason:{kind:'stop'}}});
    emit({type:'end',attemptId:'answer',outcome:{kind:'committed',eventType:'assistant/message'}});
    settle();await expect(handle.result).resolves.toMatchObject({finalText:'Done.'});await handle.dispose();
  });
});
