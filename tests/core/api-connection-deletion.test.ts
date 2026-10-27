import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiConnectionService } from '../../src/agent/connections.js';
import { RiftStore } from '../../src/storage/database.js';

const disposers:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const dispose of disposers.splice(0).reverse())await dispose();});
const route={name:'Disposable',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'test'};
async function fixture(){
  const home=await mkdtemp(path.join(tmpdir(),'rift-delete-api-')),ctx=new Context(),store=new RiftStore();
  disposers.push(async()=>{store.close();await rm(home,{recursive:true,force:true});});
  const llm=await ctx.plugin(LlmRuntime);disposers.push(()=>llm.dispose());
  const credentials=await ctx.plugin(LocalCredentialProvider,{path:path.join(home,'.credentials.yaml'),watch:false});disposers.push(()=>credentials.dispose());
  const service=new ApiConnectionService(ctx,store,home);await service.initialize();disposers.push(()=>service.close());
  return{home,ctx,store,service};
}
describe('API connection tombstones and owned credential cleanup',()=>{
  it('deletes an idle parent without changing its revision descendants or remounting it',async()=>{
    const f=await fixture(),parent=await f.service.create({...route,apiKey:'delete-parent-fake-key'});
    const child=await f.service.create({...route,apiKey:'keep-child-fake-key',parentId:parent.id});
    expect(await f.service.remove(parent.id)).toEqual({id:parent.id,deleted:true});
    expect(f.service.list().map(item=>item.id)).toEqual([child.id]);expect(f.service.get(child.id)).toMatchObject({parentId:parent.id,revision:2});
    expect(f.store.get('SELECT deleted_at,credential_deleted_at,credential_owned FROM api_connections WHERE id=?',parent.id)).toMatchObject({deletedAt:expect.any(String),credentialDeletedAt:expect.any(String),credentialOwned:1});
    expect(await f.ctx.credentials.resolve(credentialRef(parent.credentialRef))).toBeUndefined();
    expect((await f.ctx.credentials.resolve(credentialRef(child.credentialRef)))?.value).toBe('keep-child-fake-key');
    await expect(f.service.verify(parent.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(await f.service.remove(parent.id)).toEqual({id:parent.id,deleted:true});
    await f.service.close();const restored=new ApiConnectionService(f.ctx,f.store,f.home);disposers.push(()=>restored.close());await restored.initialize();
    expect(restored.list().map(item=>item.id)).toEqual([child.id]);expect(f.ctx.llm.listProviders().map(item=>item.id)).not.toContain(parent.provider);
  });
  it('preserves user-managed credentials, including names resembling generated keys',async()=>{
    const f=await fixture(),ref='RIFT_API_012345678901234567890123456789AB';
    await f.ctx.credentials.set(credentialRef(ref),'user-managed-fake-key');
    const connection=await f.service.create({...route,credentialRef:ref});const unset=vi.spyOn(f.ctx.credentials,'unset');
    await f.service.remove(connection.id);expect(unset).not.toHaveBeenCalled();expect((await f.ctx.credentials.resolve(credentialRef(ref)))?.value).toBe('user-managed-fake-key');
  });
  it('keeps the route withdrawn after cleanup failure and resumes cleanup on service restart',async()=>{
    const f=await fixture(),connection=await f.service.create({...route,apiKey:'pending-cleanup-fake-key'});
    const unset=vi.spyOn(f.ctx.credentials,'unset').mockRejectedValueOnce(new Error('controlled storage failure'));
    await expect(f.service.remove(connection.id)).rejects.toMatchObject({code:'CREDENTIAL_CLEANUP_PENDING'});
    expect(f.service.list()).toEqual([]);expect(f.ctx.llm.listProviders().map(item=>item.id)).not.toContain(connection.provider);
    expect(f.store.get('SELECT deleted_at,credential_deleted_at FROM api_connections WHERE id=?',connection.id)).toMatchObject({deletedAt:expect.any(String),credentialDeletedAt:null});
    unset.mockRestore();await f.service.close();const restored=new ApiConnectionService(f.ctx,f.store,f.home);disposers.push(()=>restored.close());await restored.initialize();
    expect(restored.list()).toEqual([]);expect(await f.ctx.credentials.resolve(credentialRef(connection.credentialRef))).toBeUndefined();
    expect(f.store.get('SELECT credential_deleted_at FROM api_connections WHERE id=?',connection.id)).toMatchObject({credentialDeletedAt:expect.any(String)});
  });
  it('rolls back provider withdrawal when tombstone persistence fails',async()=>{
    const f=await fixture(),connection=await f.service.create({...route,apiKey:'retain-on-db-failure'});
    f.store.exec("CREATE TRIGGER reject_deletion BEFORE UPDATE OF deleted_at ON api_connections BEGIN SELECT RAISE(ABORT,'controlled persistence failure'); END");
    await expect(f.service.remove(connection.id)).rejects.toThrow('controlled persistence failure');
    expect(f.service.get(connection.id).available).toBe(true);expect((await f.ctx.credentials.resolve(credentialRef(connection.credentialRef)))?.value).toBe('retain-on-db-failure');
  });
  it('migrates only exact unique Host-generated credential ownership',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-delete-migration-')),filename=path.join(home,'rift.db');
    let store=new RiftStore(filename);
    try{
      store.db.exec('ALTER TABLE api_connections DROP COLUMN deleted_at; ALTER TABLE api_connections DROP COLUMN credential_deleted_at; ALTER TABLE api_connections DROP COLUMN credential_owned; DELETE FROM schema_migrations WHERE version=17;');
      const own='connection-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',shared='connection-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      for(const [id,ref] of [[own,'RIFT_API_'+'A'.repeat(32)],[shared,'RIFT_API_'+'B'.repeat(32)],['connection-shared-user','RIFT_API_'+'B'.repeat(32)],['connection-prefixed-user','RIFT_API_USER_MANAGED']])store.exec('INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id!,id!,'openai-completions','https://example.invalid','test',ref!,id!,1,'now');
      store.close();store=new RiftStore(filename);
      expect(store.get('SELECT credential_owned FROM api_connections WHERE id=?',own)).toEqual({credentialOwned:1});
      expect(store.all<{credentialOwned:number}>('SELECT credential_owned FROM api_connections WHERE id<>?',own).every(row=>row.credentialOwned===0)).toBe(true);
    }finally{store.close();await rm(home,{recursive:true,force:true});}
  });
});
