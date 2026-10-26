import { describe,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from './fixtures.js';
import { LocalGitService } from '../../src/git/integration.js';
import { gitOk } from '../../src/git/process.js';
import type { ActivationBridge,GitService } from '../../src/contracts/index.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';

async function sourceFixture(){
  const home=await mkdtemp(path.join(tmpdir(),'rift-source-review-')),repo=path.join(home,'repo');await mkdir(repo);
  await gitOk(repo,['init','-q','-b','main']);await gitOk(repo,['config','user.name','Review']);await gitOk(repo,['config','user.email','review@example.invalid']);
  await writeFile(path.join(repo,'baseline.txt'),'baseline\n');await gitOk(repo,['add','.']);await gitOk(repo,['commit','-qm','baseline']);const base=await gitOk(repo,['rev-parse','HEAD']);
  await writeFile(path.join(repo,'allowed.txt'),'verified source\n');await gitOk(repo,['add','allowed.txt']);await gitOk(repo,['commit','-qm','original source']);const source=await gitOk(repo,['rev-parse','HEAD']);
  const store=new RiftStore(),seeded=seedWorkspace(store,'source-review'),role=seeded.roles.find(item=>item.purpose==='developer')!;
  const workspace={...seeded.workspace,rootPath:repo,repositoryPath:repo,commonGitDir:path.join(repo,'.git')};
  store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Recover existing source','running','refs/heads/rift/source-review',?)",workspace.id,base);
  store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt,source_head) VALUES('task','workflow',?,'change','Task','Task','[\"allowed.txt\"]','[]','blocked',2,?)",role.id,source);
  store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,cleanup_status,slot_released_at) VALUES('repair','task',?,'repair',2,'succeeded',?,'later','now','confirmed','now')",role.id,JSON.stringify({role,binding:seeded.bindings[0]}));
  const task=store.task('task'),workflow=store.workflow('workflow'),run=store.run('repair');
  const git=new LocalGitService({managedRoot:path.join(home,'managed')}),worktree=await git.prepareTask({workspace,workflow,task,run});
  const input={workspace,workflow,task,run,worktree,priorSource:{sourceHead:source,baseCommit:base}};
  return{home,repo,store,git,base,source,input,close:async()=>{store.close();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-source-review-'))throw new Error('Unsafe cleanup');await rm(home,{recursive:true,force:true});}};
}

describe('Independent prior-source Git recovery gates',()=>{
  it('reuses a clean known source without manufacturing a commit and checks only its original task diff',async()=>{
    const f=await sourceFixture();try{
      const result=await f.git.collectSource(f.input);
      expect(result.sourceHead).toBe(f.source);expect(result.changedPaths).toEqual(['allowed.txt']);expect(result.diff).toContain('verified source');
      expect(await gitOk(f.input.worktree.path,['rev-parse','HEAD'])).toBe(f.source);expect(await gitOk(f.input.worktree.path,['status','--porcelain=v1','--ignored'])).toBe('');
    }finally{await f.close();}
  });

  it.each(['new-task','missing-provenance','wrong-source','wrong-task-source','empty-original-diff','non-ancestor-base','head-moved','outside-scope','unknown-cleanup','wrong-writer'] as const)('rejects %s without committing or accepting anything',async mode=>{
    const f=await sourceFixture();try{
      const input={...f.input,task:{...f.input.task},run:{...f.input.run},worktree:{...f.input.worktree},priorSource:{...f.input.priorSource}} as Parameters<LocalGitService['collectSource']>[0];
      if(mode==='new-task'){input.task.attempt=1;input.run.taskAttempt=1;input.worktree.attempt=1;}
      if(mode==='missing-provenance')delete input.priorSource;
      if(mode==='wrong-source')input.priorSource!.sourceHead=f.base;
      if(mode==='wrong-task-source')input.task.sourceHead=f.base;
      if(mode==='empty-original-diff')input.priorSource!.baseCommit=f.source;
      if(mode==='non-ancestor-base')input.priorSource!.baseCommit=await gitOk(f.repo,['commit-tree',`${f.source}^{tree}`,'-m','unrelated root']);
      if(mode==='head-moved')await gitOk(input.worktree.path,['commit','--allow-empty','-qm','unrelated extra commit']);
      if(mode==='outside-scope')input.task.expectedPaths=['other.txt'];
      if(mode==='unknown-cleanup')input.run.cleanupStatus='unknown';
      if(mode==='wrong-writer')input.worktree.writerRunId='another-run';
      const head=await gitOk(input.worktree.path,['rev-parse','HEAD']);
      await expect(f.git.collectSource(input)).rejects.toThrow();
      expect(await gitOk(input.worktree.path,['rev-parse','HEAD'])).toBe(head);expect(f.store.task('task').status).toBe('blocked');expect(f.store.task('task').acceptedCommit).toBeNull();
    }finally{await f.close();}
  });
});

function coordinatorFixture(){
  const store=new RiftStore(),{workspace,roles,bindings}=seedWorkspace(store,'recovery-gates'),developer=roles.find(role=>role.purpose==='developer')!,reviewer=roles.find(role=>role.purpose==='reviewer')!;
  store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Recovery fences','paused','refs/heads/rift/recovery-fences',?)",workspace.id,'a'.repeat(40));
  const repository=store.require<{id:string}>('SELECT id FROM repositories WHERE workspace_id=?',workspace.id);
  store.exec("INSERT INTO workflow_repositories(workflow_id,repository_id,base_commit,integration_ref) VALUES('workflow',?,?,'refs/heads/rift/recovery-fences')",repository.id,'a'.repeat(40));
  store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt,blocking_reason) VALUES('task','workflow',?,'change','Task','Task','[\"allowed.txt\"]','[]','blocked',3,'HOST_COLLECTION_FAILURE')",developer.id);
  const result={schemaVersion:1,taskId:'task',runId:'current-run',outcome:'completed',summary:'Development complete',changedPaths:['allowed.txt'],checksClaimed:[],blockingReasons:[]};
  store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('current-run','task',?,'repair',3,'running',?,'later','now')",developer.id,JSON.stringify({role:developer,binding:bindings[0]}));
  store.exec("UPDATE runs SET status='succeeded',cleanup_status='confirmed',slot_released_at='now',result=? WHERE id='current-run'",JSON.stringify(result));
  store.exec("UPDATE execution_leases SET cleanup_status='confirmed',released_at='now' WHERE owner_id='current-run'");
  store.exec("INSERT INTO worktrees(id,task_id,attempt,kind,path,base_commit,head_commit,writer_run_id,status) VALUES('worktree','task',3,'task','D:/controlled/source-recovery',?,?,NULL,'active')",'a'.repeat(40),'a'.repeat(40));
  const collect=vi.fn(async()=>({sourceHead:'b'.repeat(40),diff:'actual controlled diff',changedPaths:['allowed.txt']}));
  const git={collectSource:collect} as unknown as GitService;
  const bridge={start:vi.fn(async()=>{throw new Error('Paused recovery must not start a model');})} as ActivationBridge;
  const coordinator=new TaskCoordinator({store,git,bridge});
  return{store,workspace,developer,reviewer,result,collect,coordinator,close:async()=>{await coordinator.shutdown();store.close();}};
}

describe('Independent source-recovery execution and concurrency fences',()=>{
  it.each(['wrong-version','blocked-result','unknown-cleanup','retained-lease','writer','queued-request','active-integration','latest-review'] as const)('refuses %s before touching Git or execution history',async mode=>{
    const f=coordinatorFixture();try{
      if(mode==='blocked-result')f.store.exec('UPDATE runs SET result=? WHERE id=?',JSON.stringify({...f.result,outcome:'blocked',blockingReasons:['Not complete']}),'current-run');
      if(mode==='unknown-cleanup')f.store.exec("UPDATE runs SET cleanup_status='unknown' WHERE id='current-run'");
      if(mode==='retained-lease')f.store.exec("UPDATE execution_leases SET cleanup_status='unknown',released_at=NULL WHERE owner_id='current-run'");
      if(mode==='writer')f.store.exec("UPDATE worktrees SET writer_run_id='current-run' WHERE id='worktree'");
      if(mode==='queued-request')f.store.exec("INSERT INTO operations(id,kind,dedupe_key,entity_id,phase,payload,created_at) VALUES('pending','dispatch','pending','task','queued','{}','now')");
      if(mode==='active-integration')f.store.exec("INSERT INTO integrations(id,task_id,source_head,status) VALUES('integration','task',?,'reviewing')",'b'.repeat(40));
      if(mode==='latest-review')f.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,cleanup_status,slot_released_at) VALUES('later-review','task',?,'review',3,'succeeded','{}','later','later','confirmed','later')",f.reviewer.id);
      const before=f.store.all('SELECT * FROM runs'),task=f.store.task('task');
      await expect(f.coordinator.recoverSource({taskId:'task',expectedVersion:task.version+(mode==='wrong-version'?1:0)})).rejects.toThrow();
      expect(f.collect).not.toHaveBeenCalled();expect(f.store.all('SELECT * FROM runs')).toEqual(before);expect(f.store.task('task')).toEqual(task);
    }finally{await f.close();}
  });

  it('blocks parallel recovery and retry, then rejects a cancellation racing completed Git collection without queuing acceptance',async()=>{
    const f=coordinatorFixture();let resolve!:(value:{sourceHead:string;diff:string;changedPaths:string[]})=>void;
    f.collect.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    try{
      const task=f.store.task('task'),before=f.store.all('SELECT * FROM runs');
      const recovery=f.coordinator.recoverSource({taskId:task.id,expectedVersion:task.version});
      await expect(f.coordinator.recoverSource({taskId:task.id,expectedVersion:task.version})).rejects.toMatchObject({code:'SOURCE_RECOVERY_ACTIVE'});
      expect(()=>f.coordinator.retry({taskId:task.id,expectedVersion:task.version,reason:'Parallel retry'})).toThrow(/source recovery/);
      await f.coordinator.cancelTask(task.id);
      resolve({sourceHead:'b'.repeat(40),diff:'Verified diff which cannot override cancellation',changedPaths:['allowed.txt']});
      await expect(recovery).rejects.toMatchObject({code:'VERSION_CONFLICT'});
      expect(f.store.task(task.id)).toMatchObject({status:'cancelled',attempt:3,acceptedCommit:null,sourceHead:null});
      expect(f.store.all('SELECT * FROM runs')).toEqual(before);expect(f.store.all('SELECT id FROM operations')).toEqual([]);
    }finally{await f.close();}
  });

  it('queues paused recovery without changing the completed Run or exhausted attempt counter',async()=>{
    const f=coordinatorFixture();try{
      const before=f.store.all('SELECT * FROM runs'),version=f.store.task('task').version;
      const recovered=await f.coordinator.recoverSource({taskId:'task',expectedVersion:version});
      expect(recovered.task).toMatchObject({status:'validating',attempt:3,acceptedCommit:null,sourceHead:'b'.repeat(40)});
      expect(recovered.operation).toMatchObject({kind:'integration',phase:'queued'});
      expect(f.store.all('SELECT * FROM runs')).toEqual(before);expect(f.store.workflow('workflow').status).toBe('paused');
      expect(()=>f.coordinator.finish({workflowId:'workflow',summary:'Not reviewed'})).toThrow();
    }finally{await f.close();}
  });
});
