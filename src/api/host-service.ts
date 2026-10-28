import { observeNativeRun } from '../task/run-progress.js';
import { ApplicationCommands } from '../application/commands.js';
import { resolveHttpCommand } from './command-routes.js';
import { skillResourceTools } from '../skill/resource-tool.js';
import { installedSkills } from '../skill/runtime.js';
import { WorkspaceCommands, cliEnvelope } from '../application/workspace-commands.js';
import { installWorkspaceSkill } from '../skill/default.js';
import { workspaceRepositoryAccess } from '../agent/repository-access.js';
import { createRepositoryShell } from '../agent/repository-shell.js';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { RiftStore } from '../storage/database.js';
import { ProjectService } from '../project/index.js';
import { TaskCoordinator } from '../task/coordinator.js';
import { DshActivationBridge } from '../task/activation-bridge.js';
import { LocalGitService } from '../git/integration.js';
import type { CheckCommand } from '../git/types.js';
import { RiftError, type ProviderBinding, type Workflow } from '../contracts/index.js';
import { installLeadTools } from '../tools/rift-tools.js';
import * as schemas from './schemas.js';
import { publicError, redact } from './security.js';
import type { ApiHandler } from './local-api.js';
import { ChatService } from '../chat/service.js';
import { DshChatRuntime } from '../chat/dsh-runtime.js';
import type { AgentRuntime, RuntimeTool } from '../agent/runtime-types.js';
import type { AgentTurn, ChatConnection, ContextRef, ContextSnapshot } from '../chat/contracts.js';
import { createBrowserAgent } from '../project/browser-agents.js';
import { invariant } from '../contracts/index.js';
import { SkillService } from '../skill/service.js';
import { readWorkspaceEvents } from '../events/workspace-events.js';
import { NativeCodexRuntime, nativeCodexPackage, VERIFIED_NATIVE_CODEX_MODELS } from '../agent/native-codex.js';
import { RepositoryService } from '../project/repositories.js';
import { localBootIdentity } from '../agent/boot-identity.js';
import { ApiConnectionService, publicApiConnection, registerConnectionCredential } from '../agent/connections.js';
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
  readonly workspaceCli: WorkspaceCommands;
  readonly commands: ApplicationCommands;
  readonly repositories: RepositoryService;
  readonly connections: ApiConnectionService;
  readonly chatRuntimes = new Map<string, AgentRuntime>();
  readonly runtimeModels = new Map<string, readonly string[]>();
  nativeRuntimeUnavailable = 'Native subprocess service is not mounted in this Host.';
  readonly leads = new Map<string, AgentHandle>();
  private readonly leadStarts = new Map<string, Promise<AgentHandle>>();
  readonly providerNames = new Set<string>();
  private readonly executionProviderDisposers: (() => void)[] = [];
  private closing = false;
  constructor(readonly ctx: Context, readonly config: HostConfig) {
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
    this.commands = new ApplicationCommands(this);
    this.workspaceCli = new WorkspaceCommands(this, async (turn, name, input) => {
      const tool = this.chatTools(turn).find(tool=>tool.name===name);
      invariant(tool,'TOOL_UNAVAILABLE','This execution has no such coordination capability.');
      return tool.execute(input, new AbortController().signal);
    });
    this.coordinator = new TaskCoordinator({ store: this.store, repositoryAccess:workspaceId=>workspaceRepositoryAccess(this.store,workspaceId), bridge, runTools:run=>[...this.collaboration.runTools(run),...skillResourceTools(this.store,'run',run.id,()=>{invariant(this.store.run(run.id).status==='running'&&this.store.get("SELECT id FROM execution_leases WHERE owner_type='run' AND owner_id=? AND released_at IS NULL",run.id),'UNAUTHORIZED','Run no longer owns a live execution.');})],captureRunInbox:run=>this.collaboration.captureRunInbox(run),acceptRunInbox:runId=>this.collaboration.acceptRunInbox(runId), git: this.git, runTimeoutMs: config.runTimeoutMs, limits: config.limits, textAnalysisRoot: path.join(config.home,'text-analysis'), textAnalysisBridge: { start: input => this.startTextAnalysis(input) }, skillSnapshot: (workspaceId, agentId, runtime, runId) => this.skills.snapshotExecution(workspaceId, agentId, 'run', runId, installedSkills(this.skills,this.config.home,workspaceId,agentId,runtime)) });
    this.chat = new ChatService({ store: this.store, repositoryAccess:workspaceId=>workspaceRepositoryAccess(this.store,workspaceId), home: config.home, turnTimeoutMs:turn=>turn.configuration.agent.purpose==='lead'&&!turn.configuration.conversationTitle&&(this.orchestration.forTurn(turn)||config.chatOrchestration!==false&&!this.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')",turn.workspaceId))?config.coordinationTimeoutMs:undefined, defaultConnection: () => ({ runtime: 'dsh', provider: config.leadProvider, model: config.leadModel }), validateConnection: connection => this.validateChatConnection(connection), runtime: connection => connection.runtime === 'dsh' ? new DshChatRuntime(ctx, connection.provider!) : this.chatRuntimes.get(connection.runtime)!, tools: turn => this.chatTools(turn), resolveContext: (workspaceId, refs) => this.contextSnapshots(workspaceId, refs), onLeaseReleased: () => this.coordinator.wake(), canStart:turn=>this.orchestration.canStart(turn), beforeStart:turn=>this.orchestration.beforeStart(turn), onTurnSettled:turn=>{this.orchestration.settled(turn);this.collaboration.settleTurn(turn);}, skillSnapshot: (workspaceId, agentId, runtime, turnId) => this.skills.snapshotExecution(workspaceId, agentId, 'turn', turnId, installedSkills(this.skills,this.config.home,workspaceId,agentId,runtime)) });
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
  async initialize(): Promise<void> { for(const row of this.store.all<{id:string}>('SELECT id FROM workspaces'))installWorkspaceSkill(this.store,row.id); await this.connections.initialize(); const boot=await localBootIdentity();this.repositories.setBootIdentity(boot);this.coordinator.setBootIdentity(boot);await this.coordinator.recover();this.store.exec("UPDATE native_executions SET status='interrupted',updated_at=? WHERE status IN ('starting','running')",new Date().toISOString());this.chat.setBootIdentity(boot);this.chat.initialize();this.orchestration.initialize();this.collaboration.initialize(); }
  registerChatRuntime(name: 'codex', runtime: AgentRuntime, models: readonly string[]): void { this.chatRuntimes.set(name, runtime); this.runtimeModels.set(name, models); }
  browserEvents(workspaceId: string, after: number) { return readWorkspaceEvents(this.store, workspaceId, after); }
  validateChatConnection(connection: ChatConnection): void {
    if (connection.runtime === 'dsh') invariant(this.ctx.llm?.listProviders().some(provider => provider.id === connection.provider), 'PROVIDER_UNAVAILABLE', 'The selected model API provider is not registered.');
    else { invariant(this.chatRuntimes.has(connection.runtime), 'PROVIDER_UNAVAILABLE', 'The selected native discussion runtime is not enabled.'); invariant(this.runtimeModels.get(connection.runtime)?.includes(connection.model), 'MODEL_UNVERIFIED', 'This native model has not passed the restricted tool-boundary probe.'); }
  }
  executionBinding(workspaceId: string, providerName: string): string {
    this.store.workspace(workspaceId); this.refreshProviders();
    const provider = this.ctx.subagents.getProvider(providerName);
    invariant(provider && this.providerNames.has(providerName), 'PROVIDER_UNAVAILABLE', 'Choose an exact registered execution provider.');
    const bindingId = `${workspaceId}:execution:${providerName}`;
    if (!this.store.get('SELECT id FROM provider_bindings WHERE id=?', bindingId)) this.store.exec('INSERT INTO provider_bindings(id,workspace_id,provider_name,package_version,config_revision,capabilities,credential_refs,runtime,spawn) VALUES(?,?,?,?,1,?,?,?,?)', bindingId, workspaceId, providerName, '0.2.1-rc.3', JSON.stringify(provider.capabilities), '[]', providerName === 'spawn' ? 'dsh' : null, providerName === 'spawn' ? JSON.stringify({ provider: this.config.leadProvider, model: this.config.leadModel }) : null);
    return bindingId;
  }
  configuredExecutionBinding(workspaceId: string, connection: ChatConnection): string {
    this.store.workspace(workspaceId);
    this.validateChatConnection(connection);
    const providerName = connection.runtime === 'dsh' ? 'spawn' : `rift-native-codex-${connection.model}`;
    this.refreshProviders();
    const provider = this.ctx.subagents.getProvider(providerName);
    invariant(provider, 'PROVIDER_UNAVAILABLE', 'The selected execution runtime is not available in this Host.');
    if (connection.runtime === 'codex' && connection.reasoningEffort) invariant(['low','medium','high','xhigh','max','ultra'].includes(connection.reasoningEffort), 'INVALID_CONFIG', 'Choose a supported Codex reasoning effort.');
    const saved = connection.runtime === 'dsh' ? this.store.get<{ model: string; credentialRef: string }>('SELECT model,credential_ref FROM api_connections WHERE provider=? AND deleted_at IS NULL', connection.provider!) : undefined;
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
    const handle=await runtime.start({onEvent:observeNativeRun(input.onProgress,input.onEvent),workspaceId:role.workspaceId,agentId:role.id,turnId:input.run.id,cwd:input.cwd,model:connection.model,reasoningEffort:connection.reasoningEffort,...session?{session:sessionCallbacks(this.store,session,input.run.id,input.cwd,input.onAccepted)}:{},instructions:`You are executing a registered text-only analysis task. Analyze only the supplied text, do not access files or delegate. The latest task envelope and runId supersede previous execution details.\n${role.prompt}\n${input.run.providerSnapshot.skillInstructions??''}`,messages:[{role:'user',content:input.prompt}],tools:input.tools??[],signal:input.signal});
    return{childId:`text-${input.run.id}`,dispose:()=>handle.dispose(),result:handle.result.then(result=>({stopReason:result.stopReason,text:JSON.stringify({schemaVersion:1,taskId:input.task.id,runId:input.run.id,outcome:'completed',summary:result.text,changedPaths:[],checksClaimed:[],blockingReasons:[]})}))};
  }
  private chatTools(turn: AgentTurn): RuntimeTool[] {
    const tools: RuntimeTool[] = [];
    const existing=this.store.get<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')",turn.workspaceId);
    const shortMode=Boolean(existing?this.orchestration.owner(existing.id):this.config.chatOrchestration!==false&&turn.configuration.agent.purpose==='lead');
    let calls=0,reads=0;
    const assertLive=()=>{const current=this.chat.turn(turn.workspaceId,turn.id);invariant(current.status==='running'&&current.agentId===turn.agentId&&this.store.get("SELECT id FROM execution_leases WHERE owner_type='turn' AND owner_id=? AND released_at IS NULL",turn.id),'UNAUTHORIZED','This Turn no longer owns an active execution lease.');};
    tools.push(...skillResourceTools(this.store,'turn',turn.id,assertLive));
    const activeWorkflow = () => this.store.require<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", turn.workspaceId);
    const register = (name: string, description: string, schema: z.ZodType, execute: (input: any) => unknown): void => {
      tools.push({ name, description, inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))), execute: async (args, signal) => {
        signal.throwIfAborted();
        assertLive();
        if(shortMode){calls++;reads=name==='rift_status'?reads+1:0;if(calls>(this.config.coordinationToolLimit??48)||reads>(this.config.coordinationStagnantLimit??12)){this.store.exec("UPDATE coordination_decisions SET error='COORDINATION_TOOL_BUDGET' WHERE turn_id=?",turn.id);this.store.exec("INSERT INTO turn_activities(turn_id,type,phase,summary,payload,created_at) VALUES(?,'coordination.limit','tool','Coordination tool budget exceeded.',?,?)",turn.id,JSON.stringify({reason:'COORDINATION_TOOL_BUDGET'}),new Date().toISOString());this.chat.stop(turn.workspaceId,turn.id);throw new RiftError('COORDINATION_TOOL_BUDGET','Coordination tool budget exceeded.');}}
        if(name!=='rift_send_message'&&name!=='rift_cli')this.orchestration.authorize(turn,name!=='rift_status');
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
    register('rift_cli','Execute a RIFT workspace CLI command. argv is [resource, action, optional id], input is the JSON command body. Identity and workspace are fixed by this live execution; use a stable idempotencyKey for writes. No shell or management credential is needed. For public upstream installation instructions use argv ["source","read"] with input {url:"https://github.com/OWNER/REPO"}; this reads README directly. The workspace shell also supports npm/npx/pnpm and public HTTP(S) downloads; use it to install packages and generate Skill files before preview/import/assign.',cliEnvelope.extend({idempotencyKey:z.string().min(1).max(160).optional()}),({idempotencyKey,...command})=>this.workspaceCli.execute(turn.workspaceId,command,turn,idempotencyKey));
    register('rift_status', 'Read this workspace and its current workflow. All scopes are fixed by the Host.', z.object({}).strict(), () => {
      const workflow = this.store.get<Workflow>("SELECT * FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", turn.workspaceId);
      return workflow ? {...this.coordinator.status(workflow.id),coordination:this.orchestration.owner(workflow.id)??null} : { workspace: this.store.workspace(turn.workspaceId), repositories: this.repositories.list(turn.workspaceId), roles: this.store.all('SELECT * FROM roles WHERE workspace_id=?', turn.workspaceId), workflow: null };
    });
    register('rift_send_message','Send a scoped message to one workspace member. Progress is recorded; questions and blockers queue a reply. Sending never claims acceptance or assigns a task.',sendCollaborationMessageSchema,input=>this.collaboration.send({type:'turn',id:turn.id},input));
    if (turn.configuration.agent.purpose !== 'lead') {
      register('rift_task_request', 'Register one task assigned to yourself and return its receipt. Use kind analysis without repositoryId for supplied-text analysis. End this discussion turn before the task can run; never wait for it here.', z.object({ goal: z.string().min(1).max(32000),kind:z.enum(['change','analysis']).default('change'), title: z.string().min(1).max(240), instructions: z.string().min(1).max(32000), expectedPaths: z.array(z.string()).max(100).default([]).describe('Legacy display metadata; ignored for permissions, scheduling and acceptance.'), repositoryId: z.string().min(1).max(160).optional(), acceptanceCriteria: z.array(z.string()).max(100).default([]) }).strict(), async input => {
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
    register('rift_workflow_start', 'Start or attach this workspace workflow. Use mode analysis for registered text-only tasks without Git; code mode selects repositoryIds explicitly when more than one is connected.', z.object({ goal: z.string().min(1).max(32000), mode:z.enum(['code','analysis']).default('code'), repositoryIds: z.array(z.string().min(1)).min(1).optional() }).strict(), input => startWorkflow(input.goal, input.repositoryIds,input.mode));
    const taskOwned = (taskId: string, workflowId: string) => invariant(this.store.task(taskId).workflowId === workflowId, 'CROSS_WORKFLOW', 'Task does not belong to this workspace workflow.');
    register('rift_plan_submit', 'Submit a durable dependency plan to the current workflow.', schemas.planSchema, input => this.collaboration.plan(turn,{ workflowId: activeWorkflow().id, ...schemas.planForCoordinator(input) }));
    register('rift_plan_replan', 'Update unstarted tasks using current versions.', schemas.replanSchema, input => { const workflowId = activeWorkflow().id; for (const update of input.updates) taskOwned(update.taskId, workflowId); return this.coordinator.replan({ workflowId, ...input }); });
    register('rift_task_dispatch', 'Queue an approved task. Returns a durable receipt.', schemas.dispatchSchema, input => { taskOwned(input.taskId, activeWorkflow().id); return this.collaboration.dispatch(turn,input); });
    if(!shortMode)register('rift_wait', 'Wait for this workflow task events; never infer completion without evidence.', schemas.waitSchema, input => this.coordinator.wait({ workflowId: activeWorkflow().id, ...input }));
    else register('rift_yield','Record durable handoff after dispatching this batch. Finish your final reply immediately; no more tools are allowed in this decision. Workflow events will resume the Lead after runtime cleanup.',z.object({summary:z.string().min(1).max(2000),taskIds:z.array(z.string().min(1)).max(100).default([]),requestIds:z.array(z.string().min(1)).max(100).default([])}).strict(),input=>this.orchestration.yield(turn,input));
    register('rift_task_retry', 'Retry this workflow task after confirmed cleanup; prior timeouts do not impose an attempt-count limit.', schemas.retrySchema, input => { taskOwned(input.taskId, activeWorkflow().id); return this.coordinator.retry(input); });
    register('rift_integration_request', 'Request exact-commit checking and independent review.', schemas.integrationSchema, input => { taskOwned(input.taskId, activeWorkflow().id); return this.coordinator.requestIntegration(input); });
    register('rift_workflow_finish', 'Complete only when all registered tasks passed real acceptance gates.', schemas.finishSchema, input => this.coordinator.finish({ workflowId: activeWorkflow().id, ...input }));
    return tools;
  }
  refreshProviders(): void { this.providerNames.clear(); for (const name of this.ctx.subagents.list()) this.providerNames.add(name); }
  defaultMembers() {
    return [
      { name: 'developer-a', purpose: 'developer' as const, providerName: this.config.developerProvider ?? 'claude-code-dev', prompt: 'Implement only the supplied task in this worktree. Preserve other files. Return one JSON object matching resultSchema with exact taskId and runId.' },
      { name: 'reviewer', purpose: 'reviewer' as const, providerName: this.config.reviewerProvider ?? 'codex-review', prompt: 'Review the exact candidate commit read-only. Never edit or commit. Return one JSON object matching resultSchema; approve only when all acceptance criteria pass.' },
    ];
  }
  defaults(workspaceId: string): void {
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
          const cwd=repositoryAccess?.repositoryPaths[0]??repositoryAccess?.workspaceDirectory??this.config.home;
          const stop=new AbortController();
          const chatOwned=!!this.orchestration.owner(workflowId);
          const shell=repositoryAccess&&!chatOwned?await createRepositoryShell(this.ctx.subprocess,{cwd,repositoryAccess,signal:stop.signal}):undefined;
          let underlying:AgentHandle;
          try { underlying=await this.ctx.agents.create({ sessionId: SessionId(`rift-lead-${randomUUID()}`), meta: { cwd }, agentOptions: { provider: this.config.leadProvider, model: this.config.leadModel }, setup: (scope, agent) => {
            installLeadTools(scope, agent, workflowId, this.coordinator);
            if(!chatOwned)scope.tools.register({name:'rift_cli',description:'Run workspace CLI argv [resource,action,id?] with JSON input. Workspace and identity are fixed by this live Lead. Read public GitHub README using argv ["source","read"], input {url:"https://github.com/OWNER/REPO"}.',parameters:JSON.parse(JSON.stringify(z.toJSONSchema(cliEnvelope.extend({idempotencyKey:z.string().min(1).max(160).optional()}),{io:'input'}))) as ToolDefinition['parameters'],output:{schema:{},render:(_args,value)=>[{type:'text',text:redact(JSON.stringify(value))}]},execute:async(args,execution)=>{
              const assertLive=()=>{
                invariant(execution.agent===agent&&scope.agents.get(agent.id)===agent,'UNAUTHORIZED','Only this live Lead may invoke its CLI.');
                invariant(!this.closing&&!this.orchestration.owner(workflowId)&&!['completed','cancelled','failed'].includes(this.store.workflow(workflowId).status),'INVALID_STATE','This Lead no longer owns the workflow.');
                execution.signal.throwIfAborted();
              };
              assertLive();const {idempotencyKey,...command}=cliEnvelope.extend({idempotencyKey:z.string().min(1).max(160).optional()}).parse(args);
              const role=this.store.require<{id:string}>("SELECT id FROM roles WHERE workspace_id=? AND purpose='lead' AND enabled=1",workflow.workspaceId);
              return this.workspaceCli.execute(workflow.workspaceId,command,{legacy:true,workspaceId:workflow.workspaceId,agentId:role.id,assertLive},idempotencyKey);
            }});
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
    const leadRole = this.store.require<{id:string;prompt:string}>("SELECT id,prompt FROM roles WHERE workspace_id=? AND purpose='lead' AND enabled=1", workflow.workspaceId);
    const prompt = `You are the RIFT Lead for workflow ${workflowId}. Goal: ${workflow.goal}\nUse RIFT tools for durable coordination and the repository shell for user-requested Git commits and authenticated PR commands. First inspect status. Submit a small explicit DAG. Do not use expectedPaths as a file allowlist. Read configured roles and global limits from status; dispatch independent tasks up to the available developer budget BEFORE waiting and queue additional requested tasks. Use plan_replan with current versions to update unstarted task dependencies or priority. Batch analysis may use analysisItems; write tasks must remain registered change tasks. Use returned versions and request IDs. Wait for any results using the cursor, then handle blocked tasks or retry explicitly with context after confirmed cleanup. Prior failures do not impose a lifetime attempt-count limit; do not automatically repeat uncertain side effects. Development automatically queues integration. All candidate checks and reviews are enforced by RIFT. Never finish until workflow_finish accepts. Do not invent execution evidence. Connection verification failure is request-specific and does not authorize changing any member runtime, provider or model; preserve configured selections unless the user explicitly requests a change. If blocked by credentials or unknown cleanup, explain the blocker and stop.\n${instruction ?? ''}`;
    handle.agent.followup({ id: MessageId(randomUUID()), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${leadRole.prompt}\n${installedSkills(this.skills,this.config.home,workflow.workspaceId,leadRole.id,'dsh').instructions}\n${prompt}` }] });
    return attached;
  }
  async handle(method: string, pathname: string, body: unknown, key?: string): Promise<unknown> {
    if(method==='POST'&&['/ui-api/v1/connections','/v1/connections'].includes(pathname))registerConnectionCredential(body);
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
      const command = resolveHttpCommand(method, pathname, body);
      if (command.name === 'connection.create') return publicApiConnection(value);
      if (command.name === 'connection.verify') return { ...value, connection: publicApiConnection(value.connection) };
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
    invariant(new URL(pathname,'http://rift.local').pathname.startsWith('/ui-api/v1/'),'NOT_FOUND','Unknown browser route.');
    return this.handle(method, pathname, body, key ? `browser:${key}` : undefined);
  }
  async createChatWorkflow(turn:AgentTurn|undefined,body:unknown,assertLive:()=>void=()=>{}):Promise<Workflow> {
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
  private async route(method:string,pathname:string,body:unknown):Promise<unknown> {
    const command=resolveHttpCommand(method,pathname,body);
    if(command.name==='workspace.cli')return this.workspaceCli.execute(command.workspaceId!,body);
    return this.commands.execute(command);
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
