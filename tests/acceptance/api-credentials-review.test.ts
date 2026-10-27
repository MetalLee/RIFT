import { describe,expect,it,vi } from 'vitest';
import http from 'node:http';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { RiftHostService } from '../../src/api/host-service.js';
import { publicError,redact } from '../../src/api/security.js';
import type { ApiConnection } from '../../src/agent/connections.js';

async function open(home:string){
  const ctx=new Context(),llm=await ctx.plugin(LlmRuntime),secrets=await ctx.plugin(LocalCredentialProvider,{path:path.join(home,'.credentials.yaml'),watch:false});
  const host=new RiftHostService(ctx,{home:path.join(home,'host'),port:0,leadProvider:'unused',leadModel:'unused',checks:[]});await host.connections.initialize();
  return{ctx,host,close:async()=>{await host.close();await secrets.dispose();await llm.dispose();}};
}
async function fixture(){
  const home=await mkdtemp(path.join(tmpdir(),'rift-api-credential-review-'));const authorization:string[]=[];
  const server=http.createServer(async(req,res)=>{
    for await(const _chunk of req){/* Drain the model request without logging it. */}
    authorization.push(req.headers.authorization??'');
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({id:'local-review',object:'chat.completion.chunk',created:1,model:'local-model',choices:[{index:0,delta:{role:'assistant',content:'RIFT_API_OK'},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:'local-review',object:'chat.completion.chunk',created:1,model:'local-model',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`);res.end('data: [DONE]\n\n');
  });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const endpoint=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`,route={name:'Independent direct API',protocol:'openai-completions',model:'local-model',endpoint};
  return{home,authorization,route,close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-api-credential-review-'))throw new Error('Unsafe test cleanup');await rm(home,{recursive:true,force:true});}};
}
async function request(ctx:Context,connection:ApiConnection){
  const chunks=[];for await(const chunk of ctx.llm.stream({provider:connection.provider,model:connection.model,messages:[{role:'user',content:[{type:'text',text:'Reply RIFT_API_OK.'}]}],signal:AbortSignal.timeout(10000)}))chunks.push(chunk);
  expect(JSON.stringify(chunks)).toContain('RIFT_API_OK');return chunks;
}

describe('Independent direct API credential integration',()=>{
  it('sends the stored key as the real Bearer header and restores it after a fresh Host and credential-provider restart',async()=>{
    const f=await fixture();let runtime=await open(f.home);const key='independent-stored-fake-key-unique';
    try{
      const connection=await runtime.host.handleBrowser('POST','/ui-api/v1/connections',{...f.route,apiKey:key},'create-direct') as ApiConnection;
      const chunks=await request(runtime.ctx,connection);expect(f.authorization).toEqual([`Bearer ${key}`]);expect(process.env[connection.credentialRef]).toBeUndefined();
      for(const value of [connection,chunks,runtime.host.connections.list(),runtime.host.store.all('SELECT * FROM api_connections'),runtime.host.store.all('SELECT * FROM management_requests')])expect(JSON.stringify(value)).not.toContain(key);
      await runtime.close();runtime=await open(f.home);
      const restored=runtime.host.connections.get(connection.id);expect(restored).toMatchObject({provider:connection.provider,credentialRef:connection.credentialRef,available:true});
      await request(runtime.ctx,restored);expect(f.authorization).toEqual([`Bearer ${key}`,`Bearer ${key}`]);
      expect((await readFile(path.join(f.home,'host','rift.db'))).includes(Buffer.from(key))).toBe(false);
      expect(await readFile(path.join(f.home,'.credentials.yaml'),'utf8')).toContain(key);
    }finally{await runtime.close();await f.close();}
  });

  it('keeps existing environment-reference connections working without copying their credential into configuration',async()=>{
    const f=await fixture(),runtime=await open(f.home),reference='RIFT_INDEPENDENT_LEGACY_AUTH',previous=process.env[reference],key='independent-legacy-fake-key-unique';process.env[reference]=key;
    try{
      const connection=await runtime.host.handleBrowser('POST','/ui-api/v1/connections',{...f.route,credentialRef:reference},'legacy-route') as ApiConnection;
      await request(runtime.ctx,connection);expect(f.authorization).toEqual([`Bearer ${key}`]);expect(connection.credentialRef).toBe(reference);
      expect(JSON.stringify(runtime.host.store.all('SELECT * FROM api_connections'))).not.toContain(key);expect(JSON.stringify(runtime.host.store.all('SELECT * FROM management_requests'))).not.toContain(key);
    }finally{if(previous===undefined)delete process.env[reference];else process.env[reference]=previous;await runtime.close();await f.close();}
  });

  it('does not duplicate secret writes on idempotency replay and keeps failures and cached responses free of submitted keys',async()=>{
    const f=await fixture(),runtime=await open(f.home),key='independent-idempotency-fake-key-unique',failedKey='independent-failure-fake-key-unique',conflictKey='independent-conflict-fake-key-unique';
    const set=vi.spyOn(runtime.ctx.credentials,'set');
    try{
      const body={...f.route,apiKey:key};const first=await runtime.host.handleBrowser('POST','/ui-api/v1/connections',body,'same-key');const replay=await runtime.host.handleBrowser('POST','/ui-api/v1/connections',body,'same-key');expect(replay).toEqual(first);expect(set).toHaveBeenCalledTimes(1);
      await expect(runtime.host.handleBrowser('POST','/ui-api/v1/connections',{...body,apiKey:conflictKey},'same-key')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(redact(`late diagnostic ${conflictKey}`)).not.toContain(conflictKey);
      set.mockRejectedValueOnce(new Error(`controlled credential failure ${failedKey}`));
      const failed=await runtime.host.handleBrowser('POST','/ui-api/v1/connections',{...body,apiKey:failedKey},'failed-key').catch(publicError);expect(JSON.stringify(failed)).not.toContain(failedKey);
      const replayedFailure=await runtime.host.handleBrowser('POST','/ui-api/v1/connections',{...body,apiKey:failedKey},'failed-key').catch(publicError);expect(replayedFailure).toEqual(failed);expect(set).toHaveBeenCalledTimes(2);
      for(const secret of [key,failedKey,conflictKey])for(const value of [first,replay,failed,replayedFailure,runtime.host.connections.list(),runtime.host.store.all('SELECT * FROM management_requests'),runtime.host.store.all('SELECT * FROM api_connections')])expect(JSON.stringify(value)).not.toContain(secret);
      expect(runtime.host.connections.list()).toHaveLength(1);
    }finally{set.mockRestore();await runtime.close();await f.close();}
  });
});
