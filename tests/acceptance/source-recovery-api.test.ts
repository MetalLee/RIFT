import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

async function formatFailure(outputOverride?:(text:string)=>string){
  const f=await fixture(),resultText=JSON.stringify(f.result('repair')),output=outputOverride?.(resultText)??`Implementation ready.\n\x60\x60\x60json\n${resultText}\n\x60\x60\x60`;
  f.host.store.exec("UPDATE runs SET status='failed',stop_reason='INVALID_RESULT',result=? WHERE id='repair'",JSON.stringify({error:'Expected one JSON result object.',output,outputComplete:true}));
  f.host.store.exec("UPDATE tasks SET blocking_reason='INVALID_RESULT' WHERE id='task'");
  return{...f,input:{runId:'repair',expectedVersion:0,resultText,outputSha256:createHash('sha256').update(output).digest('hex')},output};
}
describe('Result-only supplementation and stage recovery',()=>{
  it('supplements a wrapped original result without model/code execution or rewriting Run/artifact facts; recovers source on the same attempt',async()=>{
    const f=await formatFailure(),runs=f.host.store.all('SELECT * FROM runs'),artifacts=f.host.store.all('SELECT * FROM artifacts');
    const route='/v1/tasks/task/supplement-result';
    const response=await f.host.handle('POST',route,f.input,'result-only');
    expect(response).toEqual({runId:'repair',result:f.result('repair')});
    expect(f.collect).not.toHaveBeenCalled();expect(f.host.store.all('SELECT * FROM runs')).toEqual(runs);expect(f.host.store.all('SELECT * FROM artifacts')).toEqual(artifacts);
    expect(f.host.store.task('task')).toMatchObject({status:'blocked',attempt:3,version:1,acceptedCommit:null});
    // Business-level replay also works with a different transport receipt.
    expect(await f.host.handle('POST',route,f.input,'result-replay')).toEqual(response);
    expect(f.host.store.events('workflow').filter(e=>e.type==='result.supplemented')).toHaveLength(1);
    const request={expectedVersion:1,idempotencyKey:'stage-source'};
    const recovered=await f.host.handle('POST','/v1/tasks/task/recover',request,'recover-stage') as {stage:string;task:Task};
    expect(recovered).toMatchObject({stage:'source',task:{status:'validating',attempt:3,acceptedCommit:null}});
    expect(await f.host.coordinator.recoverTask({taskId:'task',...request})).toEqual(recovered);
    await expect(f.host.coordinator.recoverTask({taskId:'task',...request,expectedVersion:2})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(f.collect).toHaveBeenCalledOnce();expect(f.host.store.all('SELECT * FROM runs')).toEqual(runs);
  });
  it.each(['wrong-hash','invented-result','wrong-run','ambiguous','truncated','unknown-cleanup','lease-unknown','cancelled','stale-version','provider-stop','writer','wrong-task'] as const)('rejects %s without executing code or changing the Run',async mode=>{
    const f=await formatFailure(mode==='ambiguous'?text=>`${text}\n${text}`:undefined),input={...f.input};
    if(mode==='wrong-hash')input.outputSha256='0'.repeat(64);
    if(mode==='invented-result')input.resultText=JSON.stringify({...f.result('repair'),summary:'Invented by operator'});
    if(mode==='wrong-run')input.runId='original';
    if(mode==='wrong-task')input.resultText=JSON.stringify({...f.result('repair'),taskId:'another'});
    if(mode==='truncated')f.host.store.exec("UPDATE runs SET result=? WHERE id='repair'",JSON.stringify({output:f.output,outputComplete:false}));
    if(mode==='unknown-cleanup')f.host.store.exec("UPDATE runs SET cleanup_status='unknown' WHERE id='repair'");
    if(mode==='lease-unknown')f.host.store.exec("UPDATE execution_leases SET cleanup_status='unknown' WHERE owner_id='repair'");
    if(mode==='cancelled')f.host.store.exec("UPDATE tasks SET status='cancelled' WHERE id='task'");
    if(mode==='stale-version')input.expectedVersion=42;
    if(mode==='provider-stop')f.host.store.exec("UPDATE runs SET stop_reason='PROVIDER_STOP' WHERE id='repair'");
    if(mode==='writer')f.host.store.exec("UPDATE worktrees SET writer_run_id='repair' WHERE id='tree-repair'");
    const runs=f.host.store.all('SELECT * FROM runs');
    await expect(f.host.handle('POST','/v1/tasks/task/supplement-result',input,`reject-${mode}`)).rejects.toBeDefined();
    expect(f.host.store.all('SELECT * FROM runs')).toEqual(runs);expect(f.collect).not.toHaveBeenCalled();
    expect(f.host.store.events('workflow').filter(e=>e.type==='result.supplemented')).toHaveLength(0);
  });
  it('binds CLI supplementation to workspace ownership and the same original Run',async()=>{
    const f=await formatFailure(),workspaceId=f.host.store.workflow('workflow').workspaceId;
    const response=await f.host.workspaceCli.execute(workspaceId,{argv:['task','supplement-result','task'],input:f.input});
    expect(response).toEqual({runId:'repair',result:f.result('repair')});
    const recovered=await f.host.workspaceCli.execute(workspaceId,{argv:['task','recover','task'],input:{expectedVersion:1,idempotencyKey:'cli-source'}});
    expect(recovered).toMatchObject({stage:'source',task:{attempt:3,status:'validating'}});
  });
  it.each(['format','source','provider'] as const)('does not turn %s infrastructure retry-dispatch into development',async mode=>{
    const f=mode==='source'?await fixture():await formatFailure();
    if(mode==='provider')f.host.store.exec("UPDATE runs SET stop_reason='PROVIDER_STOP' WHERE id='repair'");
    const runs=f.host.store.all('SELECT * FROM runs'),workspaceId=f.host.store.workflow('workflow').workspaceId;
    await expect(f.host.commands.execute({name:'task.retry-dispatch',workspaceId,id:'task',input:{expectedVersion:0,reason:'Infrastructure restored'}})).rejects.toMatchObject({code:mode==='format'?'RESULT_SUPPLEMENT_REQUIRED':mode==='source'?'STAGE_RECOVERY_REQUIRED':'CONTINUATION_REQUIRED'});
    expect(f.host.store.all('SELECT * FROM runs')).toEqual(runs);expect(f.host.store.task('task').attempt).toBe(3);expect(f.collect).not.toHaveBeenCalled();expect(f.host.leads.size).toBe(0);
  });
  it('refuses developer recovery authority and cross-workspace CLI access',async()=>{
    const f=await formatFailure(),workspaceId=f.host.store.workflow('workflow').workspaceId,agentId=f.host.store.run('repair').roleId;
    await expect(f.host.workspaceCli.execute(workspaceId,{argv:['task','supplement-result','task'],input:f.input},{legacy:true,workspaceId,agentId,assertLive:()=>{}},'unauthorized')).rejects.toMatchObject({code:'UNAUTHORIZED'});
    f.host.store.exec("INSERT INTO workspaces(id,name,root_path,status) VALUES('other','Other','/other','active')");
    await expect(f.host.workspaceCli.execute('other',{argv:['task','supplement-result','task'],input:f.input})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(f.collect).not.toHaveBeenCalled();
  });
  it('does not promote an original blocked result or replace it with a completed result',async()=>{
    const f=await formatFailure(),text=JSON.stringify({...f.result('repair'),outcome:'blocked',blockingReasons:['Unfinished implementation']}),output=`Report: ${text}`;
    f.host.store.exec("UPDATE runs SET result=? WHERE id='repair'",JSON.stringify({output,outputComplete:true}));
    f.host.coordinator.supplementResult({taskId:'task',...f.input,resultText:text,outputSha256:createHash('sha256').update(output).digest('hex')});
    await expect(f.host.coordinator.recoverTask({taskId:'task',expectedVersion:1,idempotencyKey:'not-done'})).rejects.toMatchObject({code:'INVALID_STATE'});
    expect(f.collect).not.toHaveBeenCalled();expect(f.host.store.task('task')).toMatchObject({attempt:3,status:'blocked',acceptedCommit:null});
  });
  it('does not convert an interrupted provider output into completion and persists a rejected recovery receipt',async()=>{
    const f=await formatFailure();f.host.store.exec("UPDATE runs SET stop_reason='PROVIDER_STOP' WHERE id='repair'");
    const input={taskId:'task',expectedVersion:0,idempotencyKey:'provider'};
    await expect(f.host.coordinator.recoverTask(input)).rejects.toMatchObject({code:'CONTINUATION_REQUIRED'});
    await expect(f.host.coordinator.recoverTask(input)).rejects.toMatchObject({code:'CONTINUATION_REQUIRED'});
    expect(f.collect).not.toHaveBeenCalled();expect(f.host.store.task('task')).toMatchObject({attempt:3,status:'blocked',acceptedCommit:null});
  });
  it('does not replay an interrupted recovery request or recover unknown/cancelled ownership',async()=>{
    const f=await fixture();
    f.host.store.event('workflow','task.recovery_receipt',{key:'interrupted',expectedVersion:0},{taskId:'task'});
    await expect(f.host.coordinator.recoverTask({taskId:'task',expectedVersion:0,idempotencyKey:'interrupted'})).rejects.toMatchObject({code:'REQUEST_PENDING'});
    f.host.store.exec("UPDATE runs SET cleanup_status='unknown' WHERE id='repair'");
    await expect(f.host.coordinator.recoverTask({taskId:'task',expectedVersion:0,idempotencyKey:'unknown'})).rejects.toMatchObject({code:'CLEANUP_UNKNOWN'});
    expect(f.collect).not.toHaveBeenCalled();
  });
});
