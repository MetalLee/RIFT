import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeRepositoryRoots} from '../../src/agent/native-codex.js';
import {workflowSchema} from '../../src/api/schemas.js';
describe('registered repository counts',()=>{
 it('accepts 65 registered Git roots without a separate runtime or workflow count permission',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'rift-many-repos-')),exec=promisify(execFile),repos=Array.from({length:65},(_,i)=>path.join(folder,'repo-'+i));
  try{
   for(const repo of repos)await exec('git',['init','-q',repo]);
   const roots=await nativeRepositoryRoots(repos[0]!,repos,new AbortController().signal);
   expect(roots).toHaveLength(130);expect(roots).toEqual(expect.arrayContaining(repos));expect(roots).not.toContain(folder);
   expect(workflowSchema.parse({workspaceId:'workspace',goal:'cross-repository task',repositoryIds:repos.map((_,i)=>'repository-'+i)}).repositoryIds).toHaveLength(65);
  }finally{await rm(folder,{recursive:true,force:true});}
 },30000);
});
