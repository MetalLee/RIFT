import {createRepositoryShell} from '../../src/agent/repository-shell.js';
import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm,readFile,link,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {sandboxCommand} from '../../src/agent/filesystem-sandbox.js';
const exec=promisify(execFile);
describe('workspace package tooling',()=>{
 it('does not privatize shared inodes inside read-only metadata nested in a writable root',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-readonly-inode-')),project=path.join(root,'project'),metadata=path.join(project,'metadata'),shared=path.join(root,'shared');
  await mkdir(metadata,{recursive:true});await writeFile(shared,'SHARED_METADATA');await link(shared,path.join(metadata,'value'));const before=await stat(shared);
  try{
   const argv=await sandboxCommand([project],project,'cat metadata/value',[],{readOnlyRoots:[metadata]});
   expect((await exec(argv[0]!,argv.slice(1))).stdout).toBe('SHARED_METADATA');
   const after=await stat(path.join(metadata,'value'));expect(after.ino).toBe(before.ino);expect(after.nlink).toBe(2);expect(await readFile(shared,'utf8')).toBe('SHARED_METADATA');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('rejects a writable HOME alias of read-only metadata before executing',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-readonly-home-')),repo=path.join(root,'repo'),metadata=path.join(root,'metadata');await mkdir(repo);await mkdir(metadata);await writeFile(path.join(metadata,'value'),'ORIGINAL');
  try{
   for(const home of [metadata,root,path.join(metadata,'nested')]){
    await expect(sandboxCommand([repo],repo,'echo SHOULD_NOT_EXECUTE',[],{home,readOnlyRoots:[metadata]})).rejects.toMatchObject({code:'FILESYSTEM_SCOPE'});
   }
   expect(await readFile(path.join(metadata,'value'),'utf8')).toBe('ORIGINAL');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('keeps read-only grants effective under writable parents and over writable children',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-readonly-')),child=path.join(root,'child');await mkdir(child);await writeFile(path.join(child,'value'),'ORIGINAL');
  try{
   for(const [writable,readonly] of [[root,child],[child,root]]){
    const argv=await sandboxCommand([writable!],child,`node -e "const fs=require('fs');if(fs.readFileSync('value','utf8')!=='ORIGINAL')process.exit(1);try{fs.writeFileSync('value','CHANGED');process.exit(2)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e;}console.log('READONLY_OK')"`,[],{readOnlyRoots:[readonly!]});
    expect((await exec(argv[0]!,argv.slice(1))).stdout).toBe('READONLY_OK\n');
   }
   expect(await readFile(path.join(child,'value'),'utf8')).toBe('ORIGINAL');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('persists a private HOME across commands and keeps project Skill paths usable',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-package-')),repo=path.join(root,'repo'),home=path.join(root,'host','workspaces','own','shell-home');await mkdir(repo);
  await mkdir(path.join(repo,'.codex','skills'),{recursive:true});await writeFile(path.join(repo,'.codex','auth.json'),'HOST_SECRET');
  try{
   const run=async(cmd:string)=>{const argv=await sandboxCommand([repo],repo,cmd,[path.join(root,'host')],{home});return exec(argv[0]!,argv.slice(1));};
   await run(`set -eu; mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho PERSISTENT_CLI\\n' > "$HOME/.local/bin/sample"; chmod +x "$HOME/.local/bin/sample"; echo SKILL > .codex/skills/SKILL.md; test ! -s .codex/auth.json`);
   expect((await run('sample; cat .codex/skills/SKILL.md')).stdout).toBe('PERSISTENT_CLI\nSKILL\n');
   expect(await readFile(path.join(repo,'.codex','auth.json'),'utf8')).toBe('HOST_SECRET');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('cancels inode preparation promptly without changing the shared source',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-cancel-copy-'));await writeFile(path.join(root,'source'),'ORIGINAL');
  for(let i=0;i<500;i++)await link(path.join(root,'source'),path.join(root,'linked-'+i));
  try{
   const controller=new AbortController(),started=Date.now();const operation=sandboxCommand([root],root,'echo MUST_NOT_SPAWN',[],{signal:controller.signal});
   setTimeout(()=>controller.abort(),20);await expect(operation).rejects.toBeDefined();expect(Date.now()-started).toBeLessThan(2000);
   expect(await readFile(path.join(root,'source'),'utf8')).toBe('ORIGINAL');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('accepts an explicit long-build timeout instead of a fixed five-minute rejection',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-long-build-'));let spawned=false;
  const subprocess={spawn(){spawned=true;return{done:Promise.resolve({exitCode:0}),terminate(){},async waitForExit(){return true;},collected:{}};}};
  const shell=await createRepositoryShell(subprocess as never,{cwd:root,repositoryAccess:{repositoryPaths:[],workspaceDirectory:root},signal:new AbortController().signal});
  try{expect(await shell.tool.execute({cmd:'true',timeoutMs:600000},new AbortController().signal)).toMatchObject({exitCode:0});expect(spawned).toBe(true);}finally{await shell.dispose();await rm(root,{recursive:true,force:true});}
 });
 it.runIf(process.env.RIFT_NETWORK_TESTS==='1')('installs, updates, executes and removes npm dependencies through public egress',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-npm-'));await writeFile(path.join(root,'package.json'),'{"name":"rift-install-test","private":true}');
  try{
   const argv=await sandboxCommand([root],root,`set -eu; npm install --no-audit --no-fund is-number@6.0.0; npm install --no-audit --no-fund is-number@7.0.0; node -e "if(require('is-number/package.json').version!=='7.0.0')process.exit(1)"; npm uninstall --no-audit --no-fund is-number; test ! -e node_modules/is-number; echo INSTALL_UPDATE_REMOVE_OK`);
   expect((await exec(argv[0]!,argv.slice(1),{timeout:90000})).stdout).toContain('INSTALL_UPDATE_REMOVE_OK');
  }finally{await rm(root,{recursive:true,force:true});}
 },120000);
});
