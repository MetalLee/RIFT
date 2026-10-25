import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMetadataLock } from '../../src/git/worktree-binding.js';

it('honors a repository metadata lease held by another OS process',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rift-os-lock-'));
  const child=spawn(process.execPath,['--input-type=module','-e',`import { DatabaseSync } from 'node:sqlite';import { join } from 'node:path';const lease=new DatabaseSync(join(process.argv[1],'rift-metadata.lock.db'));lease.exec('BEGIN EXCLUSIVE');process.stdout.write('locked');process.stdin.once('data',()=>{lease.close();process.exit(0);});`,directory],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit');
  let waiting:Promise<void>|undefined;
  try{
    await once(child.stdout,'data');let entered=false;
    waiting=withMetadataLock(directory,async()=>{entered=true;});
    await new Promise(resolve=>setTimeout(resolve,80));expect(entered).toBe(false);
    child.stdin.end('release');await exited;await waiting;expect(entered).toBe(true);
  }finally{if(child.exitCode===null)child.kill();await exited;await waiting;await rm(directory,{recursive:true});}
},10_000);
