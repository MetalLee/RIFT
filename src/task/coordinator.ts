import { invariant, RiftError, type ActivationBridge, type ActivationHandle, type Candidate, type DevelopmentResult, type GitService, type Operation, type PlanTask, type ReviewResult, type Role, type Run, type Task, type TaskEvent, type Workflow, type Worktree } from '../contracts/index.js';
import { id, now, RiftStore } from '../storage/database.js';
import { dependencyStatus, normalizeExpectedPaths, pathsOverlap, validateDag } from './scheduler.js';
import { parseResult } from './results.js';
import { redact } from '../api/security.js';
import { saveResultArtifact } from '../storage/artifacts.js';
import { createHash } from 'node:crypto';

interface Active { controller:AbortController; handle?:ActivationHandle; cleanup?:Promise<boolean>; cancelled:boolean; cancelReason?:string }
interface IntegrationRecord { id:string; taskId:string; status:string; candidate:Candidate|null; reviewRunId:string|null; error:string|null }
export interface CoordinatorOptions { store:RiftStore; bridge:ActivationBridge; git:GitService; runTimeoutMs?:number;cleanupTimeoutMs?:number }
export interface CreateWorkflowInput { id?:string; workspaceId:string; goal:string; integrationRef:string; baseCommit:string; leadSessionId?:string }
export interface DispatchInput {taskId:string;idempotencyKey:string;expectedVersion:number;roleName?:'developer-a'|'developer-b'}
export interface WaitInput {workflowId:string;runIds?:string[];requestIds?:string[];afterEventSeq?:number;timeoutMs?:number}
const terminalRuns=new Set(['succeeded','failed','cancelled','interrupted']);
const terminalWorkflows=new Set(['completed','failed','cancelled']);
const errorMessage=(error:unknown):string=>redact(error instanceof Error?error.message:String(error),4096);
function safeValue(value:unknown):unknown {if(typeof value==='string')return redact(value);if(Array.isArray(value))return value.map(safeValue);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,safeValue(entry)]));return value;}

export class TaskCoordinator {
  readonly store:RiftStore;
  private readonly bridge:ActivationBridge;
  private readonly git:GitService;
  private readonly runTimeoutMs:number;
  private readonly cleanupTimeoutMs:number;
  private readonly active=new Map<string,Active>();
  private readonly background=new Set<Promise<void>>();
  private pumping=false;
  private stopping=false;
  private integrationBusy=false;
  constructor(options:CoordinatorOptions) {this.store=options.store;this.bridge=options.bridge;this.git=options.git;this.runTimeoutMs=options.runTimeoutMs??30*60_000;this.cleanupTimeoutMs=options.cleanupTimeoutMs??10_000;}

  createWorkflow(input:CreateWorkflowInput):Workflow {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept new work.');
    if(input.id)invariant(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.id),'INVALID_ID','Workflow ID must be a safe identifier.');
    invariant(this.store.workspace(input.workspaceId).status==='active','WORKSPACE_ARCHIVED','Archived workspaces cannot start workflows.');
    invariant(input.goal.trim()&&/^refs\/heads\/rift\/[A-Za-z0-9_./-]+$/.test(input.integrationRef)&&/^[0-9a-f]{40,64}$/.test(input.baseCommit),'INVALID_WORKFLOW','Workflow needs a goal, rift integration branch and exact base commit.');
    return this.store.transaction(()=>{
      if(input.id) {const prior=this.store.get<Workflow>('SELECT * FROM workflows WHERE id=?',input.id);if(prior){invariant(prior.workspaceId===input.workspaceId&&prior.goal===input.goal&&prior.baseCommit===input.baseCommit&&prior.integrationRef===input.integrationRef,'IDEMPOTENCY_CONFLICT','Workflow ID was used for different input.');return prior;}}
      invariant(!this.store.get('SELECT id FROM workflows WHERE status NOT IN (\'completed\',\'failed\',\'cancelled\') LIMIT 1')&&!this.store.get('SELECT id FROM runs WHERE slot_released_at IS NULL LIMIT 1')&&!this.store.get('SELECT id FROM integrations WHERE status IN (\'preparing\',\'reviewing\',\'publishing\',\'cleanup_unknown\') LIMIT 1'),'WORKFLOW_CAPACITY','Only one workflow may own active work or unconfirmed cleanup.');
      invariant(this.store.all<Role>('SELECT * FROM roles WHERE workspace_id=?',input.workspaceId).length===4,'ROLES_NOT_CONFIGURED','Configure all four roles before starting a workflow.');
      const workflowId=input.id??id('workflow');
      this.store.exec('INSERT INTO workflows(id,workspace_id,goal,lead_session_id,status,integration_ref,base_commit) VALUES(?,?,?,?,?,?,?)',workflowId,input.workspaceId,input.goal,input.leadSessionId??null,'planning',input.integrationRef,input.baseCommit);
      this.store.event(workflowId,'workflow.created');return this.store.workflow(workflowId);
    });
  }
  submitPlan(input:{workflowId:string;expectedRevision:number;tasks:PlanTask[];acceptanceCriteria?:string[]}):Task[] {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept plans.');
    return this.store.transaction(()=>{
      const workflow=this.store.workflow(input.workflowId);
      invariant(!terminalWorkflows.has(workflow.status),'INVALID_STATE','Cannot plan a terminal workflow.');
      invariant(workflow.planRevision===input.expectedRevision,'VERSION_CONFLICT','Plan revision changed.');
      invariant(workflow.planRevision<6,'REPLAN_BUDGET','Workflow allows at most five replans.');
      const existing=this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=?',workflow.id);
      invariant(input.tasks.length>0&&existing.length+input.tasks.length<=10,'PLAN_LIMIT','A workflow may contain at most ten tasks.');
      const fresh=input.tasks.map(task=>({...task,id:task.id??id('task'),expectedPaths:normalizeExpectedPaths(task.expectedPaths),acceptanceCriteria:[...new Set([...(input.acceptanceCriteria??[]),...(task.acceptanceCriteria??[])])]}));
      invariant(fresh.every(task=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(task.id)),'INVALID_ID','Task IDs must be safe identifiers.');
      const graph=existing.map(task=>({id:task.id,dependsOn:this.store.all<{dependsOnTaskId:string}>('SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?',task.id).map(dep=>dep.dependsOnTaskId)}));
      validateDag([...graph,...fresh.map(task=>({id:task.id,dependsOn:task.dependsOn??[]}))]);
      for(const task of fresh){
        invariant(task.title.trim()&&task.instructions.trim()&&['change','analysis'].includes(task.kind),'INVALID_TASK','Task title, instructions and kind are required.');
        const roleId=task.roleName?this.store.require<Role>('SELECT * FROM roles WHERE workspace_id=? AND name=?',workflow.workspaceId,task.roleName).id:null;
        this.store.exec('INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES(?,?,?,?,?,?,?,?,?)',task.id,workflow.id,roleId,task.kind,task.title,task.instructions,JSON.stringify(task.expectedPaths),JSON.stringify(task.acceptanceCriteria??[]),'pending');
      }
      for(const task of fresh)for(const dep of task.dependsOn??[])this.store.exec('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)',task.id,dep);
      this.store.exec('UPDATE workflows SET plan_revision=plan_revision+1,version=version+1,status=? WHERE id=?',workflow.status==='paused'?'paused':'running',workflow.id);
      this.store.event(workflow.id,'plan.accepted',{revision:workflow.planRevision+1,taskIds:fresh.map(task=>task.id),acceptanceCriteria:input.acceptanceCriteria??[]});
      return this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=? ORDER BY rowid',workflow.id);
    });
  }
  dispatch(input:DispatchInput):Operation {
    const operation=this.enqueue('dispatch',input.taskId,input.idempotencyKey,input.expectedVersion,undefined,input.roleName);
    this.pump();return this.store.operation(operation.id);
  }
  requestIntegration(input:{taskId:string;sourceHead:string;idempotencyKey:string;expectedVersion:number}):Operation {
    const operation=this.enqueue('integration',input.taskId,input.idempotencyKey,input.expectedVersion,input.sourceHead);
    this.pump();return this.store.operation(operation.id);
  }
  private enqueue(kind:'dispatch'|'integration',taskId:string,key:string,expectedVersion:number,sourceHead?:string,roleName?:string):Operation {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept queue requests.');
    invariant(key.trim()&&key.length<=256,'INVALID_DEDUPE_KEY','A bounded nonempty idempotency key is required.');
    return this.store.transaction(()=>{
      const prior=this.store.get<Operation>('SELECT * FROM operations WHERE dedupe_key=?',key);
      if(prior){invariant(prior.kind===kind&&prior.entityId===taskId&&(kind!=='integration'||prior.payload.sourceHead===sourceHead),'IDEMPOTENCY_CONFLICT','Idempotency key belongs to a different request.');return prior;}
      const task=this.store.task(taskId),workflow=this.store.workflow(task.workflowId);
      invariant(!terminalWorkflows.has(workflow.status),'INVALID_STATE','Workflow is terminal.');
      invariant(task.version===expectedVersion,'VERSION_CONFLICT','Task version changed.');
      const duplicate=this.store.get<Operation>('SELECT * FROM operations WHERE kind=? AND entity_id=? AND phase IN (\'queued\',\'started\')',kind,taskId);
      invariant(!duplicate,'DUPLICATE_REQUEST','Task already has an unfinished request.');
      invariant(kind==='dispatch'?['pending','ready'].includes(task.status):task.kind==='change'&&task.status==='validating'&&task.sourceHead===sourceHead,'INVALID_STATE','Task is not eligible for this request.');
      const role=roleName?this.store.require<Role>('SELECT * FROM roles WHERE workspace_id=? AND name=?',workflow.workspaceId,roleName):undefined;
      const payload:Operation['payload']={expectedVersion,planRevision:workflow.planRevision};
      if(role)payload.roleId=role.id;if(sourceHead)payload.sourceHead=sourceHead;
      const requestId=id('request');
      this.store.exec('INSERT INTO operations(id,kind,dedupe_key,entity_id,phase,payload,created_at) VALUES(?,?,?,?,?,?,?)',requestId,kind,key,taskId,'queued',JSON.stringify(payload),now());
      this.store.event(workflow.id,`${kind}.queued`,{}, {taskId,requestId});return this.store.operation(requestId);
    });
  }
  private dependencies(task:Task):Task[] {return this.store.all<Task>('SELECT t.* FROM tasks t JOIN task_dependencies d ON d.depends_on_task_id=t.id WHERE d.task_id=?',task.id);}
  private operationPhase(operation:Operation,phase:Operation['phase'],error?:string):void {
    const payload={...operation.payload};if(error)payload.error=error;
    this.store.exec('UPDATE operations SET phase=?,payload=? WHERE id=?',phase,JSON.stringify(payload),operation.id);
    const task=this.store.task(operation.entityId);this.store.event(task.workflowId,`${operation.kind}.${phase}`,error?{error}:{},{taskId:task.id,requestId:operation.id,...(payload.runId?{runId:payload.runId}:{})});
  }
  private reserve(operation:Operation):Run|undefined {
    return this.store.transaction(()=>{
      const task=this.store.task(operation.entityId),workflow=this.store.workflow(task.workflowId);
      if(workflow.status!=='running')return;
      if(operation.payload.planRevision!==workflow.planRevision||operation.payload.expectedVersion!==task.version){this.operationPhase(operation,'blocked','STALE_REQUEST');return;}
      const dependency=dependencyStatus(this.dependencies(task));
      if(dependency==='blocked'){this.operationPhase(operation,'blocked','DEPENDENCY_BLOCKED');this.store.exec('UPDATE tasks SET status=?,blocking_reason=?,version=version+1 WHERE id=?','blocked','DEPENDENCY_BLOCKED',task.id);return;}
      if(dependency==='waiting')return;
      const occupied=this.store.all<Run>('SELECT * FROM runs WHERE slot_released_at IS NULL');
      if(occupied.length>=3||occupied.filter(run=>run.purpose!=='review').length>=2||occupied.some(run=>run.taskId===task.id))return;
      if(occupied.some(run=>run.purpose!=='review'&&pathsOverlap(task.expectedPaths,this.store.task(run.taskId).expectedPaths)))return;
      const roles=this.store.all<Role>('SELECT * FROM roles WHERE workspace_id=? AND name IN (\'developer-a\',\'developer-b\') ORDER BY name',workflow.workspaceId);
      const requestedRole=operation.payload.roleId??task.roleId;
      const role=roles.find(candidate=>(!requestedRole||candidate.id===requestedRole)&&!occupied.some(run=>run.roleId===candidate.id));
      if(!role)return;
      const run=this.createRun(task,role,task.attempt===1?'develop':'repair');
      operation.payload.runId=run.id;
      this.store.exec('UPDATE tasks SET status=?,version=version+1,blocking_reason=NULL WHERE id=?','running',task.id);
      this.operationPhase(operation,'started');this.store.event(workflow.id,'dispatch_reserved',{}, {taskId:task.id,runId:run.id,requestId:operation.id});return run;
    });
  }
  private createRun(task:Task,role:Role,purpose:Run['purpose']):Run {
    const runId=id('run'),binding=role.providerBindingId?this.store.binding(role.providerBindingId):null;
    invariant(binding,'BINDING_NOT_FOUND','Child role needs a registered provider binding.');
    this.store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?)',runId,task.id,role.id,purpose,task.attempt,'preparing',JSON.stringify({role,binding}),new Date(Date.now()+this.runTimeoutMs).toISOString(),now());
    return this.store.run(runId);
  }
  private track(promise:Promise<void>):void {this.background.add(promise);void promise.finally(()=>this.background.delete(promise)).catch(()=>{});}
  private pump():void {
    if(this.stopping||this.pumping)return;this.pumping=true;
    try {
      for(const operation of this.store.all<Operation>('SELECT * FROM operations WHERE kind=\'dispatch\' AND phase=\'queued\' ORDER BY created_at,id')) {
        const run=this.reserve(operation);if(run)this.track(this.executeDevelopment(run,operation).catch(error=>this.unexpected(run,error)));
      }
      if(!this.integrationBusy&&!this.store.get('SELECT id FROM integrations WHERE status IN (\'preparing\',\'reviewing\',\'publishing\',\'cleanup_unknown\') LIMIT 1')) {
        for(const operation of this.store.all<Operation>('SELECT * FROM operations WHERE kind=\'integration\' AND phase=\'queued\' ORDER BY created_at,id')) {
          const task=this.store.task(operation.entityId),workflow=this.store.workflow(task.workflowId);
          if(workflow.status!=='running'||this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',task.id))continue;
          if(operation.payload.planRevision!==workflow.planRevision||task.sourceHead!==operation.payload.sourceHead||task.version!==operation.payload.expectedVersion){this.store.transaction(()=>this.operationPhase(operation,'blocked','STALE_REQUEST'));continue;}
          this.integrationBusy=true;
          this.track(this.executeIntegration(operation).catch(error=>{this.store.transaction(()=>this.operationPhase(this.store.operation(operation.id),'blocked',errorMessage(error)));}).finally(()=>{this.integrationBusy=false;this.pump();}));break;
        }
      }
    } finally {this.pumping=false;}
  }
  private context(task:Task) {const workflow=this.store.workflow(task.workflowId);return{task,workflow,workspace:this.store.workspace(workflow.workspaceId)};}
  private saveWorktree(worktree:Worktree,run:Run):void {this.store.exec('INSERT INTO worktrees(id,task_id,attempt,kind,path,branch,base_commit,head_commit,writer_run_id,status) VALUES(?,?,?,?,?,?,?,?,?,?)',worktree.id,run.taskId,run.taskAttempt,worktree.kind,worktree.path,worktree.branch??null,worktree.baseCommit,worktree.headCommit??null,run.id,'active');}
  private async prompt(run:Run,task:Task,cwd:string,candidate?:Candidate,worktree?:Worktree):Promise<string> {
    const previous=this.store.all<Run>('SELECT * FROM runs WHERE task_id=? AND id<>? ORDER BY created_at',task.id,run.id);
    const sourceEvidence=this.store.all<{payload:unknown}>('SELECT payload FROM task_events WHERE task_id=? AND type=? ORDER BY event_seq DESC LIMIT 1',task.id,'source.collected').map(event=>event.payload);
    const integrationEvidence=this.store.all<IntegrationRecord>('SELECT * FROM integrations WHERE task_id=? ORDER BY rowid',task.id);
    const currentTargetHead=candidate?.expectedTargetHead??(this.git.currentHead?await this.git.currentHead(this.context(task)):null);
    return JSON.stringify({role:run.providerSnapshot.role.prompt,taskId:task.id,runId:run.id,goal:this.store.workflow(task.workflowId).goal,title:task.title,instructions:task.instructions,cwd,expectedPaths:task.expectedPaths,acceptanceCriteria:task.acceptanceCriteria,attempt:task.attempt,sourceHead:task.sourceHead,baseCommit:worktree?.baseCommit??candidate?.candidateHead??this.store.workflow(task.workflowId).baseCommit,currentTargetHead,candidate,sourceEvidence,integrationEvidence,previousResults:previous.map(prior=>({runId:prior.id,status:prior.status,result:prior.result,stopReason:prior.stopReason})),resultSchema:run.purpose==='review'?{schemaVersion:1,taskId:task.id,runId:run.id,verdict:'approve|changes_requested|blocked',reviewedCommit:candidate?.candidateHead,findings:[{severity:'critical|high|medium|low',file:'string',line:1,reason:'string',suggestion:'string'}]}:{schemaVersion:1,taskId:task.id,runId:run.id,outcome:'completed|blocked',summary:'string',changedPaths:[],checksClaimed:[],blockingReasons:[]}});
  }
  private async cleanup(runId:string,state:Active):Promise<boolean> {
    if(state.cleanup)return state.cleanup;
    state.cleanup=(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try {if(!state.handle)return false;await Promise.race([state.handle.dispose(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RiftError('CLEANUP_TIMEOUT','Activation cleanup did not settle before its deadline.')),this.cleanupTimeoutMs);})]);this.store.transaction(()=>this.confirmCleanup(runId));return true;}catch(error){this.store.transaction(()=>{const timedOut=error instanceof RiftError&&error.code==='CLEANUP_TIMEOUT';this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?',timedOut?'unknown':'failed',runId);const run=this.store.run(runId);const task=this.store.task(run.taskId);this.store.event(task.workflowId,timedOut?'cleanup.unknown':'cleanup.failed',{error:errorMessage(error)},{taskId:task.id,runId});});return false;}finally{if(timer)clearTimeout(timer);}})();
    return state.cleanup;
  }
  private confirmCleanup(runId:string):void {const run=this.store.run(runId),task=this.store.task(run.taskId);this.store.exec('UPDATE runs SET cleanup_status=?,slot_released_at=? WHERE id=?','confirmed',now(),runId);this.store.exec('UPDATE worktrees SET writer_run_id=NULL WHERE writer_run_id=?',runId);this.store.event(task.workflowId,'cleanup.confirmed',{}, {taskId:task.id,runId});}
  private recordResult(runId:string,status:Run['status'],stopReason:string,result:unknown):void {
    const run=this.store.run(runId);if(terminalRuns.has(run.status))return;
    const task=this.store.task(run.taskId);
    const safe=safeValue(result);
    this.store.exec('UPDATE runs SET status=?,stop_reason=?,result=?,ended_at=? WHERE id=?',status,redact(stopReason,1024),JSON.stringify(safe),now(),runId);
    const artifactId=saveResultArtifact(this.store,this.store.workflow(task.workflowId).workspaceId,runId,safe);
    if(artifactId)this.store.exec('UPDATE runs SET result_artifact_id=? WHERE id=?',artifactId,runId);
    this.store.event(task.workflowId,'result_recorded',{status,stopReason,result:safe,artifactId},{taskId:task.id,runId});
  }
  private async execute(run:Run,task:Task,cwd:string,state:Active,candidate?:Candidate,worktree?:Worktree):Promise<DevelopmentResult|ReviewResult|undefined> {
    const timeout=setTimeout(()=>{void this.cancelRun(run.id,'TIMEOUT');},Math.max(1,Date.parse(run.deadline)-Date.now()));
    let startAttempted=false;
    let rawText:string|undefined;
    try {
      const prompt=await this.prompt(run,task,cwd,candidate,worktree);
      if(state.controller.signal.aborted)throw new RiftError('ABORTED_BEFORE_START','Run was cancelled before provider invocation.');
      this.store.transaction(()=>{const input=safeValue(JSON.parse(prompt));const artifactId=saveResultArtifact(this.store,this.store.workflow(task.workflowId).workspaceId,run.id,input,'input');this.store.event(task.workflowId,'run.input_prepared',{artifactId,promptSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd,baseCommit:worktree?.baseCommit??candidate?.candidateHead??null,sourceHead:task.sourceHead,candidateHead:candidate?.candidateHead??null},{taskId:task.id,runId:run.id});});
      startAttempted=true;
      const handle=await this.bridge.start({run,task,role:run.providerSnapshot.role,cwd,prompt,signal:state.controller.signal});state.handle=handle;
      this.store.transaction(()=>{this.store.exec('UPDATE runs SET dsh_child_id=?,status=?,started_at=? WHERE id=?',handle.childId,state.cancelled?'cancelling':'running',now(),run.id);this.store.event(task.workflowId,'activation_accepted',{childId:handle.childId},{taskId:task.id,runId:run.id});});
      if(state.cancelled){await this.cleanup(run.id,state);this.store.transaction(()=>this.recordResult(run.id,'cancelled',state.cancelReason??'CANCELLED',null));return;}
      const result=await Promise.race([handle.result,new Promise<never>((_,reject)=>{state.controller.signal.addEventListener('abort',()=>reject(new RiftError('CANCELLED','Run was cancelled.')),{once:true});})]);
      rawText=result.text;
      if(result.dshRunId)this.store.exec('UPDATE runs SET dsh_run_id=? WHERE id=?',result.dshRunId,run.id);
      invariant(['completed','end_turn','stop','success'].includes(result.stopReason),'PROVIDER_STOP',`Provider stopped with ${result.stopReason}.`);
      const parsed=parseResult(result.text,{taskId:task.id,runId:run.id,purpose:run.purpose});
      this.store.transaction(()=>this.recordResult(run.id,'succeeded',result.stopReason,parsed));return parsed;
    }catch(error){this.store.transaction(()=>{this.recordResult(run.id,state.cancelled?'cancelled':'failed',state.cancelled?(state.cancelReason??'CANCELLED'):error instanceof RiftError?error.code:'EXECUTION_FAILED',{error:errorMessage(error),...(rawText===undefined?{}:{output:redact(rawText)})});if(!state.handle){if(!startAttempted||(error instanceof RiftError&&['START_NOT_PUBLISHED','LIVE_LEAD_REQUIRED','PROVIDER_UNAVAILABLE','ABORTED_BEFORE_START'].includes(error.code)))this.confirmCleanup(run.id);else this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?','unknown',run.id);}});return;}
    finally {clearTimeout(timeout);if(state.handle)await this.cleanup(run.id,state);this.active.delete(run.id);}
  }
  private blockTask(taskId:string,reason:string):void {const task=this.store.task(taskId);if(['succeeded','cancelled'].includes(task.status))return;this.store.exec('UPDATE tasks SET status=?,blocking_reason=?,version=version+1 WHERE id=?','blocked',reason,taskId);this.store.event(task.workflowId,'task.blocked',{reason},{taskId});}
  private async executeDevelopment(run:Run,operation:Operation):Promise<void> {
    const state:Active={controller:new AbortController(),cancelled:false};this.active.set(run.id,state);
    const task=this.store.task(run.taskId);let worktree:Worktree;
    try {
      for(const dependency of this.dependencies(task))if(dependency.kind==='change'&&dependency.acceptedCommit){invariant(this.git.containsCommit,'DEPENDENCY_UNVERIFIABLE','Git service cannot verify accepted dependency ancestry.');invariant(await this.git.containsCommit({...this.context(task),commit:dependency.acceptedCommit}),'DEPENDENCY_NOT_INTEGRATED','Accepted dependency is no longer contained in the current integration head.');}
      worktree=await this.git.prepareTask({...this.context(task),run});this.store.transaction(()=>this.saveWorktree(worktree,run));
    }
    catch(error){this.store.transaction(()=>{this.recordResult(run.id,state.cancelled?'cancelled':'failed','WORKTREE_PREPARATION_FAILED',{error:errorMessage(error)});this.confirmCleanup(run.id);this.blockTask(task.id,errorMessage(error));this.operationPhase(this.store.operation(operation.id),'blocked',errorMessage(error));});this.active.delete(run.id);this.pump();return;}
    if(state.cancelled){this.store.transaction(()=>{this.recordResult(run.id,'cancelled','CANCELLED',null);this.confirmCleanup(run.id);this.operationPhase(this.store.operation(operation.id),'cancelled');});this.active.delete(run.id);this.pump();return;}
    const result=await this.execute(run,task,worktree.path,state,undefined,worktree) as DevelopmentResult|undefined;
    try {
      const completed=this.store.run(run.id);
      if(this.store.task(task.id).status==='cancelled'||terminalWorkflows.has(this.store.workflow(task.workflowId).status)){this.store.transaction(()=>this.operationPhase(this.store.operation(operation.id),'cancelled'));return;}
      if(completed.cleanupStatus!=='confirmed'){this.store.transaction(()=>{this.blockTask(task.id,'CLEANUP_UNKNOWN');this.operationPhase(this.store.operation(operation.id),'blocked','CLEANUP_UNKNOWN');});return;}
      if(completed.status==='cancelled'){this.store.transaction(()=>{this.store.exec('UPDATE tasks SET status=?,blocking_reason=?,version=version+1 WHERE id=?','cancelled','CANCELLED',task.id);this.operationPhase(this.store.operation(operation.id),'cancelled');});return;}
      if(!result||result.outcome!=='completed'){this.store.transaction(()=>{this.blockTask(task.id,result?.blockingReasons.join('; ')||completed.stopReason||'EXECUTION_FAILED');this.operationPhase(this.store.operation(operation.id),'blocked','EXECUTION_FAILED');});return;}
      if(task.kind==='analysis'){this.store.transaction(()=>{this.store.exec('UPDATE tasks SET status=?,version=version+1 WHERE id=?','succeeded',task.id);this.operationPhase(this.store.operation(operation.id),'completed');this.store.event(task.workflowId,'task.succeeded',{}, {taskId:task.id,runId:run.id});});return;}
      const source=await this.git.collectSource({...this.context(this.store.task(task.id)),run:completed,worktree});
      const eligible=this.store.transaction(()=>{
        const latest=this.store.task(task.id),workflow=this.store.workflow(task.workflowId);
        const sameAttempt=latest.attempt===run.taskAttempt;
        const mayIntegrate=sameAttempt&&latest.status==='running'&&!terminalWorkflows.has(workflow.status);
        if(mayIntegrate)this.store.exec('UPDATE tasks SET status=?,source_head=?,version=version+1 WHERE id=?','validating',source.sourceHead,task.id);
        else if(sameAttempt)this.store.exec('UPDATE tasks SET source_head=?,version=version+1 WHERE id=?',source.sourceHead,task.id);
        this.store.exec('UPDATE worktrees SET head_commit=? WHERE id=?',source.sourceHead,worktree.id);
        this.operationPhase(this.store.operation(operation.id),mayIntegrate?'completed':'cancelled');
        this.store.event(task.workflowId,'source.collected',{...source,diff:redact(source.diff),taskAttempt:run.taskAttempt,eligibleForIntegration:mayIntegrate},{taskId:task.id,runId:run.id});
        return mayIntegrate;
      });
      const latest=this.store.task(task.id);if(eligible)this.requestIntegration({taskId:task.id,sourceHead:source.sourceHead,idempotencyKey:`auto-integration:${task.id}:${task.attempt}`,expectedVersion:latest.version});
    }catch(error){this.store.transaction(()=>{this.blockTask(task.id,errorMessage(error));this.operationPhase(this.store.operation(operation.id),'blocked',errorMessage(error));});}
    finally{this.pump();}
  }
  private async executeIntegration(operation:Operation):Promise<void> {
    let task=this.store.task(operation.entityId);const integrationId=id('integration');let candidate:Candidate|undefined;let reviewRun:Run|undefined;
    this.store.transaction(()=>{this.store.exec('INSERT INTO integrations(id,task_id,source_head,status) VALUES(?,?,?,?)',integrationId,task.id,operation.payload.sourceHead!,'preparing');operation.payload.integrationId=integrationId;this.operationPhase(operation,'started');this.store.exec('UPDATE tasks SET status=?,version=version+1 WHERE id=?','integrating',task.id);});
    try {
      candidate=await this.git.prepareCandidate({...this.context(task),sourceHead:operation.payload.sourceHead!,integrationId});
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET expected_target_head=?,candidate_head=?,check_ids=?,candidate=? WHERE id=?',candidate!.expectedTargetHead,candidate!.candidateHead,JSON.stringify(candidate!.checkIds),JSON.stringify(candidate),integrationId);this.store.event(task.workflowId,'candidate.prepared',candidate,{taskId:task.id,requestId:operation.id});});
      while(this.store.workflow(task.workflowId).status==='paused'&&this.store.task(task.id).status!=='cancelled'&&!this.stopping)await new Promise(resolve=>setTimeout(resolve,25));
      task=this.store.task(task.id);invariant(!this.stopping&&this.store.workflow(task.workflowId).status==='running'&&task.status!=='cancelled','CANCELLED','Integration cancelled before review.');
      reviewRun=this.store.transaction(()=>{const role=this.store.require<Role>('SELECT * FROM roles WHERE workspace_id=? AND name=?',this.store.workflow(task.workflowId).workspaceId,'reviewer');const run=this.createRun(task,role,'review');this.store.exec('UPDATE integrations SET status=?,review_run_id=? WHERE id=?','reviewing',run.id,integrationId);operation.payload.runId=run.id;this.store.exec('UPDATE operations SET payload=? WHERE id=?',JSON.stringify(operation.payload),operation.id);this.store.event(task.workflowId,'review.reserved',{candidateHead:candidate!.candidateHead},{taskId:task.id,runId:run.id,requestId:operation.id});return run;});
      const state:Active={controller:new AbortController(),cancelled:false};this.active.set(reviewRun.id,state);
      const review=await this.execute(reviewRun,task,candidate.cwd,state,candidate) as ReviewResult|undefined;
      invariant(this.store.run(reviewRun.id).cleanupStatus==='confirmed','CLEANUP_UNKNOWN','Review cleanup is unconfirmed.');
      invariant(review&&review.verdict==='approve'&&review.reviewedCommit===candidate.candidateHead,'REVIEW_REJECTED','Review must approve the exact checked candidate commit.');
      invariant(this.store.task(task.id).status!=='cancelled'&&!terminalWorkflows.has(this.store.workflow(task.workflowId).status),'CANCELLED','Task or workflow was cancelled before publication.');
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=? WHERE id=?','publishing',integrationId);this.store.event(task.workflowId,'publication.intent',candidate,{taskId:task.id,requestId:operation.id});});
      const accepted=await this.git.publishCandidate({...this.context(task),candidate,review});
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=? WHERE id=?','accepted',integrationId);this.store.exec('UPDATE tasks SET status=?,accepted_commit=?,version=version+1,blocking_reason=NULL WHERE id=?','succeeded',accepted.acceptedCommit,task.id);this.operationPhase(this.store.operation(operation.id),'completed');this.store.event(task.workflowId,'integration.accepted',{integrationId,...accepted},{taskId:task.id,requestId:operation.id});});
    }catch(error){
      const unknown=reviewRun&&this.store.run(reviewRun.id).cleanupStatus!=='confirmed';
      const publishing=this.store.require<IntegrationRecord>('SELECT * FROM integrations WHERE id=?',integrationId).status==='publishing';
      if(publishing&&candidate){
        let publication:'published'|'not-published'|'unknown'='unknown';
        if(this.git.recoverPublication)try{publication=await this.git.recoverPublication({...this.context(task),candidate});}catch{/* Preserve publication intent for startup inspection. */}
        if(publication!=='not-published'){this.store.transaction(()=>{this.store.exec('UPDATE integrations SET error=? WHERE id=?',errorMessage(error),integrationId);this.blockTask(task.id,'PUBLICATION_REQUIRES_RECOVERY');this.store.event(task.workflowId,'publication.uncertain',{integrationId,publication},{taskId:task.id,requestId:operation.id});});return;}
      }
      if(candidate&&!unknown&&this.git.abandonCandidate)await this.git.abandonCandidate({...this.context(task),candidate,reason:errorMessage(error)}).catch(()=>{});
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=?,error=? WHERE id=?',unknown?'cleanup_unknown':'blocked',errorMessage(error),integrationId);this.blockTask(task.id,errorMessage(error));const cancelled=this.store.task(task.id).status==='cancelled'||this.store.workflow(task.workflowId).status==='cancelled';this.operationPhase(this.store.operation(operation.id),cancelled?'cancelled':'blocked',errorMessage(error));});
    }
  }
  private unexpected(run:Run,error:unknown):void {this.store.transaction(()=>{this.recordResult(run.id,'interrupted','INTERNAL_ERROR',{error:errorMessage(error)});this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=? AND slot_released_at IS NULL','unknown',run.id);this.blockTask(run.taskId,errorMessage(error));});}

  status(workflowId:string) {
    const workflow=this.store.workflow(workflowId),tasks=this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=? ORDER BY rowid',workflowId);
    const runs=this.store.all<Run>('SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.workflow_id=? ORDER BY r.created_at',workflowId),occupied=runs.filter(run=>run.slotReleasedAt===null);
    return {workflow,roles:this.store.all<Role>('SELECT * FROM roles WHERE workspace_id=? ORDER BY name',workflow.workspaceId),tasks:tasks.map(task=>({...task,dependencyStatus:dependencyStatus(this.dependencies(task))})),runs,worktrees:this.store.all<Worktree>('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id WHERE t.workflow_id=?',workflowId),operations:this.store.all<Operation>('SELECT o.* FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? ORDER BY o.created_at,o.id',workflowId),integrations:this.store.all<IntegrationRecord>('SELECT i.* FROM integrations i JOIN tasks t ON t.id=i.task_id WHERE t.workflow_id=?',workflowId),slots:{developers:occupied.filter(run=>run.purpose!=='review').length,reviewers:occupied.filter(run=>run.purpose==='review').length,total:occupied.length},eventSeq:this.store.get<{seq:number}>('SELECT COALESCE(MAX(event_seq),0) AS seq FROM task_events WHERE workflow_id=?',workflowId)!.seq};
  }
  async wait(input:WaitInput):Promise<{events:TaskEvent[];eventSeq:number;timedOut:boolean;status:ReturnType<TaskCoordinator['status']>}> {
    invariant((input.runIds?.length??0)+(input.requestIds?.length??0)>0,'INVALID_WAIT','wait requires runIds or requestIds.');
    for(const runId of input.runIds??[])invariant(this.store.task(this.store.run(runId).taskId).workflowId===input.workflowId,'CROSS_WORKFLOW','Wait run belongs to another workflow.');
    for(const requestId of input.requestIds??[])invariant(this.store.task(this.store.operation(requestId).entityId).workflowId===input.workflowId,'CROSS_WORKFLOW','Wait request belongs to another workflow.');
    const deadline=Date.now()+Math.min(Math.max(input.timeoutMs??30_000,0),60_000),after=input.afterEventSeq??0;
    while(true){const events=this.store.events(input.workflowId,after).filter(event=>(event.runId&&input.runIds?.includes(event.runId))||(event.requestId&&input.requestIds?.includes(event.requestId)));const timedOut=Date.now()>=deadline;if(events.length||timedOut||this.stopping){const status=this.status(input.workflowId);return{events,eventSeq:status.eventSeq,timedOut:events.length===0,status};}await new Promise(resolve=>setTimeout(resolve,20));}
  }
  retry(input:{taskId:string;reason:string;expectedVersion:number}):Task {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept retries.');
    return this.store.transaction(()=>{
      const task=this.store.task(input.taskId);
      invariant(task.version===input.expectedVersion,'VERSION_CONFLICT','Task version changed.');
      invariant(['blocked','failed','cancelled'].includes(task.status),'INVALID_STATE','Only blocked, failed or cancelled tasks may be retried.');
      invariant(!terminalWorkflows.has(this.store.workflow(task.workflowId).status),'INVALID_STATE','Cannot retry a terminal workflow.');
      invariant(task.attempt<3,'REPAIR_BUDGET','Task exhausted its two repairs.');
      invariant(!this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',task.id),'CLEANUP_UNKNOWN','Old execution cleanup must be confirmed before retry.');
      invariant(!this.store.get('SELECT id FROM operations WHERE entity_id=? AND phase=? AND kind=?',task.id,'started','dispatch'),'FINALIZATION_PENDING','Previous source collection or finalization must finish before retry.');
      invariant(!this.store.get('SELECT id FROM integrations WHERE task_id=? AND status IN (\'preparing\',\'reviewing\',\'publishing\',\'cleanup_unknown\')',task.id),'INTEGRATION_ACTIVE','Task still owns an integration operation.');
      this.store.exec('UPDATE tasks SET status=?,attempt=attempt+1,version=version+1,blocking_reason=NULL WHERE id=?','ready',task.id);
      this.store.event(task.workflowId,'task.retry',{reason:input.reason,attempt:task.attempt+1},{taskId:task.id});return this.store.task(task.id);
    });
  }
  pause(workflowId:string,expectedVersion?:number):Workflow {return this.workflowState(workflowId,'paused',expectedVersion);}
  resume(workflowId:string,expectedVersion?:number):Workflow {const workflow=this.workflowState(workflowId,'running',expectedVersion);this.pump();return workflow;}
  private workflowState(workflowId:string,state:'paused'|'running',expectedVersion?:number):Workflow {return this.store.transaction(()=>{const workflow=this.store.workflow(workflowId);if(expectedVersion!==undefined)invariant(workflow.version===expectedVersion,'VERSION_CONFLICT','Workflow version changed.');invariant(['running','paused','blocked'].includes(workflow.status),'INVALID_STATE','Workflow is not active.');this.store.exec('UPDATE workflows SET status=?,version=version+1 WHERE id=?',state,workflowId);this.store.event(workflowId,`workflow.${state}`);return this.store.workflow(workflowId);});}
  async cancelRun(runId:string,reason='CANCELLED'):Promise<Run> {
    const run=this.store.run(runId);if(run.slotReleasedAt)return run;
    const state=this.active.get(runId);
    this.store.transaction(()=>{if(!terminalRuns.has(run.status))this.store.exec('UPDATE runs SET status=?,stop_reason=? WHERE id=?','cancelling',reason,runId);this.store.event(this.store.task(run.taskId).workflowId,'run.cancel_requested',{reason},{taskId:run.taskId,runId});});
    if(state){state.cancelled=true;state.cancelReason=reason;state.controller.abort();if(state.handle)await this.cleanup(runId,state);}
    else this.store.transaction(()=>{this.recordResult(runId,'interrupted','HANDLE_LOST',{reason});this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?','unknown',runId);});
    return this.store.run(runId);
  }
  async cancelTask(taskId:string):Promise<Task> {
    this.store.transaction(()=>{const task=this.store.task(taskId);invariant(task.status!=='succeeded','INVALID_STATE','Accepted tasks cannot be cancelled.');this.store.exec('UPDATE tasks SET status=?,version=version+1,blocking_reason=? WHERE id=?','cancelled','CANCELLED',taskId);for(const operation of this.store.all<Operation>('SELECT * FROM operations WHERE entity_id=? AND phase=\'queued\'',taskId))this.operationPhase(operation,'cancelled');this.store.event(task.workflowId,'task.cancel_requested',{}, {taskId});});
    await Promise.allSettled(this.store.all<Run>('SELECT * FROM runs WHERE task_id=? AND slot_released_at IS NULL',taskId).map(run=>this.cancelRun(run.id)));this.pump();return this.store.task(taskId);
  }
  async cancelWorkflow(workflowId:string):Promise<ReturnType<TaskCoordinator['status']>> {
    this.store.transaction(()=>{const workflow=this.store.workflow(workflowId);invariant(workflow.status!=='completed','INVALID_STATE','Completed workflow cannot be cancelled.');this.store.exec('UPDATE workflows SET status=?,version=version+1 WHERE id=?','cancelled',workflowId);for(const operation of this.store.all<Operation>('SELECT o.* FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? AND o.phase=\'queued\'',workflowId))this.operationPhase(operation,'cancelled');this.store.exec('UPDATE tasks SET status=?,version=version+1 WHERE workflow_id=? AND status<>?','cancelled',workflowId,'succeeded');this.store.event(workflowId,'workflow.cancel_requested');});
    await Promise.allSettled(this.store.all<Run>('SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.workflow_id=? AND r.slot_released_at IS NULL',workflowId).map(run=>this.cancelRun(run.id)));return this.status(workflowId);
  }
  finish(input:{workflowId:string;summary:string;expectedVersion?:number}):Workflow {
    return this.store.transaction(()=>{const workflow=this.store.workflow(input.workflowId);if(input.expectedVersion!==undefined)invariant(workflow.version===input.expectedVersion,'VERSION_CONFLICT','Workflow version changed.');invariant(workflow.status==='running'||workflow.status==='paused','INVALID_STATE','Workflow cannot be finished in this state.');const tasks=this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=?',workflow.id);invariant(tasks.length>0&&tasks.every(task=>task.status==='succeeded'&&(task.kind==='analysis'||task.acceptedCommit)),'UNFINISHED_TASKS','Every task must pass its actual acceptance gate.');invariant(!this.store.get('SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.workflow_id=? AND r.slot_released_at IS NULL',workflow.id),'CLEANUP_UNKNOWN','All execution cleanup must be confirmed.');invariant(!this.store.get('SELECT o.id FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? AND o.phase IN (\'queued\',\'started\')',workflow.id),'UNFINISHED_REQUESTS','Workflow still has unfinished queue requests.');this.store.exec('UPDATE workflows SET status=?,summary=?,version=version+1 WHERE id=?','completed',input.summary,workflow.id);this.store.event(workflow.id,'workflow.completed',{summary:input.summary});return this.store.workflow(workflow.id);});
  }
  async recover():Promise<{interruptedRunIds:string[];recoveredIntegrationIds:string[]}> {
    invariant(this.active.size===0,'ACTIVE_HOST','Recovery only runs before this host starts executing.');
    const interruptedRunIds:string[]=[],recoveredIntegrationIds:string[]=[];
    this.store.transaction(()=>{for(const run of this.store.all<Run>('SELECT * FROM runs WHERE slot_released_at IS NULL')){if(!terminalRuns.has(run.status))this.recordResult(run.id,'interrupted','HOST_INTERRUPTED',null);this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?','unknown',run.id);this.blockTask(run.taskId,'INTERRUPTED_CLEANUP_UNKNOWN');interruptedRunIds.push(run.id);}for(const operation of this.store.all<Operation>('SELECT * FROM operations WHERE phase=\'started\' AND kind=\'dispatch\'')){if(!this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',operation.entityId))this.blockTask(operation.entityId,'HOST_INTERRUPTED_FINALIZATION');this.operationPhase(operation,'blocked','HOST_INTERRUPTED');}});
    for(const integration of this.store.all<IntegrationRecord>('SELECT * FROM integrations WHERE status IN (\'preparing\',\'reviewing\',\'publishing\',\'cleanup_unknown\')')) {
      const task=this.store.task(integration.taskId);
      if(integration.status==='publishing'&&integration.candidate&&this.git.recoverPublication&&await this.git.recoverPublication({...this.context(task),candidate:integration.candidate})==='published'){
        this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=? WHERE id=?','accepted',integration.id);this.store.exec('UPDATE tasks SET status=?,accepted_commit=?,version=version+1,blocking_reason=NULL WHERE id=?','succeeded',integration.candidate!.candidateHead,task.id);for(const operation of this.store.all<Operation>('SELECT * FROM operations WHERE entity_id=? AND kind=\'integration\' AND phase=\'started\'',task.id))this.operationPhase(operation,'completed');this.store.event(task.workflowId,'integration.recovered',{integrationId:integration.id},{taskId:task.id});});recoveredIntegrationIds.push(integration.id);
      }else this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=?,error=? WHERE id=?','cleanup_unknown','RECOVERY_REQUIRES_INSPECTION',integration.id);this.blockTask(task.id,'RECOVERY_REQUIRES_INSPECTION');});
    }
    // Queued requests are intentionally left durable. An explicit resume, with a
    // current live Lead supplied by the bridge, may consume unaffected requests.
    this.store.transaction(()=>{this.store.exec('UPDATE workflows SET status=?,version=version+1 WHERE status IN (\'running\',\'planning\',\'blocked\')','paused');});
    return{interruptedRunIds,recoveredIntegrationIds};
  }
  async shutdown():Promise<void> {this.stopping=true;await Promise.allSettled([...this.active.keys()].map(runId=>this.cancelRun(runId,'HOST_SHUTDOWN')));await Promise.allSettled([...this.background]);}
}

