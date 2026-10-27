import { afterEach, describe, expect, it } from 'vitest';
import { RiftStore } from '../../src/storage/database.js';
import { ProjectService } from '../../src/project/index.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { RiftError, type ActivationBridge, type ActivationResult, type GitService, type Run } from '../../src/contracts/index.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const sha='a'.repeat(40);
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,15));};
const stores:RiftStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function fixture(options:{failCleanup?:boolean;neverCleanup?:boolean;cleanupTimeoutMs?:number;startError?:Error;database?:string;timeoutMs?:number}={}) {
  const store=new RiftStore(options.database);stores.push(store);
  const projects=new ProjectService(store,new Set(['claude','codex']));
  const workspace=projects.createWorkspace({id:'ws',name:'workspace',rootPath:'D:/managed',repositoryPath:'D:/repo',commonGitDir:'D:/repo/.git',baseRef:'main'});
  projects.configureRoles(workspace.id,[{id:'claude',providerName:'claude',packageVersion:'test',configRevision:1,capabilities:{},credentialRefs:['env:ANTHROPIC_API_KEY']},{id:'codex',providerName:'codex',packageVersion:'test',configRevision:1,capabilities:{},credentialRefs:[]}],[{name:'lead',kind:'dsh-lead',prompt:'lead',revision:1},{name:'developer-a',kind:'subagent',providerBindingId:'claude',prompt:'developer a',revision:1},{name:'developer-b',kind:'subagent',providerBindingId:'claude',prompt:'developer b',revision:1},{name:'reviewer',kind:'subagent',providerBindingId:'codex',prompt:'reviewer',revision:1}]);
  const calls:{run:Run;result:ReturnType<typeof deferred<ActivationResult>>;disposed:boolean}[]=[];
  const bridge:ActivationBridge={async start(input){if(options.startError)throw options.startError;const call={run:input.run,result:deferred<ActivationResult>(),disposed:false};calls.push(call);return{childId:`child-${input.run.id}`,result:call.result.promise,async dispose(){if(options.failCleanup)throw new Error('cleanup failed');if(options.neverCleanup)await new Promise<void>(()=>{});call.disposed=true;}};}};
  const git:GitService={async prepareTask({task,run}){return{id:`wt-${run.id}`,taskId:task.id,attempt:task.attempt,kind:'task',path:`D:/managed/${run.id}`,baseCommit:sha,writerRunId:run.id};},async collectSource(){return{sourceHead:sha,diff:'diff',changedPaths:['src/a.ts']};},async prepareCandidate({integrationId,sourceHead}){return{integrationId,sourceHead,candidateHead:'b'.repeat(40),expectedTargetHead:sha,cwd:`D:/managed/${integrationId}`,checkIds:['check-1']};},async publishCandidate({candidate}){return{acceptedCommit:candidate.candidateHead};},async containsCommit(){return true;},async abandonCandidate(){}};
  const coordinator=new TaskCoordinator({store,bridge,git,runTimeoutMs:options.timeoutMs,cleanupTimeoutMs:options.cleanupTimeoutMs});
  const workflow=coordinator.createWorkflow({id:'workflow',workspaceId:'ws',goal:'test',integrationRef:'refs/heads/rift/test',baseCommit:sha});
  const plan=(tasks:{id:string;paths?:string[];dependsOn?:string[];kind?:'change'|'analysis'}[])=>coordinator.submitPlan({workflowId:workflow.id,expectedRevision:0,tasks:tasks.map(task=>({id:task.id,kind:task.kind??'analysis',title:task.id,instructions:'do task',expectedPaths:task.paths??[`src/${task.id}`],dependsOn:task.dependsOn}))});
  const dispatch=(taskId:string,key=taskId)=>coordinator.dispatch({taskId,idempotencyKey:key,expectedVersion:store.task(taskId).version});
  const complete=(index:number)=>{const call=calls[index]!;call.result.resolve({stopReason:'completed',text:JSON.stringify(call.run.purpose==='review'?{schemaVersion:1,taskId:call.run.taskId,runId:call.run.id,verdict:'approve',reviewedCommit:'b'.repeat(40),findings:[]}:{schemaVersion:1,taskId:call.run.taskId,runId:call.run.id,outcome:'completed',summary:'done',changedPaths:[],checksClaimed:[],blockingReasons:[]})});};
  return{store,projects,workspace,workflow,coordinator,calls,git,plan,dispatch,complete};
}
describe('persistent task coordinator',()=>{
  it('retries an infrastructure-failed review with the same source and attempt, without dispatching development',async()=>{
    const f=fixture();f.plan([{id:'a',kind:'change'}]);f.dispatch('a');await tick();f.complete(0);await tick();
    f.calls[1]!.result.resolve({stopReason:'error',text:'',diagnostic:'MISSING_CREDENTIAL: saved reviewer credential unavailable'});await tick();
    const task=f.store.task('a');expect(task.status).toBe('blocked');expect(task.blockingReason).toContain('MISSING_CREDENTIAL');
    expect(()=>f.coordinator.requestIntegration({taskId:'a',sourceHead:'c'.repeat(40),expectedVersion:task.version,idempotencyKey:'wrong-source'})).toThrow();
    f.store.exec("UPDATE runs SET cleanup_status='unknown' WHERE id=?",f.calls[1]!.run.id);
    expect(()=>f.coordinator.requestIntegration({taskId:'a',sourceHead:sha,expectedVersion:task.version,idempotencyKey:'unknown-cleanup'})).toThrow(/cleanup/i);
    f.store.exec("UPDATE runs SET cleanup_status='confirmed' WHERE id=?",f.calls[1]!.run.id);
    const request=f.coordinator.requestIntegration({taskId:'a',sourceHead:sha,expectedVersion:task.version,idempotencyKey:'review-retry'});
    expect(f.coordinator.requestIntegration({taskId:'a',sourceHead:sha,expectedVersion:task.version,idempotencyKey:'review-retry'}).id).toBe(request.id);
    await tick();expect(f.calls).toHaveLength(3);expect(f.calls[2]!.run.purpose).toBe('review');expect(f.store.task('a').attempt).toBe(task.attempt);
    expect(f.store.task('a').acceptedCommit).toBeNull();f.complete(2);await tick();expect(f.store.task('a').status).toBe('succeeded');
    await f.coordinator.shutdown();
  });
  it('does not treat a substantive review rejection as an infrastructure retry',async()=>{
    const f=fixture();f.plan([{id:'a',kind:'change'}]);f.dispatch('a');await tick();f.complete(0);await tick();
    const run=f.calls[1]!.run;f.calls[1]!.result.resolve({stopReason:'completed',text:JSON.stringify({schemaVersion:1,taskId:'a',runId:run.id,verdict:'changes_requested',reviewedCommit:'b'.repeat(40),findings:[]})});await tick();
    expect(()=>f.coordinator.requestIntegration({taskId:'a',sourceHead:sha,expectedVersion:f.store.task('a').version,idempotencyKey:'retry-rejection'})).toThrow(/infrastructure/);
    await f.coordinator.shutdown();
  });
  it('waits for the previous native developer on repair instead of losing its thread',async()=>{
    const f=fixture();f.plan([{id:'a'},{id:'b'}]);f.dispatch('a');await tick();
    const original=f.calls[0]!.run;
    f.store.exec('INSERT INTO native_sessions(id,workspace_id,scope,scope_id,agent_id,configuration_key,thread_id,runtime_home,cwd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)','session','ws','task','a',original.roleId,'config','thread','home','cwd','now');
    f.store.exec('INSERT INTO native_executions(execution_id,session_id,status,updated_at) VALUES(?,?,?,?)',original.id,'session','completed','now');
    f.calls[0]!.result.resolve({stopReason:'error',text:'needs repair'});await tick();
    f.dispatch('b');await tick();expect(f.calls[1]!.run.roleId).toBe(original.roleId);
    f.coordinator.retry({taskId:'a',reason:'continue with native memory',expectedVersion:f.store.task('a').version});
    const queued=f.dispatch('a','repair');expect(queued.phase).toBe('queued');await tick();expect(f.calls).toHaveLength(2);
    f.complete(1);await tick();expect(f.calls[2]!.run.roleId).toBe(original.roleId);expect(f.calls[2]!.run.purpose).toBe('repair');
    f.complete(2);await tick();await f.coordinator.shutdown();
  });
  it('releases a failed native startup only with an explicit runtime cleanup receipt',async()=>{
    const f=fixture({startError:new RiftError('NATIVE_START_FAILED','Saved thread unavailable',{cleanupConfirmed:true})});
    f.plan([{id:'a'}]);f.dispatch('a');await tick();
    expect(f.coordinator.status('workflow').runs[0]).toMatchObject({cleanupStatus:'confirmed',stopReason:'NATIVE_START_FAILED'});
    expect(f.coordinator.status('workflow').slots.total).toBe(0);await f.coordinator.shutdown();
  });
  it('reserves two independent developers, queues third, and handles out-of-order completion',async()=>{
    const f=fixture();f.plan([{id:'a'},{id:'b'},{id:'c'}]);const a=f.dispatch('a'),b=f.dispatch('b'),c=f.dispatch('c');
    expect(a.phase).toBe('started');expect(b.phase).toBe('started');expect(c.phase).toBe('queued');expect(f.coordinator.status('workflow').slots.developers).toBe(2);
    await tick();expect(f.calls).toHaveLength(2);const cursor=f.coordinator.status('workflow').eventSeq;
    f.complete(1);await tick();expect(f.calls).toHaveLength(3);expect(f.store.task('b').status).toBe('succeeded');
    const result=await f.coordinator.wait({workflowId:'workflow',runIds:[f.calls[0]!.run.id,f.calls[1]!.run.id],afterEventSeq:cursor,timeoutMs:0});expect(result.events.some(event=>event.runId===f.calls[1]!.run.id&&event.type==='result_recorded')).toBe(true);
    f.complete(0);f.complete(2);await tick();expect(f.coordinator.status('workflow').slots.total).toBe(0);await f.coordinator.shutdown();
  });
  it('keeps failed cleanup occupied and rejects retry or duplicate dispatch',async()=>{
    const f=fixture({failCleanup:true});f.plan([{id:'a'},{id:'b'},{id:'c'}]);const request=f.dispatch('a');f.dispatch('b');f.dispatch('c');await tick();f.complete(0);await tick();
    expect(f.coordinator.status('workflow').slots.developers).toBe(2);expect(f.store.task('a').status).toBe('blocked');expect(f.dispatch('a','a').id).toBe(request.id);
    expect(()=>f.coordinator.retry({taskId:'a',reason:'retry',expectedVersion:f.store.task('a').version})).toThrow(/cleanup/i);expect(f.calls).toHaveLength(2);await f.coordinator.cancelWorkflow('workflow');await f.coordinator.shutdown();
  });
  it('does not serialize isolated task worktrees because legacy path hints overlap',async()=>{
    const f=fixture();f.plan([{id:'a',paths:['src/shared']},{id:'b',paths:['src/shared/file.ts']},{id:'c',paths:['docs']}]);f.dispatch('a');const b=f.dispatch('b');f.dispatch('c');await tick();expect(f.calls.map(call=>call.run.taskId)).toEqual(['a','b']);f.complete(0);f.complete(1);await tick();expect(f.calls[2]!.run.taskId).toBe('c');f.complete(2);await tick();await f.coordinator.shutdown();
  });
  it('allows explicit retries after repeated transport timeouts without a lifetime attempt cap',async()=>{
    const f=fixture();f.plan([{id:'transport'}]);f.dispatch('transport');await tick();
    for(let i=0;i<6;i++){
      f.calls[i]!.result.resolve({stopReason:'error',text:'',diagnostic:'pi-ai stream idle timeout after 60000ms'});await tick();
      expect(f.store.task('transport').status).toBe('blocked');
      const next=f.coordinator.retry({taskId:'transport',reason:'Transport recovered; continue existing work',expectedVersion:f.store.task('transport').version});expect(next.attempt).toBe(i+2);
      f.dispatch('transport','retry-'+i);await tick();
    }
    expect(f.calls).toHaveLength(7);expect(f.store.all("SELECT id FROM runs WHERE task_id='transport' AND status='failed'")).toHaveLength(6);
    f.complete(6);await tick();expect(f.store.task('transport')).toMatchObject({status:'succeeded',attempt:7});await f.coordinator.shutdown();
  });
  it('rejects cyclic DAG and does not start dependencies until accepted',async()=>{
    const f=fixture();expect(()=>f.plan([{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}])).toThrow(/cycle/i);
    f.plan([{id:'a',kind:'change'},{id:'b',dependsOn:['a']}]);f.dispatch('a');const b=f.dispatch('b');await tick();expect(b.phase).toBe('queued');f.complete(0);await tick();expect(f.calls[1]!.run.purpose).toBe('review');expect(f.calls).toHaveLength(2);f.complete(1);await tick();expect(f.calls[2]!.run.taskId).toBe('b');f.complete(2);await tick();await f.coordinator.shutdown();
  });
  it('pauses queues, isolates single-task cancellation, then resumes',async()=>{
    const f=fixture();f.plan([{id:'a'},{id:'b'},{id:'c'}]);f.dispatch('a');f.dispatch('b');f.dispatch('c');await tick();f.coordinator.pause('workflow');await f.coordinator.cancelTask('a');await tick();expect(f.calls[1]!.disposed).toBe(false);expect(f.calls).toHaveLength(2);f.complete(1);await tick();expect(f.calls).toHaveLength(2);f.coordinator.resume('workflow');await tick();expect(f.calls).toHaveLength(3);f.complete(2);await tick();await f.coordinator.shutdown();
  });
  it('recovery marks unpublished reservations interrupted without replay or releasing occupancy',async()=>{
    const f=fixture();f.plan([{id:'a'},{id:'b'},{id:'c'}]);f.dispatch('a');f.dispatch('b');f.dispatch('c');await tick();const restored=new TaskCoordinator({store:f.store,bridge:{async start(){throw new Error('must not start');}},git:f.git});const report=await restored.recover();expect(report.interruptedRunIds).toHaveLength(2);expect(restored.status('workflow').slots.developers).toBe(2);expect(restored.status('workflow').workflow.status).toBe('paused');restored.resume('workflow');expect(restored.status('workflow').operations.find(op=>op.entityId==='c')!.phase).toBe('queued');await f.coordinator.shutdown();await restored.shutdown();
  });
  it('releases a proved prepublication failure but preserves an ambiguous start',async()=>{
    const f=fixture({startError:new RiftError('START_NOT_PUBLISHED','provider unavailable')});f.plan([{id:'a'}]);f.dispatch('a');await tick();expect(f.coordinator.status('workflow').slots.total).toBe(0);await f.coordinator.shutdown();
    const g=fixture({startError:new Error('network interrupted')});g.plan([{id:'a'}]);g.dispatch('a');await tick();expect(g.coordinator.status('workflow').slots.total).toBe(1);await g.coordinator.shutdown();
  });
  it('holds all change tasks behind exact candidate review and actual ancestry',async()=>{
    const f=fixture();f.plan([{id:'a',kind:'change'},{id:'b',dependsOn:['a']}]);f.dispatch('a');f.dispatch('b');await tick();f.complete(0);await tick();f.git.containsCommit=async()=>false;f.complete(1);await tick();expect(f.store.task('a').status).toBe('succeeded');expect(f.store.task('b').status).toBe('blocked');expect(f.calls).toHaveLength(2);expect(f.coordinator.status('workflow').slots.total).toBe(0);await f.coordinator.shutdown();
  });
  it('persists a redacted immutable result artifact with a verifiable hash across restart',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'rift-core-artifacts-'));
    const f=fixture({database:join(directory,'rift.db')});
    try {
      f.plan([{id:'a'}]);f.dispatch('a');await tick();const call=f.calls[0]!;
      call.result.resolve({stopReason:'completed',text:JSON.stringify({schemaVersion:1,taskId:'a',runId:call.run.id,outcome:'completed',summary:'apiKey=super-sensitive-secret-value',changedPaths:[],checksClaimed:[],blockingReasons:[]})});await tick();
      const run=f.store.run(call.run.id);expect(run.resultArtifactId).toBeTruthy();
      const artifact=f.store.require<{relativePath:string;sha256:string;byteSize:number}>('SELECT * FROM artifacts WHERE id=?',run.resultArtifactId!);
      const data=readFileSync(join(directory,artifact.relativePath));expect(data.toString()).not.toContain('super-sensitive-secret-value');expect(data.toString()).toContain('[REDACTED]');expect(createHash('sha256').update(data).digest('hex')).toBe(artifact.sha256);expect(data.length).toBe(artifact.byteSize);
      await f.coordinator.shutdown();stores.splice(stores.indexOf(f.store),1);f.store.close();const reopened=new RiftStore(join(directory,'rift.db'));try{expect(reopened.run(call.run.id).resultArtifactId).toBe(run.resultArtifactId);expect(reopened.get<{version:number}>('SELECT MAX(version) AS version FROM schema_migrations')!.version).toBeGreaterThanOrEqual(3);}finally{reopened.close();}
    }finally{if(stores.includes(f.store)){stores.splice(stores.indexOf(f.store),1);f.store.close();}rmSync(directory,{recursive:true});}
  });
  it('times out one execution without cancelling its completed sibling',async()=>{
    const f=fixture({timeoutMs:75});f.plan([{id:'a'},{id:'b'}]);f.dispatch('a');f.dispatch('b');await tick();f.complete(1);await new Promise(resolve=>setTimeout(resolve,100));
    expect(f.store.run(f.calls[0]!.run.id).stopReason).toBe('TIMEOUT');expect(f.store.task('a').status).toBe('cancelled');expect(f.store.task('b').status).toBe('succeeded');expect(f.coordinator.status('workflow').slots.total).toBe(0);await f.coordinator.shutdown();
  });
  it('does not revive a cancelled task when source collection finishes later',async()=>{
    const f=fixture();const entered=deferred<void>(),release=deferred<void>();
    f.git.collectSource=async()=>{entered.resolve();await release.promise;return{sourceHead:sha,diff:'saved after cancellation',changedPaths:['a.ts']};};
    f.plan([{id:'a',kind:'change'}]);f.dispatch('a');await tick();f.complete(0);await entered.promise;
    await f.coordinator.cancelTask('a');expect(()=>f.coordinator.retry({taskId:'a',reason:'too early',expectedVersion:f.store.task('a').version})).toThrow(/finalization/i);release.resolve();await tick();
    expect(f.store.task('a').status).toBe('cancelled');expect(f.calls).toHaveLength(1);expect(f.coordinator.status('workflow').operations[0]!.phase).toBe('cancelled');await f.coordinator.shutdown();
  });
  it('blocks interrupted finalization after confirmed cleanup so an explicit new attempt is possible',async()=>{
    const f=fixture();f.plan([{id:'a'}]);f.dispatch('a');await tick();f.complete(0);await tick();
    f.store.exec('UPDATE tasks SET status=? WHERE id=?','running','a');f.store.exec('UPDATE operations SET phase=? WHERE entity_id=?','started','a');
    const restored=new TaskCoordinator({store:f.store,bridge:{async start(){throw new Error('must not replay');}},git:f.git});
    await restored.recover();expect(f.store.task('a').status).toBe('blocked');expect(restored.status('workflow').slots.total).toBe(0);
    expect(restored.retry({taskId:'a',reason:'Inspect saved result and retry',expectedVersion:f.store.task('a').version}).attempt).toBe(2);await f.coordinator.shutdown();await restored.shutdown();
  });
  it('cancels a checked candidate while paused without requiring resume or starting review',async()=>{
    const f=fixture(),entered=deferred<void>(),release=deferred<void>();const prepare=f.git.prepareCandidate.bind(f.git);
    f.git.prepareCandidate=async input=>{const candidate=await prepare(input);entered.resolve();await release.promise;return candidate;};
    f.plan([{id:'a',kind:'change'}]);f.dispatch('a');await tick();f.complete(0);await entered.promise;f.coordinator.pause('workflow');release.resolve();await tick();
    await f.coordinator.cancelTask('a');await new Promise(resolve=>setTimeout(resolve,60));
    expect(f.coordinator.status('workflow').integrations[0]!.status).toBe('blocked');expect(f.calls).toHaveLength(1);expect(f.coordinator.status('workflow').operations.find(op=>op.kind==='integration')!.phase).toBe('cancelled');await f.coordinator.shutdown();
  });
  it('bounds unresponsive cleanup without releasing unknown slots or hanging shutdown',async()=>{
    const f=fixture({neverCleanup:true,cleanupTimeoutMs:35});f.plan([{id:'a'},{id:'b'}]);f.dispatch('a');f.dispatch('b');await tick();
    const started=Date.now();await f.coordinator.cancelWorkflow('workflow');await f.coordinator.shutdown();expect(Date.now()-started).toBeLessThan(1000);
    expect(f.coordinator.status('workflow').slots.total).toBe(2);expect(f.coordinator.status('workflow').runs.every(run=>run.cleanupStatus==='unknown'&&run.slotReleasedAt===null)).toBe(true);expect(f.store.events('workflow').filter(event=>event.type==='cleanup.unknown')).toHaveLength(2);
  });
  it('adds new dependencies and tasks in one revision while preserving queued request IDs',async()=>{
    const f=fixture();f.plan([{id:'a'}]);f.coordinator.pause('workflow');const request=f.dispatch('a');
    const tasks=f.coordinator.replan({workflowId:'workflow',expectedRevision:1,updates:[{taskId:'a',expectedVersion:0,dependsOn:['new']}],tasks:[{id:'new',kind:'analysis',title:'new',instructions:'new dependency',expectedPaths:['new']}]});
    expect(tasks.map(task=>task.id)).toEqual(['a','new']);expect(f.store.workflow('workflow').planRevision).toBe(2);
    expect(f.store.operation(request.id)).toMatchObject({phase:'queued',payload:{planRevision:2,expectedVersion:1}});
    f.dispatch('new');f.coordinator.resume('workflow');await tick();expect(f.calls.map(call=>call.run.taskId)).toEqual(['new']);
    f.complete(0);await tick();expect(f.calls[1]!.run.taskId).toBe('a');f.complete(1);await tick();await f.coordinator.shutdown();
  });
  it('rolls back invalid additions together with dependency edits',async()=>{
    const f=fixture();f.plan([{id:'a'}]);f.coordinator.pause('workflow');const request=f.dispatch('a');
    expect(()=>f.coordinator.replan({workflowId:'workflow',expectedRevision:1,updates:[{taskId:'a',expectedVersion:0,dependsOn:['new']}],tasks:[{id:'new',kind:'analysis',title:'',instructions:'invalid',expectedPaths:['new']}]})).toThrow();
    expect(f.store.workflow('workflow').planRevision).toBe(1);expect(f.store.task('a').version).toBe(0);expect(f.store.all('SELECT * FROM task_dependencies')).toHaveLength(0);expect(f.store.operation(request.id).payload.planRevision).toBe(1);await f.coordinator.shutdown();
  });
  it('enforces global capacity in SQLite even when a caller bypasses the scheduler',async()=>{
    const f=fixture();f.plan([{id:'a'},{id:'b'},{id:'c'}]);f.dispatch('a');f.dispatch('b');await tick();
    f.store.exec("INSERT INTO roles(id,workspace_id,name,purpose,kind,provider_binding_id,prompt,revision) VALUES('third','ws','third','developer','subagent','claude','third',1)");
    expect(()=>f.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('overflow','c','third','develop',1,'preparing','{}','later','now')")).toThrow(/capacity/i);
    expect(f.store.all('SELECT * FROM runs')).toHaveLength(2);await f.coordinator.shutdown();
  });
});
