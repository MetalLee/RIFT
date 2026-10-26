/** Real SDK profile composition and official credential persistence; fake key only. */
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { ApiConnectionService } from '../src/agent/connections.js';
import { RiftStore } from '../src/storage/database.js';
import { redact } from '../src/api/security.js';

const root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const temporary=await mkdtemp(path.join(root,'api-credential-store-'));
const results:Record<string,boolean>={};
for(const patch of ['rift.patch.yml','rift.codex.patch.yml']){
  const profile=patch.replaceAll('.','-'),home=path.join(temporary,profile);
  process.env.DSH_HOME=path.join(home,'dsh');process.env.RIFT_HOME=path.join(home,'rift');process.env.RIFT_PORT='0';
  initializeProfileFromDefault(profile,'sdk-minimal',process.env.DSH_HOME);
  let ref='',connectionId='';
  const key=`controlled-profile-credential-${profile}`;
  for(const restart of [false,true]){
    const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv(profile),profile,patchFiles:[path.resolve('profiles',patch)],args:[]});
    const store=new RiftStore(path.join(home,'connections.db')),service=new ApiConnectionService(ctx,store,home);
    try{
      results[`${patch}:officialStoreMounted`]=typeof ctx.get('credentials')?.set==='function';
      await service.initialize();
      if(!restart){const connection=await service.create({name:'Controlled API',protocol:'openai-completions',endpoint:'https://example.invalid/v1',model:'controlled',apiKey:key});ref=connection.credentialRef;connectionId=connection.id;}
      results[`${patch}:${restart?'restart':'initial'}Resolved`]=(await ctx.credentials.resolve(credentialRef(ref)))?.value===key;
      results[`${patch}:${restart?'restart':'initial'}Route`]=service.get(connectionId).available;
      results[`${patch}:${restart?'restart':'initial'}NoKeyInDTO`]=!JSON.stringify(service.list()).includes(key);
      results[`${patch}:${restart?'restart':'initial'}NoEnvironmentMutation`]=process.env[ref]===undefined;
      results[`${patch}:${restart?'restart':'initial'}Redaction`]=!redact(`raw echo ${key}`).includes(key);
    }finally{await service.close();store.close();await shutdown.shutdown(0);}
  }
}
const report={date:new Date().toISOString(),mode:'Actual SDK-minimal profiles with official credentials-local; temporary server stores and fake keys only; no model request',temporary,checks:results,passed:Object.values(results).every(Boolean)};
await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/api-credential-store-probe.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,checks:Object.keys(results).length}));if(!report.passed)process.exitCode=1;
