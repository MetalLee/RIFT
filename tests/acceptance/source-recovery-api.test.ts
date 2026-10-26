import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiftHostService } from '../../src/api/host-service.js';
import type { DevelopmentResult, Operation, Task } from '../../src/contracts/index.js';
import { seedWorkspace } from './fixtures.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){
  const home=await mkdtemp(join(tmpdir(),'rift-source-recovery-api-'));
  cleanups.push(()=>rm(home,{recursive:true,force:true}));
  const host=new RiftHostService({subagents:{list:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'test',leadModel:'test',checks:[]});cleanups.push(()=>host.close());
  const {workspace,roles,bindings}=seedWorkspace(host.store),role=roles.find(item=>item.purpose==='developer')!,base='a'.repeat(40),source='b'.repeat(40);
  host.store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Recover','paused','refs/heads/rift/recovery',?)",workspace.id,base);
  const repository=host.store.require<{id:string}>('SELECT id FROM repositories WHERE workspace_id=?',workspace.id);
  host.store.exec("INSERT INTO workflow_repositories(workflow_id,repository_id,base_commit,integration_ref) VALUES('workflow',?,?,'refs/heads/rift/recovery')",repository.id,base);
  host.store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt,source_head,blocking_reason) VALUES('task','workflow',?,'change','Task','Task','[\"src\"]','[]','blocked',3,?,'EMPTY_CHANGE')",role.id,source);
  const result=(runId:string):DevelopmentResult=>({schemaVersion:1,taskId:'task',runId,outcome:'completed',summary:'Completed source',changedPaths:[],checksClaimed:[],blockingReasons:[]});
  for(const [runId,attempt,treeBase] of [['original',1,base],['reuse',2,source],['repair',3,source]] as const){
    host.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,cleanup_status,slot_released_at,result) VALUES(?,'task',?,'repair',?,'succeeded',?,'later','now','confirmed','now',?)",runId,role.id,attempt,JSON.stringify({role,binding:bindings[0]}),JSON.stringify(result(runId)));
    host.store.exec("INSERT INTO worktrees(id,task_id,attempt,kind,path,base_commit,head_commit,writer_run_id,status) VALUES(?,'task',?,'task',?,?,?,NULL,'active')",`tree-${runId}`,attempt,join(home,runId),treeBase,source);
    if(attempt<3)host.store.event('workflow','source.collected',{sourceHead:source,diff:'actual prior collection',changedPaths:['src/a.ts']},{taskId:'task',runId});
  }
  host.store.event('workflow','task.blocked',{reason:'EMPTY_CHANGE'},{taskId:'task',runId:'repair'});
  host.store.exec("INSERT INTO operations(id,kind,dedupe_key,entity_id,phase,payload,created_at) VALUES('old-dispatch','dispatch','old-dispatch','task','blocked','{\"error\":\"EMPTY_CHANGE\"}','now')");
  const collect=vi.spyOn(host.git,'collectSource').mockImplementation(async input=>{
    expect(host.store.require<{writerRunId:string|null}>("SELECT writer_run_id FROM worktrees WHERE id='tree-repair'").writerRunId).toBeNull();
    expect(input.worktree.writerRunId).toBe('repair');expect(input.run.id).toBe('repair');
    expect(input.priorSource).toEqual({sourceHead:source,baseCommit:base});
    return{sourceHead:source,diff:'verified original task diff',changedPaths:['src/a.ts']};
  });
  return{host,collect,result,base,source};
}

describe('Source recollection management API (controlled Git)',()=>{
  it('queues normal integration atomically without a new Run, repair attempt, accepted commit or rewritten failure history',async()=>{
    const f=await fixture(),beforeRuns=f.host.store.all('SELECT * FROM runs'),request={expectedVersion:0},route='/v1/tasks/task/recover-source';
    const result=await f.host.handle('POST',route,request,'recover-one') as {task:Task;operation:Operation;runId:string;sourceHead:string};
    expect(result).toMatchObject({task:{status:'validating',attempt:3,sourceHead:f.source,acceptedCommit:null},operation:{kind:'integration',phase:'queued',payload:{sourceHead:f.source}},runId:'repair'});
    expect(f.host.store.all('SELECT * FROM runs')).toEqual(beforeRuns);expect(f.host.store.operation('old-dispatch')).toMatchObject({phase:'blocked',payload:{error:'EMPTY_CHANGE'}});
    const recovered=f.host.store.events('workflow').filter(event=>event.type==='source.collected'&&(event.payload as {recovered?:boolean}).recovered);
    expect(recovered).toHaveLength(1);expect(recovered[0]).toMatchObject({runId:'repair',payload:{recovered:true,previousBlockingReason:'EMPTY_CHANGE',eligibleForIntegration:true}});
    expect(await f.host.handle('POST',route,request,'recover-one')).toEqual(result);expect(f.collect).toHaveBeenCalledOnce();
    await expect(f.host.handle('POST',route,{expectedVersion:1},'recover-one')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(f.host.handle('POST',route,{expectedVersion:1},'recover-again')).rejects.toMatchObject({code:'INVALID_STATE'});
    expect(f.host.store.all('SELECT * FROM integrations')).toHaveLength(0); // Paused workflow must stay paused.
  });

  it.each(['blocked-result','unknown-cleanup'] as const)('rejects %s before Git and preserves its ledger',async mode=>{
    const f=await fixture();
    if(mode==='blocked-result')f.host.store.exec("UPDATE runs SET result=? WHERE id='repair'",JSON.stringify({...f.result('repair'),outcome:'blocked',blockingReasons:['Unfinished work']}));
    else f.host.store.exec("UPDATE runs SET cleanup_status='unknown',slot_released_at=NULL WHERE id='repair'");
    await expect(f.host.handle('POST','/v1/tasks/task/recover-source',{expectedVersion:0},`reject-${mode}`)).rejects.toMatchObject({code:mode==='blocked-result'?'INVALID_STATE':'CLEANUP_UNKNOWN'});
    expect(f.collect).not.toHaveBeenCalled();expect(f.host.store.task('task')).toMatchObject({status:'blocked',attempt:3,version:0,acceptedCommit:null});expect(f.host.store.all("SELECT * FROM operations WHERE kind='integration'")).toHaveLength(0);
  });
});
