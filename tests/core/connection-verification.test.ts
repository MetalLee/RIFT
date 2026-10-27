import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {ApiConnectionService} from '../../src/agent/connections.js';
import {DshChatRuntime} from '../../src/chat/dsh-runtime.js';
import {RiftStore} from '../../src/storage/database.js';
import {seedWorkspace} from '../acceptance/fixtures.js';

afterEach(()=>vi.restoreAllMocks());
describe('actual conversation and tool connection verification',()=>{
  it.each(['natural-reply','no-tool','no-final-reply','provider-error','cleanup-error'] as const)('records %s without replacing configured models',async mode=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-connection-verification-'));
    const database=path.join(home,'ledger.db'),store=new RiftStore(database);
    seedWorkspace(store);
    const before=JSON.stringify({roles:store.all('SELECT * FROM roles'),bindings:store.all('SELECT * FROM provider_bindings')});
    const ctx={llm:{listProviders:()=>[{id:'selected-api'}]}} as unknown as Context;
    store.exec("INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at) VALUES('selected','Selected','openai-completions','https://example.invalid','claude-selected','API_KEY','selected-api',1,'now')");
    const service=new ApiConnectionService(ctx,store,home);
    vi.spyOn(DshChatRuntime.prototype,'start').mockImplementation(async input=>{
      expect(input.model).toBe('claude-selected');expect(input.repositoryAccess).toBeUndefined();
      expect(input.messages[0]!.content).toContain('订单');expect(input.instructions).not.toContain('RIFT_API_OK');
      expect(input.tools.map(t=>t.name)).toEqual(['rift_sample_order']);
      if(mode!=='no-tool'){
        await expect(input.tools[0]!.execute({path:'do-not-read'},input.signal)).rejects.toThrow();
        expect(await input.tools[0]!.execute({},input.signal)).toMatchObject({total:30,currency:'CNY'});
      }
      const finalText=mode==='no-final-reply'?'':'订单包含笔记本和铅笔，总额为三十元。 token=private-value';
      return{result:Promise.resolve({text:'Earlier pre-tool text',finalText,stopReason:mode==='provider-error'?'failed':'completed',...(mode==='provider-error'?{diagnostic:'Provider finish_reason: content_filter token=private-value'}:{})}),async dispose(){if(mode==='cleanup-error')throw new Error('cleanup failed');}};
    });
    try{
      const result=await service.verify('selected');
      expect(result.passed).toBe(mode==='natural-reply');
      expect(result.connection.verification).toMatchObject({method:'conversation-and-tool',toolCalls:mode==='no-tool'?0:1,conversation:!['no-final-reply','provider-error'].includes(mode),cleanupConfirmed:mode!=='cleanup-error'});
      expect(JSON.stringify(result)).not.toContain('private-value');
      if(mode==='no-tool')expect(result.error).toContain('不能据此判断普通对话不可用');
      if(mode==='provider-error')expect(result.error).toContain('content_filter');
      expect(JSON.stringify({roles:store.all('SELECT * FROM roles'),bindings:store.all('SELECT * FROM provider_bindings')})).toBe(before);
      const persisted=store.require<{result:unknown}>('SELECT result FROM api_connection_verifications WHERE connection_id=?','selected');
      expect(persisted.result).toEqual(result.connection.verification);
      const reopened=new RiftStore(database,{lock:false});
      try{expect(new ApiConnectionService(ctx,reopened,home).get('selected').verification).toEqual(result.connection.verification);}finally{reopened.close();}
    }finally{await service.close();store.close();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-connection-verification-'))throw new Error('Unsafe cleanup');await rm(home,{recursive:true,force:true});}
  });
});
