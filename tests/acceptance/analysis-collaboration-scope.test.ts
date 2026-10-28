import type {RuntimeEvent} from '../../src/agent/runtime-types.js';
import {recordRunProgress,type RunActivity} from '../../src/task/run-progress.js';
import {skillResourceTools} from '../../src/skill/resource-tool.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAnalysisBatch } from '../../src/task/analysis-reuse.js';
import { RiftStore } from '../../src/storage/database.js';
import { CollaborationService } from '../../src/chat/collaboration.js';
import type { TaskCoordinator } from '../../src/task/coordinator.js';
import { seedWorkspace } from './fixtures.js';

// Resolve the exact scope package used by the installed ToolRuntime, without
// introducing a different package version or a fake restrict implementation.
const { createScope } = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))('@deepseek-ai/dsh-scope') as {
  createScope(ctx:Context,key:object,options?:{parent:object}):{ctx:Context;dispose():Promise<void>};
};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const definition=(name:string):ToolDefinition=>({name,description:name,parameters:{type:'object'},output:{schema:{},render:()=>[{type:'text',text:'global'}]},async execute(){return'global';}});

async function fixture(withResources=false){
  const home=await mkdtemp(join(tmpdir(),'rift-analysis-scope-')),cwd=join(home,'worktree');await mkdir(cwd);
  cleanups.push(()=>rm(home,{recursive:true,force:true}));
  await writeFile(join(cwd,'source.ts'),'export const defaultEnabled = true;\n');
  await mkdir(join(cwd,'.git'));await writeFile(join(cwd,'.git','config'),'private git metadata');
  await mkdir(join(home,'outside'));await writeFile(join(home,'outside','private.txt'),'outside data');
  await symlink(join(home,'outside'),join(cwd,'escape'),'junction');
  const store=new RiftStore();cleanups.push(async()=>store.close());
  const {workspace,roles,bindings}=seedWorkspace(store),role=roles.find(item=>item.purpose==='developer')!,leadRole=roles.find(item=>item.purpose==='lead')!;
  store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('conversation',?,'Analysis','now')",workspace.id);
  store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Read source','running','ref','head')",workspace.id);
  store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt,analysis_items) VALUES('task','workflow',?,'analysis','Audit','Audit defaults','[]','[]','running',1,?)",role.id,JSON.stringify([{id:'audit',prompt:'Check repository defaults.'}]));
  store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('run','task',?,'develop',1,'running',?,'later','now')",role.id,JSON.stringify({role,binding:bindings[0]}));
  store.exec("INSERT INTO worktrees(id,task_id,attempt,kind,path,base_commit,writer_run_id) VALUES('worktree','task',1,'task',?,'head','run')",cwd);
  const collaboration=new CollaborationService(store,{} as TaskCoordinator,{enqueueMessage(){throw new Error('Progress cannot start a second execution');}});cleanups.push(async()=>collaboration.close());
  const ctx=new Context();
  ctx.provide('systemPrompt',{tools(){}} as never);new ToolRuntime(ctx);
  for(const name of ['pwsh','read_image','working_directory'])ctx.tools.register(definition(name));
  const agents=new Map<string,Agent>(),scopes:ReturnType<typeof createScope>[]=[];
  cleanups.push(async()=>{for(const scope of scopes)await scope.dispose();});
  const lead={id:'lead',session:{header:{}}} as Agent;agents.set(lead.id,lead);
  let root:Agent|undefined,child:Agent|undefined,requestContext='',cleanupFailure=false;
  async function create(id:string,parent:Agent,setup?:(scope:Context)=>void){
    const agent={id,session:{header:{parentSession:parent.id}}} as Agent;
    const scope=createScope(ctx,agent,{parent});scopes.push(scope);Object.assign(agent,{ctx:scope.ctx});
    setup?.(scope.ctx);agents.set(id,agent);await ctx.serial('agent/created',{agent} as never);
    return{agent,async dispose(){agents.delete(id);await scope.dispose();}};
  }
  ctx.provide('agents',{get:(id:string)=>agents.get(id),create:async(options:{sessionId:string;setup:(scope:Context)=>void})=>{const handle=await create(options.sessionId,lead,options.setup);root=handle.agent;return handle;}} as never);
  ctx.provide('workflowEngine',{start:(request:{parent:Agent;args:{context:string}})=>{
    requestContext=request.args.context;
    return{id:'batch',result:(async()=>{child=(await create('analysis-item',request.parent)).agent;return{stopReason:'completed',value:[{id:'audit',text:'Audit result'}]};})(),async dispose(){if(cleanupFailure)throw new Error('cleanup unknown');for(const scope of scopes)await scope.dispose();if(child)agents.delete(child.id);}};
  }} as never);
  if(withResources)store.exec("INSERT INTO skill_execution_snapshots(owner_type,owner_id,workspace_id,agent_id,snapshot_json,created_at) VALUES('run','run',?,?,?,'now')",workspace.id,role.id,JSON.stringify({instructions:'Read data.csv',versions:[],resources:[{versionId:'captured-version',skillId:'captured-skill',path:'data.csv',bytes:8,sha256:'digest',contentBase64:Buffer.from('CAPTURED').toString('base64')}]}));
  const controller=new AbortController();
  const progress:RunActivity[]=[],events:RuntimeEvent[]=[];
  const handle=await startAnalysisBatch(ctx,store,lead,{task:store.task('task'),run:store.run('run'),role,cwd,prompt:'Audit source.',signal:controller.signal,onEvent:event=>events.push(event),onProgress:event=>{progress.push(event);recordRunProgress(store,'run',event);},tools:[...collaboration.runTools(store.run('run')),...skillResourceTools(store,'run','run',()=>{})]});
  await handle.result;
  const invoke=(name:string,args:unknown,agent=child!,signal=new AbortController().signal)=>ctx.tools.execute({name,arguments:args,agent,signal,callId:`call-${Math.random()}` as never});
  return{events,progress,ctx,store,home,cwd,handle,root:root!,child:child!,lead,leadRole,agents,controller,invoke,requestContext,setCleanupFailure:()=>{cleanupFailure=true;}};
}

describe('analysis batch actual DSH tool scopes',()=>{
  it('streams activity from the actual analysis descendant scope into the reserved Run projection',async()=>{
    const f=await fixture();
    await f.child.ctx.serial('agent/assistant-stream',{agent:f.child,frame:{type:'start',attemptId:'attempt'}} as never);
    await f.child.ctx.serial('agent/assistant-stream',{agent:f.child,frame:{type:'chunk',attemptId:'attempt',chunk:{type:'reasoning-delta',text:'PRIVATE_REASONING',index:0}}} as never);
    await f.child.ctx.serial('agent/assistant-stream',{agent:f.child,frame:{type:'chunk',attemptId:'attempt',chunk:{type:'text-delta',text:'正在检查源文件。',index:1}}} as never);
    expect(f.events).toContainEqual(expect.objectContaining({type:'message.delta',text:'正在检查源文件。'}));
    expect(JSON.stringify(f.events)).not.toContain('PRIVATE_REASONING');
    const result=await f.invoke('rift_list_files',{path:'.'});
    expect(result.isError).not.toBe(true);
    expect(f.progress).toEqual(expect.arrayContaining([{phase:'thinking',step:true},{phase:'tool',toolName:'rift_list_files'},{phase:'tool_done',toolName:'rift_list_files'}]));
    expect(f.store.require('SELECT model_steps,tool_calls,phase FROM run_progress WHERE run_id=?','run')).toEqual({modelSteps:1,toolCalls:1,phase:'tool_done'});
    expect(JSON.stringify(f.store.all('SELECT * FROM run_progress'))).not.toContain('PRIVATE_REASONING');
  });

  it('publishes with real global-only restriction and installs tools in each exact child scope',async()=>{
    const f=await fixture();
    expect(()=>f.root.ctx.tools.restrict({allow:['rift_send_message']})).toThrow(/unknown global tool/);
    for(const agent of [f.root,f.child]){
      for(const name of ['rift_send_message','rift_read_file','rift_list_files'])expect(f.ctx.tools.get(name,agent)?.name).toBe(name);
      for(const name of ['pwsh','read_image','working_directory'])expect(f.ctx.tools.get(name,agent)).toBeUndefined();
    }
    expect(f.ctx.tools.get('rift_send_message')).toBeUndefined();expect(f.ctx.tools.get('rift_read_file',f.lead)).toBeUndefined();
    expect(f.ctx.tools.get('pwsh',f.lead)?.name).toBe('pwsh');
    const sent=await f.invoke('rift_send_message',{recipientAgentId:f.leadRole.id,kind:'progress',content:'Inspected defaults',idempotencyKey:'progress'});
    expect(sent.isError).toBe(false);expect(f.store.all('SELECT id FROM agent_turns')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM execution_leases WHERE released_at IS NULL')).toHaveLength(1);
    expect(f.store.require('SELECT run_id,sender_agent_id FROM messages WHERE kind=\'progress\'')).toEqual({runId:'run',senderAgentId:f.store.run('run').roleId});
    // Own scope registration must not bypass the monotonic analysis guard.
    f.child.ctx.tools.register(definition('pwsh'));
    expect((await f.invoke('pwsh',{})).isError).toBe(true);
    expect(f.requestContext).toContain('Inspect the repository');
    expect(f.requestContext).not.toContain('Analyze only the supplied text');
    await f.handle.dispose();
  });

  it('registers captured Skill resources for analysis children without exposing a shell',async()=>{
    const f=await fixture(true);
    const result=await f.invoke('rift_skill_resource',{versionId:'captured-version',path:'data.csv'});expect(result.isError).toBe(false);expect(JSON.stringify(result)).toContain('CAPTURED');
    expect((await f.invoke('rift_skill_resource',{versionId:'foreign',path:'data.csv'})).isError).toBe(true);
    expect((await f.invoke('pwsh',{})).isError).toBe(true);
    await f.handle.dispose();
  });

  it('reads bounded worktree source and refuses traversal, symlink escape, metadata, binary and oversized requests',async()=>{
    const f=await fixture();
    const read=await f.invoke('rift_read_file',{path:'source.ts'});expect(read.isError).toBe(false);expect(JSON.stringify(read)).toContain('defaultEnabled = true');
    const list=await f.invoke('rift_list_files',{path:'.',limit:1});expect(list.isError).toBe(false);expect(JSON.stringify(list)).toContain('truncated');expect(JSON.stringify(list)).not.toContain('private git metadata');
    await writeFile(join(f.cwd,'large.txt'),'a'.repeat(70000));
    const large=await f.invoke('rift_read_file',{path:'large.txt'});expect(large.isError).toBe(false);expect(JSON.stringify(large)).toContain('65536');
    const tail=await f.invoke('rift_read_file',{path:'large.txt',offset:65536});expect(tail.isError).toBe(false);expect(JSON.stringify(tail)).toContain('70000');
    await writeFile(join(f.cwd,'binary'),Buffer.from([0,1,2]));
    for(const args of [{path:'../outside/private.txt'},{path:join(f.home,'outside','private.txt')},{path:'escape/private.txt'},{path:'.git/config'},{path:'source.ts:stream'},{path:'binary'},{path:'large.txt',maxBytes:65537}])expect((await f.invoke('rift_read_file',args)).isError,JSON.stringify(args)).toBe(true);
    expect((await f.invoke('rift_list_files',{path:'escape'})).isError).toBe(true);
    await f.handle.dispose();
  });

  it('denies expired child identities, cancelled calls and released Run leases',async()=>{
    const f=await fixture(),tool=f.ctx.tools.get('rift_read_file',f.child)!;
    await expect(tool.execute({path:'source.ts'},{agent:f.lead,signal:new AbortController().signal} as never)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    const cancelled=new AbortController();cancelled.abort();expect((await f.invoke('rift_read_file',{path:'source.ts'},f.child,cancelled.signal)).isError).toBe(true);
    f.agents.delete(f.child.id);expect((await f.invoke('rift_read_file',{path:'source.ts'})).isError).toBe(true);f.agents.set(f.child.id,f.child);
    f.store.exec("UPDATE runs SET status='failed',cleanup_status='confirmed',slot_released_at='now' WHERE id='run'");
    expect((await f.invoke('rift_read_file',{path:'source.ts'})).isError).toBe(true);
    expect((await f.invoke('rift_send_message',{recipientAgentId:f.leadRole.id,kind:'progress',content:'Late',idempotencyKey:'late'})).isError).toBe(true);
    await f.handle.dispose();
  });

  it('retains the guard and business lease when Workflow cleanup remains unknown',async()=>{
    const f=await fixture();f.setCleanupFailure();await expect(f.handle.dispose()).rejects.toThrow('cleanup could not be confirmed');
    expect(f.store.run('run').slotReleasedAt).toBeNull();
    f.child.ctx.tools.register(definition('pwsh'));expect((await f.invoke('pwsh',{})).isError).toBe(true);
    f.controller.abort();expect((await f.invoke('rift_read_file',{path:'source.ts'})).isError).toBe(true);
  });
});
