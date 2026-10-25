import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { SessionId } from '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-subagent-claude-code';
import { RiftStore } from '../src/storage/database.js';
import { ProjectService } from '../src/project/index.js';
import { TaskCoordinator } from '../src/task/coordinator.js';
import { LocalGitService } from '../src/git/integration.js';
import { RiftHostService } from '../src/api/host-service.js';
import { startLocalApi } from '../src/api/local-api.js';
import { redact } from '../src/api/security.js';
import type { ActivationBridge, ActivationResult, Candidate, PlanTask } from '../src/contracts/index.js';

const shell=promisify(execFile),script=fileURLToPath(import.meta.url);
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
async function until(predicate:()=>boolean|Promise<boolean>,timeoutMs=15_000):Promise<void>{const end=Date.now()+timeoutMs;while(!await predicate()){if(Date.now()>end)throw new Error('PROBE_TIMEOUT');await sleep(20);}}
async function json(file:string):Promise<any>{return JSON.parse(await readFile(file,'utf8'));}
function safeReport(value:unknown):unknown{if(typeof value==='string')return redact(value,128*1024);if(Array.isArray(value))return value.map(safeReport);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,safeReport(item)]));return value;}
const reportJson=(value:unknown)=>JSON.stringify(safeReport(value),null,2);
function checkpoint(root:string,stage:string,details:unknown):void {const temporary=path.join(root,`checkpoint-${process.pid}-${Date.now()}.tmp`);writeFileSync(temporary,reportJson({stage,pid:process.pid,time:new Date().toISOString(),details}),{flag:'wx'});renameSync(temporary,path.join(root,'checkpoint.json'));}
async function boot(root:string){
  process.env.DSH_HOME=path.join(root,'dsh-home');process.env.RIFT_HOME=path.join(root,'plugin-home');process.env.RIFT_PORT='0';
  process.env.RIFT_CODEX_MODEL='gpt-6.1-sol';process.env.RIFT_CLAUDE_MODEL='claude-opus-5-5';
  initializeProfileFromDefault('rift-recovery-probe','sdk-minimal',process.env.DSH_HOME);
  return runProfile({environment:loadLayeredEnv('rift-recovery-probe'),profile:'rift-recovery-probe',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
}
function makeGit(root:string){return new LocalGitService({managedRoot:path.join(root,'managed'),commands:[{id:'whitespace',executable:'git',args:['diff','--check','HEAD^','HEAD']}]});}
async function initialize(store:RiftStore,git:LocalGitService,root:string){
  const repo=path.join(root,'中文 空格 repo');await mkdir(repo,{recursive:true});
  if(!existsSync(path.join(repo,'.git'))){await shell('git',['init','--initial-branch=main',repo]);await shell('git',['-C',repo,'config','user.name','RIFT recovery probe']);await shell('git',['-C',repo,'config','user.email','rift-recovery@example.invalid']);await writeFile(path.join(repo,'README.md'),'Controlled recovery probe\n');await shell('git',['-C',repo,'add','README.md']);await shell('git',['-C',repo,'commit','-m','baseline']);}
  const inspected=await git.inspectRepository(repo,'main');
  if(!store.get('SELECT id FROM workspaces WHERE id=?','probe')){
    const project=new ProjectService(store,new Set(['claude-code-dev','codex-review']));project.createWorkspace({id:'probe',name:'probe',rootPath:path.join(root,'managed','probe'),repositoryPath:repo,commonGitDir:inspected.commonGitDir,baseRef:'main'});
    project.configureRoles('probe',[{id:'claude',providerName:'claude-code-dev',packageVersion:'0.2.1-rc.3',configRevision:1,capabilities:{},credentialRefs:['native:claude']},{id:'codex',providerName:'codex-review',packageVersion:'0.2.1-rc.3',configRevision:1,capabilities:{},credentialRefs:['native:codex']}],[{name:'lead',kind:'dsh-lead',prompt:'Controlled probe Lead',revision:1},{name:'developer-a',kind:'subagent',providerBindingId:'claude',prompt:'Implement the supplied controlled task and return its exact result schema.',revision:1},{name:'developer-b',kind:'subagent',providerBindingId:'claude',prompt:'Implement the supplied controlled task and return its exact result schema.',revision:1},{name:'reviewer',kind:'subagent',providerBindingId:'codex',prompt:'Read-only exact commit review.',revision:1}]);
  }
  return inspected;
}
const task=(id:string,kind:'analysis'|'change'='analysis'):PlanTask=>({id,kind,title:id,instructions:'Controlled acceptance task; no model is used unless this probe is explicitly run with --native.',expectedPaths:[`${id}.txt`]});
type ControlledCall={input:Parameters<ActivationBridge['start']>[0];result:ReturnType<typeof deferred<ActivationResult>>;disposeCalls:number;cleanup:'confirmed'|'failed'|'never'};
function controlledBridge(){const calls:ControlledCall[]=[];const bridge:ActivationBridge={async start(input){const call:ControlledCall={input,result:deferred<ActivationResult>(),disposeCalls:0,cleanup:'confirmed'};calls.push(call);return{childId:`controlled-fake-${input.run.id}`,result:call.result.promise,async dispose(){call.disposeCalls++;if(call.cleanup==='failed')throw new Error('CONTROLLED_CLEANUP_FAILURE');if(call.cleanup==='never')await new Promise<void>(()=>{});}};}};
  const complete=async(call:ControlledCall)=>{const {input}=call;let body:unknown;if(input.run.purpose==='review')body={schemaVersion:1,taskId:input.task.id,runId:input.run.id,verdict:'approve',reviewedCommit:(JSON.parse(input.prompt) as {candidate:Candidate}).candidate.candidateHead,findings:[]};else{if(input.task.kind==='change')await writeFile(path.join(input.cwd,`${input.task.id}.txt`),`Controlled actual Git change for ${input.task.id}\n`);body={schemaVersion:1,taskId:input.task.id,runId:input.run.id,outcome:'completed',summary:'Controlled result; no native model called.',changedPaths:input.task.kind==='change'?[`${input.task.id}.txt`]:[],checksClaimed:[],blockingReasons:[]};}call.result.resolve({stopReason:'completed',text:JSON.stringify(body)});};
  return{bridge,calls,complete};
}
function compact(coordinator:TaskCoordinator){const snapshot=coordinator.status('workflow');return{workflow:snapshot.workflow,slots:snapshot.slots,tasks:snapshot.tasks,runs:snapshot.runs.map(run=>({id:run.id,taskId:run.taskId,status:run.status,dshChildId:run.dshChildId,cleanupStatus:run.cleanupStatus,slotReleasedAt:run.slotReleasedAt,resultArtifactId:run.resultArtifactId})),operations:snapshot.operations,integrations:snapshot.integrations,worktrees:snapshot.worktrees,eventSeq:snapshot.eventSeq};}
class PublicationTrapStore extends RiftStore {trap:(()=>never)|undefined;override exec(sql:string,...args:SQLInputValue[]):void{if(this.trap&&sql==='UPDATE integrations SET status=? WHERE id=?'&&args[0]==='accepted')this.trap();super.exec(sql,...args);}}

async function crashWorker(mode:string,root:string):Promise<never>{
  const host=await boot(root),git=makeGit(root),store=new PublicationTrapStore(path.join(root,'business','rift.db'));const repo=await initialize(store,git,root),controlled=controlledBridge();
  let coordinator:TaskCoordinator;
  const bridge:ActivationBridge=mode==='start-window'?{async start(input){controlled.calls.push({input,result:deferred<ActivationResult>(),disposeCalls:0,cleanup:'confirmed'});if(controlled.calls.length===2)checkpoint(root,mode,{liveDshHost:true,bridge:'controlled fake',snapshot:compact(coordinator)});return new Promise(()=>{});}}:controlled.bridge;
  coordinator=new TaskCoordinator({store,git,bridge,runTimeoutMs:120_000,cleanupTimeoutMs:100});
  const lead=await host.ctx.agents.create({sessionId:SessionId(`recovery-${mode}-${Date.now()}`),meta:{cwd:repo.rootPath}});
  coordinator.createWorkflow({id:'workflow',workspaceId:'probe',goal:'OS crash acceptance',integrationRef:'refs/heads/rift/recovery',baseCommit:repo.baseCommit,leadSessionId:lead.agent.id});
  if(mode==='publication')store.trap=()=>{checkpoint(root,mode,{liveDshHost:host.ctx.agents.get(lead.agent.id)===lead.agent,bridge:'controlled fake',snapshot:compact(coordinator),transaction:'Git ref advanced; SQLite acceptance BEGIN active, not COMMIT'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);throw new Error('Unexpected trap release');};
  if(mode==='result-cleanup')git.collectSource=async()=>{checkpoint(root,mode,{liveDshHost:true,bridge:'controlled fake',snapshot:compact(coordinator)});return new Promise(()=>{});};
  const tasks=mode==='publication'||mode==='result-cleanup'?[task('a','change')]:[task('a'),task('b'),task('c')];
  coordinator.submitPlan({workflowId:'workflow',expectedRevision:0,tasks});for(const entry of tasks)coordinator.dispatch({taskId:entry.id!,idempotencyKey:`dispatch-${entry.id}`,expectedVersion:0});
  if(mode==='running'){await until(()=>controlled.calls.length===2&&store.all<{status:string}>('SELECT status FROM runs').every(run=>run.status==='running'));checkpoint(root,mode,{liveDshHost:true,bridge:'controlled fake',snapshot:compact(coordinator)});}
  if(mode==='publication'||mode==='result-cleanup'){await until(()=>controlled.calls.length===1);await controlled.complete(controlled.calls[0]!);if(mode==='publication'){await until(()=>controlled.calls.length===2);await controlled.complete(controlled.calls[1]!);}}
  return new Promise(()=>{});
}
async function recoveryWorker(mode:string,root:string){
  const host=await boot(root),git=makeGit(root),store=new RiftStore(path.join(root,'business','rift.db'));let starts=0,publishes=0;
  const publish=git.publishCandidate.bind(git);git.publishCandidate=async input=>{publishes++;return publish(input);};
  const coordinator=new TaskCoordinator({store,git,bridge:{async start(){starts++;throw new Error('FORBIDDEN_RECOVERY_REPLAY');}}});
  try {
    const before=compact(coordinator),recovery=await coordinator.recover(),after=compact(coordinator);
    assert.equal(after.workflow.status,'paused');assert.equal(starts,0);assert.equal(publishes,0);
    if(['start-window','running','native'].includes(mode)){assert.equal(after.slots.developers,2);assert.equal(after.runs.length,2);assert(after.runs.every(run=>run.status==='interrupted'&&run.cleanupStatus==='unknown'&&run.slotReleasedAt===null));assert.equal(after.operations.find(op=>op.entityId==='c')?.phase,'queued');}
    if(mode==='result-cleanup'){assert.equal(after.slots.total,0);assert.equal(after.tasks[0]!.status,'blocked');assert.equal(after.tasks[0]!.blockingReason,'HOST_INTERRUPTED_FINALIZATION');assert.equal(after.runs[0]!.cleanupStatus,'confirmed');assert(after.runs[0]!.resultArtifactId);}
    let refHead:string|null=null,journal:unknown=null;
    if(mode==='publication'){assert.equal(after.tasks[0]!.status,'succeeded');assert.equal(recovery.recoveredIntegrationIds.length,1);refHead=await git.currentHead({workspace:store.workspace('probe'),workflow:store.workflow('workflow')});assert.equal(refHead,after.tasks[0]!.acceptedCommit);journal=await git.readOperation(store.workspace('probe'),recovery.recoveredIntegrationIds[0]!);const again=await coordinator.recover();assert.equal(again.recoveredIntegrationIds.length,0);}
    const lead=await host.ctx.agents.create({sessionId:SessionId(`recovered-${Date.now()}`),meta:{cwd:store.workspace('probe').repositoryPath}});
    coordinator.resume('workflow');await sleep(150);assert.equal(starts,0);assert.equal(publishes,0);assert.equal(coordinator.status('workflow').runs.length,after.runs.length);await lead.dispose();
    return{status:'pass',mode,boundary:'real DSH Host/SQLite/Git and abrupt OS termination; controlled activation except explicit native mode',before,recovery,after,afterExplicitResume:compact(coordinator),providerRestarts:starts,publishCalls:publishes,refHead,journal};
  }finally{await coordinator.shutdown();store.close();await host.shutdown.shutdown(0);}
}
async function controlWorker(root:string){
  const host=await boot(root),results:unknown[]=[];
  async function setup(name:string,tasks:PlanTask[],timeout=30_000){const home=path.join(root,name);await mkdir(home,{recursive:true});const store=new RiftStore(path.join(home,'rift.db')),git=makeGit(home),repo=await initialize(store,git,home),controlled=controlledBridge();const coordinator=new TaskCoordinator({store,git,bridge:controlled.bridge,runTimeoutMs:timeout,cleanupTimeoutMs:120});coordinator.createWorkflow({id:'workflow',workspaceId:'probe',goal:name,integrationRef:`refs/heads/rift/${name}`,baseCommit:repo.baseCommit});coordinator.submitPlan({workflowId:'workflow',expectedRevision:0,tasks});const dispatch=(id:string)=>coordinator.dispatch({taskId:id,idempotencyKey:`dispatch-${id}`,expectedVersion:store.task(id).version});return{store,git,controlled,coordinator,dispatch,close:async()=>{await coordinator.shutdown();store.close();}};}
  try {
    const paused=await setup('pause-develop',[task('a'),task('b'),task('c')]);
    try{paused.dispatch('a');paused.dispatch('b');paused.dispatch('c');await until(()=>paused.controlled.calls.length===2);paused.coordinator.pause('workflow');await Promise.all(paused.controlled.calls.map(call=>paused.controlled.complete(call)));await until(()=>paused.coordinator.status('workflow').slots.total===0);assert.equal(paused.controlled.calls.length,2);assert.equal(paused.store.task('c').status,'pending');paused.coordinator.resume('workflow');await until(()=>paused.controlled.calls.length===3);await paused.controlled.complete(paused.controlled.calls[2]!);await until(()=>paused.store.task('c').status==='succeeded');results.push({name:'paused development queue',status:'pass',snapshot:compact(paused.coordinator)});}finally{await paused.close();}
    const review=await setup('pause-review',[task('a','change')]),entered=deferred<void>(),release=deferred<void>(),prepare=review.git.prepareCandidate.bind(review.git);
    review.git.prepareCandidate=async input=>{const candidate=await prepare(input);entered.resolve();await release.promise;return candidate;};
    try{review.dispatch('a');await until(()=>review.controlled.calls.length===1);await review.controlled.complete(review.controlled.calls[0]!);await entered.promise;review.coordinator.pause('workflow');release.resolve();await until(()=>Boolean(review.coordinator.status('workflow').integrations[0]?.candidate));await sleep(80);assert.equal(review.controlled.calls.length,1);await review.coordinator.cancelTask('a');await until(()=>review.coordinator.status('workflow').integrations[0]?.status==='blocked');assert.equal(review.controlled.calls.length,1);results.push({name:'paused review admission and cancellation',status:'pass',snapshot:compact(review.coordinator)});}finally{release.resolve();await review.close();}
    const cancelled=await setup('cancel-all',[task('a','change'),task('b'),task('c'),task('d')]);
    try{cancelled.dispatch('a');await until(()=>cancelled.controlled.calls.length===1);await cancelled.controlled.complete(cancelled.controlled.calls[0]!);await until(()=>cancelled.controlled.calls.length===2);cancelled.controlled.calls[1]!.cleanup='never';cancelled.dispatch('b');cancelled.dispatch('c');cancelled.dispatch('d');await until(()=>cancelled.controlled.calls.length===4);cancelled.controlled.calls[2]!.cleanup='failed';const start=Date.now();await cancelled.coordinator.cancelWorkflow('workflow');await until(()=>cancelled.coordinator.status('workflow').runs.every(run=>['succeeded','cancelled'].includes(run.status)));const snapshot=compact(cancelled.coordinator);assert.equal(snapshot.slots.total,2);assert(snapshot.runs.some(run=>run.cleanupStatus==='unknown'));assert(snapshot.runs.some(run=>run.cleanupStatus==='failed'));assert(cancelled.controlled.calls.every(call=>call.disposeCalls===1));assert.equal(snapshot.operations.find(op=>op.entityId==='d')?.phase,'cancelled');results.push({name:'whole workflow cancellation including cleanup timeout/failure',status:'pass',durationMs:Date.now()-start,disposeCalls:cancelled.controlled.calls.map(call=>({taskId:call.input.task.id,purpose:call.input.run.purpose,count:call.disposeCalls})),snapshot});}finally{await cancelled.close();}
    const timed=await setup('timeout',[task('a'),task('b')],1500);
    try{timed.dispatch('a');await until(()=>timed.controlled.calls.length===1);await sleep(700);timed.dispatch('b');await until(()=>timed.controlled.calls.length===2);await until(()=>timed.store.run(timed.controlled.calls[0]!.input.run.id).stopReason==='TIMEOUT');assert.equal(timed.store.run(timed.controlled.calls[1]!.input.run.id).status,'running');await timed.controlled.complete(timed.controlled.calls[1]!);await until(()=>timed.store.task('b').status==='succeeded');results.push({name:'one timeout leaves later sibling live',status:'pass',snapshot:compact(timed.coordinator)});}finally{await timed.close();}
    return{status:'pass',boundary:'real DSH Host/SQLite/Git with controlled fake activations',cases:results};
  }finally{await host.shutdown.shutdown(0);}
}
type ProcessIdentity={pid:number;parentPid:number;name:string;createdAt:string};
async function identities(pids?:number[]):Promise<ProcessIdentity[]>{
  if(process.platform!=='win32')throw new Error('This process-identity probe currently targets Windows.');
  const filter=pids?` | Where-Object { $_.ProcessId -in @(${pids.join(',')}) }`:'';
  const script=`Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,Name,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
  const output=await shell('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,maxBuffer:2*1024*1024});const parsed=output.stdout.trim()?JSON.parse(output.stdout):[];return(Array.isArray(parsed)?parsed:[parsed]).map(row=>({pid:Number(row.ProcessId),parentPid:Number(row.ParentProcessId),name:String(row.Name),createdAt:String(row.CreatedAt)}));
}
async function descendants(pid:number){const all=await identities(),selected=new Set([pid]);let changed=true;while(changed){changed=false;for(const row of all)if(selected.has(row.parentPid)&&!selected.has(row.pid)){selected.add(row.pid);changed=true;}}return all.filter(row=>selected.has(row.pid)&&row.pid!==pid);}
async function remaining(known:ProcessIdentity[]){if(!known.length)return[];const current=await identities(known.map(row=>row.pid));return current.filter(row=>known.some(prior=>prior.pid===row.pid&&prior.createdAt===row.createdAt));}
async function subprocessWorker(root:string){
  const host=await boot(root),results:unknown[]=[];let stopped=false;
  try {
    for(const method of ['terminate','service-dispose'] as const){
      const folder=path.join(root,method);await mkdir(folder,{recursive:true});
      const childSource=`const fs=require('node:fs'),path=require('node:path');const root=process.argv[2];fs.writeFileSync(path.join(root,'grandchild.json'),JSON.stringify({pid:process.pid,ppid:process.ppid}));setInterval(()=>fs.writeFileSync(path.join(root,'grandchild.heartbeat'),String(Date.now())),50);`;
      const parentSource=`const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');const root=process.argv[2];const child=spawn(process.execPath,[path.join(root,'grandchild.cjs'),root],{stdio:'ignore',windowsHide:true});fs.writeFileSync(path.join(root,'root.json'),JSON.stringify({pid:process.pid,ppid:process.ppid,childPid:child.pid}));setInterval(()=>fs.writeFileSync(path.join(root,'root.heartbeat'),String(Date.now())),50);`;
      await writeFile(path.join(folder,'grandchild.cjs'),childSource);await writeFile(path.join(folder,'root.cjs'),parentSource);
      const handle=host.ctx.subprocess.spawn({argv:[process.execPath,path.join(folder,'root.cjs'),folder],cwd:folder,stdio:{stdin:'ignore',stdout:{maxBytes:4096},stderr:{maxBytes:4096}},graceMs:1000});
      await until(()=>existsSync(path.join(folder,'grandchild.heartbeat'))&&existsSync(path.join(folder,'root.heartbeat')));
      const rootPid=(await json(path.join(folder,'root.json'))).pid as number,childPid=(await json(path.join(folder,'grandchild.json'))).pid as number;const before=await identities([rootPid,childPid]);assert.equal(before.length,2);
      if(method==='terminate')handle.terminate();else{await host.shutdown.shutdown(0);stopped=true;}
      const quiescent=await handle.waitForExit(AbortSignal.timeout(10_000));const outcome=await handle.done;const stillAlive=await remaining(before);const heartbeatBefore=await Promise.all(['root','grandchild'].map(name=>readFile(path.join(folder,`${name}.heartbeat`),'utf8')));await sleep(350);const heartbeatAfter=await Promise.all(['root','grandchild'].map(name=>readFile(path.join(folder,`${name}.heartbeat`),'utf8')));
      assert.equal(quiescent,true);assert.deepEqual(stillAlive,[]);assert.deepEqual(heartbeatAfter,heartbeatBefore);results.push({method,status:'pass',before,outcome,wholeRangeQuiescent:quiescent,survivors:stillAlive,heartbeatStopped:true});
    }
    return{status:'pass',boundary:'real public DSH subprocess service, controlled Node root plus Node grandchild; no model-triggered command',cases:results};
  }finally{if(!stopped)await host.shutdown.shutdown(0);}
}
async function nativeWorker(root:string,controls=false):Promise<unknown>{
  const host=await boot(root),service=new RiftHostService(host.ctx,{home:path.join(root,'business'),port:0,leadProvider:'deepseek-official',leadModel:'deepseek-flash',checks:[{id:'whitespace',executable:'git',args:['diff','--check','HEAD^','HEAD']}],runTimeoutMs:10*60_000});await service.initialize();const repo=await initialize(service.store,service.git,root);
  const nativeStarts:unknown[]=[],nativeEnds:{id:string;runId:string;provider:string;stopReason:string}[]=[];
  host.ctx.on('subagent/start',info=>{nativeStarts.push({id:info.id,runId:info.runId,provider:info.provider});});
  host.ctx.on('subagent/end',info=>{nativeEnds.push({id:info.id,runId:info.runId,provider:info.provider,stopReason:info.stopReason});});
  service.coordinator.createWorkflow({id:'workflow',workspaceId:'probe',goal:'Native in-flight crash recovery probe',integrationRef:'refs/heads/rift/recovery',baseCommit:repo.baseCommit});await service.ensureLead('workflow');
  const gate=path.join(root,'release-gate.txt');await writeFile(gate,'CLOSED\n');
  const tasks=[task('a','change'),task('b','change'),task('c','change')].map(entry=>({...entry,expectedPaths:[`${entry.id}.txt`,`${entry.id}.gate.txt`],instructions:`This is an authorized controlled lifecycle test in your temporary repository. Use only Read/Write/Edit tools, never shell commands. First Write ${entry.id}.gate.txt inside your cwd with content CLOSED. Then Write ${entry.id}.txt in your cwd containing RIFT_NATIVE_READY and counter 0. Repeatedly Read your local ${entry.id}.gate.txt. While its content is CLOSED, increment the counter and Write ${entry.id}.txt again, then Read the gate again. Keep making separate tool calls. Do not return a final result while CLOSED. Stop after 200 iterations if it never changes. Only edit these two permitted files. If the local gate reads OPEN, return the exact development result schema. The test owner will cancel this native activation or terminate only its own host while it is in flight. No external directories, global configuration or credentials are to be read.`}));
  service.coordinator.submitPlan({workflowId:'workflow',expectedRevision:0,tasks});for(const entry of tasks)service.coordinator.dispatch({taskId:entry.id!,idempotencyKey:`native-${entry.id}`,expectedVersion:0});
  process.on('message',message=>{if((message as {cancel?:boolean})?.cancel)void(async()=>{await service.close();await host.shutdown.shutdown(0);process.exit(0);})();});
  const heartbeatPaths=()=>['a','b'].map(name=>{const tree=service.coordinator.status('workflow').worktrees.find(tree=>tree.taskId===name);return tree?path.join(tree.path,`${name}.txt`):null;});
  await until(()=>heartbeatPaths().every(file=>Boolean(file&&existsSync(file)))&&service.coordinator.status('workflow').runs.filter(run=>run.status==='running').length===2,4*60_000);
  if(controls){
    const api=await startLocalApi(service,{home:path.join(root,'business'),port:0});
    try{
      const before=compact(service.coordinator),allDescendants=await descendants(process.pid),providerIds=new Set(allDescendants.filter(item=>item.name.toLowerCase()==='claude.exe').map(item=>item.pid));
      for(const item of allDescendants.filter(item=>providerIds.has(item.pid))){let parent=allDescendants.find(candidate=>candidate.pid===item.parentPid);while(parent){providerIds.add(parent.pid);parent=allDescendants.find(candidate=>candidate.pid===parent!.parentPid);}}
      let added=true;while(added){added=false;for(const item of allDescendants)if(providerIds.has(item.parentPid)&&!providerIds.has(item.pid)){providerIds.add(item.pid);added=true;}}
      const tracked=allDescendants.filter(item=>providerIds.has(item.pid));assert.equal(tracked.filter(item=>item.name.toLowerCase()==='claude.exe').length,2);
      const token=(await readFile(path.join(root,'business','management.token'),'utf8')).trim();
      async function manage(action:string,body:unknown){const response=await fetch(`http://127.0.0.1:${api.port}/v1/workflows/workflow/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':`native-controls-${action}`},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
      await manage('pause',{expectedVersion:service.store.workflow('workflow').version});await sleep(700);
      const paused=compact(service.coordinator);assert.equal(paused.workflow.status,'paused');assert.equal(paused.runs.length,2);assert.equal(paused.operations.find(op=>op.entityId==='c')?.phase,'queued');assert.equal(nativeStarts.length,2);
      const started=Date.now();await manage('cancel',{});
      await until(()=>nativeEnds.length===2&&service.coordinator.status('workflow').runs.every(run=>run.status==='cancelled'&&run.cleanupStatus==='confirmed'),20_000);
      const cancelled=compact(service.coordinator);assert.equal(cancelled.slots.total,0);assert.equal(cancelled.workflow.status,'cancelled');assert.equal(cancelled.operations.find(op=>op.entityId==='c')?.phase,'cancelled');assert.equal(nativeStarts.length,2);assert(nativeEnds.every(item=>item.stopReason==='aborted'));
      let survivors=tracked;await until(async()=>{survivors=await remaining(tracked);return survivors.length===0;},15_000);
      const files=heartbeatPaths() as string[],contents=await Promise.all(files.map(file=>readFile(file,'utf8')));await sleep(500);assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),contents);
      return{status:'pass',boundary:'real official Claude activations; loopback management API pause and whole-workflow cancellation; no external process kill',provider:'claude-code-dev',model:'claude-opus-5-5',before,paused,cancelled,nativeStarts,nativeEnds,cancellationDurationMs:Date.now()-started,allDescendants,tracked,survivors,readyFilesStableAfterCancellation:true,hostClosed:true};
    }finally{await api.close();await service.close();await host.shutdown.shutdown(0);process.disconnect?.();}
  }
  checkpoint(root,'native',{liveDshHost:true,provider:'claude-code-dev',model:'claude-opus-5-5',bridge:'real official DSH Claude Code Provider; Read/Write gate, no shell',snapshot:compact(service.coordinator),heartbeatPaths:heartbeatPaths(),descendants:await descendants(process.pid)});return new Promise(()=>{});
}

async function worker(action:string,mode:string,root:string){await mkdir(root,{recursive:true});if(action==='seed')return crashWorker(mode,root);if(action==='native')return nativeWorker(root);if(action==='native-controls')return nativeWorker(root,true);if(action==='recover')return recoveryWorker(mode,root);if(action==='controls')return controlWorker(root);if(action==='subprocess')return subprocessWorker(root);if(action==='lease'){const store=new RiftStore(path.join(root,'business','rift.db'));checkpoint(root,'lease-acquired',{owner:process.pid});process.send?.({status:'acquired',pid:process.pid});setInterval(()=>{},1000);return new Promise(()=>{});}throw new Error('Unknown worker action');}
function launch(action:string,mode:string,root:string):{child:ChildProcess;output:()=>string;done:Promise<{code:number|null;signal:NodeJS.Signals|null}>}{
  const child=spawn(process.execPath,['--import','tsx',script,'--worker',action,mode,root],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});let output='';child.stdout?.on('data',data=>{output=(output+String(data)).slice(-16000);});child.stderr?.on('data',data=>{output=(output+String(data)).slice(-16000);});const done=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));return{child,output:()=>redact(output,16000),done};
}
async function runToCompletion(action:string,mode:string,root:string){const run=launch(action,mode,root);const timer=setTimeout(()=>run.child.kill('SIGKILL'),action==='native-controls'?5*60_000:60_000);try{const exit=await run.done;const result=await json(path.join(root,`${action}-result.json`)).catch(()=>({status:'fail',error:run.output()}));if(exit.code!==0||result.status!=='pass')throw new Error(JSON.stringify({action,mode,exit,result,output:run.output()}));return result;}finally{clearTimeout(timer);}}
async function killAtCheckpoint(mode:string,root:string,native=false){
  const run=launch(native?'native':'seed',mode,root);let dead=false;void run.done.then(()=>{dead=true;});
  try {await until(()=>existsSync(path.join(root,'checkpoint.json'))||dead,native?5*60_000:30_000);if(dead)throw new Error(`Host exited before checkpoint: ${run.output()}`);const point=await json(path.join(root,'checkpoint.json'));const known=native?(point.details.descendants as ProcessIdentity[]):[];assert(run.child.pid&&run.child.pid===point.pid);const killedAt=new Date().toISOString();assert.equal(run.child.kill('SIGKILL'),true);const exit=await run.done;let survivors=known;const end=Date.now()+15_000;while(known.length&&Date.now()<end){survivors=await remaining(known);if(!survivors.length)break;await sleep(300);}let heartbeatsStopped:boolean|null=null;if(native){const files=point.details.heartbeatPaths as string[];const before=await Promise.all(files.map(file=>readFile(file,'utf8')));await sleep(500);heartbeatsStopped=JSON.stringify(before)===JSON.stringify(await Promise.all(files.map(file=>readFile(file,'utf8'))));}
    return{status:'pass',mode,hostPid:point.pid,killedAt,exit,checkpoint:point,nativeCleanup:native?{status:known.length>0&&survivors.length===0&&heartbeatsStopped?'pass':'unknown',tracked:known,survivors,heartbeatsStopped}:null};
  }catch(error){if(!dead){run.child.send?.({cancel:true});await Promise.race([run.done,sleep(12_000)]);if(!dead)run.child.kill('SIGKILL');await run.done;}throw error;}
}
async function leaseRace(root:string){const runs=[launch('lease','one',root),launch('lease','two',root)];const observations=await Promise.all(runs.map(run=>new Promise<{status:string;pid?:number;output?:string}>(resolve=>{run.child.once('message',message=>resolve(message as {status:string;pid:number}));run.child.once('exit',()=>resolve({status:'rejected',output:run.output()}));})));try{assert.equal(observations.filter(value=>value.status==='acquired').length,1);assert.equal(observations.filter(value=>value.status==='rejected').length,1);return{status:'pass',observations};}finally{for(const run of runs)if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill('SIGKILL');await Promise.all(runs.map(run=>run.done));}}

if(process.argv[2]==='--worker'){
  const action=process.argv[3]!,mode=process.argv[4]!,root=path.resolve(process.argv[5]!);
  try{const result=await worker(action,mode,root);await writeFile(path.join(root,`${action}-result.json`),reportJson(result));process.exitCode=0;}catch(error){await writeFile(path.join(root,`${action}-result.json`),reportJson({status:'fail',error:redact(String(error))}));console.error(redact(String(error)));process.exitCode=1;}
}else{
  const evidenceRoot=path.resolve('.runtime-evidence');await mkdir(evidenceRoot,{recursive:true});const root=await mkdtemp(path.join(evidenceRoot,'recovery-acceptance-'));const native=process.argv.includes('--native'),nativeControls=process.argv.includes('--native-controls');
  const report:Record<string,unknown>={date:new Date().toISOString(),node:process.version,platform:process.platform,dsh:'0.2.1-rc.3',root,mode:nativeControls?'native Claude management API pause and cancellation':native?'native Claude in-flight Host kill':'real Host/SQLite/Git OS fault windows, controlled fake activations and real subprocess service',nativeModelCallsRequested:native||nativeControls,cases:[]};
  try{
    for(const mode of nativeControls?[]:native?['native']:['start-window','running','result-cleanup','publication']){const folder=path.join(root,mode);await mkdir(folder,{recursive:true});const crash=await killAtCheckpoint(mode,folder,native);const lease=mode==='start-window'?await leaseRace(folder):null;const recovery=await runToCompletion('recover',mode,folder);(report.cases as unknown[]).push({mode,status:'pass',crash,lease,recovery});console.log(`PASS ${mode}`);}
    if(nativeControls){report.controls=await runToCompletion('native-controls','native-controls',path.join(root,'native-controls'));console.log('PASS native controls');}
    if(!native&&!nativeControls){report.controls=await runToCompletion('controls','controls',path.join(root,'controls'));console.log('PASS controls');report.subprocess=await runToCompletion('subprocess','subprocess',path.join(root,'subprocess'));console.log('PASS subprocess tree');}
    report.status=native&&(report.cases as {crash:{nativeCleanup:{status:string}}}[]).some(entry=>entry.crash.nativeCleanup.status!=='pass')?'partial':'pass';if(report.status==='partial')process.exitCode=2;
  }catch(error){report.status='fail';report.error=redact(String(error),24000);process.exitCode=1;}
  const file=path.join(evidenceRoot,nativeControls?'recovery-native-controls.json':native?'recovery-native-acceptance.json':'recovery-acceptance.json');await writeFile(path.join(root,'report.json'),reportJson(report));await writeFile(file,reportJson(report));console.log(JSON.stringify({status:report.status,evidence:file,root,error:report.error??null},null,2));
}

