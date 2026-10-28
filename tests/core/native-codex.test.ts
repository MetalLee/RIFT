import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime, nativeRepositoryRoots, type NativeCodexOptions } from '../../src/agent/native-codex.js';
import type { RuntimeEvent, RuntimeHandle, RuntimeTurnInput } from '../../src/agent/runtime-types.js';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.allSettled(disposers.splice(0).map(dispose => dispose())); });
function harness(options: { sandbox?: string; cleanup?: boolean; resumeId?:string; resumeActive?:boolean; resumeMissing?:boolean;mode?:NativeCodexOptions['mode'];env?:NodeJS.ProcessEnv;networkMismatch?:boolean } = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const peer = new JsonRpcLineTransport(stdin, stdout);
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let terminateCount = 0, spawnSpec: SubprocessSpawnSpec | undefined;
  let exit!: (value: { exitCode: number; signal: null }) => void;
  const done = new Promise<{ exitCode: number; signal: null }>(resolve => { exit = resolve; });
  const child: SubprocessHandle = {
    stdin, stdout, stderr: undefined, control: undefined, collected: {}, done,
    terminate() { terminateCount++; exit({ exitCode: 0, signal: null }); },
    async waitForExit() { return options.cleanup !== false; },
  };
  const sandbox=(params:Record<string,any>)=>({type:options.sandbox??(params.sandbox==='danger-full-access'?'dangerFullAccess':'readOnly'),...(params.sandbox==='read-only'?{networkAccess:options.networkMismatch??false}:{})});
  peer.onRequest(async (method, params) => {
    requests.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { mcp_servers: { legacy: { command: 'never-start' } } } };
    if (method === 'thread/start') return { cwd:params.cwd,thread: { id: 'native-thread', ephemeral: params.ephemeral }, approvalPolicy: 'never', sandbox: sandbox(params) };
    if (method === 'thread/resume') {
      if (options.resumeMissing) throw new Error('Thread missing');
      return { cwd:params.cwd,thread: { id:options.resumeId??'native-thread',ephemeral:false,status:{type:options.resumeActive?'active':'idle'} },approvalPolicy:'never',sandbox:sandbox(params) };
    }
    if (method === 'turn/start') return { turn: { id: 'native-turn', status: 'inProgress' } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method ${method}`);
  });
  peer.start();
  const runtime = new NativeCodexRuntime({mode:options.mode,env:options.env,spawn(spec) { spawnSpec = spec; return child; } });
  const controller = new AbortController();
  const calls: unknown[] = [];
  const input: RuntimeTurnInput = {
    workspaceId: 'one', agentId: 'lead-one', turnId: 'turn-one', cwd: process.cwd(), model: 'gpt-6.1-sol',
    instructions: 'Use scoped tools.', messages: [{ role: 'user', content: 'Inspect status.' }], signal: controller.signal,
    tools: [{ name: 'rift_status', description: 'Status', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(args) { calls.push(args); return { workspaceId: 'one' }; } }],
  };
  const toolCall = (overrides: Record<string, unknown> = {}) => peer.request('item/tool/call', { threadId: 'native-thread', turnId: 'native-turn', callId: 'call-one', namespace: null, tool: 'rift_status', arguments: {}, ...overrides }) as Promise<{ success: boolean; contentItems: { text: string }[] }>;
  const complete = () => {
    peer.notify('item/completed', { threadId: 'native-thread', turnId: 'native-turn', item: { type: 'agentMessage', text: 'Verified', phase: 'final_answer' } });
    peer.notify('turn/completed', { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } });
  };
  return { runtime, input, calls, peer, toolCall, complete, requests, controller, get terminateCount() { return terminateCount; }, get spawnSpec() { return spawnSpec; }, async start() { const handle = await runtime.start(input); disposers.push(handle.dispose); return handle; } };
}

describe('native Codex Host-owned tool gateway', () => {
  it.each(['我先检查代码。', 'I will inspect the code.'])('streams native commentary, public summaries and tool progress before completion: %s',async text=>{
    const h=harness();const events:RuntimeEvent[]=[];let legacy='';
    h.input.onEvent=event=>events.push(event);h.input.onText=chunk=>{legacy+=chunk;};
    const handle=await h.start();
    expect(h.requests.find(request=>request.method==='turn/start')?.params.summary).toBe('auto');
    let done=false;void handle.result.then(()=>{done=true;});
    const notify=(method:string,extra:Record<string,unknown>)=>h.peer.notify(method,{threadId:'native-thread',turnId:'native-turn',...extra});
    notify('item/started',{item:{id:'pre',type:'agentMessage',phase:'commentary'}});
    for(const chunk of text)notify('item/agentMessage/delta',{itemId:'pre',delta:chunk});
    notify('item/completed',{item:{id:'pre',type:'agentMessage',phase:'commentary',text}});
    notify('item/started',{item:{id:'reason',type:'reasoning'}});
    notify('item/reasoning/textDelta',{itemId:'reason',delta:'private data must not be forwarded'});
    notify('item/reasoning/summaryTextDelta',{itemId:'reason',summaryIndex:0,delta:'Checking the relevant files.'});
    notify('item/completed',{item:{id:'reason',type:'reasoning'}});
    expect((await h.toolCall()).success).toBe(true);
    expect(done).toBe(false);expect(legacy).toBe('');
    expect(events.filter(event=>event.type==='message.delta'&&event.messageId==='pre').map(event=>'text' in event?event.text:'').join('')).toBe(text);
    expect(events).toContainEqual({type:'message.completed',messageId:'pre',text,kind:'commentary'});
    expect(events).toContainEqual({type:'tool.started',toolCallId:'call-one',toolName:'rift_status'});
    expect(events).toContainEqual({type:'tool.completed',toolCallId:'call-one',toolName:'rift_status'});
    expect(events).toContainEqual({type:'message.started',messageId:'summary:reason:0',kind:'reasoning_summary'});
    expect(JSON.stringify(events)).not.toContain('private data');
    notify('item/started',{item:{id:'answer',type:'agentMessage',phase:'final_answer'}});
    notify('item/agentMessage/delta',{itemId:'answer',delta:'Done.'});
    notify('item/completed',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Done.'}});
    h.peer.notify('turn/completed',{threadId:'native-thread',turn:{id:'native-turn',status:'completed'}});
    await expect(handle.result).resolves.toMatchObject({text:'Done.',finalText:'Done.'});
  });

  it('recovers completion-only public summaries without exposing raw content',async()=>{
    const h=harness(),events:RuntimeEvent[]=[];
    h.input.onEvent=event=>events.push(event);
    const handle=await h.start();
    h.peer.notify('item/completed',{threadId:'native-thread',turnId:'native-turn',item:{id:'reason',type:'reasoning',summary:['核对调用结果。','Checking the results.'],content:['opaque private data']}});
    h.complete();await handle.result;
    expect(events).toContainEqual({type:'message.completed',messageId:'summary:reason:0',kind:'reasoning_summary',text:'核对调用结果。'});
    expect(events).toContainEqual({type:'message.completed',messageId:'summary:reason:1',kind:'reasoning_summary',text:'Checking the results.'});
    expect(JSON.stringify(events)).not.toContain('opaque private data');
  });

  it('persists the thread before accepting a turn and resumes with fresh tool closures', async () => {
    const recorded:string[]=[];
    const h=harness();
    h.input.session={runtimeHome:process.cwd(),onThread:id=>recorded.push(`thread:${id}`),onTurn:id=>recorded.push(`turn:${id}`),onSettled:status=>recorded.push(status)};
    const first=await h.start();
    expect(recorded).toEqual(['thread:native-thread','turn:native-turn']);
    expect(h.spawnSpec!.env!.CODEX_HOME).toBe(process.cwd());
    h.complete();await first.result;await first.dispose();
    const next=harness();next.input.session={...h.input.session,threadId:'native-thread'};
    await next.start();
    expect(next.requests.some(r=>r.method==='thread/start')).toBe(false);
    expect(next.requests.find(r=>r.method==='thread/resume')!.params).toMatchObject({threadId:'native-thread',cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only'});
    expect(next.requests.find(r=>r.method==='thread/resume')!.params).not.toHaveProperty('dynamicTools');
    expect((await next.toolCall()).success).toBe(true);
    expect(next.calls).toHaveLength(1);expect(h.calls).toHaveLength(0);
  });

  it.each([{resumeMissing:true},{resumeId:'foreign'},{resumeActive:true}])('never silently replaces an unavailable or mismatched persisted thread: %j',async options=>{
    const h=harness(options);
    h.input.session={threadId:'native-thread',runtimeHome:process.cwd(),onThread(){},onTurn(){},onSettled(){}};
    await expect(h.start()).rejects.toThrow();
    expect(h.requests.some(r=>r.method==='turn/start'||r.method==='thread/start')).toBe(false);
    expect(h.terminateCount).toBe(1);
  });
  it('binds tools to the authoritative thread and turn and rejects inherited authority', async () => {
    const h = harness(); const handle = await h.start();
    for (const mismatch of [{ threadId: 'other-workspace' }, { turnId: 'other-turn' }, { namespace: 'functions' }, { tool: 'exec_command' }]) expect((await h.toolCall(mismatch)).success).toBe(false);
    expect(h.calls).toEqual([]);
    expect((await h.toolCall()).success).toBe(true);
    expect(h.calls).toEqual([{}]);
    const started = h.requests.find(request => request.method === 'thread/start')!.params;
    expect(started.environments).toEqual([]);
    expect((started.config as Record<string, unknown>)['mcp_servers.legacy.enabled']).toBe(false);
    expect(h.spawnSpec!.argv).toContain('features.shell_tool=false');
    expect(h.spawnSpec!.argv).toEqual(expect.arrayContaining(['features.code_mode=false','features.code_mode_host=false']));
    expect(started.config).toMatchObject({'features.code_mode':false,'features.code_mode_host':false});
    h.complete(); await expect(handle.result).resolves.toMatchObject({ text: 'Verified', stopReason: 'completed' });
  });

  it('does not repeat tool side effects on call replay or allow call identity mutation', async () => {
    const h = harness(); await h.start();
    const [first, duplicate] = await Promise.all([h.toolCall(), h.toolCall()]);
    expect(first.success && duplicate.success).toBe(true); expect(h.calls).toHaveLength(1);
    expect((await h.toolCall({ arguments: { different: true } })).success).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it('continues legitimate tool work beyond 128 calls while preserving replay identity',async()=>{
    const h=harness(),handle=await h.start();
    for(let i=0;i<160;i++)expect((await h.toolCall({callId:'long-turn-'+i})).success).toBe(true);
    expect(h.calls).toHaveLength(160);expect((await h.toolCall({callId:'long-turn-0'})).success).toBe(true);expect(h.calls).toHaveLength(160);
    h.complete();await handle.result;
  });
  it('revokes tools on stop and confirms managed-range cleanup separately', async () => {
    const h = harness(); const handle = await h.start();
    h.controller.abort();
    await expect(handle.result).rejects.toMatchObject({ code: 'TURN_CANCELLED' });
    expect((await h.toolCall()).success).toBe(false);
    await handle.dispose();
    expect(h.terminateCount).toBe(1); expect(h.calls).toHaveLength(0);
  });

  it('does not publish a runtime with unconfirmed restrictions or cleanup', async () => {
    const bad = harness({ sandbox: 'dangerFullAccess' });
    await expect(bad.start()).rejects.toMatchObject({ code: 'NATIVE_RESTRICTIONS_UNCONFIRMED' });
    expect(bad.terminateCount).toBe(1);
    const h = harness({ cleanup: false }); const handle = await h.start();
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'CLEANUP_UNKNOWN' });
  });

  it('fails before spawning when a model has not passed native tool isolation', async () => {
    const h = harness(); h.input.model = 'unverified-model';
    await expect(h.start()).rejects.toMatchObject({ code: 'NATIVE_MODEL_UNVERIFIED' });
    expect(h.spawnSpec).toBeUndefined();
  });

  it('keeps cleanup pending until Host tool operations are also quiescent', async () => {
    const h = harness(); let finish!: () => void;
    h.input.tools[0]!.execute = () => new Promise(resolve => { finish = () => resolve({ done: true }); });
    const handle = await h.start();
    const call = h.toolCall(); void call.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    let released = false; const disposal = handle.dispose().then(() => { released = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(released).toBe(false);
    finish(); await disposal; expect(released).toBe(true);
  });
});

describe('native repository capabilities',()=>{
  it('keeps one-shot development without repository grants restricted without requiring a repository session',async()=>{
    const h=harness({mode:'develop'}),handle=await h.start();
    expect(h.requests.find(r=>r.method==='thread/start')!.params).toMatchObject({sandbox:'read-only',approvalPolicy:'never',ephemeral:true});
    expect(h.requests.find(r=>r.method==='turn/start')!.params.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    h.complete();await handle.result;await handle.dispose();
  });
  async function repositories(){
    const folder=await mkdtemp(path.join(tmpdir(),'rift-native-roots-')),repo=path.join(folder,'repo'),other=path.join(folder,'other'),worktree=path.join(folder,'worktree');
    disposers.push(async()=>{await rm(folder,{recursive:true,force:true});});
    const exec=promisify(execFile);
    for(const cwd of [repo,other]){await mkdir(cwd);await exec('git',['init','-q','-b','main',cwd]);await writeFile(path.join(cwd,'base.txt'),'base\n');await exec('git',['-C',cwd,'add','.']);await exec('git',['-C',cwd,'-c','user.name=Probe','-c','user.email=probe@example.invalid','commit','-qm','base']);}
    await exec('git',['-C',repo,'worktree','add','-q','-b','probe',worktree]);return{folder,repo,other,worktree};
  }
  it('derives exact Git metadata roots for all associated repositories and refuses foreign cwd or broad roots',async()=>{
    const f=await repositories(),signal=new AbortController().signal;
    const roots=await nativeRepositoryRoots(f.worktree,[f.repo,f.other],signal);
    expect(roots).toEqual(expect.arrayContaining([f.repo,f.other,f.worktree,path.join(f.repo,'.git'),path.join(f.repo,'.git','worktrees','worktree'),path.join(f.other,'.git')]));
    expect(roots).not.toContain(f.folder);
    await expect(nativeRepositoryRoots(f.other,[f.repo],signal)).rejects.toMatchObject({code:'NATIVE_REPOSITORY_SCOPE'});
    await expect(nativeRepositoryRoots(f.repo,[path.parse(f.repo).root],signal)).rejects.toMatchObject({code:'NATIVE_REPOSITORY_SCOPE'});
    await expect(nativeRepositoryRoots(f.repo,['relative'],signal)).rejects.toMatchObject({code:'NATIVE_REPOSITORY_SCOPE'});
  });
  it.each(['discussion','develop'] as const)('exposes only the scoped repository command tool for %s on both start and resume without inheriting desktop authority',async mode=>{
    const f=await repositories();
    for(const resume of [false,true]){
      const h=harness({mode,env:{CODEX_DESKTOP_TOOL_PIPE:'must-not-inherit',CODEX_THREAD_ID:'foreign'}});h.input.cwd=f.worktree;h.input.repositoryAccess={repositoryPaths:[f.repo,f.other]};
      if(resume)h.input.session={threadId:'native-thread',runtimeHome:f.folder,onThread(){},onTurn(){},onSettled(){}};
      const handle=await h.start(),request=h.requests.find(r=>r.method===(resume?'thread/resume':'thread/start'))!.params;
      expect(request.sandbox).toBe('read-only');expect(request.environments).toEqual([]);expect(h.requests.find(r=>r.method==='turn/start')!.params.environments).toEqual([]);if(!resume)expect((request.dynamicTools as any[]).map((tool:any)=>tool.name)).toContain('rift_exec_command');
      expect(request.config).toMatchObject({'features.shell_tool':false,'features.unified_exec':false,'features.multi_agent':false,'mcp_servers.legacy.enabled':false});
      expect(request.config).toMatchObject({'features.code_mode':false,'features.code_mode_host':false});
      expect(h.spawnSpec!.argv).toContain('features.code_mode=false');
      expect(h.spawnSpec!.argv).not.toContain('sandbox_mode="danger-full-access"');
      expect(h.spawnSpec!.argv.some(arg=>arg.includes('windows.sandbox')||arg.includes('sandbox_workspace_write'))).toBe(false);
      expect(h.requests.find(r=>r.method==='turn/start')!.params.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
      expect(h.spawnSpec!.argv).toContain('features.code_mode_host=false');
      expect(h.spawnSpec!.argv).not.toContain('features.code_mode_host=true');
      expect((await h.toolCall()).success).toBe(true);expect(h.calls).toEqual([{}]);
      expect((await h.toolCall({callId:'foreign',threadId:'foreign'})).success).toBe(false);
      expect(h.calls).toHaveLength(1);
      expect(h.spawnSpec!.env).toMatchObject({CODEX_DESKTOP_TOOL_PIPE:undefined,CODEX_THREAD_ID:undefined});expect(h.spawnSpec!.argv.some(arg=>arg.includes('model_catalog_json'))).toBe(true);
      h.complete();await handle.result;await handle.dispose();
    }
  });
  it.each(['review','analysis'] as const)('does not promote formal %s even when repositoryAccess is supplied',async mode=>{
    const h=harness({mode});h.input.repositoryAccess={repositoryPaths:['not-a-repository']};const handle=await h.start();
    const request=h.requests.find(r=>r.method==='thread/start')!.params;expect(request.sandbox).toBe('read-only');expect(request.config).toMatchObject({'features.shell_tool':false,'features.unified_exec':false});expect(request.environments).toEqual([]);
    expect(request.config).toMatchObject({'features.code_mode':false,'features.code_mode_host':false});
    expect(h.spawnSpec!.argv).toEqual(expect.arrayContaining(['features.code_mode=false','features.code_mode_host=false']));
    expect((request.dynamicTools as {name:string}[]).map(tool=>tool.name)).toEqual(['rift_status','rift_read_file','rift_list_files']);
    expect(h.requests.find(r=>r.method==='turn/start')!.params.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
    h.complete();await handle.result;await handle.dispose();
  });
  it.each(['workspaceWrite','dangerFullAccess'] as const)('rejects a substituted %s policy before turn publication',async sandbox=>{
    const f=await repositories(),h=harness({sandbox});h.input.cwd=f.worktree;h.input.repositoryAccess={repositoryPaths:[f.repo]};
    await expect(h.start()).rejects.toMatchObject({code:'NATIVE_RESTRICTIONS_UNCONFIRMED'});expect(h.requests.some(r=>r.method==='turn/start')).toBe(false);expect(h.terminateCount).toBe(1);
  });
  it('rejects read-only permission responses that silently enable remote network writes',async()=>{
    const h=harness({mode:'review',networkMismatch:true});await expect(h.start()).rejects.toMatchObject({code:'NATIVE_RESTRICTIONS_UNCONFIRMED'});expect(h.requests.some(r=>r.method==='turn/start')).toBe(false);
  });
});
