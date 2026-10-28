import { describe,expect,it,vi } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { redact } from '../../src/api/security.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { RiftHostService } from '../../src/api/host-service.js';
import { seedWorkspace } from './fixtures.js';
import { ApiConnectionService,type ApiConnection } from '../../src/agent/connections.js';
import { RiftStore } from '../../src/storage/database.js';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';

async function connections(){
  const home=await mkdtemp(path.join(tmpdir(),'rift-connection-delete-review-')),ctx=new Context(),llm=await ctx.plugin(LlmRuntime),secrets=await ctx.plugin(LocalCredentialProvider,{path:path.join(home,'.credentials.yaml'),watch:false});
  const host=new RiftHostService(ctx,{home:path.join(home,'host'),port:0,leadProvider:'unused',leadModel:'unused',checks:[]});await host.connections.initialize();const seed=seedWorkspace(host.store,'delete-review');let sequence=0;
  const create=(extra:Record<string,unknown>={})=>host.handleBrowser('POST','/ui-api/v1/connections',{name:'Review connection',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'review-model',apiKey:'deletion-independent-fake-key',...extra},`create-${sequence++}`) as Promise<ApiConnection>;
  const remove=(id:string)=>host.handleBrowser('DELETE',`/ui-api/v1/connections/${id}`,{},`delete-${sequence++}`);
  return{home,ctx,host,seed,create,remove,reference:(id:string)=>host.store.require<{credentialRef:string}>('SELECT credential_ref FROM api_connections WHERE id=?',id).credentialRef,close:async()=>{await host.close();await secrets.dispose();await llm.dispose();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-connection-delete-review-'))throw new Error('Unsafe cleanup');await rm(home,{recursive:true,force:true});}};
}

describe('Independent API connection management boundaries',()=>{
  it('returns a fixed HTTP parse error without echoing unregistered credentials from malformed request bodies',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-connection-management-review-')),handle=vi.fn(async(_method:string,_pathname:string,body:unknown)=>({accepted:body}));
    const api=await startLocalApi({handle},{home,port:0});
    try{
      const token=(await readFile(path.join(home,'management.token'),'utf8')).trim(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':'parse-review'},url=`http://127.0.0.1:${api.port}/v1/connections`;
      for(const body of ['fakeIndependentCredentialNeverRegistered invalid-json','{"apiKey":"fakeIndependentCredentialNeverRegistered",','{"name": "unclosed']){
        const response=await fetch(url,{method:'POST',headers,body}),text=await response.text();expect(response.status).toBe(400);expect(JSON.parse(text)).toEqual({error:{code:'INVALID_JSON',message:'Request body must be valid JSON.'}});expect(text).not.toContain('fakeIndepend');expect(text).not.toContain(body);
      }
      expect(handle).not.toHaveBeenCalled();const valid=await fetch(url,{method:'POST',headers,body:'{"name":"Valid request"}'});expect(valid.status).toBe(200);expect(await valid.json()).toEqual({accepted:{name:'Valid request'}});expect(handle).toHaveBeenCalledOnce();
    }finally{await api.close();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-connection-management-review-'))throw new Error('Unsafe cleanup');await rm(home,{recursive:true,force:true});}
  });

  it.each(['workspace-lead','member-chat','member-execution'] as const)('refuses deletion while a current %s selection uses the route',async mode=>{
    const f=await connections();try{
      const connection=await f.create(),developer=f.seed.roles.find(role=>role.purpose==='developer')!,selection=JSON.stringify({runtime:'dsh',provider:connection.provider,model:connection.model});
      if(mode==='workspace-lead')f.host.store.exec('UPDATE workspaces SET lead_connection=? WHERE id=?',selection,f.seed.workspace.id);
      if(mode==='member-chat')f.host.store.exec('UPDATE roles SET chat_connection=? WHERE id=?',selection,developer.id);
      if(mode==='member-execution')f.host.store.exec('UPDATE provider_bindings SET runtime=?,spawn=? WHERE id=?','dsh',JSON.stringify({provider:connection.provider,model:connection.model}),developer.providerBindingId!);
      await expect(f.remove(connection.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'});expect(f.host.connections.get(connection.id).available).toBe(true);expect((await f.ctx.credentials.resolve(credentialRef(f.reference(connection.id))))?.value).toBe('deletion-independent-fake-key');
    }finally{await f.close();}
  });

  it('also retains a saved route selected by the Host default Lead configuration',async()=>{
    const f=await connections();try{const connection=await f.create();f.host.config.leadProvider=connection.provider;await expect(f.remove(connection.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'});expect(f.host.connections.get(connection.id).available).toBe(true);}finally{await f.close();}
  });

  it('retains queued Turn and unresolved Run snapshots after Agent settings change, then preserves history when deletion becomes safe',async()=>{
    const f=await connections();try{
      const connection=await f.create(),developer=f.seed.roles.find(role=>role.purpose==='developer')!,conversation=f.host.chat.createConversation(f.seed.workspace.id,'Historical route');
      f.host.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES('old-message',?,?,?,'user','Preserve prior request','queued','now')",f.seed.workspace.id,conversation.id,developer.id);
      f.host.store.exec("INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('old-turn',?,?,'old-message',?,'queued',?,'now')",f.seed.workspace.id,conversation.id,developer.id,JSON.stringify({connection:{runtime:'dsh',provider:connection.provider,model:connection.model}}));
      await expect(f.remove(connection.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'});
      f.host.store.exec("UPDATE agent_turns SET status='completed',cleanup_status='confirmed' WHERE id='old-turn'");
      f.host.store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('old-workflow',?,'Historical work','running','','')",f.seed.workspace.id);
      f.host.store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('old-task','old-workflow',?,'analysis','Task','Inspect','[]','[]','running')",developer.id);
      f.host.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('old-run','old-task',?,'develop',1,'running',?,'later','now')",developer.id,JSON.stringify({role:developer,binding:{providerName:'spawn',spawn:{provider:connection.provider,model:connection.model}}}));
      await expect(f.remove(connection.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'});
      f.host.store.exec("UPDATE runs SET status='succeeded',cleanup_status='unknown' WHERE id='old-run'");
      await expect(f.remove(connection.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'});
      f.host.store.exec("UPDATE runs SET cleanup_status='confirmed',slot_released_at='done' WHERE id='old-run'");
      const before=f.host.store.all('SELECT * FROM runs'),messages=f.host.store.all('SELECT * FROM messages'),turns=f.host.store.all('SELECT * FROM agent_turns');
      expect(await f.remove(connection.id)).toEqual({id:connection.id,deleted:true});expect(f.host.connections.list()).toEqual([]);expect(f.ctx.llm.listProviders().some(item=>item.id===connection.provider)).toBe(false);
      expect(f.host.store.all('SELECT * FROM runs')).toEqual(before);expect(f.host.store.all('SELECT * FROM messages')).toEqual(messages);expect(f.host.store.all('SELECT * FROM agent_turns')).toEqual(turns);
      expect(f.host.store.require<{deletedAt:string}>('SELECT deleted_at FROM api_connections WHERE id=?',connection.id).deletedAt).toBeTruthy();expect(await f.ctx.credentials.resolve(credentialRef(f.reference(connection.id)))).toBeUndefined();
    }finally{await f.close();}
  });

  it('does not delete a shared generated key until its last saved reference is removed',async()=>{
    const f=await connections();try{
      const owner=await f.create(),alias=await f.create({name:'Shared existing reference',apiKey:undefined,credentialRef:f.reference(owner.id)});
      await expect(f.remove(owner.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'});await f.remove(alias.id);expect((await f.ctx.credentials.resolve(credentialRef(f.reference(owner.id))))?.value).toBe('deletion-independent-fake-key');
      await f.remove(owner.id);expect(await f.ctx.credentials.resolve(credentialRef(f.reference(owner.id)))).toBeUndefined();
    }finally{await f.close();}
  });

  it('never treats an existing environment or managed reference as owned merely because its name starts with RIFT_API_',async()=>{
    const f=await connections(),reference='RIFT_API_LEGACY_INDEPENDENT_REFERENCE',previous=process.env[reference];process.env[reference]='legacy-environment-key';
    try{
      await f.ctx.credentials.set(credentialRef(reference),'legacy-managed-key');const unset=vi.spyOn(f.ctx.credentials,'unset'),connection=await f.create({apiKey:undefined,credentialRef:reference});
      await f.remove(connection.id);expect(unset).not.toHaveBeenCalled();expect((await f.ctx.credentials.resolve(credentialRef(reference)))?.value).toBe('legacy-managed-key');expect(process.env[reference]).toBe('legacy-environment-key');unset.mockRestore();
    }finally{if(previous===undefined)delete process.env[reference];else process.env[reference]=previous;await f.close();}
  });

  it('uses one actual completion suffix and preserves a redacted provider 404 through real DSH verification, including old stored full endpoints',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-verify-endpoint-review-')),previousHome=process.env.DSH_HOME,key='independent-error-echo-fake-key';let fail=false;
    const requests:{url:string;authorization:string;model:string}[]=[];
    const server=http.createServer(async(req,res)=>{
      const parts:Buffer[]=[];for await(const chunk of req)parts.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(parts).toString('utf8'));requests.push({url:req.url??'',authorization:req.headers.authorization??'',model:body.model});
      if(fail){res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:`INDEPENDENT_MODEL_ROUTE_404 ${key}`,type:'invalid_request_error',code:'model_not_found'}}));return;}
      // Current verification requires an actual tool round-trip, not the old
      // fixed-token reply. Keep exercising the real DSH HTTP adapter here.
      const replied=body.messages.some((message:{role:string})=>message.role==='tool');
      const delta=replied?{role:'assistant',content:'订单包含笔记本和铅笔，总额为三十元。'}:{role:'assistant',tool_calls:[{index:0,id:'endpoint-order',type:'function',function:{name:'rift_sample_order',arguments:'{}'}}]};
      res.writeHead(200,{'Content-Type':'text/event-stream'});for(const [chunk,reason] of [[delta,null],[{},replied?'stop':'tool_calls']] as const)res.write(`data: ${JSON.stringify({id:'endpoint-review',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:chunk,finish_reason:reason}]})}\n\n`);res.end('data: [DONE]\n\n');
    });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`,full=`${base}/chat/completions`;
    process.env.DSH_HOME=path.join(home,'dsh');initializeProfileFromDefault('endpoint-review','sdk-minimal',process.env.DSH_HOME);
    const patch=path.join(home,'headless.patch.yml');await writeFile(patch,'- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n');
    const runtime=await runProfile({environment:loadLayeredEnv('endpoint-review'),profile:'endpoint-review',patchFiles:[patch],args:[]}),store=new RiftStore();
    await runtime.ctx.plugin(LocalCredentialProvider,{path:path.join(home,'.credentials.yaml'),watch:false});let service=new ApiConnectionService(runtime.ctx,store,home);
    try{
      await service.initialize();const connection=await service.create({name:'Full endpoint',protocol:'openai-completions',endpoint:`${full}/`,model:'claude-5.5-review',apiKey:key});expect(connection.endpoint).toBe(base);
      const verified=await service.verify(connection.id);expect(verified.passed,redact(JSON.stringify({verified,requests}))).toBe(true);expect(verified.connection.verification).toMatchObject({toolCalls:1,conversation:true,cleanupConfirmed:true});
      expect(requests).toEqual(Array.from({length:2},()=>({url:'/v1/chat/completions',authorization:`Bearer ${key}`,model:'claude-5.5-review'})));
      await service.close();store.exec('UPDATE api_connections SET endpoint=? WHERE id=?',full,connection.id);service=new ApiConnectionService(runtime.ctx,store,home);await service.initialize();fail=true;
      const result=await service.verify(connection.id);expect(result.passed).toBe(false);expect(result.error).toContain('INDEPENDENT_MODEL_ROUTE_404');expect(JSON.stringify(result)).not.toContain(key);expect(result.connection.verificationError).toBe(result.error);
      expect(requests).toHaveLength(3);expect(requests[2]!.url).toBe('/v1/chat/completions');expect(requests[2]!.authorization).toBe(`Bearer ${key}`);expect(JSON.stringify(store.all('SELECT * FROM api_connections'))).not.toContain(key);
    }finally{await service.close();store.close();await runtime.shutdown.shutdown(0);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-verify-endpoint-review-'))throw new Error('Unsafe cleanup');await rm(home,{recursive:true,force:true});}
  },30000);
});
