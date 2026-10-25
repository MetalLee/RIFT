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

export interface HostConfig { home: string; port: number; leadProvider: string; leadModel: string; developerProvider?: string; reviewerProvider?: string; limits?: z.infer<typeof schemas.limitsSchema>; checks: CheckCommand[]; runTimeoutMs?: number }
export class RiftHostService implements ApiHandler {
  readonly store: RiftStore;
  readonly project: ProjectService;
  readonly git: LocalGitService;
  readonly coordinator: TaskCoordinator;
  private readonly leads = new Map<string, AgentHandle>();
  private readonly leadStarts = new Map<string, Promise<AgentHandle>>();
  private readonly providerNames = new Set<string>();
  private closing = false;
  constructor(private readonly ctx: Context, readonly config: HostConfig) {
    this.store = new RiftStore(path.join(config.home, 'rift.db'));
    try {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS management_requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT)');
    this.project = new ProjectService(this.store, this.providerNames);
    this.git = new LocalGitService({ managedRoot: path.join(config.home, 'workspaces'), commands: config.checks });
    const bridge = new DshActivationBridge(ctx, taskId => this.leads.get(this.store.task(taskId).workflowId)?.agent, this.store);
    this.coordinator = new TaskCoordinator({ store: this.store, bridge, git: this.git, runTimeoutMs: config.runTimeoutMs, limits: config.limits });
    } catch (error) { this.store.close(); throw error; }
  }
  async initialize(): Promise<void> { await this.coordinator.recover(); }
  private refreshProviders(): void { this.providerNames.clear(); for (const name of this.ctx.subagents.list()) this.providerNames.add(name); }
  private defaults(workspaceId: string): void {
    this.refreshProviders();
    const developerProvider = this.config.developerProvider ?? 'claude-code-dev';
    const reviewerProvider = this.config.reviewerProvider ?? 'codex-review';
    const bindings: ProviderBinding[] = [...new Set([developerProvider, reviewerProvider])].map(providerName => {
      const provider = this.ctx.subagents.getProvider(providerName);
      if (!provider) throw new RiftError('PROVIDER_UNAVAILABLE', `Profile is missing ${providerName}.`);
      return { id: `${workspaceId}:${providerName}`, providerName, packageVersion: '0.2.1-rc.3', configRevision: 1, capabilities: { ...provider.capabilities }, credentialRefs: providerName.startsWith('claude') ? ['native:claude', 'env:ANTHROPIC_API_KEY'] : providerName === 'spawn' ? ['env:DEEPSEEK_API_KEY'] : ['native:codex'], ...(providerName === 'spawn' ? { runtime: 'dsh' as const, spawn: { provider: this.config.leadProvider, model: this.config.leadModel } } : {}) };
    });
    this.project.configureRoles(workspaceId, bindings, [
      { name: 'lead', purpose: 'lead', kind: 'dsh-lead', prompt: 'Coordinate a durable plan, parallel independent developers and exact-commit acceptance. Do not claim success before workflow_finish succeeds.', revision: 1 },
      ...Array.from({ length: this.coordinator.limits.developers }, (_, index) => index < 26 ? `developer-${String.fromCharCode(97 + index)}` : `developer-${index + 1}`).map(name => ({ name, purpose: 'developer' as const, kind: 'subagent' as const, providerBindingId: `${workspaceId}:${developerProvider}`, prompt: 'Implement only the supplied task in this worktree. Preserve other files. Return one JSON object matching resultSchema with exact taskId and runId.', revision: 1 })),
      { name: 'reviewer', purpose: 'reviewer', kind: 'subagent', providerBindingId: `${workspaceId}:${reviewerProvider}`, prompt: 'Review the exact candidate commit read-only. Never edit or commit. Return one JSON object matching resultSchema; approve only when all acceptance criteria pass.', revision: 1 },
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
          const created = await this.ctx.agents.create({ sessionId: SessionId(`rift-lead-${randomUUID()}`), meta: { cwd: this.store.workspace(workflow.workspaceId).repositoryPath }, agentOptions: { provider: this.config.leadProvider, model: this.config.leadModel }, setup: (scope, agent) => installLeadTools(scope, agent, workflowId, this.coordinator) });
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
    if (!this.ctx.llm.listProviders().some(provider => provider.id === this.config.leadProvider)) throw new RiftError('LEAD_PROVIDER_UNAVAILABLE', `Profile is missing Lead provider ${this.config.leadProvider}. Inspect doctor and the registered model routes.`);
    const attached = await this.ensureLead(workflowId);
    const handle = this.leads.get(workflowId)!;
    const workflow = this.store.workflow(workflowId);
    if (this.closing || ['completed','cancelled','failed'].includes(workflow.status)) throw new RiftError('INVALID_STATE', 'Workflow no longer accepts Lead input.');
    const leadRole = this.store.require<{prompt:string}>("SELECT prompt FROM roles WHERE workspace_id=? AND purpose='lead' AND enabled=1", workflow.workspaceId);
    const prompt = `You are the RIFT Lead for workflow ${workflowId}. Goal: ${workflow.goal}\nUse only RIFT tools. First inspect status. Submit a small explicit DAG and expected write paths. Read configured roles and global limits from status; dispatch independent tasks up to the available developer budget BEFORE waiting and queue additional requested tasks. Use plan_replan with current versions to update unstarted task dependencies or priority. Batch analysis may use analysisItems; write tasks must remain registered change tasks. Use returned versions and request IDs. Wait for any results using the cursor, then handle blocked tasks or retry with context (maximum two repairs). Development automatically queues integration. All candidate checks and reviews are enforced by RIFT. Never finish until workflow_finish accepts. Do not invent execution evidence. If blocked by credentials or unknown cleanup, explain the blocker and stop.\n${instruction ?? ''}`;
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
  private async route(method:string, pathname:string, body:unknown):Promise<unknown> {
    if (method === 'GET' && pathname === '/v1/doctor') return this.doctor();
    if (method === 'GET' && pathname === '/v1/workspaces') return this.store.all('SELECT * FROM workspaces ORDER BY id');
    if (method === 'POST' && pathname === '/v1/workspaces') {
      const input = schemas.workspaceSchema.parse(body), repo = await this.git.inspectRepository(input.repositoryPath,input.baseRef), id = `workspace-${randomUUID()}`;
      const workspace = this.store.transaction(() => { const workspace = this.project.createWorkspace({ id,name:input.name,rootPath:path.join(this.config.home,'workspaces',id),repositoryPath:repo.rootPath,commonGitDir:repo.commonGitDir,baseRef:input.baseRef }); this.defaults(id); return workspace; });
      return workspace;
    }
    if (method === 'POST' && pathname === '/v1/workflows') {
      const input = schemas.workflowSchema.parse(body), workspace = this.store.workspace(input.workspaceId), repo = await this.git.inspectRepository(workspace.repositoryPath,workspace.baseRef), id = `workflow-${randomUUID()}`;
      const workflow = this.coordinator.createWorkflow({ id,workspaceId:workspace.id,goal:input.goal,baseCommit:repo.baseCommit,integrationRef:`refs/heads/rift/${workspace.id}/${id}` });
      if (input.startLead) await this.startLead(id);
      return this.store.workflow(workflow.id);
    }
    const match = /^\/v1\/(workspaces|workflows|tasks|runs)\/([^/]+)(?:\/(roles|plan|replan|dispatch|integration|retry|cancel|pause|resume|lead|finish|wait|logs|archive|report))?$/.exec(pathname);
    if (!match) throw new RiftError('NOT_FOUND','Unknown management route.');
    const [,entity,rawId,action] = match; const id = decodeURIComponent(rawId);
    if (entity === 'workspaces') {
      if (method === 'PUT' && action === 'roles') { const input = schemas.rolesSchema.parse(body); this.refreshProviders(); return this.project.configureRoles(id,input.bindings,input.roles); }
      if (method === 'POST' && action === 'archive') {
        const workspace = this.store.workspace(id);
        if (this.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','cancelled','failed')",id)) throw new RiftError('WORKSPACE_ACTIVE','Finish or cancel the active workflow first.');
        const trees=this.store.all<Worktree>('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=?',id);
        for(const worktree of trees) {const unknown=Boolean(this.store.get('SELECT id FROM runs WHERE task_id=? AND slot_released_at IS NULL',worktree.taskId));await this.git.archiveWorktree({workspace,worktree,active:unknown,cleanupConfirmed:!unknown,artifactsSaved:true});}
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
      if (method === 'POST' && (action === 'pause'||action === 'resume')) {const input=z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body); if(action==='resume'&&!this.leads.has(id))throw new RiftError('LIVE_LEAD_REQUIRED','Attach a new Lead before resuming queues.');return this.coordinator[action](id,input.expectedVersion);}
      if (method === 'POST' && action === 'lead') return this.startLead(id);
    }
    if (entity === 'tasks') {
      if (method === 'GET' && !action) return this.store.task(id);
      if (method === 'POST' && action === 'dispatch') return this.coordinator.dispatch(schemas.dispatchSchema.parse({...body as object,taskId:id}));
      if (method === 'POST' && action === 'integration') return this.coordinator.requestIntegration(schemas.integrationSchema.parse({...body as object,taskId:id}));
      if (method === 'POST' && action === 'retry') return this.coordinator.retry(schemas.retrySchema.parse({...body as object,taskId:id}));
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
  async close():Promise<void>{this.closing=true;await this.coordinator.shutdown();await Promise.allSettled([...this.leadStarts.values()]);await Promise.allSettled([...this.leads.values()].map(handle=>handle.dispose()));this.store.close();}
}
