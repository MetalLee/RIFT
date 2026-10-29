import { describe,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,readFile,realpath,rm,writeFile,symlink,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import { seedWorkspace } from './fixtures.js';
import { gitOk } from '../../src/git/process.js';
import { workspaceRepositoryAccess,REPOSITORY_PERMISSION_VERSION } from '../../src/agent/repository-access.js';
import type { RuntimeTurnInput,RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { NativeCodexRuntime,nativeRepositoryRoots,type NativeCodexOptions } from '../../src/agent/native-codex.js';
import { PassThrough } from 'node:stream';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import type { SubprocessHandle,SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { createRepositoryShell } from '../../src/agent/repository-shell.js';

const until=async(check:()=>boolean)=>{for(let n=0;n<250;n++){if(check())return;await new Promise(done=>setTimeout(done,10));}throw new Error('Independent permissions condition did not settle');};

function protocol(mode:NativeCodexOptions['mode'],alter?:(reply:Record<string,any>)=>void){
  const stdin=new PassThrough(),stdout=new PassThrough(),peer=new JsonRpcLineTransport(stdin,stdout);
  const requests:{method:string;params:Record<string,any>}[]=[];let spec!:SubprocessSpawnSpec;let end!:(value:{exitCode:number;signal:null})=>void;
  const done=new Promise<{exitCode:number;signal:null}>(resolve=>{end=resolve;});let terminated=0;
  const child:SubprocessHandle={stdin,stdout,stderr:undefined,control:undefined,collected:{},done,terminate(){terminated++;end({exitCode:0,signal:null});},async waitForExit(){return true;}};
  peer.onRequest(async(method,params)=>{
    requests.push({method,params});
    if(method==='initialize')return{};
    if(method==='config/read')return{config:{mcp_servers:{desktop_authority:{command:'must-not-run'}}}};
    if(method==='thread/start'||method==='thread/resume'){
      const config=params.config as Record<string,unknown>;
      const reply={cwd:params.cwd,thread:{id:'independent-thread',ephemeral:params.ephemeral??false,status:{type:'idle'}},approvalPolicy:'never',sandbox:{type:params.sandbox==='danger-full-access'?'dangerFullAccess':'readOnly',writableRoots:config['sandbox_workspace_write.writable_roots']??[],networkAccess:config['sandbox_workspace_write.network_access']??false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
      alter?.(reply);return reply;
    }
    if(method==='turn/start')return{turn:{id:'independent-turn',status:'inProgress'}};
    if(method==='turn/interrupt')return{};
    throw new Error(`Unexpected protocol method ${method}`);
  });peer.start();
  const runtime=new NativeCodexRuntime({mode,env:{CODEX_TEST_DESKTOP_PIPE:'must-not-inherit'},spawn(value){spec=value;return child;}});
  return{runtime,requests,get spec(){return spec;},get terminated(){return terminated;},close(){peer.close();}};
}

const nativeInput=(cwd:string,repositoryPaths:string[]):RuntimeTurnInput=>({workspaceId:'independent',agentId:'lead',turnId:'turn',cwd,repositoryAccess:{repositoryPaths},model:'gpt-6.1-sol',instructions:'Independent permission protocol validation.',messages:[{role:'user',content:'Inspect only.'}],tools:[],signal:new AbortController().signal});

async function fixture(){
  const home=await mkdtemp(path.join(tmpdir(),'rift-permissions-review-'));
  const repositories:string[]=[];
  for(const name of ['one','two','foreign']){
    const cwd=path.join(home,name);await mkdir(cwd);await gitOk(cwd,['init','-q','-b','main']);await writeFile(path.join(cwd,'README.md'),`${name}\n`);await gitOk(cwd,['add','.']);await gitOk(cwd,['-c','user.name=Review','-c','user.email=review@example.invalid','commit','-qm','baseline']);repositories.push(await realpath(cwd));
  }
  const ctx:Record<string,any>={subagents:{list:()=>[]},llm:{listProviders:()=>[]}};
  const host=new RiftHostService(ctx as unknown as Context,{home:path.join(home,'host'),port:0,leadProvider:'unused',leadModel:'unused',checks:[]});
  const own=seedWorkspace(host.store,'permissions-own'),foreign=seedWorkspace(host.store,'permissions-foreign');
  const ownRepository=host.store.require<{id:string}>('SELECT id FROM repositories WHERE workspace_id=?',own.workspace.id),foreignRepository=host.store.require<{id:string}>('SELECT id FROM repositories WHERE workspace_id=?',foreign.workspace.id);
  for(const [repository,cwd] of [[ownRepository,repositories[0]!],[foreignRepository,repositories[2]!]] as const)host.store.exec('UPDATE repositories SET canonical_path=?,common_git_dir=? WHERE id=?',cwd,await realpath(path.join(cwd,'.git')),repository.id);
  host.store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'permission-test'}),own.workspace.id);
  const calls:{input:RuntimeTurnInput;finish:(value:RuntimeTurnResult)=>void}[]=[];
  host.registerChatRuntime('codex',{persistentSessions:true,async start(input){input.session?.onThread(input.session.threadId??`permission-thread-${calls.length}`);input.session?.onTurn(`permission-native-${calls.length}`);let finish!:(value:RuntimeTurnResult)=>void;const result=new Promise<RuntimeTurnResult>(done=>{finish=done;});calls.push({input,finish});return{result,async dispose(){finish({text:'',stopReason:'cancelled'});}};}},['permission-test']);
  await host.initialize();
  const connectSecond=()=>host.repositories.connect(own.workspace.id,{repositoryPath:repositories[1]!,baseRef:'main',expectedVersion:host.store.workspace(own.workspace.id).version!});
  return{home,host,ctx,own,foreign,ownRepository,repositories,calls,connectSecond,close:async()=>{await host.close();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-permissions-review-'))throw new Error('Unsafe test cleanup');await rm(home,{recursive:true,force:true});}};
}

async function legacyFixture(chatOwned=false){
  const f=await fixture(),definitions:any[]=[],agents=new Map<string,any>();let created=0,disposed=0,spawns=0,confirmed=true,restricted=false;
  f.ctx.subprocess={async resolveExecutable(){return'pwsh';},spawn(){spawns++;return{stdin:undefined,stdout:undefined,stderr:undefined,control:undefined,collected:{},done:Promise.resolve({exitCode:0,signal:null}),terminate(){},async waitForExit(){return confirmed;}};}};
  f.ctx.agents={get:(id:string)=>agents.get(id),async create(options:any){created++;const agent={id:options.sessionId,followups:[] as any[],followup(message:any){this.followups.push(message);}};agents.set(agent.id,agent);options.setup({agents:f.ctx.agents,tools:{restrict(value:any){restricted=value.allow.length===0;},register(definition:any){definitions.push(definition);}}},agent);return{agent,async dispose(){disposed++;agents.delete(agent.id);}};}};
  f.host.store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('legacy-permission',?,'Legacy capability review','running','refs/heads/rift/legacy-permission',?)",f.own.workspace.id,await gitOk(f.repositories[0]!,['rev-parse','HEAD']));
  const attach=()=>{const conversation=f.host.chat.createConversation(f.own.workspace.id,'Owned lead');f.host.store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES('legacy-permission',?,?,?,'chat','now')",f.own.workspace.id,conversation.id,f.own.roles.find(role=>role.purpose==='lead')!.id);};
  if(chatOwned)attach();
  return{...f,definitions,agents,attach,get created(){return created;},get disposed(){return disposed;},get spawns(){return spawns;},get restricted(){return restricted;},get confirmed(){return confirmed;},set confirmed(value:boolean){confirmed=value;}};
}

describe('Independent workspace repository permissions',()=>{
  it('derives only the associated workspace repositories, keeps its default first, and excludes another workspace',async()=>{
    const f=await fixture();try{
      await f.connectSecond();
      const access=await workspaceRepositoryAccess(f.host.store,f.own.workspace.id);
      expect(access?.repositoryPaths).toEqual(f.repositories.slice(0,2));expect(access?.repositoryPaths).not.toContain(f.repositories[2]);
      expect((await workspaceRepositoryAccess(f.host.store,f.foreign.workspace.id))?.repositoryPaths).toEqual([f.repositories[2]]);
      expect(access?.repositoryPaths).not.toContain(f.home);
    }finally{await f.close();}
  });

  it('rejects a registered checkout whose .git pointer now targets another repository',async()=>{
    const f=await fixture();try{
      const linked=path.join(f.home,'linked');await gitOk(f.repositories[0]!,['worktree','add','--detach',linked,'HEAD']);
      f.host.store.exec('UPDATE repositories SET canonical_path=? WHERE id=?',await realpath(linked),f.ownRepository.id);
      expect((await workspaceRepositoryAccess(f.host.store,f.own.workspace.id))?.repositoryPaths).toEqual([await realpath(linked)]);
      const gitFile=await readFile(path.join(linked,'.git'),'utf8');
      // Git marks this file hidden on Windows; replacing the fixture file
      // avoids Node's truncate-open restriction for hidden files.
      await unlink(path.join(linked,'.git'));
      await writeFile(path.join(linked,'.git'),`gitdir: ${path.join(f.repositories[2]!,'.git')}\n`);
      await expect(workspaceRepositoryAccess(f.host.store,f.own.workspace.id)).rejects.toMatchObject({code:'REPOSITORY_IDENTITY_CHANGED'});
      await writeFile(path.join(linked,'.git'),gitFile);
    }finally{await f.close();}
  });

  it('grants the exact linked-worktree Git metadata and associated second repository without broadening their parent',async()=>{
    const f=await fixture();try{
      const linked=path.join(f.home,'linked');await gitOk(f.repositories[0]!,['worktree','add','--detach',linked,'HEAD']);
      const roots=await nativeRepositoryRoots(linked,f.repositories.slice(0,2),new AbortController().signal);
      const canonical=(value:string)=>path.resolve(value).toLowerCase();
      const actual=roots.map(canonical);
      for(const root of [linked,...f.repositories.slice(0,2),path.join(f.repositories[0]!,'.git'),path.join(f.repositories[0]!,'.git','worktrees','linked'),path.join(f.repositories[1]!,'.git')])expect(actual).toContain(canonical(root));
      expect(actual).toHaveLength(6);expect(actual).not.toContain(canonical(f.home));expect(actual).not.toContain(canonical(f.repositories[2]!));
    }finally{await f.close();}
  });

  it('rejects unrelated task checkouts and subdirectory capabilities before starting a native process',async()=>{
    const f=await fixture();try{
      await expect(nativeRepositoryRoots(f.repositories[2]!,[f.repositories[0]!],new AbortController().signal)).rejects.toMatchObject({code:'NATIVE_REPOSITORY_SCOPE'});
      const sub=path.join(f.repositories[0]!,'sub');await mkdir(sub);
      await expect(nativeRepositoryRoots(sub,[sub],new AbortController().signal)).rejects.toMatchObject({code:'NATIVE_REPOSITORY_SCOPE'});
      await expect(nativeRepositoryRoots(f.repositories[0]!,[],new AbortController().signal)).rejects.toMatchObject({code:'NATIVE_REPOSITORY_SCOPE'});
    }finally{await f.close();}
  });

  it('rejects a noncanonical junction rather than turning an alias into an additional permission root',async()=>{
    const f=await fixture();try{
      const alias=path.join(f.home,'alias');await symlink(f.repositories[2]!,alias,'junction');
      f.host.store.exec('UPDATE repositories SET canonical_path=? WHERE id=?',alias,f.ownRepository.id);
      await expect(workspaceRepositoryAccess(f.host.store,f.own.workspace.id)).rejects.toMatchObject({code:'REPOSITORY_IDENTITY_CHANGED'});
    }finally{await f.close();}
  });

  it('freezes Host-selected roots and rotates native sessions when repositories change while preserving same-boundary continuation',async()=>{
    const f=await fixture();try{
      const conversation=f.host.chat.createConversation(f.own.workspace.id,'Permission boundary review');
      const send=async(index:number)=>{const result=f.host.chat.send(f.own.workspace.id,conversation.id,{clientMessageId:`permission-${index}`,content:'Describe the authorized repository context without creating tasks.'});await until(()=>f.calls.length===index+1);return{...f.calls[index]!,turn:result.turn};};
      const first=await send(0);expect(first.input.cwd).toBe(f.repositories[0]);expect(first.input.repositoryAccess?.repositoryPaths).toEqual([f.repositories[0]]);
      expect(f.host.chat.turn(f.own.workspace.id,first.turn.id).configuration.runtimeAccess).toMatchObject({permissionVersion:REPOSITORY_PERMISSION_VERSION,cwd:f.repositories[0],repositoryPaths:[f.repositories[0]]});
      first.finish({text:'The first repository is authorized.',stopReason:'completed'});await until(()=>f.host.chat.turn(f.own.workspace.id,first.turn.id).status==='completed');
      const second=await send(1);expect(second.input.session?.threadId).toBe('permission-thread-0');second.finish({text:'Same permission boundary.',stopReason:'completed'});await until(()=>f.host.chat.turn(f.own.workspace.id,second.turn.id).status==='completed');
      const added=await f.connectSecond();
      const third=await send(2);expect(third.input.session?.threadId).toBeUndefined();expect(third.input.repositoryAccess?.repositoryPaths).toEqual(f.repositories.slice(0,2));
      expect(first.input.repositoryAccess?.repositoryPaths).toEqual([f.repositories[0]]);
      third.finish({text:'The associated repository set changed.',stopReason:'completed'});await until(()=>f.host.chat.turn(f.own.workspace.id,third.turn.id).status==='completed');
      f.host.store.exec('DELETE FROM repositories WHERE id=?',added.id);
      const fourth=await send(3);expect(fourth.input.session?.threadId).not.toBe('permission-thread-2');expect(fourth.input.repositoryAccess?.repositoryPaths).toEqual([f.repositories[0]]);
      expect(fourth.input.repositoryAccess?.repositoryPaths).not.toContain(f.repositories[2]);
      expect(f.host.store.all('SELECT id FROM tasks')).toEqual([]);
    }finally{await f.close();}
  });

  it.each(['review','analysis'] as const)('keeps %s read-only even if the caller accidentally supplies all repository capabilities',async mode=>{
    const f=await fixture(),p=protocol(mode);try{
      const handle=await p.runtime.start(nativeInput(f.repositories[0]!,f.repositories.slice(0,2)));
      const request=p.requests.find(row=>row.method==='thread/start')!.params;
      expect(request.sandbox).toBe('read-only');expect(request.config['features.shell_tool']).toBe(false);expect(request.config['features.unified_exec']).toBe(false);
      expect(request.dynamicTools.map((tool:any)=>tool.name)).toEqual(['rift_read_file','rift_list_files']);expect(request.environments).toEqual([]);
      expect(request.config['mcp_servers.desktop_authority.enabled']).toBe(false);expect(request.config['features.apps']).toBe(false);expect(request.config['features.multi_agent']).toBe(false);
      expect(p.spec.env!.CODEX_TEST_DESKTOP_PIPE).toBeUndefined();await handle.dispose();
    }finally{p.close();await f.close();}
  });

  it('rejects a fresh ephemeral repository thread when the server silently substitutes another cwd',async()=>{
    const f=await fixture(),p=protocol('develop',reply=>{reply.cwd=f.repositories[2];});try{
      await expect(p.runtime.start(nativeInput(f.repositories[0]!,[f.repositories[0]!]))).rejects.toMatchObject({code:'NATIVE_SCOPE_MISMATCH'});
      expect(p.requests.some(row=>row.method==='turn/start')).toBe(false);expect(p.terminated).toBe(1);
    }finally{p.close();await f.close();}
  });

  it('refuses a resumed thread that does not confirm the requested full-access policy',async()=>{
    const f=await fixture(),p=protocol('develop',reply=>{reply.sandbox.type='workspaceWrite';});try{
      const input=nativeInput(f.repositories[0]!,[f.repositories[0]!]);input.session={threadId:'independent-thread',runtimeHome:f.home,onThread(){},onTurn(){},onSettled(){}};
      await expect(p.runtime.start(input)).rejects.toMatchObject({code:'NATIVE_RESTRICTIONS_UNCONFIRMED'});
      expect(p.requests.some(row=>row.method==='thread/resume')).toBe(true);expect(p.requests.some(row=>row.method==='turn/start')).toBe(false);expect(p.terminated).toBe(1);
    }finally{p.close();await f.close();}
  });

  it('builds an isolated DSH native sandbox profile and rejects outside cwd or late execution',async()=>{
    const f=await fixture();let spec:SubprocessSpawnSpec|undefined;let spawns=0;
    const subprocess={async resolveExecutable(){return'pwsh';},spawn(value:SubprocessSpawnSpec){spec=value;spawns++;return{stdin:undefined,stdout:undefined,stderr:undefined,control:undefined,collected:{},done:Promise.resolve({exitCode:0,signal:null}),terminate(){},async waitForExit(){return true;}} as SubprocessHandle;}} as unknown as Context['subprocess'];
    const shell=await createRepositoryShell(subprocess,{cwd:f.repositories[0]!,repositoryAccess:{repositoryPaths:f.repositories.slice(0,2)},signal:new AbortController().signal});
    try{
      await shell.tool.execute({cmd:'git status --porcelain'},new AbortController().signal);
      expect(spec!.argv[0]).toBe('/usr/bin/bwrap');expect(spec!.argv).toContain('--unshare-all');expect(spec!.argv).toContain('--clearenv');expect(spec!.argv).toContain('--bind');expect(spec!.argv).not.toContain('--share-net');
      await expect(shell.tool.execute({cmd:'git status',cwd:f.repositories[2]},new AbortController().signal)).rejects.toMatchObject({code:'REPOSITORY_SCOPE'});
      expect(spawns).toBe(1);await shell.dispose();
      await expect(shell.tool.execute({cmd:'git status'},new AbortController().signal)).rejects.toMatchObject({code:'TURN_STOPPED'});expect(spawns).toBe(1);
    }finally{await shell.dispose();await f.close();}
  });

  it('does not report DSH command cleanup confirmed while its process lease remains unknown',async()=>{
    const f=await fixture();let confirmed=false;
    const subprocess={async resolveExecutable(){return'pwsh';},spawn(){return{stdin:undefined,stdout:undefined,stderr:undefined,control:undefined,collected:{},done:Promise.resolve({exitCode:0,signal:null}),terminate(){},async waitForExit(){return confirmed;}} as SubprocessHandle;}} as unknown as Context['subprocess'];
    const shell=await createRepositoryShell(subprocess,{cwd:f.repositories[0]!,repositoryAccess:{repositoryPaths:[f.repositories[0]!]},signal:new AbortController().signal});
    try{
      await expect(shell.tool.execute({cmd:'git status'},new AbortController().signal)).rejects.toMatchObject({code:'CLEANUP_UNKNOWN'});
      await expect(shell.dispose()).rejects.toMatchObject({code:'CLEANUP_UNKNOWN'});
      confirmed=true;await shell.dispose();
    }finally{confirmed=true;await shell.dispose();await f.close();}
  });

  it('gives one legacy Lead a scoped shell and rejects foreign identity, chat takeover and terminal workflow writes',async()=>{
    const f=await legacyFixture();try{
      const [first,second]=await Promise.all([f.host.ensureLead('legacy-permission'),f.host.ensureLead('legacy-permission')]);
      expect(first).toEqual(second);expect(f.created).toBe(1);expect(f.restricted).toBe(true);
      const tool=f.definitions.find(item=>item.name==='exec_command');expect(tool).toBeDefined();const agent=f.agents.get(first.leadSessionId),signal=new AbortController().signal;
      await expect(tool.execute({cmd:'git status'},{agent:{id:agent.id},signal})).rejects.toMatchObject({code:'UNAUTHORIZED'});
      await tool.execute({cmd:'git status'},{agent,signal});expect(f.spawns).toBe(1);
      f.attach();await expect(tool.execute({cmd:'git commit'},{agent,signal})).rejects.toMatchObject({code:'INVALID_STATE'});expect(f.spawns).toBe(1);
      f.host.store.exec("DELETE FROM workflow_conversations WHERE workflow_id='legacy-permission'");f.host.store.exec("UPDATE workflows SET status='cancelled' WHERE id='legacy-permission'");
      await expect(tool.execute({cmd:'git commit'},{agent,signal})).rejects.toMatchObject({code:'INVALID_STATE'});expect(f.spawns).toBe(1);
    }finally{await f.close();expect(f.disposed).toBe(1);}
  });

  it('loads the ordinary default Skill and exposes the scoped CLI to an autonomous legacy Lead',async()=>{
    const f=await legacyFixture();try{
      f.ctx.llm.listProviders=()=>[{id:'unused'}];
      const attached=await f.host.startLead('legacy-permission'),agent=f.agents.get(attached.leadSessionId);
      const cli=f.definitions.find(item=>item.name==='rift_cli');expect(cli).toBeDefined();
      const result=await cli.execute({argv:['workspace','show'],input:{}},{agent,signal:new AbortController().signal});
      expect(result.workspace.id).toBe(f.own.workspace.id);
      expect(agent.followups[0].content[0].text).toContain('# RIFT workspace operations');
      await expect(cli.execute({argv:['workspace','grant-path'],input:{path:f.home},idempotencyKey:'legacy-grant'},{agent,signal:new AbortController().signal})).rejects.toMatchObject({code:'OPERATOR_REQUIRED'});
      await expect(cli.execute({argv:['workspace','show'],input:{}},{agent:{id:'foreign'},signal:new AbortController().signal})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    }finally{await f.close();}
  });

  it('never gives an activation-only parent a second shell alongside the chat-owned Lead',async()=>{
    const f=await legacyFixture(true);try{await f.host.ensureLead('legacy-permission');expect(f.created).toBe(1);expect(f.restricted).toBe(true);expect(f.definitions).toEqual([]);expect(f.spawns).toBe(0);}finally{await f.close();expect(f.disposed).toBe(1);}
  });

  it('disposes the underlying legacy agent even if its owned command cleanup is unknown',async()=>{
    const f=await legacyFixture();try{
      const attached=await f.host.ensureLead('legacy-permission'),agent=f.agents.get(attached.leadSessionId),tool=f.definitions.find(item=>item.name==='exec_command');f.confirmed=false;
      await expect(tool.execute({cmd:'git status'},{agent,signal:new AbortController().signal})).rejects.toMatchObject({code:'CLEANUP_UNKNOWN'});
    }finally{await f.close();expect(f.disposed).toBe(1);}
  });
});

describe('explicit unrestricted Agent execution',()=>{
  it('propagates operator configuration and rotates the persistent thread when permission mode changes',async()=>{
    const f=await fixture();try{
      const conversation=f.host.chat.createConversation(f.own.workspace.id,'Mode change');
      const first=f.host.chat.send(f.own.workspace.id,conversation.id,{clientMessageId:'sandboxed-mode',content:'Hello'});
      await until(()=>f.calls.length===1);expect(f.calls[0]!.input.repositoryAccess?.sandboxMode).toBeUndefined();
      f.calls[0]!.finish({text:'Done',stopReason:'completed'});await until(()=>f.host.chat.turn(f.own.workspace.id,first.turn.id).status==='completed');
      vi.stubEnv('RIFT_AGENT_SANDBOX','unrestricted');
      f.host.chat.send(f.own.workspace.id,conversation.id,{clientMessageId:'unrestricted-mode',content:'Again'});
      await until(()=>f.calls.length===2);expect(f.calls[1]!.input.repositoryAccess?.sandboxMode).toBe('unrestricted');expect(f.calls[1]!.input.session?.threadId).toBeUndefined();
      f.calls[1]!.finish({text:'Done',stopReason:'completed'});
    }finally{vi.unstubAllEnvs();await f.close();}
  });

  it.each(['discussion','develop','review'] as const)('confirms full-access native policy and exposes the Host shell for %s',async mode=>{
    const f=await fixture(),p=protocol(mode);
    try {
      const input=nativeInput(f.repositories[0]!,[f.repositories[0]!]);(input.repositoryAccess as any).sandboxMode='unrestricted';
      const handle=await p.runtime.start(input);
      const request=p.requests.find(r=>r.method==='thread/start')!.params;
      expect(request.sandbox).toBe('danger-full-access');expect(request.approvalPolicy).toBe('never');
      expect((request.dynamicTools as {name:string}[]).some(t=>t.name==='rift_exec_command')).toBe(true);
      expect(p.requests.find(r=>r.method==='turn/start')!.params.sandboxPolicy).toEqual({type:'dangerFullAccess'});
      await handle.dispose();
    }finally{p.close();await f.close();}
  });
  it('keeps analysis read-only even with operator unrestricted mode',async()=>{
    const f=await fixture(),p=protocol('analysis');
    try{
      const input=nativeInput(f.repositories[0]!,[f.repositories[0]!]);input.repositoryAccess!.sandboxMode='unrestricted';
      const handle=await p.runtime.start(input);const request=p.requests.find(r=>r.method==='thread/start')!.params;
      expect(request.sandbox).toBe('read-only');
      const names=(request.dynamicTools as {name:string}[]).map(t=>t.name);
      expect(names).toContain('rift_read_file');expect(names).toContain('rift_list_files');expect(names).not.toContain('rift_exec_command');
      await handle.dispose();
    }finally{p.close();await f.close();}
  });
  it('runs directly with Host environment and accepts an outside cwd while keeping disposal checks',async()=>{
    const f=await fixture();let spec:SubprocessSpawnSpec|undefined;
    const subprocess={spawn(value:SubprocessSpawnSpec){spec=value;return{collected:{},done:Promise.resolve({exitCode:0,signal:null}),terminate(){},async waitForExit(){return true;}} as SubprocessHandle;}} as unknown as Context['subprocess'];
    const input={cwd:f.repositories[0]!,repositoryAccess:{repositoryPaths:[f.repositories[0]!],sandboxMode:'unrestricted'},signal:new AbortController().signal};
    const shell=await createRepositoryShell(subprocess,input as any);
    try {
      await shell.tool.execute({cmd:'pwd',cwd:f.repositories[2]},new AbortController().signal);
      expect(spec!.argv).toEqual(['/bin/bash','--noprofile','--norc','-c','pwd']);expect(spec!.cwd).toBe(f.repositories[2]);expect(spec!.env?.PATH).toBe(process.env.PATH);
      await shell.dispose();await expect(shell.tool.execute({cmd:'true'},new AbortController().signal)).rejects.toMatchObject({code:'TURN_STOPPED'});
    }finally{await shell.dispose();await f.close();}
  });
});
