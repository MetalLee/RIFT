import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm,readFile,link,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {sandboxCommand} from '../../src/agent/filesystem-sandbox.js';
const exec=promisify(execFile);
describe('workspace package tooling',()=>{
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
 it.runIf(process.env.RIFT_NETWORK_TESTS==='1')('installs, updates, executes and removes npm dependencies through public egress',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-npm-'));await writeFile(path.join(root,'package.json'),'{"name":"rift-install-test","private":true}');
  try{
   const argv=await sandboxCommand([root],root,`set -eu; npm install --no-audit --no-fund is-number@6.0.0; npm install --no-audit --no-fund is-number@7.0.0; node -e "if(require('is-number/package.json').version!=='7.0.0')process.exit(1)"; npm uninstall --no-audit --no-fund is-number; test ! -e node_modules/is-number; echo INSTALL_UPDATE_REMOVE_OK`);
   expect((await exec(argv[0]!,argv.slice(1),{timeout:90000})).stdout).toContain('INSTALL_UPDATE_REMOVE_OK');
  }finally{await rm(root,{recursive:true,force:true});}
 },120000);
});
