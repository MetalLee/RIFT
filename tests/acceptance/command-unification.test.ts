import { describe,it,expect,vi } from 'vitest';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { managementRequest } from '../../src/cli/client.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { RiftHostService } from '../../src/api/host-service.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { HTTP_COMMAND_ROUTES,resolveHttpCommand } from '../../src/api/command-routes.js';
import { DshChatRuntime } from '../../src/chat/dsh-runtime.js';
const exec=promisify(execFile);
const cli=async(home:string,...args:string[])=>JSON.parse((await exec(process.execPath,['--import','tsx','src/cli/main.ts',...args,'--home',home,'--json'],{timeout:15000})).stdout);
async function fixture(uiEnabled=true){
  const home=await mkdtemp(path.join(tmpdir(),'rift-unified-')),ctx=new Context();
  const llm=await ctx.plugin(LlmRuntime),secrets=await ctx.plugin(LocalCredentialProvider,{path:path.join(home,'credentials.yaml'),watch:false});
  Object.defineProperty(ctx,'subagents',{value:{list:()=>[],getProvider:()=>undefined}});
  const host=new RiftHostService(ctx,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[],chatOrchestration:false,uiEnabled});
  await host.initialize();const api=await startLocalApi(host,{home,port:0,uiEnabled});
  const origin=`http://127.0.0.1:${api.port}`,token=(await readFile(path.join(home,'management.token'),'utf8')).trim();
  const management=(method:string,route:string,body?:unknown,key:string=randomUUID())=>fetch(origin+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const session=uiEnabled?await fetch(origin+'/ui-api/v1/session/connect',{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:'{}'}):undefined;
  const cookie=session?.headers.get('set-cookie')?.split(';')[0]??'',csrf=session?(await session.json() as {csrfToken:string}).csrfToken:'';
  const browser=async(method:string,route:string,body?:unknown,key:string=randomUUID())=>{
    const response=await fetch(origin+'/ui-api/v1'+route,{method,headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf,'Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json() as any};
  };
  return {home,ctx,host,api,origin,management,browser,reference:(id:string)=>host.store.require<{credentialRef:string}>('SELECT credential_ref FROM api_connections WHERE id=?',id).credentialRef,close:async()=>{await api.close();await host.close();await secrets.dispose();await llm.dispose();await rm(home,{recursive:true,force:true});}};
}
describe('shared application commands and executable capability coverage',()=>{
  it('documents and resolves every HTTP business entry, without transport paths in execution',async()=>{
    const matrix=await readFile('docs/cli-capability-matrix.md','utf8');
    for(const route of HTTP_COMMAND_ROUTES){
      expect(matrix,`${route.method} ${route.path}`).toContain(`\`${route.method} ${route.path}\``);
      const url=route.path.replace(':workspaceId','workspace').replace(':agentId','agent').replace(':kind','task').replace(':id','object');
      expect(resolveHttpCommand(route.method,url,{}).name).toBe(route.name);
    }
    for(const file of ['commands.ts','workspace-commands.ts']){
      const source=await readFile(`src/application/${file}`,'utf8');
      expect(source).not.toMatch(/\/ui-api\/|\/v1\/|this\.route\(|fetch\(/);
    }
    expect(()=>resolveHttpCommand('POST','/ui-api/v1/workspaces/w/workflows/f/retry',{})).toThrow();
    expect(()=>resolveHttpCommand('POST','/ui-api/v1/workspaces/w/worktree-removals/invalid/id/delete',{})).toThrow();
  });
  it('projects the same safe connection DTO for browser, management and CLI receipts',async()=>{
    const f=await fixture();try{
      const input={name:'Public contract',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'test',credentialRef:'HOST_ONLY_CONTRACT_AUTH'};
      const created=await f.browser('POST','/connections',input,'public-create');expect(created.status).toBe(200);
      expect(f.reference(created.value.id)).toBe(input.credentialRef);
      const keys=['id','name','protocol','endpoint','model','provider','revision','parentId','createdAt','verifiedAt','verificationStatus','verificationError','available','verification'];
      const browser=(await f.browser('GET','/connections')).value.savedConnections;
      const management=await (await f.management('GET','/v1/connections')).json() as {savedConnections:unknown[]};
      const executable=(await cli(f.home,'connection','list')).savedConnections;
      for(const value of [created.value,browser[0],management.savedConnections[0],executable[0]]) {
        expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
        expect(JSON.stringify(value)).not.toContain(input.credentialRef);
      }
      expect(browser).toEqual(executable);expect(management.savedConnections).toEqual(browser);
      expect((await f.browser('POST','/connections',input,'public-create')).value).toEqual(created.value);
      expect(JSON.stringify(f.host.store.all('SELECT response FROM management_requests'))).not.toContain(input.credentialRef);
    }finally{await f.close();}
  });
  it('shares creation, optimistic versions, errors and durable replay across browser and executable CLI',async()=>{
    const f=await fixture();try{
      const workspace=await cli(f.home,'workspace','create','--name','No repository','--key','create');
      expect(workspace.repositoryPath).toBe('');
      expect(await cli(f.home,'workspace','create','--name','No repository','--key','create')).toEqual(workspace);
      expect((await f.browser('GET',`/workspaces/${workspace.id}`)).value.workspace.id).toBe(workspace.id);
      const created=await f.browser('POST','/workspaces',{name:'Browser without repo'});expect(created.status).toBe(200);
      const invalid=await f.browser('POST','/workspaces',{name:'Bad',baseRef:'HEAD'});expect(invalid.value.error.code).toBe('INVALID_WORKSPACE');
      await expect(cli(f.home,'workspace','create','--name','Bad','--base','HEAD')).rejects.toMatchObject({stderr:expect.stringContaining('INVALID_WORKSPACE')});
      const input={expectedVersion:workspace.version,name:'Renamed'};
      const renamed=await cli(f.home,'ws','workspace','update','--workspace',workspace.id,'--data',JSON.stringify(input),'--key','rename');
      expect(await cli(f.home,'ws','workspace','update','--workspace',workspace.id,'--data',JSON.stringify(input),'--key','rename')).toEqual(renamed);
      await expect(cli(f.home,'ws','workspace','update','--workspace',workspace.id,'--data',JSON.stringify({...input,name:'Other'}),'--key','rename')).rejects.toMatchObject({stderr:expect.stringContaining('IDEMPOTENCY_CONFLICT')});
      expect((await f.browser('PATCH',`/workspaces/${workspace.id}`,input)).value.error.code).toBe('VERSION_CONFLICT');
      await expect(cli(f.home,'ws','workspace','update','--workspace',workspace.id,'--data',JSON.stringify(input))).rejects.toMatchObject({stderr:expect.stringContaining('VERSION_CONFLICT')});
      const overview=await cli(f.home,'workspace','overview');expect(overview.workspaces).toEqual((await f.browser('GET','/workspaces')).value.workspaces);
      expect((await f.browser('POST',`/workspaces/${created.value.id}/workflows/not-own/resume`,{expectedVersion:0})).status).not.toBe(200);
    }finally{await f.close();}
  });
  it('matches browser retry-and-dispatch and report export instead of silently using reset-only retry',async()=>{
    const f=await fixture();try{
      const workspace=await cli(f.home,'workspace','create','--name','Retry text');
      const invoke=(argv:string[],input:unknown={},key:string=randomUUID())=>f.host.handle('POST',`/v1/workspaces/${workspace.id}/cli`,{argv,input},key) as Promise<any>;
      const flow=await invoke(['workflow','start'],{mode:'analysis',goal:'Compare text',startLead:false});
      const tasks=await invoke(['plan','submit',flow.id],{expectedRevision:0,tasks:[{id:'retry-text',kind:'analysis',title:'Compare',instructions:'Compare a/b'}]});
      await invoke(['task','cancel',tasks[0].id]);const task=await invoke(['task','show',tasks[0].id]);
      const body={expectedVersion:task.version,reason:'Explicit retry'};
      const result=await cli(f.home,'ws','task','retry-dispatch',task.id,'--workspace',workspace.id,'--data',JSON.stringify(body),'--key','retry-dispatch');
      expect(result).toHaveProperty('request.id');
      expect(await cli(f.home,'ws','task','retry-dispatch',task.id,'--workspace',workspace.id,'--data',JSON.stringify(body),'--key','retry-dispatch')).toEqual(result);
      expect((await f.browser('POST',`/workspaces/${workspace.id}/tasks/${task.id}/retry`,body)).value.error.code).toBe('VERSION_CONFLICT');
      expect((await cli(f.home,'ws','workflow','report',flow.id,'--workspace',workspace.id)).workflow.id).toBe(flow.id);
      const report=await cli(f.home,'report','--workflow',flow.id);expect(report.file).toBe(path.join(f.home,'workspaces',workspace.id,'reports',flow.id+'.json'));
      expect(JSON.parse(await readFile(report.file,'utf8')).workflow.id).toBe(flow.id);
    }finally{await f.close();}
  });
  it('creates, verifies and deletes connections without UI, using key files and never logging plaintext',async()=>{
    const f=await fixture(false),secret='command-unification-private-literal';try{
      const workspace=await cli(f.home,'workspace','create','--name','Headless');
      expect((await cli(f.home,'ws','workspace','show','--workspace',workspace.id)).workspace.id).toBe(workspace.id);
      const config=path.join(f.home,'connection.json'),keyFile=path.join(f.home,'key.txt');
      await writeFile(config,JSON.stringify({name:'File key',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'test'}));await writeFile(keyFile,secret+'\n',{mode:0o600});
      const connection=await cli(f.home,'connection','create','--file',config,'--api-key-file',keyFile,'--key','create-connection');
      expect(JSON.stringify(connection)).not.toContain(secret);expect(connection).not.toHaveProperty('apiKey');expect(connection).not.toHaveProperty('credentialRef');
      expect(await cli(f.home,'connection','create','--file',config,'--api-key-file',keyFile,'--key','create-connection')).toEqual(connection);
      expect((await f.ctx.credentials.resolve(credentialRef(f.reference(connection.id))))?.value).toBe(secret);
      const saved=(await cli(f.home,'connection','list')).savedConnections;expect(saved).toHaveLength(1);expect(saved[0]).toEqual(connection);
      // Exercise the real verification service; only the external model activation is replaced.
      const dispose=vi.fn(async()=>{}),activation=vi.spyOn(DshChatRuntime.prototype,'start').mockImplementation(async input=>{
        await input.tools![0]!.execute({},input.signal);
        return {result:Promise.resolve({text:'Sample total 30',finalText:'Sample total 30',stopReason:'completed'}),dispose};
      });
      try{
        const verified=await cli(f.home,'connection','verify',connection.id,'--key','verify');expect(verified.passed).toBe(true);expect(verified.connection).not.toHaveProperty('credentialRef');
        expect(verified.connection.verification).toMatchObject({toolCalls:1,conversation:true,cleanupConfirmed:true});expect(dispose).toHaveBeenCalledOnce();
        expect(await cli(f.home,'connection','verify',connection.id,'--key','verify')).toEqual(verified);expect(dispose).toHaveBeenCalledOnce();
      }finally{activation.mockRestore();}
      f.host.config.leadProvider=connection.provider;
      await expect(cli(f.home,'connection','delete',connection.id)).rejects.toMatchObject({stderr:expect.stringContaining('CONNECTION_IN_USE')});
      f.host.config.leadProvider='unused';expect(await cli(f.home,'connection','delete',connection.id)).toEqual({id:connection.id,deleted:true});
      expect(await f.ctx.credentials.resolve(credentialRef(f.reference(connection.id)))).toBeUndefined();
      const ledger=JSON.stringify(f.host.store.all('SELECT * FROM management_requests')),rows=JSON.stringify(f.host.store.all('SELECT * FROM api_connections'));
      expect(ledger+rows).not.toContain(secret);expect(ledger).not.toContain(f.reference(connection.id));
      const disabled=await f.management('POST','/ui-api/v1/connections',{});expect(disabled.status).not.toBe(200);
      await expect(cli(f.home,'connection','create','--data',JSON.stringify({apiKey:secret}))).rejects.toMatchObject({stderr:expect.not.stringContaining(secret)});
      await writeFile(config,`{"apiKey":"${secret}",`);
      await expect(cli(f.home,'connection','create','--file',config)).rejects.toMatchObject({stderr:expect.stringContaining('INVALID_JSON')});
      try{await cli(f.home,'connection','create','--file',config);}catch(error){expect((error as {stderr:string}).stderr).not.toContain(secret);}
    }finally{await f.close();}
  });
  it.each(['slow-success','service-timeout','cleanup-timeout','client-timeout'] as const)('waits for the real verification lifecycle: %s',async mode=>{
    const f=await fixture(false);
    const waitUntil=async(predicate:()=>boolean)=>{
      for(let i=0;i<1000;i++){if(predicate())return;await sleep(2);}
      throw new Error('HTTP lifecycle did not reach the expected phase');
    };
    try{
      const connection=await f.host.handle('POST','/v1/connections',{name:'Slow verification',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'test',apiKey:'test-only-key'},'create-slow') as {id:string};
      const route=`/v1/connections/${connection.id}/verify`;
      vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
      const dispose=vi.fn(()=>mode==='cleanup-timeout'?new Promise<void>(()=>{}):new Promise<void>(resolve=>setTimeout(resolve,4000)));
      const activation=vi.spyOn(DshChatRuntime.prototype,'start').mockImplementation(async input=>{
        await input.tools[0]!.execute({},input.signal);
        return {result:['service-timeout','cleanup-timeout'].includes(mode)?new Promise<never>(()=>{}):new Promise(resolve=>setTimeout(()=>resolve({text:'Total 30',finalText:'Total 30',stopReason:'completed' as const}),40000)),dispose};
      });
      let first:any,second:any,failure:any,firstDone=false,secondDone=false;
      const firstRequest=managementRequest(f.home,'POST',route,{},'slow-first').then(value=>{first=value;firstDone=true;});
      await waitUntil(()=>activation.mock.calls.length===1);
      const secondRequest=mode==='client-timeout'?managementRequest(f.home,'POST',route,{},'slow-second').then(value=>{second=value;secondDone=true;},error=>{failure=error;secondDone=true;}):undefined;
      if(secondRequest)await waitUntil(()=>!!f.host.store.get("SELECT key FROM management_requests WHERE key='slow-second'"));
      await vi.advanceTimersByTimeAsync(35001);
      expect(firstDone).toBe(false);expect(secondDone).toBe(false);expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(['service-timeout','cleanup-timeout'].includes(mode)?24999:4999);
      await waitUntil(()=>dispose.mock.calls.length===1);
      expect(firstDone).toBe(false);
      await vi.advanceTimersByTimeAsync(mode==='cleanup-timeout'?5000:4000);
      await waitUntil(()=>firstDone);await firstRequest;
      expect(first.passed).toBe(mode==='slow-success'||mode==='client-timeout');
      expect(first.connection.verification.cleanupConfirmed).toBe(mode!=='cleanup-timeout');
      expect(first.connection.verification.toolCalls).toBe(1);
      if(mode==='service-timeout')expect(first.error).toContain('timed out');
      if(mode==='cleanup-timeout')expect(first.error).toContain('cleanup');
      if(secondRequest){
        await waitUntil(()=>activation.mock.calls.length===2);
        await vi.advanceTimersByTimeAsync(26000);
        await waitUntil(()=>secondDone);await secondRequest;
        expect(second).toBeUndefined();
        expect(failure).toMatchObject({code:'REQUEST_TIMEOUT',message:expect.stringContaining('outcome is unknown')});
        expect(failure.message).toContain('--key "slow-second"');
        expect(f.host.store.get<{status:string}>("SELECT status FROM management_requests WHERE key='slow-second'")?.status).toBe('pending');
        await expect(managementRequest(f.home,'POST',route,{},'slow-second')).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});
        expect(activation).toHaveBeenCalledTimes(2); // No automatic replay or replacement key.
        await vi.advanceTimersByTimeAsync(14000);
        await waitUntil(()=>dispose.mock.calls.length===2);
        await vi.advanceTimersByTimeAsync(4000);
        await waitUntil(()=>f.host.store.get<{status:string}>("SELECT status FROM management_requests WHERE key='slow-second'")?.status==='completed');
        expect((await managementRequest(f.home,'POST',route,{},'slow-second')).passed).toBe(true);
        expect(activation).toHaveBeenCalledTimes(2);
      }else{
        expect(await managementRequest(f.home,'POST',route,{},'slow-first')).toEqual(first);
        expect(activation).toHaveBeenCalledOnce();
      }
    }finally{vi.useRealTimers();vi.restoreAllMocks();await f.close();}
  });
  it('denies management without token, cookie writes without CSRF, foreign workspace ids and agent global scope',async()=>{
    const f=await fixture();try{
      expect((await fetch(f.origin+'/v1/connections')).status).toBe(401);
      await expect(f.host.handleBrowser('GET','/v1/connections',{})).rejects.toMatchObject({code:'NOT_FOUND'});
      const browser=await f.browser('POST','/workspaces',{name:'Own'}),w=browser.value.id;
      const session=await fetch(f.origin+'/ui-api/v1/session/connect',{method:'POST',headers:{Origin:f.origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:'{}'});
      const noCsrf=await fetch(f.origin+'/ui-api/v1/connections',{method:'POST',headers:{Origin:f.origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',Cookie:session.headers.get('set-cookie')!.split(';')[0]!},body:'{}'});expect(noCsrf.status).toBe(403);
      const actor={legacy:true as const,workspaceId:w,agentId:`${w}:lead`,assertLive(){}};
      await expect(f.host.workspaceCli.execute(w,{argv:['connection','create'],input:{}},actor,'create')).rejects.toMatchObject({code:'UNKNOWN_COMMAND'});
      await expect(f.host.workspaceCli.execute(w,{argv:['workspace','grant-path'],input:{path:'/tmp'}},actor,'grant')).rejects.toMatchObject({code:'OPERATOR_REQUIRED'});
      const foreign=(await f.browser('POST','/workspaces',{name:'Foreign'})).value;
      const flow=await f.host.handle('POST','/v1/workflows',{workspaceId:foreign.id,mode:'analysis',goal:'Text only',startLead:false},randomUUID()) as {id:string};
      expect((await f.browser('POST',`/workspaces/${w}/workflows/${flow.id}/pause`,{expectedVersion:0})).value.error.code).toBe('NOT_FOUND');
      await expect(cli(f.home,'ws','workflow','show',flow.id,'--workspace',w)).rejects.toMatchObject({stderr:expect.stringContaining('NOT_FOUND')});
    }finally{await f.close();}
  });
});
