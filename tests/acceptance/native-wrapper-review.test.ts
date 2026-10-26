import { describe,expect,it } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import type { SubprocessHandle,SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime,type NativeCodexOptions } from '../../src/agent/native-codex.js';
import type { RuntimeTurnInput,RuntimeHandle } from '../../src/agent/runtime-types.js';
import { createHash } from 'node:crypto';
import { RiftStore } from '../../src/storage/database.js';
import { nativeSession } from '../../src/agent/native-sessions.js';
import { seedWorkspace } from './fixtures.js';

/** Controlled wire assertions complement the real native wrapper probe. They
 * do not claim that a mock process can prove native shell or Git execution. */
function boundary(mode:NativeCodexOptions['mode'],repository:boolean,resume=false){
  const stdin=new PassThrough(),stdout=new PassThrough(),peer=new JsonRpcLineTransport(stdin,stdout);
  const requests:{method:string;params:Record<string,any>}[]=[];let spec!:SubprocessSpawnSpec,called=0;
  let end!:(value:{exitCode:number;signal:null})=>void;const done=new Promise<{exitCode:number;signal:null}>(resolve=>{end=resolve;});
  const child:SubprocessHandle={stdin,stdout,stderr:undefined,control:undefined,collected:{},done,terminate(){end({exitCode:0,signal:null});},async waitForExit(){return true;}};
  peer.onRequest(async(method,params)=>{
    requests.push({method,params});
    if(method==='initialize')return{};
    if(method==='config/read')return{config:{mcp_servers:{desktop_tools:{command:'never-inherit'}}}};
    if(method==='thread/start'||method==='thread/resume'){
      const config=params.config as Record<string,unknown>;
      return{cwd:params.cwd,thread:{id:'owned-thread',ephemeral:params.ephemeral??false,status:{type:'idle'}},approvalPolicy:'never',sandbox:params.sandbox==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:config['sandbox_workspace_write.writable_roots'],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
    }
    if(method==='turn/start')return{turn:{id:'owned-turn',status:'inProgress'}};
    if(method==='turn/interrupt')return{};
    throw new Error(`Unexpected request: ${method}`);
  });peer.start();
  const input:RuntimeTurnInput={workspaceId:'wrapper-review',agentId:'lead',turnId:'turn',cwd:process.cwd(),model:'gpt-6.1-sol',instructions:'Inspect the provided capability boundary.',messages:[{role:'user',content:'Inspect status.'}],tools:[{name:'rift_status',description:'Owned status',inputSchema:{type:'object'},async execute(){called++;return{owned:true};}}],signal:new AbortController().signal,...repository?{repositoryAccess:{repositoryPaths:[process.cwd()]}}:{},...resume?{session:{threadId:'owned-thread',runtimeHome:process.cwd(),onThread(){},onTurn(){},onSettled(){}}}:{}};
  const runtime=new NativeCodexRuntime({mode,env:{CODEX_DESKTOP_PIPE:'must-not-inherit'},spawn(value){spec=value;return child;}});
  return{input,runtime,requests,peer,get spec(){return spec;},get called(){return called;},call:(tool:string,namespace:string|null=null,identity={threadId:'owned-thread',turnId:'owned-turn'})=>peer.request('item/tool/call',{...identity,callId:`call-${tool}-${namespace}-${identity.threadId}`,namespace,tool,arguments:{}}) as Promise<{success:boolean}>,close:async(handle?:RuntimeHandle)=>{await handle?.dispose();peer.close();}};
}

describe('Independent native wrapper permission boundary',()=>{
  it.each(['discussion','develop'] as const)('enables the native wrapper for repository %s on start and resume while preserving the scoped Host gateway',async mode=>{
    for(const resume of [false,true]){
      const p=boundary(mode,true,resume);let handle:RuntimeHandle|undefined;
      try{
        handle=await p.runtime.start(p.input);const request=p.requests.find(row=>row.method===(resume?'thread/resume':'thread/start'))!.params;
        expect(request.sandbox).toBe('workspace-write');expect(request.config).toMatchObject({'features.code_mode':true,'features.code_mode_host':true,'features.shell_tool':true,'features.unified_exec':true,'features.apps':false,'features.plugins':false,'features.multi_agent':false,'mcp_servers.desktop_tools.enabled':false});
        expect(p.spec.argv).toContain('features.code_mode=true');expect(p.spec.argv).toContain('features.code_mode_host=true');expect(p.spec.env!.CODEX_DESKTOP_PIPE).toBeUndefined();
        expect((await p.call('rift_status')).success).toBe(true);expect(p.called).toBe(1);
        expect((await p.call('rift_status',null,{threadId:'foreign-thread',turnId:'owned-turn'})).success).toBe(false);
        expect((await p.call('rift_status','desktop_tools')).success).toBe(false);expect(p.called).toBe(1);
      }finally{await p.close(handle);}
    }
  });

  it.each(['review','analysis'] as const)('keeps wrapper and shell unavailable for formal %s even with repository roots and a resumed thread',async mode=>{
    const p=boundary(mode,true,true);let handle:RuntimeHandle|undefined;
    try{
      handle=await p.runtime.start(p.input);const request=p.requests.find(row=>row.method==='thread/resume')!.params;
      expect(request.sandbox).toBe('read-only');expect(request.config).toMatchObject({'features.code_mode':false,'features.code_mode_host':false,'features.shell_tool':false,'features.unified_exec':false,'features.apps':false});
      expect(request.environments).toEqual([]);expect(p.requests.find(row=>row.method==='turn/start')!.params.sandboxPolicy).toEqual({type:'readOnly',networkAccess:false});
      for(const [tool,namespace] of [['exec_command',null],['exec','functions'],['code_mode',null]] as const)expect((await p.call(tool,namespace)).success).toBe(false);
      expect(p.called).toBe(0);expect((await p.call('rift_status')).success).toBe(true);
    }finally{await p.close(handle);}
  });

  it('does not enable wrapper execution for repository-free discussion',async()=>{
    const p=boundary('discussion',false);let handle:RuntimeHandle|undefined;
    try{handle=await p.runtime.start(p.input);const request=p.requests.find(row=>row.method==='thread/start')!.params;expect(request.config).toMatchObject({'features.code_mode':false,'features.code_mode_host':false,'features.shell_tool':false});expect(request.sandbox).toBe('read-only');expect((await p.call('exec','functions')).success).toBe(false);expect(p.called).toBe(0);}finally{await p.close(handle);}
  });

  it('does not resume a persisted v2 thread after the wrapper permission contract changes',()=>{
    const store=new RiftStore();try{
      const {workspace,roles}=seedWorkspace(store,'wrapper-version-review'),agent=roles.find(role=>role.purpose==='lead')!;
      const configuration={model:'gpt-6.1-sol',purpose:'chat'},cwd=process.cwd(),runtimeHome=process.cwd();
      // This is the deployed v2 identity, retained as a historical fixture.
      const oldKey=createHash('sha256').update(JSON.stringify([configuration,runtimeHome,cwd,'workspace-repositories-v2','codex-0.164.0'])).digest('hex');
      store.exec("INSERT INTO native_sessions(id,workspace_id,scope,scope_id,agent_id,configuration_key,thread_id,runtime_home,cwd,created_at) VALUES('v2-session',?,'chat','conversation',?,?,'failed-wrapper-v2-thread',?,?,'before-upgrade')",workspace.id,agent.id,oldKey,runtimeHome,cwd);
      const input={workspaceId:workspace.id,scope:'chat' as const,scopeId:'conversation',agentId:agent.id,configuration,cwd,runtimeHome};
      const next=nativeSession(store,input);expect(next.id).not.toBe('v2-session');expect(next.threadId).toBeNull();expect(nativeSession(store,input).id).toBe(next.id);
      expect(store.require<{threadId:string}>("SELECT thread_id FROM native_sessions WHERE id='v2-session'").threadId).toBe('failed-wrapper-v2-thread');
    }finally{store.close();}
  });
});
