import { describe,it,expect } from 'vitest';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from '../../src/git/process.js';
const exec=promisify(execFile);
describe('Host Git configuration boundary',()=>{
 it('checks worktree configuration as well as repository configuration before invoking Git helpers',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-git-config-')),repo=path.join(root,'repo');await mkdir(repo);
  try{
   await exec('git',['init','-q',repo]);
   await exec('git',['-C',repo,'config','extensions.worktreeConfig','true']);
   await exec('git',['-C',repo,'config','--worktree','core.fsmonitor','not-an-approved-helper']);
   await expect(git(repo,['status','--porcelain'])).rejects.toThrow('UNSAFE_GIT_CONFIG');
   await exec('git',['-C',repo,'config','--worktree','--unset','core.fsmonitor']);
   await exec('git',['-C',repo,'config','--worktree','include.path','unapproved-config']);
   await expect(git(repo,['status','--porcelain'])).rejects.toThrow('UNSAFE_GIT_CONFIG');
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
