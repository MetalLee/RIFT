import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiConnectionService } from '../../src/agent/connections.js';
import { publicError, redact } from '../../src/api/security.js';
import { RiftStore } from '../../src/storage/database.js';

const dispose: Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of dispose.splice(0).reverse())await close();});
const route={name:'Direct API',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'test-model'};
async function fixture(withCredentials=true){
  const home=await mkdtemp(path.join(tmpdir(),'rift-api-key-')),ctx=new Context(),store=new RiftStore();
  dispose.push(async()=>{store.close();await rm(home,{recursive:true,force:true});});
  const llm=await ctx.plugin(LlmRuntime);dispose.push(()=>llm.dispose());
  if(withCredentials){const secrets=await ctx.plugin(LocalCredentialProvider,{path:path.join(home,'.credentials.yaml'),watch:false});dispose.push(()=>secrets.dispose());}
  const service=new ApiConnectionService(ctx,store,home);await service.initialize();dispose.push(()=>service.close());
  return{home,ctx,store,service,reference:(id:string)=>store.require<{credentialRef:string}>('SELECT credential_ref FROM api_connections WHERE id=?',id).credentialRef,};
}
describe('Direct API keys use the official credential store',()=>{
  it('stores independent keys per immutable revision and never serializes them into routes, profiles or environment',async()=>{
    const f=await fixture(),firstKey='direct-fake-first-credential',secondKey='direct-fake-second-credential';
    const first=await f.service.create({...route,apiKey:firstKey});
    const second=await f.service.create({...route,apiKey:secondKey,parentId:first.id});
    expect(f.reference(first.id)).toMatch(/^RIFT_API_[A-F0-9]{32}$/);expect(f.reference(second.id)).not.toBe(f.reference(first.id));
    expect((await f.ctx.credentials.resolve(credentialRef(f.reference(first.id))))?.value).toBe(firstKey);
    expect((await f.ctx.credentials.resolve(credentialRef(f.reference(second.id))))?.value).toBe(secondKey);
    expect(second.revision).toBe(2);expect(process.env[f.reference(first.id)]).toBeUndefined();
    for(const value of [first,second,f.service.list(),f.store.all('SELECT * FROM api_connections'),f.ctx.llm.listProviders()]){
      expect(JSON.stringify(value)).not.toContain(firstKey);expect(JSON.stringify(value)).not.toContain(secondKey);expect(value).not.toHaveProperty('apiKey');
    }
    expect(redact(`echo ${firstKey} and ${secondKey}`)).not.toContain(firstKey);
    expect(await readFile(path.join(f.home,'.credentials.yaml'),'utf8')).toContain(firstKey);
  });
  it('removes only the new owned secret if connection persistence fails',async()=>{
    const f=await fixture();
    const first=await f.service.create({...route,apiKey:'rollback-existing-key'});
    f.store.exec("CREATE TRIGGER reject_route BEFORE INSERT ON api_connections BEGIN SELECT RAISE(ABORT,'controlled route failure'); END");
    await expect(f.service.create({...route,apiKey:'rollback-new-key',parentId:first.id})).rejects.toThrow('controlled route failure');
    expect(f.service.list()).toHaveLength(1);expect((await f.ctx.credentials.resolve(credentialRef(f.reference(first.id))))?.value).toBe('rollback-existing-key');
    expect(await readFile(path.join(f.home,'.credentials.yaml'),'utf8')).not.toContain('rollback-new-key');
    expect(f.ctx.llm.listProviders().filter(item=>item.id.startsWith('rift-api-')).map(item=>item.id)).toEqual([first.provider]);
  });
  it('rejects direct keys without a managed store while preserving existing credential references',async()=>{
    const f=await fixture(false);
    await expect(f.service.create({...route,apiKey:'missing-store-key'})).rejects.toMatchObject({code:'CREDENTIAL_STORE_UNAVAILABLE'});
    expect(f.service.list()).toEqual([]);
    const connection=await f.service.create({...route,credentialRef:'LEGACY_PROVIDER_AUTH'});
    expect(connection).toMatchObject({available:true});expect(connection).not.toHaveProperty('credentialRef');
    expect(f.reference(connection.id)).toBe('LEGACY_PROVIDER_AUTH');
  });
  it('registers redaction before schema and credential-store failures',async()=>{
    const f=await fixture(),invalidKey='validation-fake-key-value';
    expect(()=>f.service.create({...route,name:'',apiKey:invalidKey})).toThrow();
    expect(redact(`unexpected echo ${invalidKey}`)).not.toContain(invalidKey);
    const failingKey='storage-fake-key-value';vi.spyOn(f.ctx.credentials,'set').mockRejectedValueOnce(new Error(`storage rejected ${failingKey}`));
    const error=await f.service.create({...route,apiKey:failingKey}).catch(error=>publicError(error));
    expect(JSON.stringify(error)).not.toContain(failingKey);expect(f.service.list()).toEqual([]);
  });
  it('rejects missing or ambiguous authentication before writing a secret',async()=>{
    const f=await fixture(),set=vi.spyOn(f.ctx.credentials,'set');
    for(const authentication of [{},{apiKey:''},{apiKey:'fake-ambiguous-key',credentialRef:'EXISTING_AUTH'}])expect(()=>f.service.create({...route,...authentication})).toThrow();
    expect(set).not.toHaveBeenCalled();expect(f.service.list()).toEqual([]);
  });
});
