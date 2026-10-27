import {skillResourceTool} from '../../src/skill/resource-tool.js';
import {workspaceRepositoryAccess} from '../../src/agent/repository-access.js';
import {nativeRepositoryRoots} from '../../src/agent/native-codex.js';
import { describe,it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { sandboxCommand } from '../../src/agent/filesystem-sandbox.js';
import { createRepositoryReadTools } from '../../src/agent/repository-read.js';
import { gitOk } from '../../src/git/process.js';
import type { RuntimeTurnInput,RuntimeTurnResult } from '../../src/agent/runtime-types.js';
const exec=promisify(execFile);
const until=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timeout');};
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'rift-cli-')),home=path.join(root,'host');
 const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'test',leadModel:'test',checks:[],chatOrchestration:false});
 const executions:{input:RuntimeTurnInput;finish:(result:RuntimeTurnResult)=>void}[]=[];
 host.registerChatRuntime('codex',{async start(input){let finish!:(result:RuntimeTurnResult)=>void;const result=new Promise<RuntimeTurnResult>(resolve=>finish=resolve);executions.push({input,finish});return{result,async dispose(){finish({text:'',stopReason:'cancelled'});}};}},['test']);
 await host.initialize();
 const create=async(name:string)=>host.handle('POST','/ui-api/v1/workspaces',{name,leadConnection:{runtime:'codex',model:'test'}},randomUUID()) as Promise<any>;
 const a=await create('own'),b=await create('foreign');
 const call=(argv:string[],input:Record<string,unknown>={},w=a.id)=>host.handle('POST',`/v1/workspaces/${w}/cli`,{argv,input},randomUUID()) as Promise<any>;
 return {root,home,host,a,b,call,executions,close:async()=>{await host.close();await rm(root,{recursive:true,force:true});}};
}
describe('workspace CLI and ordinary default Skill',()=>{
 it('defaults to Lead, remains transferable, preserves exclusions/archival across initialization',async()=>{
  const f=await fixture();try{
   const list=await f.call(['skill','list']);expect(list.skills).toHaveLength(1);const skill=list.skills[0];expect(skill.shared).toBeNull();expect(skill.assignments).toHaveLength(1);
   const members=(await f.call(['agent','list'])).agents;const dev=members.find((x:any)=>x.purpose==='developer');
   expect(skill.assignments[0].agentId).toBe(members.find((x:any)=>x.purpose==='lead').id);
   const assignment=await f.call(['skill','assign',skill.id],{agentId:dev.id,mode:'include',versionId:skill.versions[0].id,expectedRevision:0});expect(assignment.mode).toBe('include');
   expect((await f.call(['skill','effective',dev.id])).instructions).toContain('rift_cli');
   await expect(f.call(['skill','assign',skill.id],{agentId:`${f.b.id}:lead`,mode:'include',versionId:skill.versions[0].id,expectedRevision:0})).rejects.toMatchObject({code:'NOT_FOUND'});
   await f.call(['skill','archive',skill.id],{expectedRevision:skill.revision});
   expect((await f.call(['skill','show',skill.id])).archived).toBe(1);
   const {installWorkspaceSkill}=await import('../../src/skill/default.js');installWorkspaceSkill(f.host.store,f.a.id);expect((await f.call(['skill','show',skill.id])).archived).toBe(1);
   await f.call(['skill','restore',skill.id],{expectedRevision:skill.revision+1});expect((await f.call(['skill','show',skill.id])).archived).toBe(0);
  }finally{await f.close();}
 });
 it('runs the real executable CLI through the management API and retains optimistic concurrency',async()=>{
  const f=await fixture(),api=await startLocalApi(f.host,{home:f.home,port:0,uiEnabled:false});try{
   const cli=(...args:string[])=>exec(process.execPath,['--import','tsx','src/cli/main.ts','ws',...args,'--home',f.home,'--workspace',f.a.id],{cwd:process.cwd()});
   const shown=JSON.parse((await cli('workspace','show')).stdout);expect(shown.workspace.id).toBe(f.a.id);expect(shown).not.toHaveProperty('hostCapacity');
   const body=JSON.stringify({expectedVersion:shown.workspace.version,name:'renamed'});
   const first=await cli('workspace','update','--data',body,'--key','rename');expect(JSON.parse(first.stdout).name).toBe('renamed');
   expect((await cli('workspace','update','--data',body,'--key','rename')).stdout).toBe(first.stdout);
   await expect(cli('workspace','update','--data',body,'--key','stale')).rejects.toMatchObject({code:1,stderr:expect.stringContaining('VERSION_CONFLICT')});
   expect(JSON.parse((await cli('--help')).stdout).commands.skill).toContain('assign');
  }finally{await api.close();await f.close();}
 });
 it('provides member, conversation, skill and diagnostic operations without frontend changes',async()=>{
  const f=await fixture();try{
   const member=await f.call(['agent','create'],{displayName:'analyst',name:'analyst',purpose:'developer',prompt:'Analyze',chatConnection:null});
   const updated=await f.call(['agent','update',member.id],{expectedVersion:member.version,displayName:'Analyst'});expect(updated.displayName).toBe('Analyst');
   expect((await f.call(['agent','disable',member.id],{expectedVersion:updated.version})).enabled).toBe(0);
   const conv=await f.call(['conversation','create'],{title:'Test'});const renamed=await f.call(['conversation','rename',conv.id],{expectedVersion:conv.version,title:'Renamed'});expect(renamed.title).toBe('Renamed');
   expect((await f.call(['conversation','archive',conv.id],{expectedVersion:renamed.version})).archived).toBe(1);
   expect((await f.call(['message','list',conv.id])).messages).toEqual([]);
   await expect(f.call(['message','send',conv.id],{clientMessageId:'archived',content:'hello'})).rejects.toMatchObject({code:'CONVERSATION_ARCHIVED'});
   const directory=path.join(f.root,'skill');await mkdir(directory);await writeFile(path.join(f.root,'linked-skill.md'),'# Sample\nUse receipts.');await link(path.join(f.root,'linked-skill.md'),path.join(directory,'SKILL.md'));
   await expect(f.call(['skill','preview'],{directory})).rejects.toMatchObject({code:'PATH_SCOPE'});
   await f.call(['workspace','grant-path'],{path:directory});
   const preview=await f.call(['skill','preview'],{directory});const imported=await f.call(['skill','import'],{previewId:preview.previewId});expect(imported.version.instructions).toContain('Use receipts');await writeFile(path.join(f.root,'linked-skill.md'),'Changed source');expect((await f.call(['skill','show',imported.skill.id])).versions[0].instructions).toContain('Use receipts');
   expect((await f.call(['queue','list'])).leases).toEqual([]);expect((await f.call(['diagnostic','show'])).workspace.workspace.id).toBe(f.a.id);
   expect((await f.call(['event','list'])).events.length).toBeGreaterThan(0);
  }finally{await f.close();}
 });
 it('imports large Skill resources, assigns ordinary versions and executes immutable script snapshots',async()=>{
  const f=await fixture();try{
   const directory=path.join(f.root,'resource-skill');await mkdir(path.join(directory,'scripts'),{recursive:true});
   await writeFile(path.join(directory,'SKILL.md'),'Use scripts/search.py and data.txt.');await writeFile(path.join(directory,'data.txt'),'x'.repeat(900000));
   await writeFile(path.join(directory,'scripts','search.py'),"from pathlib import Path; print('SKILL_RESOURCE_OK' if len((Path(__file__).parent.parent/'data.txt').read_text())==900000 else 'BAD')");
   await f.call(['workspace','grant-path'],{path:directory});const preview=await f.call(['skill','preview'],{directory});const imported=await f.call(['skill','import'],{previewId:preview.previewId});
   const member=(await f.call(['agent','list'])).agents.find((x:any)=>x.purpose==='developer');
   await f.call(['skill','assign',imported.skill.id],{agentId:member.id,mode:'include',versionId:imported.version.id,expectedRevision:0});
   const effective=await f.call(['skill','effective',member.id],{runtime:'codex'});expect(effective.resources).toHaveLength(2);
   const resources=path.join(f.home,'workspaces',f.a.id,'skill-resources'),snapshot=path.join(resources,imported.version.id);expect(effective.instructions).toContain(snapshot);
   await writeFile(path.join(directory,'scripts','search.py'),"raise Exception('SOURCE_CHANGED')");
   const args=await sandboxCommand([directory],directory,`set -eu; python3 '${snapshot}/scripts/search.py'; if echo BAD > '${snapshot}/data.txt' 2>/dev/null; then exit 1; fi`,[f.home],{resources});
   expect((await exec(args[0]!,args.slice(1))).stdout).toBe('SKILL_RESOURCE_OK\n');
   expect((await f.call(['skill','effective',member.id],{runtime:'dsh'})).versions.map((x:any)=>x.versionId)).toContain(imported.version.id);
   await expect(f.call(['skill','show',imported.skill.id],{},f.b.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  }finally{await f.close();}
 });
 it('offers an isolated installation directory before any repository is registered',async()=>{
  const f=await fixture();try{
   const access=await workspaceRepositoryAccess(f.host.store,f.a.id);expect(access?.repositoryPaths).toEqual([]);expect(access?.workspaceDirectory).toContain(f.a.id);
   const roots=await nativeRepositoryRoots(access!.workspaceDirectory!,[],new AbortController().signal,access!.workspaceDirectory);
   const args=await sandboxCommand(roots,access!.workspaceDirectory!,"echo WORKSPACE_INSTALL > installed.txt; test ! -e ../../management.token; cat installed.txt",access!.protectedPaths,{home:access!.shellHome,resources:access!.skillResources});
   expect((await exec(args[0]!,args.slice(1))).stdout).toBe('WORKSPACE_INSTALL\n');
   const other=await workspaceRepositoryAccess(f.host.store,f.b.id);expect(other?.shellHome).not.toBe(access?.shellHome);
   await expect(nativeRepositoryRoots(other!.workspaceDirectory!,[],new AbortController().signal,access!.workspaceDirectory)).rejects.toBeDefined();
  }finally{await f.close();}
 });
 it('provides formal read-only executions only their captured Skill resource bytes',async()=>{
  const f=await fixture();try{
   const dir=path.join(f.root,'readonly-skill');await mkdir(dir);await writeFile(path.join(dir,'SKILL.md'),'Read asset.txt');await writeFile(path.join(dir,'asset.txt'),'CAPTURED');
   await f.call(['workspace','grant-path'],{path:dir});const preview=await f.call(['skill','preview'],{directory:dir});const imported=await f.call(['skill','import'],{previewId:preview.previewId});
   const member=(await f.call(['agent','list'])).agents.find((x:any)=>x.purpose==='reviewer');
   await f.call(['skill','assign',imported.skill.id],{agentId:member.id,mode:'include',versionId:imported.version.id,expectedRevision:0});
   const compiled=f.host.skills.resolveEffective(f.a.id,member.id,{runtime:'codex',resources:true,scripts:true});f.host.skills.snapshotExecution(f.a.id,member.id,'run','readonly-test',compiled);
   let live=true;const tool=skillResourceTool(f.host.store,'run','readonly-test',()=>{if(!live)throw new Error('STOPPED');});
   await writeFile(path.join(dir,'asset.txt'),'SOURCE_CHANGED');await f.call(['skill','assign',imported.skill.id],{agentId:member.id,mode:'exclude',expectedRevision:1});
   expect(await tool.execute({versionId:imported.version.id,path:'asset.txt'},new AbortController().signal)).toMatchObject({content:'CAPTURED'});
   await expect(tool.execute({versionId:'foreign-version',path:'asset.txt'},new AbortController().signal)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(tool.execute({versionId:imported.version.id,path:'../management.token'},new AbortController().signal)).rejects.toMatchObject({code:'NOT_FOUND'});
   live=false;await expect(tool.execute({versionId:imported.version.id,path:'asset.txt'},new AbortController().signal)).rejects.toThrow('STOPPED');
  }finally{await f.close();}
 });
 it('scopes historical workflow/task/run operations, rejects foreign IDs and edits only unstarted tasks',async()=>{
  const f=await fixture();try{
   const wf=await f.call(['workflow','start'],{mode:'analysis',goal:'Compare supplied text',startLead:false});
   await expect(f.call(['workflow','yield',wf.id],{summary:'handoff'})).rejects.toMatchObject({code:'EXECUTION_REQUIRED'});
   const tasks=await f.call(['plan','submit',wf.id],{expectedRevision:0,tasks:[{id:'cli-analysis',kind:'analysis',title:'Compare',instructions:'Compare a/b',expectedPaths:[]}]});expect(tasks).toHaveLength(1);
   const updated=await f.call(['task','update','cli-analysis'],{expectedVersion:0,title:'Compare text'});expect(updated.title).toBe('Compare text');
   await expect(f.call(['task','update','cli-analysis'],{expectedVersion:updated.version,expectedPaths:['outside']})).rejects.toMatchObject({code:'INVALID_PATH'});
   await expect(f.call(['workflow','show',wf.id],{},f.b.id)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(f.call(['task','show','cli-analysis'],{},f.b.id)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(f.call(['task','list'],{workflowId:wf.id},f.b.id)).rejects.toMatchObject({code:'NOT_FOUND'});
   expect((await f.call(['task','list'],{kind:'analysis'})).tasks).toHaveLength(1);
   await f.call(['task','cancel','cli-analysis']);expect((await f.call(['task','show','cli-analysis'])).status).toBe('cancelled');
   await expect(f.call(['task','update','cli-analysis'],{expectedVersion:updated.version+1,title:'Rewrite'})).rejects.toMatchObject({code:'TASK_STARTED'});
  }finally{await f.close();}
 });
 it('binds the agent CLI to a live turn without a management token or a caller-selected workspace',async()=>{
  const f=await fixture();try{
   const conversation=await f.call(['conversation','create'],{title:'Admin'});
   const sent=await f.call(['message','send',conversation.id],{clientMessageId:'agent-cli',content:'Inspect workspace'});await until(()=>f.executions.length===1);
   const tool=f.executions[0]!.input.tools.find(tool=>tool.name==='rift_cli')!;expect(tool).toBeDefined();const signal=new AbortController().signal;
   const own=await tool.execute({argv:['workspace','show'],input:{}},signal) as any;expect(own.workspace.id).toBe(f.a.id);
   await expect(tool.execute({argv:['workspace','show'],input:{},workspaceId:f.b.id},signal)).rejects.toBeDefined();
   await expect(tool.execute({argv:['agent','show',`${f.b.id}:lead`],input:{}},signal)).rejects.toMatchObject({code:'NOT_FOUND'});
   await expect(tool.execute({argv:['workspace','grant-path'],input:{path:f.root},idempotencyKey:'grant'},signal)).rejects.toMatchObject({code:'OPERATOR_REQUIRED'});
   const command={argv:['conversation','create'],input:{title:'Created by member'},idempotencyKey:'create'};
   const receipt=await tool.execute(command,signal);expect(await tool.execute(command,signal)).toEqual(receipt);
   await expect(tool.execute({...command,input:{title:'Different'}},signal)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
   f.executions[0]!.finish({text:'Done',stopReason:'completed'});await until(()=>f.host.chat.turn(f.a.id,sent.turn.id).status==='completed');
   await expect(tool.execute({argv:['workspace','show'],input:{}},signal)).rejects.toMatchObject({code:'UNAUTHORIZED'});
  }finally{await f.close();}
 });
 it('provides repository registration/base ref/disconnect with explicit path grants',async()=>{
  const f=await fixture();try{
   const repo=path.join(f.root,'repo');await mkdir(repo);await gitOk(repo,['init','-q','-b','main']);await writeFile(path.join(repo,'file'),'baseline');await gitOk(repo,['add','.']);await gitOk(repo,['-c','user.name=Test','-c','user.email=test@test','commit','-qm','baseline']);
   const sub=path.join(repo,'sub');await mkdir(sub);
   await f.call(['workspace','grant-path'],{path:sub});
   await expect(f.call(['repository','connect'],{repositoryPath:sub,baseRef:'main',expectedVersion:(await f.call(['workspace','show'])).workspace.version})).rejects.toMatchObject({code:'PATH_SCOPE'});
   await f.call(['workspace','grant-path'],{path:repo});
   let ws=(await f.call(['workspace','show'])).workspace;
   const connected=await f.call(['repository','connect'],{repositoryPath:repo,baseRef:'main',expectedVersion:ws.version});
   ws=(await f.call(['workspace','show'])).workspace;
   expect((await f.call(['repository','update',connected.id],{baseRef:'HEAD',expectedVersion:ws.version})).baseRef).toBe('HEAD');
   ws=(await f.call(['workspace','show'])).workspace;
   expect(await f.call(['repository','disconnect',connected.id],{expectedVersion:ws.version})).toEqual({disconnected:connected.id});
  }finally{await f.close();}
 });
});
describe('real filesystem and network boundary',()=>{
 it.runIf(process.platform==='linux')('runs real Vite and Vitest with writable temporary config caches',async()=>{
  const project=process.cwd(),own=await mkdtemp(path.join(tmpdir(),'rift-vite-'));
  await mkdir(path.join(own,'node_modules'));await symlink(path.join(project,'node_modules','vitest'),path.join(own,'node_modules','vitest'));
  await writeFile(path.join(own,'package.json'),'{"type":"module"}');
  await writeFile(path.join(own,'vite.config.ts'),"export default {test:{globals:true,include:['sample.test.js']}};");
  await writeFile(path.join(own,'sample.test.js'),"test('sample',()=>expect(1).toBe(1));");
  await writeFile(path.join(own,'index.html'),'<html><body>Build</body></html>');
  try{
   const argv=await sandboxCommand([project,own],own,`set -eu; node '${project}/node_modules/vitest/vitest.mjs' run; node '${project}/node_modules/vite/bin/vite.js' build; echo TOOLCHAIN_OK`,[path.join(project,'.rift')]);
   expect((await exec(argv[0]!,argv.slice(1),{timeout:30000})).stdout).toContain('TOOLCHAIN_OK');
   expect(await readFile(path.join(own,'dist','index.html'),'utf8')).toContain('Build');
  }finally{await rm(own,{recursive:true,force:true});}
 },180000);
 it.runIf(process.platform==='linux')('reads pnpm-shaped dependencies while protecting shared store inodes and private files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-pnpm-')),own=path.join(root,'own'),store=path.join(root,'store');
  await mkdir(path.join(own,'node_modules','sample'),{recursive:true});await mkdir(store);
  await writeFile(path.join(store,'index.js'),"module.exports='DEPENDENCY_OK'");
  await link(path.join(store,'index.js'),path.join(own,'node_modules','sample','index.js'));
  await writeFile(path.join(own,'node_modules','.env'),'DEPENDENCY_SECRET');await writeFile(path.join(own,'README.md'),'README_OK');
  try{
   const argv=await sandboxCommand([own],own,`set -eu; cat README.md; node -e "require('dns').lookup('localhost',(e,a)=>{if(e||!['127.0.0.1','::1'].includes(a))process.exit(1)})"; node -e "console.log(require('sample'))"; test ! -s node_modules/.env; echo PRIVATE_EDIT > node_modules/sample/index.js; ln node_modules/sample/index.js alias; mkdir -p node_modules/.vite-temp; echo CACHE > node_modules/.vite-temp/config.mjs; echo EDITED > writable; test ! -e '${store}/index.js'`);
   expect(argv.filter(x=>x==='--ro-bind').length).toBeLessThan(12);
   expect((await exec(argv[0]!,argv.slice(1))).stdout).toBe('README_OKDEPENDENCY_OK\n');
   expect(await readFile(path.join(store,'index.js'),'utf8')).toBe("module.exports='DEPENDENCY_OK'");
   expect(await readFile(path.join(own,'writable'),'utf8')).toBe('EDITED\n');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.runIf(process.platform==='linux')('permits own edits and tests but denies sibling/Host secrets, symlinks, inherited environment and Host loopback',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rift-sandbox-')),own=path.join(root,'own'),foreign=path.join(root,'foreign');await mkdir(own);await mkdir(foreign);await writeFile(path.join(foreign,'secret'),'FOREIGN');await mkdir(path.join(own,'.rift'));await writeFile(path.join(own,'.rift','management.token'),'HOST_TOKEN');await writeFile(path.join(own,'.env'),'SECRET');await symlink(foreign,path.join(own,'escape'));await writeFile(path.join(own,'file'),'OWN');
  try{
   const cmd=`set -eu; test "$(cat file)" = OWN; printf CHANGED > file; test ! -s .env; test ! -e .rift/management.token; test ! -e '${foreign}/secret'; test ! -e escape/secret; test -z "\${TEST_SECRET:-}"; test ! -e /root/.codex/auth.json; node -e 'const n=require("net"); const s=n.connect(1,"127.0.0.1");s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0))'; echo ISOLATED`;
   const args=await sandboxCommand([own],own,cmd);const result=await exec(args[0]!,args.slice(1),{env:{...process.env,TEST_SECRET:'LEAK'}});expect(result.stdout.trim()).toBe('ISOLATED');expect(await readFile(path.join(own,'file'),'utf8')).toBe('CHANGED');expect(await readFile(path.join(own,'.rift','management.token'),'utf8')).toBe('HOST_TOKEN');
   const nested=path.join(own,'.rift','workspaces','own','tasks','current');await mkdir(nested,{recursive:true});await writeFile(path.join(nested,'nested.txt'),'TASK');
   const nestedArgs=await sandboxCommand([own,nested],nested,`test ! -e '${own}/.rift/management.token'; cat nested.txt`,[path.join(own,'.rift')]);
   expect((await exec(nestedArgs[0]!,nestedArgs.slice(1))).stdout).toBe('TASK');
   await link(path.join(foreign,'secret'),path.join(own,'hardlink'));
   const linkedArgs=await sandboxCommand([own],own,"cat hardlink; printf PRIVATE_EDIT > hardlink; printf STILL_OWN > file");
   expect((await exec(linkedArgs[0]!,linkedArgs.slice(1))).stdout).toBe('FOREIGN');
   expect(await readFile(path.join(foreign,'secret'),'utf8')).toBe('FOREIGN');
   expect(await createRepositoryReadTools(own)[0]!.execute({path:'hardlink'},new AbortController().signal)).toMatchObject({content:'PRIVATE_EDIT'});
   await expect(createRepositoryReadTools(own)[0]!.execute({path:'escape/secret'},new AbortController().signal)).rejects.toMatchObject({code:'UNAUTHORIZED'});
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
