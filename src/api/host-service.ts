import { workspaceRepositoryAccess } from '../agent/repository-access.js';
import { createRepositoryShell } from '../agent/repository-shell.js';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { RiftStore } from '../storage/database.js';
import { ProjectService } from '../project/index.js';
import { TaskCoordinator } from '../task/coordinator.js';
import { DshActivationBridge } from '../task/activation-bridge.js';
import { LocalGitService } from '../git/integration.js';
import type { CheckCommand } from '../git/types.js';
import { RiftError, type ProviderBinding, type Workflow, type Worktree } from '../contracts/index.js';
import { installLeadTools } from '../tools/rift-tools.js';
import * as schemas from './schemas.js';
import { publicError, redact } from './security.js';
import type { ApiHandler } from './local-api.js';
import { workspaceDetail, workspaceList, workspaceTasks } from './workspace-views.js';
import { ChatService, sendMessageSchema } from '../chat/service.js';
import { DshChatRuntime } from '../chat/dsh-runtime.js';
import type { AgentRuntime, RuntimeTool } from '../agent/runtime-types.js';
import type { AgentTurn, ChatConnection, ContextRef, ContextSnapshot } from '../chat/contracts.js';
import { connectionSchema, createAgentSchema, createBrowserAgent, updateAgentSchema, updateBrowserAgent } from '../project/browser-agents.js';
import { invariant } from '../contracts/index.js';
import { SkillService } from '../skill/service.js';
import { readWorkspaceEvents } from '../events/workspace-events.js';
import { NativeCodexRuntime, nativeCodexPackage, VERIFIED_NATIVE_CODEX_MODELS } from '../agent/native-codex.js';
import { RepositoryService } from '../project/repositories.js';
import { localBootIdentity } from '../agent/boot-identity.js';
import { ApiConnectionService } from '../agent/connections.js';
import type { ActivationBridge } from '../contracts/index.js';
import { nativeSession, sessionCallbacks } from '../agent/native-sessions.js';
import { bindingConnection } from '../agent/execution-connection.js';
import { PersistentCodexProvider } from '../agent/codex-provider.js';
import { validateBinding } from '../project/provider-bindings.js';
import { ChatOrchestration } from '../chat/orchestration.js';
import { CollaborationService,delegateSchema,sendCollaborationMessageSchema } from '../chat/collaboration.js';

export interface HostConfig { home: string; port: number; uiDist?: string; uiEnabled?: boolean; leadTurnLimit?: number; leadProvider: string; leadModel: string; developerProvider?: string; reviewerProvider?: string; limits?: z.infer<typeof schemas.limitsSchema>; checks: CheckCommand[]; runTimeoutMs?: number; chatOrchestration?:boolean; coordinationToolLimit?:number; coordinationStagnantLimit?:number; coordinationAutomaticTurnLimit?:number; coordinationTimeoutMs?:number }
export class RiftHostService implements ApiHandler {
  readonly store: RiftStore;
  readonly project: ProjectService;
  readonly git: LocalGitService;
  readonly coordinator: TaskCoordinator;
  readonly chat: ChatService;
  readonly orchestration: ChatOrchestration;
  readonly collaboration: CollaborationService;
  readonly skills: SkillService;
  readonly repositories: RepositoryService;
  readonly connections: ApiConnectionService;
  private readonly chatRuntimes = new Map<string, AgentRuntime>();
  private readonly runtimeModels = new Map<string, readonly string[]>();
  private nativeRuntimeUnavailable = 'Native subprocess service is not mounted in this Host.';
  private readonly leads = new Map<string, AgentHandle>();
  private readonly leadStarts = new Map<string, Promise<AgentHandle>>();
  private readonly providerNames = new Set<string>();
  private readonly executionProviderDisposers: (() => void)[] = [];
  private closing = false;
  constructor(private readonly ctx: Context, readonly config: HostConfig) {
    this.store = new RiftStore(path.join(config.home, 'rift.db'));
    try {
    if (config.leadTurnLimit !== undefined) {
      invariant(Number.isInteger(config.leadTurnLimit) && config.leadTurnLimit >= 1 && config.leadTurnLimit <= 128, 'INVALID_LIMITS', 'Lead turn limit must be 1–128.');
      invariant(this.store.require<{count:number}>("SELECT COUNT(*) AS count FROM execution_leases WHERE released_at IS NULL AND capacity='lead'").count <= config.leadTurnLimit, 'LIMITS_IN_USE', 'Retained Lead executions exceed the requested limit.');
      this.store.exec('UPDATE scheduler_limits SET lead_turns=? WHERE id=1', config.leadTurnLimit);
    }
    this.store.db.exec('CREATE TABLE IF NOT EXISTS management_requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT)');
    this.project = new ProjectService(this.store, this.providerNames);
    this.git = new LocalGitService({ managedRoot: path.join(config.home, 'workspaces'), commands: config.checks });
    this.repositories = new RepositoryService(this.store, this.git);
    this.connections = new ApiConnectionService(ctx, this.store, config.home);
    const bridge = new DshActivationBridge(ctx, taskId => this.leads.get(this.store.task(taskId).workflowId)?.agent, this.store);
    this.skills = new SkillService(this.store);
    this.coordinator = new TaskCoordinator({ store: this.store, repositoryAccess:workspaceId=>workspaceRepositoryAccess(this.store,workspaceId), bridge, runTools:run=>this.collaboration.runTools(run),captureRunInbox:run=>this.collaboration.captureRunInbox(run),acceptRunInbox:runId=>this.collaboration.acceptRunInbox(runId), git: this.git, runTimeoutMs: config.runTimeoutMs, limits: config.limits, textAnalysisRoot: path.join(config.home,'text-analysis'), textAnalysisBridge: { start: input => this.startTextAnalysis(input) }, skillSnapshot: (workspaceId, agentId, runtime, runId) => this.skills.snapshotExecution(workspaceId, agentId, 'run', runId, this.skills.resolveEffective(workspaceId, agentId, runtime)) });
    this.chat = new ChatService({ store: this.store, repositoryAccess:workspaceId=>workspaceRepositoryAccess(this.store,workspaceId), home: config.home, turnTimeoutMs:turn=>turn.configuration.agent.purpose==='lead'&&!turn.configuration.conversationTitle&&(this.orchestration.forTurn(turn)||config.chatOrchestration!==false&&!this.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')",turn.workspaceId))?config.coordinationTimeoutMs:undefined, defaultConnection: () => ({ runtime: 'dsh', provider: config.leadProvider, model: config.leadModel }), validateConnection: connection => this.validateChatConnection(connection), runtime: connection => connection.runtime === 'dsh' ? new DshChatRuntime(ctx, connection.provider!) : this.chatRuntimes.get(connection.runtime)!, tools: turn => this.chatTools(turn), resolveContext: (workspaceId, refs) => this.contextSnapshots(workspaceId, refs), onLeaseReleased: () => this.coordinator.wake(), canStart:turn=>this.orchestration.canStart(turn), beforeStart:turn=>this.orchestration.beforeStart(turn), onTurnSettled:turn=>{this.orchestration.settled(turn);this.collaboration.settleTurn(turn);}, skillSnapshot: (workspaceId, agentId, runtime, turnId) => this.skills.snapshotExecution(workspaceId, agentId, 'turn', turnId, this.skills.resolveEffective(workspaceId, agentId, runtime)) });
    this.collaboration=new CollaborationService(this.store,this.coordinator,{enqueueMessage:(workspaceId,conversationId,messageId)=>this.chat.enqueueMessage(workspaceId,conversationId,messageId),validateDiscussion:(workspaceId,agentId)=>{this.chat.validateAgentConnection(workspaceId,agentId);},validateRecipient:(role,workflowId)=>{if(this.store.workflow(workflowId).baseCommit){this.refreshProviders();invariant(role.providerBindingId&&this.providerNames.has(this.store.binding(role.providerBindingId).providerName),'PROVIDER_UNAVAILABLE','Recipient has no registered executable binding.');}}});
    this.orchestration=new ChatOrchestration(this.store,{projectReceipt:input=>this.collaboration.projectReceipt(input),enqueue:(workspaceId,conversationId,triggerId,content)=>this.chat.enqueueTrigger(workspaceId,conversationId,triggerId,content),ensureParent:workflowId=>this.ensureLead(workflowId),stop:turn=>this.chat.stop(turn.workspaceId,turn.id),maxTools:config.coordinationToolLimit,maxStagnant:config.coordinationStagnantLimit,maxAutomaticTurns:config.coordinationAutomaticTurnLimit});
    const subprocess = ctx.get?.('subprocess');
    if (subprocess) {
      try {
        nativeCodexPackage();
        this.registerChatRuntime('codex', new NativeCodexRuntime({ spawn: specification => subprocess.spawn(specification) }), VERIFIED_NATIVE_CODEX_MODELS);
        for (const model of VERIFIED_NATIVE_CODEX_MODELS) {
          const providerName = `rift-native-codex-${model}`;
          this.executionProviderDisposers.push(ctx.subagents.registerProvider(new PersistentCodexProvider({ providerName, model }, spec => subprocess.spawn(spec))));
        }
      }
      catch (error) { this.nativeRuntimeUnavailable = publicError(error).message; }
    }
    } catch (error) { this.store.close(); throw error; }
  }
  async initialize(): Promise<void> { await this.connections.initialize(); const boot=await localBootIdentity();this.repositories.setBootIdentity(boot);this.coordinator.setBootIdentity(boot);await this.coordinator.recover();this.store.exec("UPDATE native_executions SET status='interrupted',updated_at=? WHERE status IN ('starting','running')",new Date().toISOString());this.chat.setBootIdentity(boot);this.chat.initialize();this.orchestration.initialize();this.collaboration.initialize(); }
  registerChatRuntime(name: 'codex', runtime: AgentRuntime, models: readonly string[]): void { this.chatRuntimes.set(name, runtime); this.runtimeModels.set(name, models); }
  browserEvents(workspaceId: string, after: number) { return readWorkspaceEvents(this.store, workspaceId, after); }
  private validateChatConnection(connection: ChatConnection): void {
    if (connection.runtime === 'dsh') invariant(this.ctx.llm?.listProviders().some(provider => provider.id === connection.provider), 'PROVIDER_UNAVAILABLE', 'The selected model API provider is not registered.');
    else { invariant(this.chatRuntimes.has(connection.runtime), 'PROVIDER_UNAVAILABLE', 'The selected native discussion runtime is not enabled.'); invariant(this.runtimeModels.get(connection.runtime)?.includes(connection.model), 'MODEL_UNVERIFIED', 'This native model has not passed the restricted tool-boundary probe.'); }
  }
  private executionBinding(workspaceId: string, providerName: string): string {
    this.store.workspace(workspaceId); this.refreshProviders();
    const provider = this.ctx.subagents.getProvider(providerName);
    invariant(provider && this.providerNames.has(providerName), 'PROVIDER_UNAVAILABLE', 'Choose an exact registered execution provider.');
    const bindingId = `${workspaceId}:execution:${providerName}`;
    if (!this.store.get('SELECT id FROM provider_bindings WHERE id=?', bindingId)) this.store.exec('INSERT INTO provider_bindings(id,workspace_id,provider_name,package_version,config_revision,capabilities,credential_refs,runtime,spawn) VALUES(?,?,?,?,1,?,?,?,?)', bindingId, workspaceId, providerName, '0.2.1-rc.3', JSON.stringify(provider.capabilities), '[]', providerName === 'spawn' ? 'dsh' : null, providerName === 'spawn' ? JSON.stringify({ provider: this.config.leadProvider, model: this.config.leadModel }) : null);
    return bindingId;
  }
  private configuredExecutionBinding(workspaceId: string, connection: ChatConnection): string {
    this.store.workspace(workspaceId);
    this.validateChatConnection(connection);
    const providerName = connection.runtime === 'dsh' ? 'spawn' : `rift-native-codex-${connection.model}`;
    this.refreshProviders();
    const provider = this.ctx.subagents.getProvider(providerName);
    invariant(provider, 'PROVIDER_UNAVAILABLE', 'The selected execution runtime is not available in this Host.');
    if (connection.runtime === 'codex' && connection.reasoningEffort) invariant(['low','medium','high','xhigh','max','ultra'].includes(connection.reasoningEffort), 'INVALID_CONFIG', 'Choose a supported Codex reasoning effort.');
    const saved = connection.runtime === 'dsh' ? this.connections.list().find(item => item.provider === connection.provider) : undefined;
    invariant(!saved || saved.model === connection.model, 'INVALID_CONFIG', 'Use the model configured for this API connection.');
    const binding: ProviderBinding = {
      id: `${workspaceId}:execution:${randomUUID()}`, providerName, packageVersion: '0.2.1-rc.3', configRevision: 1,
      capabilities: { ...provider.capabilities }, credentialRefs: connection.runtime === 'codex' ? ['native:codex'] : saved ? [`env:${saved.credentialRef}`] : [],
      runtime: connection.runtime, model: connection.model,
      ...(connection.runtime === 'dsh' ? { spawn: { provider: connection.provider!, model: connection.model, ...(connection.reasoningEffort ? { reasoningEffort: connection.reasoningEffort } : {}) } } : { reasoningEffort: connection.reasoningEffort ?? null }),
    };
    validateBinding(binding, this.providerNames);
    this.store.exec('INSERT INTO provider_bindings(id,workspace_id,provider_name,package_version,config_revision,capabilities,credential_refs,runtime,model,reasoning_effort,spawn) VALUES(?,?,?,?,?,?,?,?,?,?,?)', binding.id, workspaceId, binding.providerName, binding.packageVersion, binding.configRevision, JSON.stringify(binding.capabilities), JSON.stringify(binding.credentialRefs), binding.runtime!, binding.model!, binding.reasoningEffort ?? null, binding.spawn ? JSON.stringify(binding.spawn) : null);
    return binding.id;
  }
  private contextSnapshots(workspaceId: string, refs: ContextRef[]): ContextSnapshot[] {
    return refs.map(ref => {
      let value: unknown, version: number | null = null;
      if (ref.type === 'repository') value = this.repositories.get(workspaceId, ref.id);
      else if (ref.type === 'task') { const task = this.store.task(ref.id); invariant(this.store.workflow(task.workflowId).workspaceId === workspaceId, 'NOT_FOUND', 'Context task does not belong to this workspace.'); value = task; version = task.version; }
      else { const tree = this.store.get<{version?:number}>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND id=?', workspaceId, ref.id) ?? this.store.require<{version?:number}>('SELECT t.* FROM worktrees t JOIN tasks k ON k.id=t.task_id JOIN workflows f ON f.id=k.workflow_id WHERE f.workspace_id=? AND t.id=?', workspaceId, ref.id); value = tree; version = tree.version ?? null; }
      return { ref, version, content: redact(JSON.stringify(value), 16 * 1024) };
    });
  }
  private async startTextAnalysis(input: Parameters<ActivationBridge['start']>[0]) {
    const role=input.run.providerSnapshot.role as import('../project/browser-agents.js').BrowserAgent,binding=input.run.providerSnapshot.binding;
    const connection=bindingConnection(binding)??role.chatConnection;
    invariant(connection,'START_NOT_PUBLISHED','Configure a supported execution connection for this text-analysis Agent.');
    this.validateChatConnection(connection);
    const runtime:AgentRuntime=connection.runtime==='dsh'?new DshChatRuntime(this.ctx,connection.provider!):this.chatRuntimes.get(connection.runtime)!;
    const session=runtime.persistentSessions?nativeSession(this.store,{workspaceId:role.workspaceId,scope:'task',scopeId:input.task.id,agentId:role.id,cwd:input.cwd,configuration:{connection,mode:'text-analysis',prompt:role.prompt,skills:input.run.providerSnapshot.skillInstructions??'',tools:(input.tools??[]).map(({name,description,inputSchema})=>({name,description,inputSchema}))}}):undefined;
    const handle=await runtime.start({workspaceId:role.workspaceId,agentId:role.id,turnId:input.run.id,cwd:input.cwd,model:connection.model,reasoningEffort:connection.reasoningEffort,...session?{session:sessionCallbacks(this.store,session,input.run.id,input.cwd,input.onAccepted)}:{},instructions:`You are executing a registered text-only analysis task. Analyze only the supplied text, do not access files or delegate. The latest task envelope and runId supersede previous execution details.\n${role.prompt}\n${input.run.providerSnapshot.skillInstructions??''}`,messages:[{role:'user',content:input.prompt}],tools:input.tools??[],signal:input.signal});
    return{childId:`text-${input.run.id}`,dispose:()=>handle.dispose(),result:handle.result.then(result=>({stopReason:result.stopReason,text:JSON.stringify({schemaVersion:1,taskId:input.task.id,runId:input.run.id,outcome:'completed',summary:result.text,changedPaths:[],checksClaimed:[],blockingReasons:[]})}))};
  }
  private chatTools(turn: AgentTurn): RuntimeTool[] {
    const tools: RuntimeTool[] = [];
    const existing=this.store.get<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')",turn.workspaceId);
    const shortMode=Boolean(existing?this.orchestration.owner(existing.id):this.config.chatOrchestration!==false&&turn.configuration.agent.purpose==='lead');
    let calls=0,reads=0;
    const assertLive=()=>{const current=this.chat.turn(turn.workspaceId,turn.id);invariant(current.status==='running'&&current.agentId===turn.agentId&&this.store.get("SELECT id FROM execution_leases WHERE owner_type='turn' AND owner_id=? AND released_at IS NULL",turn.id),'UNAUTHORIZED','This Turn no longer owns an active execution lease.');};
    const activeWorkflow = () => this.store.require<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", turn.workspaceId);
    const register = (name: string, description: string, schema: z.ZodType, execute: (input: any) => unknown): void => {
      tools.push({ name, description, inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))), execute: async (args, signal) => {
        signal.throwIfAborted();
        assertLive();
        if(shortMode){calls++;reads=name==='rift_status'?reads+1:0;if(calls>(this.config.coordinationToolLimit??48)||reads>(this.config.coordinationStagnantLimit??12)){this.store.exec("UPDATE coordination_decisions SET error='COORDINATION_TOOL_BUDGET' WHERE turn_id=?",turn.id);this.store.exec("INSERT INTO turn_activities(turn_id,type,phase,summary,payload,created_at) VALUES(?,'coordination.limit','tool','Coordination tool budget exceeded.',?,?)",turn.id,JSON.stringify({reason:'COORDINATION_TOOL_BUDGET'}),new Date().toISOString());this.chat.stop(turn.workspaceId,turn.id);throw new RiftError('COORDINATION_TOOL_BUDGET','Coordination tool budget exceeded.');}}
        if(name!=='rift_send_message')this.orchestration.authorize(turn,name!=='rift_status');
        return JSON.parse(JSON.stringify(await execute(schema.parse(args)) ?? null, (_key, item) => typeof item === 'string' ? redact(item) : item));
      } });
    };
    const startWorkflow = async (goal: string, repositoryIds?: string[], mode: 'code'|'analysis' = 'code') => {
      const existing = this.store.get<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", turn.workspaceId);
      if (existing) { if(existing.baseCommit)await this.ensureLead(existing.id); assertLive();return existing; }
      const workspace = this.store.workspace(turn.workspaceId);
      invariant(mode==='analysis'||workspace.repositoryPath, 'REPOSITORY_REQUIRED', 'Connect a Git repository before requesting code work.');
      this.refreshProviders();
      if(mode==='code')for (const purpose of ['developer','reviewer']) invariant(this.store.all<{providerName:string}>("SELECT b.provider_name FROM roles r JOIN provider_bindings b ON b.id=r.provider_binding_id WHERE r.workspace_id=? AND r.purpose=? AND r.enabled=1", turn.workspaceId, purpose).some(row => this.providerNames.has(row.providerName)), 'ROLES_NOT_CONFIGURED', `Configure an executable ${purpose} before requesting code work.`);
      const workflow = await this.createChatWorkflow(turn,{workspaceId:turn.workspaceId,goal,mode,startLead:false,...(repositoryIds?{repositoryIds}:{})},assertLive);
      if(mode==='code')await this.ensureLead(workflow.id); assertLive();return workflow;
    };
    register('rift_status', 'Read this workspace and its current workflow. All scopes are fixed by the Host.', z.object({}).strict(), () => {
      const workflow = this.store.get<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", turn.workspaceId);
      return workflow ? {...this.coordinator.status(workflow.id),coordination:this.orchestration.owner(workflow.id)??null} : { workspace: this.store.workspace(turn.workspaceId), repositories: this.repositories.list(turn.workspaceId), roles: this.store.all('SELECT * FROM roles WHERE workspace_id=?', turn.workspaceId), workflow: null };
    });
    register('rift_send_message','Send a scoped message to one workspace member. Progress is recorded; questions and blockers queue a reply. Sending never claims acceptance or assigns a task.',sendCollaborationMessageSchema,input=>this.collaboration.send({type:'turn',id:turn.id},input));
    if (turn.configuration.agent.purpose !== 'lead') {
      register('rift_task_request', 'Register one task assigned to yourself and return its receipt. Use kind analysis without repositoryId for supplied-text analysis. End this discussion turn before the task can run; never wait for it here.', z.object({ goal: z.string().min(1).max(32000),kind:z.enum(['change','analysis']).default('change'), title: z.string().min(1).max(240), instructions: z.string().min(1).max(32000), expectedPaths: z.array(z.string()).max(100), repositoryId: z.string().min(1).max(160).optional(), acceptanceCriteria: z.array(z.string()).max(100).default([]) }).strict(), async input => {
        invariant(turn.configuration.agent.purpose === 'developer', 'ROLE_UNAVAILABLE', 'Only a developer can register a self-assigned change task.');
        const workflow = await startWorkflow(input.goal,input.repositoryId?[input.repositoryId]:undefined,input.kind==='analysis'&&!input.repositoryId?'analysis':'code'), role = this.store.role(turn.agentId);
        if(workflow.baseCommit)invariant(role.providerBindingId && this.providerNames.has(this.store.binding(role.providerBindingId).providerName), 'PROVIDER_UNAVAILABLE', 'This discussion member has no executable task binding.');
        const taskId = `task-${randomUUID()}`;
        this.coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: workflow.planRevision, tasks: [{ id: taskId, kind: input.kind, title: input.title, instructions: input.instructions, expectedPaths: input.expectedPaths, acceptanceCriteria: input.acceptanceCriteria, repositoryId: input.repositoryId, roleName: role.name }] });
        const request = this.coordinator.dispatch({ taskId, expectedVersion: 0, idempotencyKey: `${turn.id}:${taskId}` });
        return { taskId, requestId: request.id, workflowId: workflow.id, state: 'queued-until-discussion-releases-agent' };
      });
      return tools;
    }
    register('rift_delegate','Atomically assign an existing task or task draft to one developer, save its collaboration message, and persist dispatch. Returns task/request/message receipts. Do not wait for task completion here.',delegateSchema,input=>this.collaboration.delegate(turn,input));
    register('rift_workflow_start', 'Start or attach this workspace workflow. Use mode analysis for registered text-only tasks without Git; code mode selects repositoryIds explicitly when more than one is connected.', z.object({ goal: z.string().min(1).max(32000), mode:z.enum(['code','analysis']).default('code'), repositoryIds: z.array(z.string().min(1)).min(1).max(20).optional() }).strict(), input => startWorkflow(input.goal, input.repositoryIds,input.mode));
    const taskOwned = (taskId: string, workflowId: string) => invariant(this.store.task(taskId).workflowId === workflowId, 'CROSS_WORKFLOW', 'Task does not belong to this workspace workflow.');
    register('rift_plan_submit', 'Submit a durable dependency plan to the current workflow.', schemas.planSchema, input => this.collaboration.plan(turn,{ workflowId: activeWorkflow().id, ...schemas.planForCoordinator(input) }));
    register('rift_plan_replan', 'Update unstarted tasks using current versions.', schemas.replanSchema, input => { const workflowId = activeWorkflow().id; for (const update of input.updates) taskOwned(update.taskId, workflowId); return this.coordinator.replan({ workflowId, ...input }); });
    register('rift_task_dispatch', 'Queue an approved task. Returns a durable receipt.', schemas.dispatchSchema, input => { taskOwned(input.taskId, activeWorkflow().id); return this.collaboration.dispatch(turn,input); });
    if(!shortMode)register('rift_wait', 'Wait for this workflow task events; never infer completion without evidence.', schemas.waitSchema, input => this.coordinator.wait({ workflowId: activeWorkflow().id, ...input }));
    else register('rift_yield','Record durable handoff after dispatching this batch. Finish your final reply immediately; no more tools are allowed in this decision. Workflow events will resume the Lead after runtime cleanup.',z.object({summary:z.string().min(1).max(2000),taskIds:z.array(z.string().min(1)).max(100).default([]),requestIds:z.array(z.string().min(1)).max(100).default([])}).strict(),input=>this.orchestration.yield(turn,input));
    register('rift_task_retry', 'Retry this workflow task after cleanup and within repair limits.', schemas.retrySchema, input => { taskOwned(input.taskId, activeWorkflow().id); return this.coordinator.retry(input); });
    register('rift_integration_request', 'Request exact-commit checking and independent review.', schemas.integrationSchema, input => { taskOwned(input.taskId, activeWorkflow().id); return this.coordinator.requestIntegration(input); });
    register('rift_workflow_finish', 'Complete only when all registered tasks passed real acceptance gates.', schemas.finishSchema, input => this.coordinator.finish({ workflowId: activeWorkflow().id, ...input }));
    return tools;
  }
  private refreshProviders(): void { this.providerNames.clear(); for (const name of this.ctx.subagents.list()) this.providerNames.add(name); }
  private defaultMembers() {
    return [
      { name: 'developer-a', purpose: 'developer' as const, providerName: this.config.developerProvider ?? 'claude-code-dev', prompt: 'Implement only the supplied task in this worktree. Preserve other files. Return one JSON object matching resultSchema with exact taskId and runId.' },
      { name: 'reviewer', purpose: 'reviewer' as const, providerName: this.config.reviewerProvider ?? 'codex-review', prompt: 'Review the exact candidate commit read-only. Never edit or commit. Return one JSON object matching resultSchema; approve only when all acceptance criteria pass.' },
    ];
  }
  private defaults(workspaceId: string): void {
    this.refreshProviders();
    const members = this.defaultMembers();
    const bindings: ProviderBinding[] = [...new Set(members.map(member => member.providerName))].map(providerName => {
      const provider = this.ctx.subagents.getProvider(providerName);
      if (!provider) throw new RiftError('PROVIDER_UNAVAILABLE', `Profile is missing ${providerName}.`);
      return { id: `${workspaceId}:${providerName}`, providerName, packageVersion: '0.2.1-rc.3', configRevision: 1, capabilities: { ...provider.capabilities }, credentialRefs: providerName.startsWith('claude') ? ['native:claude', 'env:ANTHROPIC_API_KEY'] : providerName === 'spawn' ? ['env:DEEPSEEK_API_KEY'] : ['native:codex'], ...(providerName === 'spawn' ? { runtime: 'dsh' as const, spawn: { provider: this.config.leadProvider, model: this.config.leadModel } } : {}) };
    });
    this.project.configureRoles(workspaceId, bindings, [
      { name: 'lead', purpose: 'lead', kind: 'dsh-lead', prompt: 'Coordinate a durable plan, parallel independent developers and exact-commit acceptance. Do not claim success before workflow_finish succeeds.', revision: 1 },
      ...members.map(({ providerName, ...member }) => ({ ...member, kind: 'subagent' as const, providerBindingId: `${workspaceId}:${providerName}`, revision: 1 })),
    ]);
  }
  /** Attach the workflow's one live parent without requesting a model turn. */
  async ensureLead(workflowId: string): Promise<{ leadSessionId: string }> {
    if (this.closing) throw new RiftError('HOST_CLOSING', 'Host is closing.');
    let handle = this.leads.get(workflowId);
    const workflow = this.store.workflow(workflowId);
    if (['completed','cancelled','failed'].includes(workflow.status)) throw new RiftError('INVALID_STATE', 'Workflow is terminal.');
    if (!handle) {
      let pending = this.leadStarts.get(workflowId);
      if (!pending) {
        pending = (async () => {
          const repositoryAccess=await workspaceRepositoryAccess(this.store,workflow.workspaceId);
          const cwd=repositoryAccess?.repositoryPaths[0]??this.config.home;
          const stop=new AbortController();
          const chatOwned=!!this.orchestration.owner(workflowId);
          const shell=repositoryAccess&&!chatOwned?await createRepositoryShell(this.ctx.subprocess,{cwd,repositoryAccess,signal:stop.signal}):undefined;
          let underlying:AgentHandle;
          try { underlying=await this.ctx.agents.create({ sessionId: SessionId(`rift-lead-${randomUUID()}`), meta: { cwd }, agentOptions: { provider: this.config.leadProvider, model: this.config.leadModel }, setup: (scope, agent) => {
            installLeadTools(scope, agent, workflowId, this.coordinator);
            if(shell)scope.tools.register({name:shell.tool.name,description:shell.tool.description,parameters:shell.tool.inputSchema as ToolDefinition['parameters'],output:{schema:{},render:(_args,value)=>[{type:'text',text:redact(JSON.stringify(value))}]},execute:async(args,execution)=>{
              invariant(execution.agent===agent&&scope.agents.get(agent.id)===agent,'UNAUTHORIZED','Only this live Lead may execute repository commands.');
              invariant(!this.closing&&!this.orchestration.owner(workflowId)&&!['completed','cancelled','failed'].includes(this.store.workflow(workflowId).status),'INVALID_STATE','This Lead no longer owns an active workflow.');
              return shell.tool.execute(args,execution.signal);
            }});
          }}); } catch(error) {stop.abort();await shell?.dispose();throw error;}
          const created:AgentHandle={agent:underlying.agent,dispose:async()=>{stop.abort();try{await shell?.dispose();}finally{await underlying.dispose();}}};
          try {
            if (this.closing || ['completed','cancelled','failed'].includes(this.store.workflow(workflowId).status)) throw new RiftError('HOST_CLOSING', 'Lead attachment is no longer admitted.');
            this.store.transaction(() => { this.store.exec('UPDATE workflows SET lead_session_id=? WHERE id=?',created.agent.id,workflowId); this.store.event(workflowId,'lead.attached',{sessionId:created.agent.id}); });
            this.leads.set(workflowId, created);
            return created;
          } catch (error) { await created.dispose(); throw error; }
        })();
        this.leadStarts.set(workflowId, pending);
      }
      try { handle = await pending; }
      finally { if (this.leadStarts.get(workflowId) === pending) this.leadStarts.delete(workflowId); }
    }
    return { leadSessionId: handle.agent.id };
  }
  async startLead(workflowId: string, instruction?: string): Promise<{ leadSessionId: string }> {
    if(this.orchestration.owner(workflowId)){
      const workflow=this.store.workflow(workflowId);invariant(!['completed','cancelled','failed'].includes(workflow.status),'INVALID_STATE','Workflow is terminal.');
      if(workflow.baseCommit)await this.ensureLead(workflowId);
      this.orchestration.wake(workflowId,`manual:${randomUUID()}`,instruction??'Explicit Lead wake requested. Inspect current workflow status.',true);
      await this.orchestration.pump();return {leadSessionId:workflow.leadSessionId??`chat:${this.orchestration.owner(workflowId)!.conversationId}`};
    }
    if (!this.ctx.llm.listProviders().some(provider => provider.id === this.config.leadProvider)) throw new RiftError('LEAD_PROVIDER_UNAVAILABLE', `Profile is missing Lead provider ${this.config.leadProvider}. Inspect doctor and the registered model routes.`);
    const attached = await this.ensureLead(workflowId);
    const handle = this.leads.get(workflowId)!;
    const workflow = this.store.workflow(workflowId);
    if (this.closing || ['completed','cancelled','failed'].includes(workflow.status)) throw new RiftError('INVALID_STATE', 'Workflow no longer accepts Lead input.');
    const leadRole = this.store.require<{prompt:string}>("SELECT prompt FROM roles WHERE workspace_id=? AND purpose='lead' AND enabled=1", workflow.workspaceId);
    const prompt = `You are the RIFT Lead for workflow ${workflowId}. Goal: ${workflow.goal}\nUse RIFT tools for durable coordination and the repository shell for user-requested Git commits and authenticated PR commands. First inspect status. Submit a small explicit DAG and expected write paths. Read configured roles and global limits from status; dispatch independent tasks up to the available developer budget BEFORE waiting and queue additional requested tasks. Use plan_replan with current versions to update unstarted task dependencies or priority. Batch analysis may use analysisItems; write tasks must remain registered change tasks. Use returned versions and request IDs. Wait for any results using the cursor, then handle blocked tasks or retry with context (maximum two repairs). Development automatically queues integration. All candidate checks and reviews are enforced by RIFT. Never finish until workflow_finish accepts. Do not invent execution evidence. If blocked by credentials or unknown cleanup, explain the blocker and stop.\n${instruction ?? ''}`;
    handle.agent.followup({ id: MessageId(randomUUID()), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${leadRole.prompt}\n${prompt}` }] });
    return attached;
  }
  async handle(method: string, pathname: string, body: unknown, key?: string): Promise<unknown> {
    if (this.closing) throw new RiftError('HOST_CLOSING','Host is closing.');
    if (method === 'GET') return this.route(method, pathname, body);
    if (!key) throw new RiftError('IDEMPOTENCY_KEY_REQUIRED','Write requests require a key.');
    const fingerprint = createHash('sha256').update(JSON.stringify([method,pathname,body])).digest('hex');
    const prior = this.store.get<{fingerprint:string;status:string;response:string|null}>('SELECT * FROM management_requests WHERE key=?',key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new RiftError('IDEMPOTENCY_CONFLICT','Key belongs to a different request.');
      if (prior.status === 'pending') throw new RiftError('OUTCOME_UNKNOWN','Previous request is pending or interrupted; inspect status before retrying with a new key.');
      const value = JSON.parse(prior.response!);
      if (prior.status === 'failed') throw new RiftError(value.code,value.message);
      return value;
    }
    this.store.exec('INSERT INTO management_requests(key,fingerprint,status) VALUES(?,?,?)',key,fingerprint,'pending');
    try {
      const value = await this.route(method,pathname,body);
      this.store.exec('UPDATE management_requests SET status=?,response=? WHERE key=?','completed',JSON.stringify(value ?? null,(_key,item)=>typeof item==='string'?redact(item):item),key);
      return value;
    } catch (error) { this.store.exec('UPDATE management_requests SET status=?,response=? WHERE key=?','failed',JSON.stringify(publicError(error)),key); throw error; }
  }
  /** Explicit browser allowlist; never forward arbitrary management paths. */
  async handleBrowser(method: string, pathname: string, body: unknown, key?: string): Promise<unknown> {
    invariant(this.config.uiEnabled!==false,'NOT_FOUND','Browser UI is disabled.');
    return this.handle(method, pathname, body, key ? `browser:${key}` : undefined);
  }
  private async routeBrowser(method: string, pathname: string, body: unknown): Promise<unknown> {
    if (this.closing) throw new RiftError('HOST_CLOSING', 'Host is closing.');
    const url = new URL(pathname, 'http://127.0.0.1'); pathname = url.pathname;
    if(method==='POST'&&pathname==='/ui-api/v1/connections')return this.connections.create(body);
    const connectionVerify=/^\/ui-api\/v1\/connections\/([^/]+)\/verify$/.exec(pathname);
    if(method==='POST'&&connectionVerify){z.object({}).strict().parse(body);return this.connections.verify(decodeURIComponent(connectionVerify[1]!));}
    if (method === 'GET' && pathname === '/ui-api/v1/connections') return { savedConnections: this.connections.list(), configuration: this.connections.configurationCapability(), executionProviders: this.ctx.subagents.list().map(name => ({ name, capabilities: this.ctx.subagents.getProvider(name)?.capabilities ?? {}, authentication: 'not-verified' })), connections: [...(this.ctx.llm?.listProviders() ?? []).map(provider => ({ id: `dsh:${provider.id}`, runtime: 'dsh', provider: provider.id, available: true, authentication: 'not-verified', modelSelection: 'explicit', models: [], executionAvailable: Boolean(this.ctx.subagents.getProvider('spawn')?.capabilities.agentOptions), tools: true, streaming: false, output: 'buffered-for-redaction' })), { id: 'codex', runtime: 'codex', available: this.chatRuntimes.has('codex'), authentication: 'not-verified', modelSelection: 'verified-only', models: this.runtimeModels.get('codex') ?? [], executionAvailable: VERIFIED_NATIVE_CODEX_MODELS.every(model => Boolean(this.ctx.subagents.getProvider(`rift-native-codex-${model}`))), disabledReason: this.chatRuntimes.has('codex') ? null : this.nativeRuntimeUnavailable, tools: true, streaming: false, output: 'buffered-for-redaction' }] };
    if (method === 'GET' && pathname === '/ui-api/v1/workspaces') return workspaceList(this.store);
    const match = /^\/ui-api\/v1\/workspaces\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && match) {
      this.refreshProviders();
      return workspaceDetail(this.store, decodeURIComponent(match[1]!), this.providerNames, { provider: this.config.leadProvider, model: this.config.leadModel });
    }
    if (method === 'POST' && pathname === '/ui-api/v1/workspaces') {
      const input = z.object({ name: z.string().trim().min(1).max(120), repositoryPath: z.string().min(1).optional(), baseRef: z.string().min(1).optional(), leadConnection: connectionSchema.optional() }).strict().parse(body);
      if (input.leadConnection) this.validateChatConnection(input.leadConnection);
      let workspace: import('../contracts/index.js').Workspace;
      if (input.repositoryPath) workspace = await this.route('POST', '/v1/workspaces', { name: input.name, repositoryPath: input.repositoryPath, baseRef: input.baseRef ?? 'HEAD' }) as typeof workspace;
      else {
        invariant(!input.baseRef, 'INVALID_WORKSPACE', 'A base ref requires a repository.');
        const id = `workspace-${randomUUID()}`;
        workspace = this.store.transaction(() => {
          this.store.exec('INSERT INTO workspaces(id,name,root_path,status) VALUES(?,?,?,?)', id, input.name, path.join(this.config.home, 'workspaces', id), 'active');
          this.store.exec("INSERT INTO roles(id,workspace_id,name,purpose,kind,prompt,revision,display_name) VALUES(?,?,'lead','lead','dsh-lead',?,1,?)", `${id}:lead`, id, 'Help the user discuss and plan. Register all code work through RIFT tools; never bypass acceptance gates.', '主 Agent');
          // A discussion-only Host may have no execution providers yet.
          // Bind registered providers when available; otherwise retain inert discussion members.
          for (const { providerName, ...member } of this.defaultMembers()) createBrowserAgent(this.store, id, {
            ...member, displayName: member.name, chatConnection: null,
            ...(this.ctx.subagents.list().includes(providerName) ? { providerBindingId: this.executionBinding(id, providerName) } : {}),
          });
          return this.store.workspace(id);
        });
      }
      if (input.leadConnection) this.store.exec('UPDATE workspaces SET lead_connection=?,version=version+1 WHERE id=?', JSON.stringify(input.leadConnection), workspace.id);
      this.chat.createConversation(workspace.id);
      return this.store.workspace(workspace.id);
    }
    const archiveWorkspace=/^\/ui-api\/v1\/workspaces\/([^/]+)\/archive$/.exec(pathname);
    if(archiveWorkspace&&method==='POST'){z.object({}).strict().parse(body);return this.route('POST',`/v1/workspaces/${archiveWorkspace[1]}/archive`,{});}
    const retryDelivery=/^\/ui-api\/v1\/workspaces\/([^/]+)\/messages\/([^/]+)\/retry-delivery$/.exec(pathname);
    if(retryDelivery&&method==='POST'){z.object({}).strict().parse(body);return this.collaboration.retryDelivery(decodeURIComponent(retryDelivery[1]!),decodeURIComponent(retryDelivery[2]!));}
    const taskList=/^\/ui-api\/v1\/workspaces\/([^/]+)\/tasks$/.exec(pathname);
    if(taskList&&method==='GET')return workspaceTasks(this.store,decodeURIComponent(taskList[1]!),url.searchParams);
    const repositoryRoute = /^\/ui-api\/v1\/workspaces\/([^/]+)\/repositories(?:\/([^/]+)(?:\/(worktrees))?)?$/.exec(pathname);
    if (repositoryRoute) {
      const workspaceId = decodeURIComponent(repositoryRoute[1]!), repositoryId = repositoryRoute[2] ? decodeURIComponent(repositoryRoute[2]) : undefined;
      if (!repositoryId && method === 'GET') return { repositories: this.repositories.list(workspaceId) };
      if (!repositoryId && method === 'POST') return this.repositories.connect(workspaceId, z.object({ repositoryPath: z.string().min(1), baseRef: z.string().min(1).default('HEAD'), expectedVersion: z.number().int().nonnegative() }).strict().parse(body));
      if (repositoryId && repositoryRoute[3] === 'worktrees' && method === 'GET') return { worktrees: this.repositories.worktrees(workspaceId, repositoryId), discovered: await this.repositories.discover(workspaceId, repositoryId) };
      if (repositoryId && repositoryRoute[3] === 'worktrees' && method === 'POST') return this.repositories.createWorktree(workspaceId, repositoryId, z.object({ origin: z.enum(['managed','external']), path: z.string().min(1).optional(), baseRef: z.string().min(1).optional(), branch: z.string().min(1).max(200).optional() }).strict().parse(body));
    }
    const worktreeRoute = /^\/ui-api\/v1\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/(archive|detach|takeover|reconcile)$/.exec(pathname);
    if (worktreeRoute && method === 'POST') {
      const workspaceId=decodeURIComponent(worktreeRoute[1]!),treeId=decodeURIComponent(worktreeRoute[2]!);
      if(worktreeRoute[3]==='takeover')return this.repositories.takeover(workspaceId,treeId,z.object({expectedVersion:z.number().int().nonnegative(),confirmExclusiveOwnership:z.literal(true),destinationPath:z.string().min(1).optional()}).strict().parse(body));
      const input = z.object({ expectedVersion: z.number().int().nonnegative() }).strict().parse(body); if(worktreeRoute[3]==='reconcile')return this.repositories.reconcile(workspaceId,treeId,input.expectedVersion);return this.repositories[worktreeRoute[3] === 'archive' ? 'archive' : 'detach'](workspaceId,treeId,input.expectedVersion);
    }
    const taskRoute=/^\/ui-api\/v1\/workspaces\/([^/]+)\/tasks\/([^/]+)(?:\/(retry|evidence))?$/.exec(pathname);
    const runReconcile=/^\/ui-api\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/reconcile$/.exec(pathname);
    if(runReconcile&&method==='POST'){const workspaceId=decodeURIComponent(runReconcile[1]!),runId=decodeURIComponent(runReconcile[2]!),run=this.store.run(runId);invariant(this.store.workflow(this.store.task(run.taskId).workflowId).workspaceId===workspaceId,'NOT_FOUND','Run does not belong to this workspace.');this.coordinator.reconcileRun(runId,z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body).expectedVersion);return this.store.require('SELECT id,task_id,status,version,cleanup_status,slot_released_at FROM runs WHERE id=?',runId);}
    const integrationReconcile=/^\/ui-api\/v1\/workspaces\/([^/]+)\/integrations\/([^/]+)\/reconcile$/.exec(pathname);
    if(integrationReconcile&&method==='POST'){const workspaceId=decodeURIComponent(integrationReconcile[1]!),integrationId=decodeURIComponent(integrationReconcile[2]!),integration=this.store.require<{taskId:string}>('SELECT task_id FROM integrations WHERE id=?',integrationId);invariant(this.store.workflow(this.store.task(integration.taskId).workflowId).workspaceId===workspaceId,'NOT_FOUND','Integration does not belong to this workspace.');return this.coordinator.reconcileIntegration(integrationId,z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body).expectedVersion);}
    if(taskRoute){
      const workspaceId=decodeURIComponent(taskRoute[1]!),taskId=decodeURIComponent(taskRoute[2]!),task=this.store.task(taskId);
      invariant(this.store.workflow(task.workflowId).workspaceId===workspaceId,'NOT_FOUND','Task does not belong to this workspace.');
      if(method==='GET'&&!taskRoute[3])return{...task,dependsOn:this.store.all<{dependsOnTaskId:string}>('SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id',task.id).map(row=>row.dependsOnTaskId)};
      if(method==='POST'&&taskRoute[3]==='retry'){
        const workflow=this.store.workflow(task.workflowId);if(workflow.baseCommit)await this.ensureLead(workflow.id);
        const retried=await this.route('POST',`/v1/tasks/${encodeURIComponent(taskId)}/retry`,body) as import('../contracts/index.js').Task;
        const request=this.coordinator.dispatch({taskId,expectedVersion:retried.version,idempotencyKey:`browser-retry:${taskId}:${retried.attempt}`});
        return{task:this.store.task(taskId),request};
      }
      if(method==='GET'&&taskRoute[3]==='evidence'){
        const records=this.store.all<{id:string;status:string;candidate:unknown}>('SELECT id,status,candidate FROM integrations WHERE task_id=? ORDER BY rowid',taskId);
        const integrations=await Promise.all(records.map(async record=>{if(!record.candidate)return{...record,checks:[],review:null,evidenceUnavailable:true};try{const operation=await this.git.readOperation(this.store.workspace(workspaceId),record.id);return{id:record.id,status:record.status,candidateHead:operation.candidateHead,checks:operation.checks??[],review:operation.review??null,evidenceUnavailable:false};}catch{return{id:record.id,status:record.status,checks:[],review:null,evidenceUnavailable:true};}}));
        return{taskId,acceptedCommit:task.acceptedCommit,integrations};
      }
    }
    const skillRoute = /^\/ui-api\/v1\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?(?:\/(shared|archive))?$/.exec(pathname);
    if (skillRoute) {
      const workspaceId = decodeURIComponent(skillRoute[1]!), skillId = skillRoute[2] ? decodeURIComponent(skillRoute[2]) : undefined, action = skillRoute[3];
      if (method === 'GET' && !skillId) return { skills: this.skills.list(workspaceId) };
      if (method === 'POST' && skillId === 'preview') return this.skills.previewImport({ workspaceId, ...z.object({ directory: z.string().min(1), name: z.string().max(120).optional(), description: z.string().max(2000).optional(), skillId: z.string().max(160).optional(), expectedRevision: z.number().int().nonnegative().optional(), runtimes: z.array(z.string()).max(20).optional() }).strict().parse(body) });
      if (method === 'POST' && skillId === 'import') {
        const result = this.skills.saveImport({ workspaceId, ...z.object({ previewId: z.string().min(1).max(160) }).strict().parse(body) });
        return { ...result, version: { ...result.version, resources: result.version.resources.map(({ contentBase64: _content, ...resource }) => resource) } };
      }
      if (method === 'PUT' && skillId && action === 'shared') return this.skills.setShared(workspaceId, skillId, z.object({ versionId: z.string().min(1).max(160), enabled: z.boolean(), expectedRevision: z.number().int().nonnegative() }).strict().parse(body));
      if (method === 'POST' && skillId && action === 'archive') return this.skills.archive(workspaceId, skillId, z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(body).expectedRevision);
    }
    const assignmentRoute = /^\/ui-api\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)\/skills\/([^/]+)$/.exec(pathname);
    if (assignmentRoute) {
      const workspaceId = decodeURIComponent(assignmentRoute[1]!), agentId = decodeURIComponent(assignmentRoute[2]!), skillId = decodeURIComponent(assignmentRoute[3]!);
      if (method === 'GET' && skillId === 'effective') { const effective = this.skills.resolveEffective(workspaceId, agentId, url.searchParams.get('runtime') ?? 'dsh'); return { ...effective, resources: effective.resources.map(({ contentBase64: _content, ...resource }) => resource) }; }
      if (method === 'PUT') return this.skills.setAgent(workspaceId, agentId, skillId, z.object({ mode: z.enum(['include','exclude','inherit']), versionId: z.string().min(1).max(160).optional(), expectedRevision: z.number().int().nonnegative() }).strict().parse(body));
    }
    const scoped = /^\/ui-api\/v1\/workspaces\/([^/]+)(?:\/(agents|conversations|turns|workflows|snapshot)(?:\/([^/]+))?(?:\/(messages|stop|reconcile|pause|resume|cancel|retry|replan))?)?$/.exec(pathname);
    if (scoped) {
      const workspaceId = decodeURIComponent(scoped[1]!), section = scoped[2], entityId = scoped[3] ? decodeURIComponent(scoped[3]) : undefined, action = scoped[4];
      this.store.workspace(workspaceId);
      if (method === 'PATCH' && !section) {
        const input = z.object({ expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(120).optional(), leadConnection: connectionSchema.optional() }).strict().parse(body);
        if (input.leadConnection) this.validateChatConnection(input.leadConnection);
        return this.store.transaction(() => {
          const workspace = this.store.workspace(workspaceId) as import('../contracts/index.js').Workspace & { version: number; leadConnection: ChatConnection | null };
          invariant(workspace.version === input.expectedVersion, 'VERSION_CONFLICT', 'Workspace configuration changed.');
          this.store.exec('UPDATE workspaces SET name=?,lead_connection=?,version=version+1 WHERE id=?', input.name ?? workspace.name, input.leadConnection ? JSON.stringify(input.leadConnection) : workspace.leadConnection ? JSON.stringify(workspace.leadConnection) : null, workspaceId);
          return this.store.workspace(workspaceId);
        });
      }
      if (section === 'snapshot' && method === 'GET') return this.routeBrowser('GET', `/ui-api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {});
      if (section === 'agents') {
        if (method === 'GET' && !entityId) return { agents: this.store.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY name', workspaceId) };
        if (method === 'POST' && !entityId) { const input = createAgentSchema.parse(body); if (input.chatConnection) this.validateChatConnection(input.chatConnection); invariant([input.executionConnection, input.executionProviderName, input.providerBindingId].filter(Boolean).length <= 1, 'INVALID_CONFIG', 'Select one execution connection.'); return this.store.transaction(() => createBrowserAgent(this.store, workspaceId, { ...input, ...(input.executionConnection ? { providerBindingId: this.configuredExecutionBinding(workspaceId, input.executionConnection) } : input.executionProviderName ? { providerBindingId: this.executionBinding(workspaceId, input.executionProviderName) } : {}) })); }
        if (method === 'PATCH' && entityId) { const input = updateAgentSchema.parse(body); if (input.chatConnection) this.validateChatConnection(input.chatConnection); invariant([input.executionConnection, input.executionProviderName, input.providerBindingId].filter(Boolean).length <= 1, 'INVALID_CONFIG', 'Select one execution connection.'); return this.store.transaction(() => updateBrowserAgent(this.store, workspaceId, entityId, { ...input, ...(input.executionConnection ? { providerBindingId: this.configuredExecutionBinding(workspaceId, input.executionConnection) } : input.executionProviderName ? { providerBindingId: this.executionBinding(workspaceId, input.executionProviderName) } : {}) })); }
      }
      if (section === 'conversations') {
        if (method === 'GET' && !entityId) return { conversations: this.chat.list(workspaceId) };
        if (method === 'POST' && !entityId) return this.chat.createConversation(workspaceId, z.object({ title: z.string().trim().min(1).max(240).default('新对话') }).strict().parse(body).title);
        if (entityId && action === 'messages' && method === 'GET') return this.chat.page(workspaceId, entityId, url.searchParams.get('before') ?? undefined, Number(url.searchParams.get('limit') ?? 50));
        if (entityId && action === 'messages' && method === 'POST') return this.chat.send(workspaceId, entityId, sendMessageSchema.parse(body));
      }
      if (section === 'turns' && entityId && action === 'stop' && method === 'POST') return this.chat.stop(workspaceId, entityId);
      if (section === 'turns' && entityId && action === 'reconcile' && method === 'POST') return this.chat.reconcile(workspaceId, entityId, z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body).expectedVersion);
      if (section === 'turns' && entityId && !action && method === 'GET') return this.chat.turn(workspaceId, entityId);
      if (section === 'workflows' && entityId && action && method === 'POST') { const workflow=this.store.workflow(entityId); invariant(workflow.workspaceId === workspaceId, 'NOT_FOUND', 'Workflow does not belong to this workspace.'); if(action==='resume'&&workflow.baseCommit)await this.ensureLead(entityId); return this.route(method, `/v1/workflows/${encodeURIComponent(entityId)}/${action}`, body); }
    }
    throw new RiftError('NOT_FOUND', 'Unknown browser route.');
  }
  private async createChatWorkflow(turn:AgentTurn|undefined,body:unknown,assertLive:()=>void=()=>{}):Promise<Workflow> {
      const create=(input:Parameters<TaskCoordinator['createWorkflow']>[0])=>this.store.transaction(()=>{assertLive();const workflow=this.coordinator.createWorkflow(input);if(turn&&this.config.chatOrchestration!==false&&turn.configuration.agent.purpose==='lead')this.orchestration.bind(workflow.id,turn);return workflow;});
      const input = schemas.workflowSchema.parse(body), workspace = this.store.workspace(input.workspaceId), available = this.repositories.list(workspace.id), id = `workflow-${randomUUID()}`;
      if(input.mode==='analysis'){
        invariant(!input.repositoryIds,'INVALID_REPOSITORIES','Text-only analysis does not select repositories.');
        assertLive();
        const workflow=create({id,workspaceId:workspace.id,goal:input.goal,baseCommit:'',integrationRef:'',repositoryFree:true});
        if(input.startLead)await this.startLead(workflow.id);
        return this.store.workflow(workflow.id);
      }
      invariant(available.length, 'REPOSITORY_REQUIRED', 'Connect a repository before starting a workflow.');
      invariant(input.repositoryIds || available.length === 1, 'AMBIGUOUS_REPOSITORY', 'Specify repositoryIds when this workspace has multiple repositories.');
      const selected = input.repositoryIds ? input.repositoryIds.map(repositoryId => this.repositories.get(workspace.id, repositoryId)) : available;
      const snapshots = await Promise.all(selected.map(async repository => ({ repositoryId: repository.id, baseCommit: (await this.git.inspectRepository(repository.canonicalPath, repository.baseRef)).baseCommit, integrationRef: `refs/heads/rift/${workspace.id}/${id}${selected.length > 1 ? `/${repository.id}` : ''}` })));
      assertLive();
      const workflow = create({ id,workspaceId:workspace.id,goal:input.goal,baseCommit:snapshots[0]!.baseCommit,integrationRef:snapshots[0]!.integrationRef,repositorySnapshots:snapshots });
      if (input.startLead) await this.startLead(id);
      return this.store.workflow(workflow.id);
  }
  private async route(method:string, pathname:string, body:unknown):Promise<unknown> {
    if (pathname.startsWith('/ui-api/')) return this.routeBrowser(method, pathname, body);
    if (method === 'GET' && pathname === '/v1/doctor') return this.doctor();
    if (method === 'GET' && pathname === '/v1/workspaces') return this.store.all('SELECT * FROM workspaces ORDER BY id');
    if (method === 'POST' && pathname === '/v1/workspaces') {
      const input = schemas.workspaceSchema.parse(body), repo = await this.git.inspectRepository(input.repositoryPath,input.baseRef), id = `workspace-${randomUUID()}`;
      const workspace = this.store.transaction(() => { const workspace = this.project.createWorkspace({ id,name:input.name,rootPath:path.join(this.config.home,'workspaces',id),repositoryPath:repo.rootPath,commonGitDir:repo.commonGitDir,baseRef:input.baseRef }); this.defaults(id); return workspace; });
      return workspace;
    }
    if (method === 'POST' && pathname === '/v1/workflows') return this.createChatWorkflow(undefined,body);
    const match = /^\/v1\/(workspaces|workflows|tasks|runs)\/([^/]+)(?:\/(roles|plan|replan|dispatch|integration|retry|recover-source|cancel|pause|resume|lead|finish|wait|logs|archive|report))?$/.exec(pathname);
    if (!match) throw new RiftError('NOT_FOUND','Unknown management route.');
    const [,entity,rawId,action] = match; const id = decodeURIComponent(rawId);
    if (entity === 'workspaces') {
      if (method === 'PUT' && action === 'roles') { const input = schemas.rolesSchema.parse(body); this.refreshProviders(); return this.project.configureRoles(id,input.bindings,input.roles); }
      if (method === 'POST' && action === 'archive') {
        const workspace = this.store.workspace(id);
        if(workspace.status==='archived')return workspace;
        invariant(!this.store.get("SELECT id FROM workspace_worktrees WHERE workspace_id=? AND status IN ('creating','creation_unknown','moving','move_unknown')",id),'WORKSPACE_ACTIVE','Reconcile unfinished worktree operations before archiving.');
        invariant(!this.store.get("SELECT id FROM agent_turns WHERE workspace_id=? AND status IN ('queued','running','stopping')", id) && !this.store.get('SELECT id FROM execution_leases WHERE workspace_id=? AND released_at IS NULL', id), 'WORKSPACE_ACTIVE', 'Finish or stop queued discussions and confirm all execution cleanup before archiving.');
        if (this.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','cancelled','failed')",id)) throw new RiftError('WORKSPACE_ACTIVE','Finish or cancel the active workflow first.');
        const trees=this.store.all<Worktree>('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=?',id);
        for(const worktree of trees) {const unknown=Boolean(this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',worktree.taskId));const task=this.store.task(worktree.taskId),repository=task.repositoryId?this.repositories.get(id,task.repositoryId):undefined;await this.git.archiveWorktree({workspace:repository?{...workspace,repositoryPath:repository.canonicalPath,commonGitDir:repository.commonGitDir,baseRef:repository.baseRef}:workspace,worktree,active:unknown,cleanupConfirmed:!unknown,artifactsSaved:true});}
        this.store.exec('UPDATE workspaces SET status=? WHERE id=?','archived',id); return this.store.workspace(id);
      }
    }
    if (entity === 'workflows') {
      if (method === 'GET' && !action) return this.coordinator.status(id);
      if (method === 'GET' && action === 'report') { const report=this.coordinator.status(id);const folder=path.join(this.config.home,'workspaces',report.workflow.workspaceId,'reports');await mkdir(folder,{recursive:true});const file=path.join(folder,`${id}.json`);await writeFile(file,JSON.stringify(report,(_key,item)=>typeof item==='string'?redact(item):item,2));return{file,report}; }
      if (method === 'POST' && action === 'plan') return this.coordinator.submitPlan({workflowId:id,...schemas.planForCoordinator(schemas.planSchema.parse(body))});
      if (method === 'POST' && action === 'replan') return this.coordinator.replan({workflowId:id,...schemas.replanSchema.parse(body)});
      if (method === 'POST' && action === 'wait') return this.coordinator.wait({workflowId:id,...schemas.waitSchema.parse(body)});
      if (method === 'POST' && action === 'finish') return this.coordinator.finish({workflowId:id,...schemas.finishSchema.parse(body)});
      if (method === 'POST' && action === 'cancel') {
        let leadError: unknown;
        try { await this.leads.get(id)?.agent.cancel({kind:'user'} as Parameters<Agent['cancel']>[0]); } catch (error) { leadError = error; }
        const result = await this.coordinator.cancelWorkflow(id);
        if (leadError) {
          this.store.event(id,'lead.cancel_failed',{error:publicError(leadError)});
          throw new RiftError('LEAD_CANCEL_FAILED','Workflow work was cancelled, but Lead cancellation could not be confirmed.');
        }
        return result;
      }
      if (method === 'POST' && (action === 'pause'||action === 'resume')) {const input=z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body); if(action==='resume'&&this.store.workflow(id).baseCommit&&!this.leads.has(id))throw new RiftError('LIVE_LEAD_REQUIRED','Attach a new Lead before resuming queues.');return this.coordinator[action](id,input.expectedVersion);}
      if (method === 'POST' && action === 'lead') return this.startLead(id,z.object({instruction:z.string().trim().min(1).max(16000).optional()}).strict().parse(body).instruction);
    }
    if (entity === 'tasks') {
      if (method === 'GET' && !action) return this.store.task(id);
      if (method === 'POST' && action === 'dispatch') return this.coordinator.dispatch(schemas.dispatchSchema.parse({...body as object,taskId:id}));
      if (method === 'POST' && action === 'integration') return this.coordinator.requestIntegration(schemas.integrationSchema.parse({...body as object,taskId:id}));
      if (method === 'POST' && action === 'retry') return this.coordinator.retry(schemas.retrySchema.parse({...body as object,taskId:id}));
      if (method === 'POST' && action === 'recover-source') return this.coordinator.recoverSource(schemas.recoverSourceSchema.parse({...body as object,taskId:id}));
      if (method === 'POST' && action === 'cancel') return this.coordinator.cancelTask(id);
    }
    if (entity === 'runs') {
      if (method === 'GET' && !action) return this.store.run(id);
      if (method === 'GET' && action === 'logs') {const run=this.store.run(id);return this.store.events(this.store.task(run.taskId).workflowId).filter(event=>event.runId===id);}
      if (method === 'POST' && action === 'cancel') return this.coordinator.cancelRun(id);
    }
    throw new RiftError('NOT_FOUND','Unknown management route.');
  }
  doctor() {
    return {
      version:'0.1.0',node:process.version,dsh:'0.2.1-rc.3',
      lead:{provider:this.config.leadProvider,model:this.config.leadModel,registered:this.ctx.llm?.listProviders().some(provider=>provider.id===this.config.leadProvider)??false},
      providers:this.ctx.subagents.list().map(name=>({name,capabilities:this.ctx.subagents.getProvider(name)?.capabilities})),
      configuration:{credentialReferences:['env:DEEPSEEK_API_KEY','env:ANTHROPIC_API_KEY','native:claude','native:codex'],environmentPresence:{deepseekApiKey:Boolean(process.env.DEEPSEEK_API_KEY),anthropicApiKey:Boolean(process.env.ANTHROPIC_API_KEY)}},
      authentication:{deepseek:'not-verified',claude:'not-verified',codex:'not-verified',verification:'Provider registration, environment-variable presence and an open Desktop app do not verify authentication or model access. Check a real activation probe for the configured instance.'},
      limits:{...this.coordinator.limits,workflowsPerWorkspace:1,reviewers:1},
      unconfirmedRuns:this.store.all("SELECT id,task_id,status,cleanup_status FROM runs WHERE slot_released_at IS NULL"),
      interruptedRequests:this.store.all("SELECT key,status FROM management_requests WHERE status='pending'"),
      restrictions:['External providers use one-shot activations.','Reviewer permission never inherits native sandbox; independent checkout and mutation gate enforce acceptance.','Authentication and model availability require real activation evidence; doctor does not run a model.'],
    };
  }
  async close():Promise<void>{this.closing=true;this.orchestration.close();this.collaboration.close();await this.chat.close();await this.coordinator.shutdown();await this.connections.close();await Promise.allSettled([...this.leadStarts.values()]);await Promise.allSettled([...this.leads.values()].map(handle=>handle.dispose()));for (const dispose of this.executionProviderDisposers.splice(0)) dispose();this.store.close();}
}
