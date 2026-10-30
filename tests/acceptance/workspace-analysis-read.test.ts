import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {RiftHostService} from '../../src/api/host-service.js';
import {gitOk} from '../../src/git/process.js';
import {createWorkspaceRepositoryReadTools} from '../../src/agent/repository-read.js';
import type {RuntimeTurnInput} from '../../src/agent/runtime-types.js';

describe('workspace read-only analysis',()=>{
 it('reads default and selected repositories with no write or path escape capability',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'rift-analysis-read-'));
  try{
   const first=path.join(home,'first'),second=path.join(home,'second');await mkdir(first);await mkdir(second);
   await writeFile(path.join(first,'source.ts'),'FIRST');await writeFile(path.join(second,'source.ts'),'SECOND');
   await writeFile(path.join(first,'.env'),'PRIVATE');await symlink(second,path.join(first,'escape'),'junction');
   const tools=createWorkspaceRepositoryReadTools([{id:'first',name:'First',path:first},{id:'second',name:'Second',path:second}]);
   expect(tools.map(t=>t.name)).toEqual(['rift_read_file','rift_list_files','rift_view_image']);
   const signal=new AbortController().signal,read=tools[0]!,list=tools[1]!;
   expect(await read.execute({path:'source.ts'},signal)).toMatchObject({content:'FIRST',repositoryId:'first'});
   expect(await read.execute({path:'source.ts',repositoryId:'second'},signal)).toMatchObject({content:'SECOND'});
   expect(await list.execute({},signal)).toMatchObject({repositories:[{id:'first',name:'First'},{id:'second',name:'Second'}]});
   for(const input of [{path:'source.ts',repositoryId:'foreign'},{path:'../second/source.ts'},{path:'escape/source.ts'},{path:second+'/source.ts'},{path:'.env'},{path:'source.ts',content:'OVERWRITE'}])await expect(read.execute(input,signal)).rejects.toThrow();
   expect(await readFile(path.join(first,'source.ts'),'utf8')).toBe('FIRST');
   expect(createWorkspaceRepositoryReadTools([])).toEqual([]);
  }finally{await rm(home,{recursive:true,force:true});}
 });
 it('grants repository reads to an analysis workflow without workflow_repositories and never grants shell access',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'rift-analysis-host-')),repo=path.join(home,'repo');await mkdir(repo);
  await gitOk(repo,['init','-b','main']);await writeFile(path.join(repo,'README.md'),'READ_ONLY_EVIDENCE');
  await gitOk(repo,['add','.']);await gitOk(repo,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base']);
  const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home:path.join(home,'host'),port:0,leadProvider:'none',leadModel:'none',checks:[]});
  const inputs:RuntimeTurnInput[]=[];
  host.registerChatRuntime('codex',{async start(input){
   inputs.push(input);
   const tool=input.tools.find(t=>t.name==='rift_read_file');expect(tool).toBeDefined();
   expect(await tool!.execute({path:'README.md'},input.signal)).toMatchObject({content:'READ_ONLY_EVIDENCE'});
   expect(input.repositoryAccess).toBeUndefined();expect(input.tools.some(t=>/exec|write|edit|shell/.test(t.name))).toBe(false);
   expect(input.instructions).toContain('read-only analysis');expect(input.instructions).not.toContain('do not access files');
   return{result:Promise.resolve({text:'README.md: READ_ONLY_EVIDENCE',stopReason:'completed' as const}),async dispose(){}};
  }},['analysis-test']);
  try{
   const ws=await host.handleBrowser('POST','/ui-api/v1/workspaces',{name:'Analysis'},'ws') as {id:string};
   await host.repositories.connect(ws.id,{repositoryPath:repo,baseRef:'main',expectedVersion:host.store.workspace(ws.id).version ?? 0});
   await host.handleBrowser('POST',`/ui-api/v1/workspaces/${ws.id}/agents`,{name:'analyst',displayName:'Analyst',purpose:'developer',prompt:'Analyze repository.',chatConnection:{runtime:'codex',model:'analysis-test'}},'agent');
   const wf=await host.handle('POST','/v1/workflows',{workspaceId:ws.id,goal:'Read code',mode:'analysis',startLead:false},'wf') as {id:string};
   host.coordinator.submitPlan({workflowId:wf.id,expectedRevision:0,tasks:[{id:'read',kind:'analysis',title:'Read',instructions:'Inspect README',expectedPaths:[],roleName:'analyst'}]});
   host.coordinator.dispatch({taskId:'read',expectedVersion:0,idempotencyKey:'dispatch'});
   await expect.poll(()=>host.store.task('read').status,{timeout:10000}).toBe('succeeded');
   expect(inputs).toHaveLength(1);expect(host.store.all('SELECT * FROM workflow_repositories')).toEqual([]);
   expect(await readFile(path.join(repo,'README.md'),'utf8')).toBe('READ_ONLY_EVIDENCE');
   expect(await gitOk(repo,['status','--porcelain'])).toBe('');
  }finally{await host.close();await rm(home,{recursive:true,force:true});}
 });
});
