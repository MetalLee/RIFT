import { agentSandboxMode } from '../agent/sandbox-mode.js';
import { RunChatStream } from './run-stream.js';
import { recordRunProgress } from './run-progress.js';
import type { RepositoryAccess } from '../agent/repository-access.js';
import { invariant, RiftError, type ActivationBridge, type ActivationHandle, type Candidate, type DevelopmentResult, type GitService, type Operation, type PlanTask, type ReviewResult, type Role, type Run, type Task, type TaskEvent, type Workflow, type Worktree } from '../contracts/index.js';
import { id, now, RiftStore } from '../storage/database.js';
import { dependencyStatus, validateDag, schedulerLimits, schedulingOrder, validatePriority, type SchedulerLimits } from './scheduler.js';
import { parseResult } from './results.js';
import { redact } from '../api/security.js';
import { saveResultArtifact } from '../storage/artifacts.js';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { provesPreviousBootExited } from '../agent/boot-identity.js';

interface Active { controller:AbortController; handle?:ActivationHandle; cleanup?:Promise<boolean>; cancelled:boolean; cancelReason?:string }
interface IntegrationRecord { id:string; taskId:string; status:string; candidate:Candidate|null; reviewRunId:string|null; error:string|null }
export interface CoordinatorOptions { repositoryAccess?(workspaceId:string):Promise<RepositoryAccess|undefined>; store:RiftStore; bridge:ActivationBridge; git:GitService; runTimeoutMs?:number;cleanupTimeoutMs?:number; limits?:Partial<SchedulerLimits>; skillSnapshot?:(workspaceId:string,agentId:string,runtime:string,runId:string)=>{instructions:string;versions:unknown[]}; textAnalysisBridge?:ActivationBridge; textAnalysisRoot?:string;runTools?(run:Run):import('../agent/runtime-types.js').RuntimeTool[];captureRunInbox?(run:Run):unknown[];acceptRunInbox?(runId:string):void }
export interface CreateWorkflowInput { id?:string; workspaceId:string; goal:string; integrationRef:string; baseCommit:string; leadSessionId?:string; repositorySnapshots?:{repositoryId:string;baseCommit:string;integrationRef:string}[]; repositoryFree?:boolean }
export interface DispatchInput {taskId:string;idempotencyKey:string;expectedVersion:number;roleName?:string}
export interface ReplanInput {workflowId:string;expectedRevision:number;updates:{taskId:string;expectedVersion:number;dependsOn?:string[];priority?:number}[];tasks?:PlanTask[]}
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
  private closed=false;
  private bootIdentity:string|null=null;
  private readonly cleanupReceipts=new Set<string>();
  private readonly integrationCleanupReceipts=new Set<string>();
  private readonly sourceRecoveries=new Set<string>();
  private readonly skillSnapshot: CoordinatorOptions['skillSnapshot'];
  private readonly textAnalysisBridge: ActivationBridge | undefined;
  private readonly textAnalysisRoot: string | undefined;
  private readonly collaboration:Pick<CoordinatorOptions,'runTools'|'captureRunInbox'|'acceptRunInbox'|'repositoryAccess'>;
  constructor(options:CoordinatorOptions) {this.store=options.store;this.bridge=options.bridge;this.git=options.git;this.runTimeoutMs=options.runTimeoutMs??30*60_000;this.cleanupTimeoutMs=options.cleanupTimeoutMs??10_000;this.skillSnapshot=options.skillSnapshot;this.textAnalysisBridge=options.textAnalysisBridge;this.textAnalysisRoot=options.textAnalysisRoot;this.collaboration=options;
    if(options.limits){const limits=schedulerLimits(options.limits);this.store.transaction(()=>{
      const occupied=this.globalSlots();
      invariant(occupied.total<=limits.total&&occupied.developers<=limits.developers,'LIMITS_IN_USE','New limits cannot be lower than retained execution slots.');
      this.store.exec('UPDATE scheduler_limits SET developers=?,total=?,max_tasks=?,max_replans=?,aging_ms=? WHERE id=1',limits.developers,limits.total,limits.maxTasks,limits.maxReplans,limits.agingMs);
    });}
  }
  get limits():SchedulerLimits {return this.store.require<SchedulerLimits>('SELECT developers,total,max_tasks,max_replans,aging_ms FROM scheduler_limits WHERE id=1');}
  wake(): void { this.pump(); }
  setBootIdentity(identity:string|null):void {this.bootIdentity=identity;}
  reconcileRun(runId:string,expectedVersion:number):Run {
    this.store.transaction(()=>{
      const run=this.store.require<Run & {version:number;runtimeBootId:string|null}>('SELECT * FROM runs WHERE id=?',runId);
      invariant(run.version===expectedVersion,'VERSION_CONFLICT','Run changed; reload before reconciling cleanup.');
      if(run.cleanupStatus==='confirmed')return;
      invariant(terminalRuns.has(run.status),'RUN_ACTIVE','Cancel the Run before reconciling cleanup.');
      invariant(this.cleanupReceipts.has(runId)||provesPreviousBootExited(run.runtimeBootId,this.bootIdentity),'CLEANUP_UNKNOWN','No owned cleanup receipt or same-machine OS reboot proof is available. Restarting only the Host does not prove descendants exited.');
      this.confirmCleanup(runId);
    });
    this.pump();return this.store.run(runId);
  }
  private cleanupReceipt(runId:string):void {if(this.closed)return;this.cleanupReceipts.add(runId);const run=this.store.run(runId) as Run & {version:number};if(['unknown','failed'].includes(run.cleanupStatus)&&terminalRuns.has(run.status))this.reconcileRun(runId,run.version);}
  async reconcileIntegration(integrationId:string,expectedVersion:number) {
    invariant(!this.integrationBusy,'INTEGRATION_ACTIVE','Wait for the current integration worker to stop.');
    const integration=this.store.require<IntegrationRecord & {version:number;runtimeBootId:string|null}>('SELECT * FROM integrations WHERE id=?',integrationId),task=this.store.task(integration.taskId);
    invariant(integration.version===expectedVersion,'VERSION_CONFLICT','Integration changed; reload before reconciling.');
    invariant(['cleanup_unknown','publishing'].includes(integration.status),'INVALID_STATE','Only an uncertain integration can be reconciled.');
    invariant(!this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',task.id),'CLEANUP_UNKNOWN','Verify all Run cleanup before inspecting publication.');
    invariant(this.integrationCleanupReceipts.has(integrationId)||provesPreviousBootExited(integration.runtimeBootId,this.bootIdentity),'CLEANUP_UNKNOWN','Git/check subprocess cleanup has no owned completion receipt or same-machine reboot proof. Missing candidate/Run rows do not prove cleanup.');
    let publication:'published'|'not-published'|'unknown'='not-published';
    if(integration.candidate){invariant(this.git.recoverPublication,'PUBLICATION_UNKNOWN','Git publication verification is unavailable.');publication=await this.git.recoverPublication({...this.context(task),candidate:integration.candidate});}
    invariant(publication!=='unknown','PUBLICATION_UNKNOWN','Git cannot establish the exact publication outcome; no ledger state was released.');
    if(publication==='not-published'&&integration.candidate&&this.git.abandonCandidate)await this.git.abandonCandidate({...this.context(task),candidate:integration.candidate,reason:'Execution cleanup verified; unpublished candidate abandoned for explicit retry.'});
    this.store.transaction(()=>{
      invariant(this.store.require<{version:number}>('SELECT version FROM integrations WHERE id=?',integrationId).version===expectedVersion,'VERSION_CONFLICT','Integration changed during verification.');
      invariant(!this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',task.id),'CLEANUP_UNKNOWN','Execution ownership changed during verification.');
      this.store.exec('UPDATE integrations SET status=?,error=? WHERE id=?',publication==='published'?'accepted':'blocked',publication==='published'?null:'Cleanup verified; candidate was not published. Retry the task explicitly.',integrationId);
      if(publication==='published')this.store.exec('UPDATE tasks SET status=?,accepted_commit=?,blocking_reason=NULL,version=version+1 WHERE id=?',task.status==='cancelled'?'cancelled':'succeeded',integration.candidate!.candidateHead,task.id);
      else this.blockTask(task.id,'RECOVERED_NOT_PUBLISHED');
      for(const operation of this.store.all<Operation>("SELECT * FROM operations WHERE entity_id=? AND kind='integration' AND phase IN ('queued','started')",task.id))this.operationPhase(operation,publication==='published'?'completed':'blocked');
      this.store.event(task.workflowId,'integration.reconciled',{integrationId,publication},{taskId:task.id});
    });
    this.pump();return this.store.require('SELECT id,task_id,status,version,error FROM integrations WHERE id=?',integrationId);
  }

  createWorkflow(input:CreateWorkflowInput):Workflow {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept new work.');
    if(input.id)invariant(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.id),'INVALID_ID','Workflow ID must be a safe identifier.');
    invariant(this.store.workspace(input.workspaceId).status==='active','WORKSPACE_ARCHIVED','Archived workspaces cannot start workflows.');
    invariant(input.repositoryFree || this.store.workspace(input.workspaceId).repositoryPath, 'REPOSITORY_REQUIRED', 'Connect a repository before starting code execution.');
    invariant(input.goal.trim()&&(input.repositoryFree?input.integrationRef===''&&input.baseCommit==='':/^refs\/heads\/rift\/[A-Za-z0-9_./-]+$/.test(input.integrationRef)&&/^[0-9a-f]{40,64}$/.test(input.baseCommit)),'INVALID_WORKFLOW','Code workflow needs a goal, rift integration branch and exact base commit; repository-free analysis uses empty Git fields.');
    return this.store.transaction(()=>{
      if(input.id) {const prior=this.store.get<Workflow>('SELECT * FROM workflows WHERE id=?',input.id);if(prior){invariant(prior.workspaceId===input.workspaceId&&prior.goal===input.goal&&prior.baseCommit===input.baseCommit&&prior.integrationRef===input.integrationRef,'IDEMPOTENCY_CONFLICT','Workflow ID was used for different input.');return prior;}}
      invariant(!this.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled') LIMIT 1",input.workspaceId)&&!this.store.get('SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=? AND r.slot_released_at IS NULL LIMIT 1',input.workspaceId)&&!this.store.get("SELECT i.id FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=? AND i.status IN ('preparing','reviewing','publishing','cleanup_unknown') LIMIT 1",input.workspaceId),'WORKFLOW_CAPACITY','This workspace already owns active work or unconfirmed cleanup.');
      const roles=this.store.all<Role>('SELECT * FROM roles WHERE workspace_id=? AND enabled=1',input.workspaceId);
      invariant((input.repositoryFree?['lead','developer']:['lead','developer','reviewer']).every(purpose=>roles.some(role=>role.purpose===purpose)),'ROLES_NOT_CONFIGURED','Configure the required Lead/developer roles, and a reviewer for code workflows.');
      const workflowId=input.id??id('workflow');
      const available=this.store.all<{id:string}>('SELECT id FROM repositories WHERE workspace_id=? ORDER BY id',input.workspaceId);
      invariant(input.repositoryFree || input.repositorySnapshots || available.length===1,'AMBIGUOUS_REPOSITORY','Explicit repository snapshots are required for a multi-repository workflow.');
      const repositories=input.repositoryFree?[]:input.repositorySnapshots??[{repositoryId:available[0]!.id,baseCommit:input.baseCommit,integrationRef:input.integrationRef}];
      invariant((input.repositoryFree||repositories.length>0)&&new Set(repositories.map(repo=>repo.repositoryId)).size===repositories.length&&repositories.every(repo=>available.some(item=>item.id===repo.repositoryId)&&/^[0-9a-f]{40,64}$/.test(repo.baseCommit)&&/^refs\/heads\/rift\/[A-Za-z0-9_./-]+$/.test(repo.integrationRef)&&!repo.integrationRef.includes('..')),'INVALID_REPOSITORIES','Workflow repositories must belong to this workspace and have exact commits and safe integration refs.');
      this.store.exec('INSERT INTO workflows(id,workspace_id,goal,lead_session_id,status,integration_ref,base_commit) VALUES(?,?,?,?,?,?,?)',workflowId,input.workspaceId,input.goal,input.leadSessionId??null,'planning',input.integrationRef,input.baseCommit);
      for(const repository of repositories)this.store.exec('INSERT INTO workflow_repositories(workflow_id,repository_id,base_commit,integration_ref) VALUES(?,?,?,?)',workflowId,repository.repositoryId,repository.baseCommit,repository.integrationRef);
      this.store.event(workflowId,'workflow.created');return this.store.workflow(workflowId);
    });
  }
  submitPlan(input:{workflowId:string;expectedRevision:number;tasks:PlanTask[];acceptanceCriteria?:string[]}):Task[] {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept plans.');
    return this.store.transaction(()=>{
      const workflow=this.store.workflow(input.workflowId);
      invariant(!terminalWorkflows.has(workflow.status),'INVALID_STATE','Cannot plan a terminal workflow.');
      invariant(workflow.planRevision===input.expectedRevision,'VERSION_CONFLICT','Plan revision changed.');
      invariant(workflow.planRevision<=this.limits.maxReplans,'REPLAN_BUDGET','Workflow exhausted its configured replan budget.');
      const existing=this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=?',workflow.id);
      invariant(input.tasks.length>0&&existing.length+input.tasks.length<=this.limits.maxTasks,'PLAN_LIMIT','Workflow exceeds its configured task limit.');
      const fresh=input.tasks.map(task=>({...task,id:task.id??id('task'),expectedPaths:task.expectedPaths??[],acceptanceCriteria:[...new Set([...(input.acceptanceCriteria??[]),...(task.acceptanceCriteria??[])])]}));
      invariant(fresh.every(task=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(task.id)),'INVALID_ID','Task IDs must be safe identifiers.');
      const graph=existing.map(task=>({id:task.id,dependsOn:this.store.all<{dependsOnTaskId:string}>('SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?',task.id).map(dep=>dep.dependsOnTaskId)}));
      validateDag([...graph,...fresh.map(task=>({id:task.id,dependsOn:task.dependsOn??[]}))]);
      for(const task of fresh){
        invariant(task.title.trim()&&task.instructions.trim()&&['change','analysis'].includes(task.kind),'INVALID_TASK','Task title, instructions and kind are required.');
        const roleId=task.roleName?this.store.require<Role>("SELECT * FROM roles WHERE workspace_id=? AND name=? AND purpose='developer' AND enabled=1",workflow.workspaceId,task.roleName).id:null;
        const repositories=this.store.all<{repositoryId:string}>('SELECT repository_id FROM workflow_repositories WHERE workflow_id=?',workflow.id);
        const repositoryId=task.repositoryId??(repositories.length===1?repositories[0]!.repositoryId:undefined);
        invariant(repositories.length===0?task.kind==='analysis'&&!task.repositoryId:repositoryId&&repositories.some(repo=>repo.repositoryId===repositoryId),'REPOSITORY_REQUIRED','Code tasks select a repository; repository-free workflows accept only text analysis with no write paths.');
        validatePriority(task.priority??0);
        if(task.analysisItems!==undefined){invariant(task.kind==='analysis'&&Array.isArray(task.analysisItems)&&task.analysisItems.length>0&&task.analysisItems.length<=32&&new Set(task.analysisItems.map(item=>item.id)).size===task.analysisItems.length&&task.analysisItems.every(item=>typeof item.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id)&&typeof item.prompt==='string'&&item.prompt.trim()),'INVALID_ANALYSIS_ITEMS','Analysis batches require 1 to 32 unique safe item IDs and nonempty prompts on an analysis task.');}

        this.store.exec('INSERT INTO tasks(id,workflow_id,role_id,repository_id,kind,title,instructions,expected_paths,acceptance_criteria,status,priority,analysis_items) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',task.id,workflow.id,roleId,repositoryId??null,task.kind,task.title,task.instructions,JSON.stringify(task.expectedPaths),JSON.stringify(task.acceptanceCriteria??[]),'pending',task.priority??0,task.analysisItems?JSON.stringify(task.analysisItems):null);
      }
      for(const task of fresh)for(const dep of task.dependsOn??[])this.store.exec('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)',task.id,dep);
      this.store.exec('UPDATE workflows SET plan_revision=plan_revision+1,version=version+1,status=? WHERE id=?',workflow.status==='paused'?'paused':'running',workflow.id);
      this.refreshQueuedRequests(workflow.id);
      this.store.event(workflow.id,'plan.accepted',{revision:workflow.planRevision+1,taskIds:fresh.map(task=>task.id),acceptanceCriteria:input.acceptanceCriteria??[]});
      return this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=? ORDER BY rowid',workflow.id);
    });
  }
  dispatch(input:DispatchInput,deferWake=false):Operation {
    const operation=this.enqueue('dispatch',input.taskId,input.idempotencyKey,input.expectedVersion,undefined,input.roleName);
    if(!deferWake)this.pump();return this.store.operation(operation.id);
  }
  /** Change the future graph atomically; already running or accepted work is immutable. */
  replan(input:ReplanInput):Task[] {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot replan.');
    const result=this.store.transaction(()=>{
      const workflow=this.store.workflow(input.workflowId);
      invariant(!terminalWorkflows.has(workflow.status),'INVALID_STATE','Cannot replan a terminal workflow.');
      invariant(workflow.planRevision===input.expectedRevision,'VERSION_CONFLICT','Plan revision changed.');
      invariant(workflow.planRevision>0&&workflow.planRevision<=this.limits.maxReplans,'REPLAN_BUDGET','Workflow exhausted its configured replan budget.');
      invariant(input.updates.length>0||(input.tasks?.length??0)>0,'INVALID_REPLAN','Replan must change or add tasks.');
      invariant(new Set(input.updates.map(update=>update.taskId)).size===input.updates.length,'DUPLICATE_TASK','A task may be updated only once per replan.');
      const updates=new Map(input.updates.map(update=>[update.taskId,update]));
      const existing=this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=?',workflow.id);
      for(const update of input.updates){
        const task=this.store.task(update.taskId);
        invariant(!this.sourceRecoveries.has(task.id),'SOURCE_RECOVERY_ACTIVE','Wait for source recovery before replanning this task.');
        invariant(task.workflowId===workflow.id,'CROSS_WORKFLOW','Replan task belongs to another workflow.');
        invariant(task.version===update.expectedVersion,'VERSION_CONFLICT','Task version changed.');
        invariant(['pending','ready'].includes(task.status)||(task.status==='blocked'&&task.blockingReason==='DEPENDENCY_BLOCKED'),'TASK_ALREADY_STARTED','Only tasks awaiting their first execution may be replanned.');
        invariant(!this.store.get('SELECT id FROM runs WHERE task_id=? LIMIT 1',task.id),'TASK_ALREADY_STARTED','Execution history makes task inputs immutable.');
        if(update.priority!==undefined)validatePriority(update.priority);
        if(update.dependsOn!==undefined)invariant(new Set(update.dependsOn).size===update.dependsOn.length,'INVALID_DEPENDENCY','Dependencies must be unique.');
      }
      const additions=(input.tasks??[]).map(task=>({...task,id:task.id??id('task')}));
      validateDag([...existing.map(task=>({id:task.id,dependsOn:updates.get(task.id)?.dependsOn??this.dependencies(task).map(dependency=>dependency.id)})),...additions.map(task=>({id:task.id,dependsOn:task.dependsOn??[]}))]);
      // Additions and edits share a transaction and exactly one plan revision.
      if(additions.length)this.submitPlan({workflowId:workflow.id,expectedRevision:workflow.planRevision,tasks:additions.map(task=>({...task,dependsOn:[]}))});
      for(const update of input.updates){
        const task=this.store.task(update.taskId);
        if(update.dependsOn!==undefined){this.store.exec('DELETE FROM task_dependencies WHERE task_id=?',task.id);for(const dep of update.dependsOn)this.store.exec('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)',task.id,dep);}
        this.store.exec('UPDATE tasks SET priority=?,status=?,blocking_reason=NULL,version=version+1 WHERE id=?',update.priority??task.priority??0,'pending',task.id);
      }
      for(const task of additions)for(const dep of task.dependsOn??[])this.store.exec('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)',task.id,dep);
      if(!additions.length)this.store.exec('UPDATE workflows SET plan_revision=plan_revision+1,version=version+1 WHERE id=?',workflow.id);
      this.refreshQueuedRequests(workflow.id);
      this.store.event(workflow.id,'plan.replanned',{revision:workflow.planRevision+1,updates:input.updates,addedTaskIds:additions.map(task=>task.id)});
      return this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=? ORDER BY rowid',workflow.id);
    });
    this.pump();return result;
  }
  private refreshQueuedRequests(workflowId:string):void {
    const workflow=this.store.workflow(workflowId);
    for(const operation of this.store.all<Operation>("SELECT o.* FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? AND o.phase='queued'",workflowId)){
      operation.payload.planRevision=workflow.planRevision;operation.payload.expectedVersion=this.store.task(operation.entityId).version;
      this.store.exec('UPDATE operations SET payload=? WHERE id=?',JSON.stringify(operation.payload),operation.id);
    }
  }
  private markScheduled(workflowId:string):void {
    this.store.exec('UPDATE scheduler_limits SET dispatch_sequence=dispatch_sequence+1 WHERE id=1');
    this.store.exec('UPDATE workflows SET last_scheduled=(SELECT dispatch_sequence FROM scheduler_limits WHERE id=1) WHERE id=?',workflowId);
  }
  private queued(kind:Operation['kind']):Operation[] {
    return schedulingOrder(this.store.all<Operation&{priority:number;lastScheduled:number;sequence:number}>("SELECT o.*,t.priority,w.last_scheduled,o.rowid AS sequence FROM operations o JOIN tasks t ON t.id=o.entity_id JOIN workflows w ON w.id=t.workflow_id WHERE o.kind=? AND o.phase='queued'",kind),this.limits.agingMs);
  }
  requestIntegration(input:{taskId:string;sourceHead:string;idempotencyKey:string;expectedVersion:number}):Operation {
    const operation=this.enqueue('integration',input.taskId,input.idempotencyKey,input.expectedVersion,input.sourceHead);
    this.pump();return this.store.operation(operation.id);
  }
  /** A previous collected source is Host evidence, never a model-provided base.
   * Skip later no-op recollections whose attempt base is already that source. */
  private priorCollectedSource(task:Task):{sourceHead:string;baseCommit:string}|undefined {
    if(!task.sourceHead)return;
    const records=this.store.all<{payload:{sourceHead?:string};baseCommit:string}>("SELECT e.payload,w.base_commit FROM task_events e JOIN runs r ON r.id=e.run_id AND r.task_id=e.task_id JOIN worktrees w ON w.task_id=r.task_id AND w.attempt=r.task_attempt AND w.kind='task' WHERE e.task_id=? AND e.type='source.collected' ORDER BY e.event_seq DESC",task.id);
    const prior=records.find(record=>record.payload.sourceHead===task.sourceHead&&record.baseCommit!==task.sourceHead&&/^[a-f0-9]{40,64}$/.test(record.baseCommit));
    return prior?{sourceHead:task.sourceHead,baseCommit:prior.baseCommit}:undefined;
  }
  /** Recollect a completed, quiescent developer attempt without running a model
   * or spending another repair. Actual Git checks and normal integration remain mandatory. */
  async recoverSource(input:{taskId:string;expectedVersion:number}):Promise<{task:Task;operation:Operation;runId:string;sourceHead:string}> {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot recover source.');
    invariant(!this.sourceRecoveries.has(input.taskId),'SOURCE_RECOVERY_ACTIVE','This task already has a source recovery in progress.');
    this.sourceRecoveries.add(input.taskId);
    const work=(async()=>{
      const check=()=>{
        invariant(!this.stopping,'HOST_STOPPING','Host stopped accepting source recovery.');
        const task=this.store.task(input.taskId),workflow=this.store.workflow(task.workflowId);
        invariant(task.version===input.expectedVersion,'VERSION_CONFLICT','Task changed; reload before recovering source.');
        invariant(task.kind==='change'&&task.status==='blocked'&&!task.acceptedCommit&&['running','paused'].includes(workflow.status),'INVALID_STATE','Only a blocked change task in an active workflow may recover source.');
        const run=this.store.get<Run & {version:number}>('SELECT * FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
        invariant(run&&run.taskAttempt===task.attempt&&run.purpose!=='review'&&run.status==='succeeded','INVALID_STATE','The current attempt must end with a successful developer Run, not a review or failed execution.');
        const result=parseResult(JSON.stringify(run.result),{taskId:task.id,runId:run.id,purpose:run.purpose}) as DevelopmentResult;
        invariant(result.outcome==='completed','INVALID_STATE','A blocked model result cannot be recovered as completed source.');
        invariant(run.cleanupStatus==='confirmed'&&run.slotReleasedAt&&this.store.get("SELECT id FROM execution_leases WHERE owner_type='run' AND owner_id=? AND agent_id=? AND workspace_id=? AND cleanup_status='confirmed' AND released_at IS NOT NULL",run.id,run.roleId,workflow.workspaceId),'CLEANUP_UNKNOWN','The completed Run and its execution lease must both have confirmed cleanup.');
        invariant(!this.active.has(run.id)&&!this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',task.id),'CLEANUP_UNKNOWN','Task still owns execution or unconfirmed cleanup.');
        invariant(!this.store.get("SELECT id FROM operations WHERE entity_id=? AND phase IN ('queued','started')",task.id),'FINALIZATION_PENDING','Task still owns unfinished dispatch or integration requests.');
        invariant(!this.store.get("SELECT id FROM integrations WHERE task_id=? AND status IN ('preparing','reviewing','publishing','cleanup_unknown')",task.id),'INTEGRATION_ACTIVE','Task still owns an integration operation.');
        const worktree=this.store.get<Worktree>("SELECT * FROM worktrees WHERE task_id=? AND attempt=? AND kind='task'",task.id,task.attempt);
        invariant(worktree&&worktree.writerRunId===null&&worktree.status==='active','WORKTREE_OWNERSHIP','Recovery requires this attempt\'s active worktree with no writer.');
        return{task,run,worktree};
      };
      const snapshot=this.store.transaction(check);
      this.store.event(snapshot.task.workflowId,'source.recovery_started',{taskAttempt:snapshot.task.attempt,worktreeId:snapshot.worktree.id,expectedVersion:input.expectedVersion},{taskId:snapshot.task.id,runId:snapshot.run.id});
      try{
        // The ledger writer stays NULL: this is Git collection after proven
        // cleanup, not reacquisition of a model execution lease.
        const source=await this.git.collectSource({...this.context(snapshot.task),run:snapshot.run,worktree:{...snapshot.worktree,writerRunId:snapshot.run.id},priorSource:this.priorCollectedSource(snapshot.task)});
        const queued=this.store.transaction(()=>{
          const current=check();
          invariant(current.run.id===snapshot.run.id&&current.run.version===snapshot.run.version&&JSON.stringify(current.worktree)===JSON.stringify(snapshot.worktree),'VERSION_CONFLICT','Run or worktree changed during source verification.');
          invariant(/^[a-f0-9]{40,64}$/.test(source.sourceHead)&&source.changedPaths.length>0,'INVALID_SOURCE','Git did not return a nonempty collected source.');
          this.store.exec('UPDATE tasks SET status=?,source_head=?,blocking_reason=NULL,version=version+1 WHERE id=? AND version=?','validating',source.sourceHead,current.task.id,input.expectedVersion);
          this.store.exec('UPDATE worktrees SET head_commit=? WHERE id=?',source.sourceHead,current.worktree.id);
          this.store.event(current.task.workflowId,'source.collected',{...source,diff:redact(source.diff),taskAttempt:current.task.attempt,eligibleForIntegration:true,recovered:true,previousBlockingReason:snapshot.task.blockingReason},{taskId:current.task.id,runId:current.run.id});
          const task=this.store.task(current.task.id),idempotencyKey=`source-recovery-integration:${current.run.id}:${input.expectedVersion}`;
          // Commit the real source fact and its normal gated queue intent together.
          const operation=this.enqueue('integration',task.id,idempotencyKey,task.version,source.sourceHead);
          return{task,operation,runId:current.run.id,sourceHead:source.sourceHead};
        });
        const operation=this.requestIntegration({taskId:queued.task.id,sourceHead:queued.sourceHead,idempotencyKey:queued.operation.dedupeKey,expectedVersion:queued.task.version});
        return{...queued,operation,task:this.store.task(queued.task.id)};
      }catch(error){
        if(!this.closed)this.store.event(snapshot.task.workflowId,'source.recovery_failed',{error:errorMessage(error)},{taskId:snapshot.task.id,runId:snapshot.run.id});
        throw error;
      }
    })();
    this.track(work.then(()=>{},()=>{}));
    try{return await work;}finally{this.sourceRecoveries.delete(input.taskId);}
  }
  private enqueue(kind:'dispatch'|'integration',taskId:string,key:string,expectedVersion:number,sourceHead?:string,roleName?:string):Operation {
    invariant(!this.stopping,'HOST_STOPPING','Host is shutting down and cannot accept queue requests.');
    invariant(key.trim()&&key.length<=256,'INVALID_DEDUPE_KEY','A bounded nonempty idempotency key is required.');
    invariant(kind!=='dispatch'||!this.sourceRecoveries.has(taskId),'SOURCE_RECOVERY_ACTIVE','Wait for source recovery before dispatching this task.');
    return this.store.transaction(()=>{
      const prior=this.store.get<Operation>('SELECT * FROM operations WHERE dedupe_key=?',key);
      if(prior){invariant(prior.kind===kind&&prior.entityId===taskId&&(kind!=='integration'||prior.payload.sourceHead===sourceHead),'IDEMPOTENCY_CONFLICT','Idempotency key belongs to a different request.');return prior;}
      const task=this.store.task(taskId),workflow=this.store.workflow(task.workflowId);
      invariant(!terminalWorkflows.has(workflow.status),'INVALID_STATE','Workflow is terminal.');
      invariant(task.version===expectedVersion,'VERSION_CONFLICT','Task version changed.');
      const duplicate=this.store.get<Operation>('SELECT * FROM operations WHERE kind=? AND entity_id=? AND phase IN (\'queued\',\'started\')',kind,taskId);
      invariant(!duplicate,'DUPLICATE_REQUEST','Task already has an unfinished request.');
      let requestVersion=expectedVersion;
      if(kind==='integration'&&task.status==='blocked'&&task.kind==='change'&&task.sourceHead===sourceHead){
        const latest=this.store.get<Run>('SELECT * FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
        const report=latest?.result as Partial<ReviewResult>|null|undefined;
        const previous=latest?this.store.get<IntegrationRecord>("SELECT * FROM integrations WHERE task_id=? AND review_run_id=? AND source_head=? AND status='blocked' ORDER BY rowid DESC LIMIT 1",task.id,latest.id,sourceHead):undefined;
        const blockedReview=latest?.status==='succeeded'&&report?.verdict==='blocked'&&report.taskId===task.id&&report.runId===latest.id&&!!previous?.candidate&&report.reviewedCommit===previous.candidate.candidateHead;
        invariant(latest?.purpose==='review'&&latest.taskAttempt===task.attempt&&(['failed','interrupted'].includes(latest.status)||blockedReview),'INVALID_STATE','Only an infrastructure-failed or explicitly blocked review can retry integration without development; changes_requested requires development.');
        invariant(!this.store.get("SELECT id FROM runs WHERE task_id=? AND (slot_released_at IS NULL OR cleanup_status<>'confirmed')",task.id),'CLEANUP_UNKNOWN','All previous execution cleanup must be confirmed before review retry.');
        invariant(!this.store.get("SELECT id FROM integrations WHERE task_id=? AND status IN ('preparing','reviewing','publishing','cleanup_unknown')",task.id),'INTEGRATION_ACTIVE','Previous integration must settle before review retry.');
        invariant(!this.store.get("SELECT id FROM operations WHERE entity_id=? AND phase IN ('queued','started')",task.id),'FINALIZATION_PENDING','Previous task requests must settle before review retry.');
        this.store.exec("UPDATE tasks SET status='validating',blocking_reason=NULL,version=version+1 WHERE id=?",task.id);
        requestVersion++;
        this.store.event(workflow.id,'review.retry_requested',{sourceHead,previousRunId:latest.id,reason:blockedReview?'review_blocked':'infrastructure_failure'},{taskId});
      }else invariant(kind==='dispatch'?['pending','ready'].includes(task.status):task.kind==='change'&&task.status==='validating'&&task.sourceHead===sourceHead,'INVALID_STATE','Task is not eligible for this request.');
      const role=roleName?this.store.require<Role>("SELECT * FROM roles WHERE workspace_id=? AND name=? AND purpose='developer' AND enabled=1",workflow.workspaceId,roleName):undefined;
      const payload:Operation['payload']={expectedVersion:requestVersion,planRevision:workflow.planRevision};
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
      const slots=this.globalSlots();
      if(slots.total>=this.limits.total||slots.developers>=this.limits.developers||occupied.some(run=>run.taskId===task.id))return;
      const textOnly=this.isTextAnalysis(task);
      const roles=this.store.all<Role>(`SELECT r.* FROM roles r JOIN provider_bindings b ON b.id=r.provider_binding_id WHERE r.workspace_id=? AND r.purpose='developer' AND r.enabled=1 AND ${textOnly?"(r.chat_connection IS NOT NULL OR b.spawn IS NOT NULL OR (b.runtime='codex' AND b.model IS NOT NULL))":"b.provider_name<>'discussion-only'"} ORDER BY r.name`,workflow.workspaceId);
      const previousNativeRole=task.attempt>1?this.store.get<{roleId:string}>("SELECT r.role_id FROM runs r JOIN native_executions e ON e.execution_id=r.id OR instr(e.execution_id,r.id||':item:')=1 JOIN native_sessions s ON s.id=e.session_id WHERE r.task_id=? AND r.purpose<>'review' AND s.thread_id IS NOT NULL ORDER BY r.rowid DESC LIMIT 1",task.id)?.roleId:undefined;
      const requestedRole=operation.payload.roleId??task.roleId??previousNativeRole;
      if(!roles.length||(requestedRole&&!roles.some(role=>role.id===requestedRole))){const reason=textOnly?'CONNECTION_REQUIRED':'ROLE_UNAVAILABLE';this.blockTask(task.id,reason);this.operationPhase(operation,'blocked',reason);return;}
      const role=roles.find(candidate=>(!requestedRole||candidate.id===requestedRole)&&!this.store.get('SELECT id FROM execution_leases WHERE agent_id=? AND released_at IS NULL',candidate.id));
      if(!role)return;
      const run=this.createRun(task,role,task.attempt===1?'develop':'repair');
      this.markScheduled(workflow.id);
      operation.payload.runId=run.id;
      this.store.exec('UPDATE tasks SET status=?,version=version+1,blocking_reason=NULL WHERE id=?','running',task.id);
      this.operationPhase(operation,'started');this.store.event(workflow.id,'dispatch_reserved',{}, {taskId:task.id,runId:run.id,requestId:operation.id});return run;
    });
  }
  private createRun(task:Task,role:Role,purpose:Run['purpose']):Run {
    const runId=id('run'),binding=role.providerBindingId?this.store.binding(role.providerBindingId):null;
    invariant(binding,'BINDING_NOT_FOUND','Child role needs a registered provider binding.');
    const skills=this.skillSnapshot?.(this.store.workflow(task.workflowId).workspaceId,role.id,binding.runtime??(this.isTextAnalysis(task)?(role as Role & {chatConnection?:{runtime:string}}).chatConnection?.runtime:undefined)??binding.providerName,runId);
    this.store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,runtime_boot_id) VALUES(?,?,?,?,?,?,?,?,?,?)',runId,task.id,role.id,purpose,task.attempt,'preparing',JSON.stringify({role,binding,...skills?{skills:skills.versions,skillInstructions:skills.instructions}:{}}),new Date(Date.now()+this.runTimeoutMs).toISOString(),now(),this.bootIdentity);
    return this.store.run(runId);
  }
  private track(promise:Promise<void>):void {this.background.add(promise);void promise.finally(()=>this.background.delete(promise)).catch(()=>{});}
  private pump():void {
    if(this.stopping||this.pumping)return;this.pumping=true;
    try {
      // Re-sort after every reservation so a large workflow cannot consume every vacancy.
      for(;;){let reserved=false;for(const operation of this.queued('dispatch')){
        let run: Run | undefined;
        try { run=this.reserve(operation); }
        catch(error) {
          if (!(error instanceof RiftError) || !/^SKILL_(?:INCOMPATIBLE|ARCHIVED|NAME_CONFLICT|CONTEXT_LIMIT)$/.test(error.code)) throw error;
          this.store.transaction(()=>{this.blockTask(operation.entityId,errorMessage(error));this.operationPhase(this.store.operation(operation.id),'blocked',`${error.code}: ${errorMessage(error)}`);});
          continue;
        }
        if(run){this.track(this.executeDevelopment(run,operation).catch(error=>this.unexpected(run,error)));reserved=true;break;}
      }if(!reserved)break;}
      if(!this.integrationBusy&&!this.store.get('SELECT id FROM integrations WHERE status IN (\'preparing\',\'reviewing\',\'publishing\',\'cleanup_unknown\') LIMIT 1')) {
        for(const operation of this.queued('integration')) {
          const task=this.store.task(operation.entityId),workflow=this.store.workflow(task.workflowId);
          if(workflow.status!=='running'||this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',task.id))continue;
          if(operation.payload.planRevision!==workflow.planRevision||task.sourceHead!==operation.payload.sourceHead||task.version!==operation.payload.expectedVersion){this.store.transaction(()=>this.operationPhase(operation,'blocked','STALE_REQUEST'));continue;}
          this.store.transaction(()=>this.markScheduled(workflow.id));
          this.integrationBusy=true;
          this.track(this.executeIntegration(operation).catch(error=>{this.store.transaction(()=>this.operationPhase(this.store.operation(operation.id),'blocked',errorMessage(error)));}).finally(()=>{this.integrationBusy=false;this.pump();}));break;
        }
      }
    } finally {this.pumping=false;}
  }
  private context(task:Task) {
    const workflow=this.store.workflow(task.workflowId),workspace=this.store.workspace(workflow.workspaceId);
    const repositories=this.store.all<{repositoryId:string;canonicalPath:string;commonGitDir:string;baseRef:string;baseCommit:string;integrationRef:string}>('SELECT f.*,r.canonical_path,r.common_git_dir,r.base_ref FROM workflow_repositories f JOIN repositories r ON r.id=f.repository_id WHERE f.workflow_id=?',workflow.id);
    const repository=task.repositoryId?repositories.find(repo=>repo.repositoryId===task.repositoryId):repositories.length===1?repositories[0]:undefined;
    invariant(repository,'REPOSITORY_REQUIRED','Task repository is missing or ambiguous.');
    return {task,workflow:{...workflow,baseCommit:repository.baseCommit,integrationRef:repository.integrationRef},workspace:{...workspace,repositoryPath:repository.canonicalPath,commonGitDir:repository.commonGitDir,baseRef:repository.baseRef}};
  }
  private isTextAnalysis(task:Task):boolean {return task.kind==='analysis'&&!this.store.get('SELECT repository_id FROM workflow_repositories WHERE workflow_id=? LIMIT 1',task.workflowId);}
  private saveWorktree(worktree:Worktree,run:Run):void {this.store.exec('INSERT INTO worktrees(id,task_id,attempt,kind,path,branch,base_commit,head_commit,writer_run_id,status) VALUES(?,?,?,?,?,?,?,?,?,?)',worktree.id,run.taskId,run.taskAttempt,worktree.kind,worktree.path,worktree.branch??null,worktree.baseCommit,worktree.headCommit??null,run.id,'active');}
  private async prompt(run:Run,task:Task,cwd:string,candidate?:Candidate,worktree?:Worktree,repositoryAccess?:RepositoryAccess):Promise<string> {
    const previous=this.store.all<Run>('SELECT * FROM runs WHERE task_id=? AND id<>? ORDER BY created_at',task.id,run.id);
    const sourceEvidence=this.store.all<{payload:unknown}>('SELECT payload FROM task_events WHERE task_id=? AND type=? ORDER BY event_seq DESC LIMIT 1',task.id,'source.collected').map(event=>event.payload);
    const integrationEvidence=this.store.all<IntegrationRecord>('SELECT * FROM integrations WHERE task_id=? ORDER BY rowid',task.id);
    const currentTargetHead=candidate?.expectedTargetHead??(!this.isTextAnalysis(task)&&this.git.currentHead?await this.git.currentHead(this.context(task)):null);
    if(candidate?.checks)invariant(JSON.stringify(candidate.checks.map(check=>check.id))===JSON.stringify(candidate.checkIds)&&candidate.checks.every(check=>check.candidateHead===candidate.candidateHead&&check.exitCode===0),'CANDIDATE_EVIDENCE_MISMATCH','Review check evidence must match the exact candidate and successful Host checks.');
    const reviewProtocol=run.purpose==='review'?{stage:'pre-publication-independent-review',instructions:'Review the exact candidate commit against the task requirements. Legacy expectedPaths metadata is not an allowlist; assess the relevance and correctness of all actual changes rather than rejecting new helper or test files merely for being unlisted. candidate.checks contains actual Host command results, not developer checksClaimed; absent check evidence is unavailable, never assumed passed. Your verdict is a prerequisite for publication. Acceptance, acceptedCommit, final Workflow completion, and cleanup of this very reviewer happen only after your result and Host cleanup checks; they cannot be preconditions for returning your review verdict. Approve only when the implementation and available check evidence satisfy the reviewable requirements. The Host separately enforces runtime cleanup, exact-commit publication and final acceptance.',evidenceSource:'Host Git operation',integrationId:candidate?.integrationId}:undefined;
    const developmentProtocol=task.kind==='change'&&run.purpose!=='review'?{stage:'development-before-host-source-collection',instructions:'Implement the task in the CURRENT cwd, adding or refactoring any files needed within the workspace. Legacy expectedPaths metadata is not a file permission boundary. Local git add/commit is permitted in the assigned current worktree. You may use the Host-authorized workspace repository set, but preserve other active work and use the task checkout for assigned changes. Push or create/update a PR only when explicitly requested by the user. After your result and confirmed cleanup the Host verifies the actual source commits and diff, collects any remaining edits, runs candidate checks and starts independent review. A local commit or PR does not replace those acceptance gates. outcome completed means implementation is ready for Host validation, not that the Task is accepted. Report local test failures or unavailable commands honestly in checksClaimed/summary; sandbox denial of Git writes or test subprocesses alone must not block a ready implementation waiting for Host validation. Actual incomplete implementation or failed behavior remains blocked. Never claim tests passed when they did not. Finish your result promptly; do not wait for Host submission or review inside this Run.'}:undefined;
    const previousAttemptWorktrees=run.purpose!=='review'?this.store.all('SELECT w.attempt,w.path,w.base_commit,w.head_commit FROM worktrees w WHERE w.task_id=? AND w.kind=\'task\' AND w.attempt<? AND w.writer_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.task_id=w.task_id AND r.task_attempt=w.attempt AND r.slot_released_at IS NULL) ORDER BY w.attempt DESC LIMIT 2',task.id,run.taskAttempt):[];
    const retryContext=this.store.get<{payload:unknown}>("SELECT payload FROM task_events WHERE task_id=? AND type='task.retry' ORDER BY event_seq DESC LIMIT 1",task.id)?.payload;
    return JSON.stringify({publicProgressInstructions:'Work in the shared conversation as your own role. Briefly state your next action before a tool phase, and report meaningful findings or blockers as ordinary assistant text while working. Keep updates concise, factual and in the user language. Do not reveal private reasoning, credentials or raw tool payloads. Do not wait until the final result to communicate. The final response must still match resultSchema.',repositoryAccess,collaborationMessages:this.collaboration.captureRunInbox?.(run)??[],developmentProtocol,reviewProtocol,retryContext,previousAttemptWorktrees,previousAttemptPolicy:'Previous attempt checkouts are preserved evidence, not current cwd. If instructed to recover unfinished edits, inspect them read-only and explicitly reapply appropriate changes in the current checkout, then validate. Never edit or commit the old checkout. They may contain uncommitted/untracked files absent from the new attempt base.',role:run.providerSnapshot.role.prompt,skillInstructions:run.providerSnapshot.skillInstructions??'',skillVersions:run.providerSnapshot.skills??[],taskId:task.id,runId:run.id,goal:this.store.workflow(task.workflowId).goal,title:task.title,instructions:task.instructions,cwd,acceptanceCriteria:task.acceptanceCriteria,attempt:task.attempt,sourceHead:task.sourceHead,baseCommit:worktree?.baseCommit??candidate?.candidateHead??this.store.workflow(task.workflowId).baseCommit,currentTargetHead,candidate,sourceEvidence,integrationEvidence,previousResults:previous.map(prior=>({runId:prior.id,status:prior.status,result:prior.result,stopReason:prior.stopReason})),resultSchema:run.purpose==='review'?{schemaVersion:1,taskId:task.id,runId:run.id,verdict:'approve|changes_requested|blocked',reviewedCommit:candidate?.candidateHead,findings:[{severity:'critical|high|medium|low',file:'string',line:1,reason:'string',suggestion:'string'}]}:{schemaVersion:1,taskId:task.id,runId:run.id,outcome:'completed|blocked',summary:'string',changedPaths:[],checksClaimed:[],blockingReasons:[]}});
  }
  private async cleanup(runId:string,state:Active):Promise<boolean> {
    // Disposal may have succeeded even when persisting its receipt failed (for example, disk full).
    if(this.cleanupReceipts.has(runId)){this.store.transaction(()=>this.confirmCleanup(runId));return true;}
    if(state.cleanup)return state.cleanup;
    state.cleanup=(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try {if(!state.handle)return false;await Promise.race([state.handle.dispose().then(()=>this.cleanupReceipt(runId)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RiftError('CLEANUP_TIMEOUT','Activation cleanup did not settle before its deadline.')),this.cleanupTimeoutMs);})]);this.store.transaction(()=>this.confirmCleanup(runId));return true;}catch(error){this.store.transaction(()=>{const timedOut=error instanceof RiftError&&error.code==='CLEANUP_TIMEOUT';this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?',timedOut?'unknown':'failed',runId);const run=this.store.run(runId);const task=this.store.task(run.taskId);this.store.event(task.workflowId,timedOut?'cleanup.unknown':'cleanup.failed',{error:errorMessage(error)},{taskId:task.id,runId});});return false;}finally{if(timer)clearTimeout(timer);}})();
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
    const stream=new RunChatStream(this.store,run.id);
    let startAttempted=false;
    let rawText:string|undefined;
    let abortListener:(()=>void)|undefined;
    const aborted=new Promise<never>((_,reject)=>{abortListener=()=>reject(new RiftError('CANCELLED','Run was cancelled.'));state.controller.signal.addEventListener('abort',abortListener,{once:true});});
    void aborted.catch(()=>undefined);
    try {
      const repositoryAccess=!task.analysisItems?.length&&((task.kind==='change'&&run.purpose!=='review')||agentSandboxMode()==='unrestricted')?await this.collaboration.repositoryAccess?.(this.store.workflow(task.workflowId).workspaceId):undefined;
      const prompt=await this.prompt(run,task,cwd,candidate,worktree,repositoryAccess);
      if(state.controller.signal.aborted)throw new RiftError('ABORTED_BEFORE_START','Run was cancelled before provider invocation.');
      this.store.transaction(()=>{const input=safeValue(JSON.parse(prompt));const artifactId=saveResultArtifact(this.store,this.store.workflow(task.workflowId).workspaceId,run.id,input,'input');this.store.event(task.workflowId,'run.input_prepared',{artifactId,promptSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd,baseCommit:worktree?.baseCommit??candidate?.candidateHead??null,sourceHead:task.sourceHead,candidateHead:candidate?.candidateHead??null},{taskId:task.id,runId:run.id});});
      startAttempted=true;
      const bridge=this.isTextAnalysis(task)?this.textAnalysisBridge:this.bridge;
      invariant(bridge,'START_NOT_PUBLISHED','A restricted text-analysis runtime is not configured.');
      const starting=bridge.start({run,task,role:run.providerSnapshot.role,cwd,...repositoryAccess?{repositoryAccess}:{},prompt,signal:state.controller.signal,tools:this.collaboration.runTools?.(run),onEvent:event=>stream.accept(event),onProgress:event=>{try{recordRunProgress(this.store,run.id,event);}catch{/* Progress must not change execution results. */}},onAccepted:()=>this.collaboration.acceptRunInbox?.(run.id)});
      void starting.then(late=>{if(!state.handle&&state.controller.signal.aborted){void late.result.catch(()=>undefined);void late.dispose().then(()=>this.cleanupReceipt(run.id)).catch(()=>undefined);}},()=>undefined);
      const handle=await Promise.race([starting,aborted]);state.handle=handle;
      if(state.cleanup)state.cleanup=undefined;
      this.store.transaction(()=>{this.store.exec('UPDATE runs SET dsh_child_id=?,status=?,started_at=? WHERE id=?',handle.childId,state.cancelled?'cancelling':'running',now(),run.id);this.collaboration.acceptRunInbox?.(run.id);this.store.event(task.workflowId,'activation_accepted',{childId:handle.childId},{taskId:task.id,runId:run.id});});
      if(state.cancelled){await this.cleanup(run.id,state);this.store.transaction(()=>this.recordResult(run.id,'cancelled',state.cancelReason??'CANCELLED',null));return;}
      const result=await Promise.race([handle.result,aborted]);
      rawText=result.text;
      if(result.dshRunId)this.store.exec('UPDATE runs SET dsh_run_id=? WHERE id=?',result.dshRunId,run.id);
      invariant(['completed','end_turn','stop','success'].includes(result.stopReason),'PROVIDER_STOP',`Provider stopped with ${result.stopReason}.${result.diagnostic?` ${redact(result.diagnostic,4096)}`:''}`);
      const parsed=parseResult(result.text,{taskId:task.id,runId:run.id,purpose:run.purpose});
      this.store.transaction(()=>this.recordResult(run.id,'succeeded',result.stopReason,parsed));return parsed;
    }catch(error){this.store.transaction(()=>{this.recordResult(run.id,state.cancelled?'cancelled':'failed',state.cancelled?(state.cancelReason??'CANCELLED'):error instanceof RiftError?error.code:'EXECUTION_FAILED',{error:errorMessage(error),...(rawText===undefined?{}:{output:redact(rawText)})});if(!state.handle){if(!startAttempted||(error instanceof RiftError&&(['START_NOT_PUBLISHED','LIVE_LEAD_REQUIRED','PROVIDER_UNAVAILABLE','ABORTED_BEFORE_START'].includes(error.code)||(error.details as {cleanupConfirmed?:boolean}|undefined)?.cleanupConfirmed)))this.confirmCleanup(run.id);else this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?','unknown',run.id);}});return;}
    finally {clearTimeout(timeout);if(abortListener)state.controller.signal.removeEventListener('abort',abortListener);try {try {stream.finish(this.store.run(run.id).status!=='succeeded');} finally {if(state.handle)await this.cleanup(run.id,state);}} finally {this.active.delete(run.id);}}
  }
  private blockTask(taskId:string,reason:string):void {const task=this.store.task(taskId);if(['succeeded','cancelled'].includes(task.status))return;this.store.exec('UPDATE tasks SET status=?,blocking_reason=?,version=version+1 WHERE id=?','blocked',reason,taskId);this.store.event(task.workflowId,'task.blocked',{reason},{taskId});}
  private async executeDevelopment(run:Run,operation:Operation):Promise<void> {
    const state:Active={controller:new AbortController(),cancelled:false};this.active.set(run.id,state);
    const task=this.store.task(run.taskId);let worktree:Worktree|undefined;let cwd:string;
    try {
      for(const dependency of this.dependencies(task))if(dependency.kind==='change'&&dependency.acceptedCommit){invariant(this.git.containsCommit,'DEPENDENCY_UNVERIFIABLE','Git service cannot verify accepted dependency ancestry.');invariant(await this.git.containsCommit({...this.context(dependency),commit:dependency.acceptedCommit}),'DEPENDENCY_NOT_INTEGRATED','Accepted dependency is no longer contained in the current integration head.');}
      if(this.isTextAnalysis(task)){
        invariant(this.textAnalysisRoot&&this.textAnalysisBridge,'START_NOT_PUBLISHED','Repository-free analysis requires the restricted text runtime.');
        cwd=resolve(this.textAnalysisRoot,run.id);await mkdir(cwd,{recursive:true});invariant((await readdir(cwd)).length===0,'ANALYSIS_DIRECTORY_DIRTY','Text-analysis staging must start empty.');
      }else{worktree=await this.git.prepareTask({...this.context(task),run});cwd=worktree.path;this.store.transaction(()=>this.saveWorktree(worktree!,run));}
    }
    catch(error){this.store.transaction(()=>{this.recordResult(run.id,state.cancelled?'cancelled':'failed','WORKTREE_PREPARATION_FAILED',{error:errorMessage(error)});this.confirmCleanup(run.id);this.blockTask(task.id,errorMessage(error));this.operationPhase(this.store.operation(operation.id),'blocked',errorMessage(error));});this.active.delete(run.id);this.pump();return;}
    if(state.cancelled){this.store.transaction(()=>{this.recordResult(run.id,'cancelled','CANCELLED',null);this.confirmCleanup(run.id);this.operationPhase(this.store.operation(operation.id),'cancelled');});this.active.delete(run.id);this.pump();return;}
    const result=await this.execute(run,task,cwd,state,undefined,worktree) as DevelopmentResult|undefined;
    try {
      const completed=this.store.run(run.id);
      if(this.store.task(task.id).status==='cancelled'||terminalWorkflows.has(this.store.workflow(task.workflowId).status)){this.store.transaction(()=>this.operationPhase(this.store.operation(operation.id),'cancelled'));return;}
      if(completed.cleanupStatus!=='confirmed'){this.store.transaction(()=>{this.blockTask(task.id,'CLEANUP_UNKNOWN');this.operationPhase(this.store.operation(operation.id),'blocked','CLEANUP_UNKNOWN');});return;}
      if(completed.status==='cancelled'){this.store.transaction(()=>{this.store.exec('UPDATE tasks SET status=?,blocking_reason=?,version=version+1 WHERE id=?','cancelled','CANCELLED',task.id);this.operationPhase(this.store.operation(operation.id),'cancelled');});return;}
      if(!result||result.outcome!=='completed'){this.store.transaction(()=>{this.blockTask(task.id,result?.blockingReasons.join('; ')||completed.stopReason||'EXECUTION_FAILED');this.operationPhase(this.store.operation(operation.id),'blocked','EXECUTION_FAILED');});return;}
      if(task.kind==='analysis'){
        const evidence=this.isTextAnalysis(task)?{textOnly:true,noFilesystemChanges:(await readdir(cwd)).length===0}:this.git.verifyAnalysis?await this.git.verifyAnalysis({...this.context(this.store.task(task.id)),run:completed,worktree:worktree!}):undefined;
        if(this.isTextAnalysis(task))invariant(evidence&&'noFilesystemChanges' in evidence&&evidence.noFilesystemChanges,'ANALYSIS_MUTATION','Text-analysis runtime changed its staging directory.');
        this.store.transaction(()=>{
          const latest=this.store.task(task.id);
          if(latest.status==='cancelled'||terminalWorkflows.has(this.store.workflow(task.workflowId).status)){this.operationPhase(this.store.operation(operation.id),'cancelled');return;}
          invariant(latest.status==='running'&&latest.attempt===run.taskAttempt,'STALE_ANALYSIS','Analysis no longer owns the current task attempt.');
          if(evidence)this.store.event(task.workflowId,'analysis.verified',evidence,{taskId:task.id,runId:run.id});
          this.store.exec('UPDATE tasks SET status=?,version=version+1 WHERE id=?','succeeded',task.id);this.operationPhase(this.store.operation(operation.id),'completed');this.store.event(task.workflowId,'task.succeeded',{}, {taskId:task.id,runId:run.id});
        });return;
      }
      const sourceTask=this.store.task(task.id);
      const source=await this.git.collectSource({...this.context(sourceTask),run:completed,worktree:worktree!,priorSource:this.priorCollectedSource(sourceTask)});
      const eligible=this.store.transaction(()=>{
        const latest=this.store.task(task.id),workflow=this.store.workflow(task.workflowId);
        const sameAttempt=latest.attempt===run.taskAttempt;
        const mayIntegrate=sameAttempt&&latest.status==='running'&&!terminalWorkflows.has(workflow.status);
        if(mayIntegrate)this.store.exec('UPDATE tasks SET status=?,source_head=?,version=version+1 WHERE id=?','validating',source.sourceHead,task.id);
        else if(sameAttempt)this.store.exec('UPDATE tasks SET source_head=?,version=version+1 WHERE id=?',source.sourceHead,task.id);
        this.store.exec('UPDATE worktrees SET head_commit=? WHERE id=?',source.sourceHead,worktree!.id);
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
    this.store.transaction(()=>{this.store.exec('INSERT INTO integrations(id,task_id,source_head,status,runtime_boot_id) VALUES(?,?,?,?,?)',integrationId,task.id,operation.payload.sourceHead!,'preparing',this.bootIdentity);operation.payload.integrationId=integrationId;this.operationPhase(operation,'started');this.store.exec('UPDATE tasks SET status=?,version=version+1 WHERE id=?','integrating',task.id);});
    try {
      candidate=await this.git.prepareCandidate({...this.context(task),sourceHead:operation.payload.sourceHead!,integrationId});
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET expected_target_head=?,candidate_head=?,check_ids=?,candidate=? WHERE id=?',candidate!.expectedTargetHead,candidate!.candidateHead,JSON.stringify(candidate!.checkIds),JSON.stringify(candidate),integrationId);this.store.event(task.workflowId,'candidate.prepared',candidate,{taskId:task.id,requestId:operation.id});});
      while((this.store.workflow(task.workflowId).status==='paused'||!this.availableReviewer(this.store.workflow(task.workflowId).workspaceId))&&!terminalWorkflows.has(this.store.workflow(task.workflowId).status)&&this.store.task(task.id).status!=='cancelled'&&!this.stopping)await new Promise(resolve=>setTimeout(resolve,25));
      task=this.store.task(task.id);invariant(!this.stopping&&this.store.workflow(task.workflowId).status==='running'&&task.status!=='cancelled','CANCELLED','Integration cancelled before review.');
      reviewRun=this.store.transaction(()=>{const role=this.availableReviewer(this.store.workflow(task.workflowId).workspaceId);invariant(role,'CAPACITY','Reviewer capacity is occupied.');const run=this.createRun(task,role,'review');this.store.exec('UPDATE integrations SET status=?,review_run_id=? WHERE id=?','reviewing',run.id,integrationId);operation.payload.runId=run.id;this.store.exec('UPDATE operations SET payload=? WHERE id=?',JSON.stringify(operation.payload),operation.id);this.store.event(task.workflowId,'review.reserved',{candidateHead:candidate!.candidateHead},{taskId:task.id,runId:run.id,requestId:operation.id});return run;});
      const state:Active={controller:new AbortController(),cancelled:false};this.active.set(reviewRun.id,state);
      const review=await this.execute(reviewRun,task,candidate.cwd,state,candidate) as ReviewResult|undefined;
      invariant(this.store.run(reviewRun.id).cleanupStatus==='confirmed','CLEANUP_UNKNOWN','Review cleanup is unconfirmed.');
      const settledReview=this.store.run(reviewRun.id);
      const reviewFailure=settledReview.result&&typeof settledReview.result==='object'&&'error' in settledReview.result&&typeof settledReview.result.error==='string'?settledReview.result.error:'';
      invariant(review,'REVIEW_EXECUTION_FAILED',`Review execution failed: ${settledReview.stopReason??'UNKNOWN'}. ${reviewFailure}`);
      invariant(review&&review.verdict==='approve'&&review.reviewedCommit===candidate.candidateHead,'REVIEW_REJECTED','Review must approve the exact checked candidate commit.');
      invariant(this.store.task(task.id).status!=='cancelled'&&!terminalWorkflows.has(this.store.workflow(task.workflowId).status),'CANCELLED','Task or workflow was cancelled before publication.');
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=? WHERE id=?','publishing',integrationId);this.store.event(task.workflowId,'publication.intent',candidate,{taskId:task.id,requestId:operation.id});});
      const accepted=await this.git.publishCandidate({...this.context(task),candidate,review});
      this.store.transaction(()=>{this.store.exec('UPDATE integrations SET status=? WHERE id=?','accepted',integrationId);this.store.exec('UPDATE tasks SET status=?,accepted_commit=?,version=version+1,blocking_reason=NULL WHERE id=?','succeeded',accepted.acceptedCommit,task.id);this.operationPhase(this.store.operation(operation.id),'completed');this.store.event(task.workflowId,'integration.accepted',{integrationId,...accepted},{taskId:task.id,requestId:operation.id});});
    }catch(error){
      const unknown=reviewRun&&this.store.run(reviewRun.id).cleanupStatus!=='confirmed';
      const publishing=this.store.require<IntegrationRecord>('SELECT * FROM integrations WHERE id=?',integrationId).status==='publishing';
      if(candidate&&!publishing)this.integrationCleanupReceipts.add(integrationId);
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

  private globalSlots():{developers:number;reviewers:number;total:number} {return this.store.require("SELECT COALESCE(SUM(capacity='developer'),0) AS developers,COALESCE(SUM(capacity='reviewer'),0) AS reviewers,COUNT(*) AS total FROM execution_leases WHERE released_at IS NULL AND capacity<>'lead'");}
  private availableReviewer(workspaceId:string):Role|undefined {const slots=this.globalSlots();if(slots.total>=this.limits.total||slots.reviewers>=1)return;return this.store.get<Role>("SELECT r.* FROM roles r JOIN provider_bindings b ON b.id=r.provider_binding_id WHERE r.workspace_id=? AND r.purpose='reviewer' AND r.enabled=1 AND b.provider_name<>'discussion-only' AND NOT EXISTS(SELECT 1 FROM execution_leases l WHERE l.agent_id=r.id AND l.released_at IS NULL) ORDER BY r.name LIMIT 1",workspaceId);}
  status(workflowId:string) {
    const workflow=this.store.workflow(workflowId),tasks=this.store.all<Task>('SELECT * FROM tasks WHERE workflow_id=? ORDER BY rowid',workflowId);
    const runs=this.store.all<Run & {runtimeBootId:string|null}>('SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.workflow_id=? ORDER BY r.created_at',workflowId).map(({runtimeBootId:_boot,...run})=>run),occupied=runs.filter(run=>run.slotReleasedAt===null);
    const nativeExecutions=this.store.all("SELECT r.id AS run_id,s.id AS session_id,s.agent_id,s.thread_id,e.execution_id,e.native_turn_id,e.status FROM runs r JOIN native_executions e ON e.execution_id=r.id OR instr(e.execution_id,r.id||':item:')=1 JOIN native_sessions s ON s.id=e.session_id JOIN tasks t ON t.id=r.task_id WHERE t.workflow_id=? ORDER BY r.rowid,e.execution_id",workflowId);
    return {workflow,nativeExecutions,repositories:this.store.all('SELECT * FROM workflow_repositories WHERE workflow_id=?',workflowId),roles:this.store.all<Role>('SELECT * FROM roles WHERE workspace_id=? ORDER BY name',workflow.workspaceId),tasks:tasks.map(task=>({...task,dependencyStatus:dependencyStatus(this.dependencies(task))})),runs,worktrees:this.store.all<Worktree>('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id WHERE t.workflow_id=?',workflowId),operations:this.store.all<Operation>('SELECT o.* FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? ORDER BY o.created_at,o.id',workflowId),integrations:this.store.all<IntegrationRecord & {runtimeBootId:string|null}>('SELECT i.* FROM integrations i JOIN tasks t ON t.id=i.task_id WHERE t.workflow_id=?',workflowId).map(({runtimeBootId:_boot,...integration})=>integration),limits:this.limits,globalSlots:this.globalSlots(),slots:{developers:occupied.filter(run=>run.purpose!=='review').length,reviewers:occupied.filter(run=>run.purpose==='review').length,total:occupied.length},eventSeq:this.store.get<{seq:number}>('SELECT COALESCE(MAX(event_seq),0) AS seq FROM task_events WHERE workflow_id=?',workflowId)!.seq};
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
    invariant(!this.sourceRecoveries.has(input.taskId),'SOURCE_RECOVERY_ACTIVE','Wait for source recovery before retrying this task.');
    return this.store.transaction(()=>{
      const task=this.store.task(input.taskId);
      invariant(task.version===input.expectedVersion,'VERSION_CONFLICT','Task version changed.');
      invariant(['blocked','failed','cancelled'].includes(task.status),'INVALID_STATE','Only blocked, failed or cancelled tasks may be retried.');
      invariant(!terminalWorkflows.has(this.store.workflow(task.workflowId).status),'INVALID_STATE','Cannot retry a terminal workflow.');
      // Explicit retries retain monotonic attempts and history; transport failures
      // must not consume an arbitrary lifetime development-attempt allowance.
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
    if(state){state.cancelled=true;state.cancelReason=reason;state.controller.abort();if(state.handle&&await this.cleanup(runId,state)){this.store.transaction(()=>this.recordResult(runId,'cancelled',reason,null));this.active.delete(runId);}}
    else this.store.transaction(()=>{const confirmed=this.cleanupReceipts.has(runId);this.recordResult(runId,confirmed?'cancelled':'interrupted',confirmed?reason:'HANDLE_LOST',{reason});if(confirmed)this.confirmCleanup(runId);else this.store.exec('UPDATE runs SET cleanup_status=? WHERE id=?','unknown',runId);});
    return this.store.run(runId);
  }
  async cancelTask(taskId:string):Promise<Task> {
    this.store.transaction(()=>{const task=this.store.task(taskId);invariant(task.status!=='succeeded','INVALID_STATE','Accepted tasks cannot be cancelled.');this.store.exec('UPDATE tasks SET status=?,version=version+1,blocking_reason=? WHERE id=?','cancelled','CANCELLED',taskId);for(const operation of this.store.all<Operation>('SELECT * FROM operations WHERE entity_id=? AND phase=\'queued\'',taskId))this.operationPhase(operation,'cancelled');this.store.event(task.workflowId,'task.cancel_requested',{}, {taskId});});
    await Promise.allSettled(this.store.all<Run>('SELECT * FROM runs WHERE task_id=? AND slot_released_at IS NULL',taskId).map(run=>this.cancelRun(run.id)));
    if(this.background.size===0&&!this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',taskId))this.store.transaction(()=>{for(const operation of this.store.all<Operation>("SELECT * FROM operations WHERE entity_id=? AND kind='dispatch' AND phase='started'",taskId))this.operationPhase(operation,'cancelled');});
    this.pump();return this.store.task(taskId);
  }
  async cancelWorkflow(workflowId:string):Promise<ReturnType<TaskCoordinator['status']>> {
    this.store.transaction(()=>{const workflow=this.store.workflow(workflowId);invariant(workflow.status!=='completed','INVALID_STATE','Completed workflow cannot be cancelled.');this.store.exec('UPDATE workflows SET status=?,version=version+1 WHERE id=?','cancelled',workflowId);for(const operation of this.store.all<Operation>('SELECT o.* FROM operations o JOIN tasks t ON t.id=o.entity_id WHERE t.workflow_id=? AND o.phase=\'queued\'',workflowId))this.operationPhase(operation,'cancelled');this.store.exec('UPDATE tasks SET status=?,version=version+1 WHERE workflow_id=? AND status<>?','cancelled',workflowId,'succeeded');this.store.event(workflowId,'workflow.cancel_requested');});
    await Promise.allSettled(this.store.all<Run>('SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.workflow_id=? AND r.slot_released_at IS NULL',workflowId).map(run=>this.cancelRun(run.id)));this.pump();return this.status(workflowId);
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
  async shutdown():Promise<void> {this.stopping=true;await Promise.allSettled([...this.active.keys()].map(runId=>this.cancelRun(runId,'HOST_SHUTDOWN')));await Promise.allSettled([...this.background]);this.closed=true;}
}

