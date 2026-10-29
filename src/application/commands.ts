import { previewBaseline, previewCheck } from '../git/evidence.js';
import { parseTimelineRefresh } from '../chat/timeline-page.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { RiftHostService } from '../api/host-service.js';
import { invariant, RiftError, type Worktree } from '../contracts/index.js';
import * as schemas from '../api/schemas.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { publicError, redact } from '../api/security.js';
import { workspaceDetail, workspaceList, workspaceTasks } from '../api/workspace-views.js';
import { taskView } from '../api/task-diagnostics.js';
import { connectionSchema,createAgentSchema,createBrowserAgent,updateAgentSchema,updateBrowserAgent } from '../project/browser-agents.js';
import type { ChatConnection } from '../chat/contracts.js';
import { sendMessageSchema } from '../chat/service.js';
import { installWorkspaceSkill } from '../skill/default.js';
import { installedSkills } from '../skill/runtime.js';
import { VERIFIED_NATIVE_CODEX_MODELS } from '../agent/native-codex.js';

export interface ApplicationCommand { name:string; workspaceId?:string; id?:string; agentId?:string; kind?:import('../project/worktree-removals.js').RemovalKind; input?:unknown; query?:URLSearchParams; removalActor?:import('../project/worktree-removals.js').WorktreeRemovalActor; validateRepository?:Parameters<RiftHostService['repositories']['connect']>[2] }
/** Business execution only: transports supply named commands, never HTTP paths. */
export class ApplicationCommands {
  constructor(private readonly host:RiftHostService) {}
  async execute(command:ApplicationCommand):Promise<unknown> {
    const {name,input:body={}}=command,workspaceId=command.workspaceId!,id=command.id!,query=command.query??new URLSearchParams();
    if(workspaceId&&id&&name.startsWith('workflow.'))invariant(this.host.store.workflow(id).workspaceId===workspaceId,'NOT_FOUND','Workflow does not belong to this workspace.');
    if(name==='connection.create')return this.host.connections.create(body);
    if(name==='connection.delete'){
      z.object({}).strict().parse(body);const connectionId=id;
      const saved=this.host.store.get<{provider:string;deletedAt:string|null}>('SELECT provider,deleted_at FROM api_connections WHERE id=?',connectionId);
      invariant(!saved||saved.deletedAt||saved.provider!==this.host.config.leadProvider,'CONNECTION_IN_USE','The Host default Lead still selects this API connection. Choose another default before deleting it.');
      return this.host.connections.remove(connectionId);
    }
    if(name==='connection.verify'){z.object({}).strict().parse(body);return this.host.connections.verify(id);}
    if(name==='connection.catalogue') return { savedConnections: this.host.connections.list(), configuration: this.host.connections.configurationCapability(), executionProviders: this.host.ctx.subagents.list().map(name => ({ name, capabilities: this.host.ctx.subagents.getProvider(name)?.capabilities ?? {}, authentication: 'not-verified' })), connections: [...(this.host.ctx.llm?.listProviders() ?? []).map(provider => ({ id: `dsh:${provider.id}`, runtime: 'dsh', provider: provider.id, available: true, authentication: 'not-verified', modelSelection: 'explicit', models: [], executionAvailable: Boolean(this.host.ctx.subagents.getProvider('spawn')?.capabilities.agentOptions), tools: true, streaming: true, output: 'redacted-event-stream' })), { id: 'codex', runtime: 'codex', available: this.host.chatRuntimes.has('codex'), authentication: 'not-verified', modelSelection: 'verified-only', models: this.host.runtimeModels.get('codex') ?? [], executionAvailable: VERIFIED_NATIVE_CODEX_MODELS.every(model => Boolean(this.host.ctx.subagents.getProvider(`rift-native-codex-${model}`))), disabledReason: this.host.chatRuntimes.has('codex') ? null : this.host.nativeRuntimeUnavailable, tools: true, streaming: true, output: 'redacted-event-stream' }] };
    if(name==='workspace.list') return workspaceList(this.host.store);
    if(name==='workspace.show') {
      this.host.refreshProviders();
      return workspaceDetail(this.host.store, workspaceId, this.host.providerNames, { provider: this.host.config.leadProvider, model: this.host.config.leadModel });
    }
    if(name==='workspace.create') {
      const input = z.object({ name: z.string().trim().min(1).max(120), repositoryPath: z.string().min(1).optional(), baseRef: z.string().min(1).optional(), leadConnection: connectionSchema.optional() }).strict().parse(body);
      if (input.leadConnection) this.host.validateChatConnection(input.leadConnection);
      let workspace: import('../contracts/index.js').Workspace;
      if (input.repositoryPath) workspace = await this.execute({name:'workspace.create-repository',input:{ name: input.name, repositoryPath: input.repositoryPath, baseRef: input.baseRef ?? 'HEAD' }}) as typeof workspace;
      else {
        invariant(!input.baseRef, 'INVALID_WORKSPACE', 'A base ref requires a repository.');
        const id = `workspace-${randomUUID()}`;
        workspace = this.host.store.transaction(() => {
          this.host.store.exec('INSERT INTO workspaces(id,name,root_path,status) VALUES(?,?,?,?)', id, input.name, path.join(this.host.config.home, 'workspaces', id), 'active');
          this.host.store.exec("INSERT INTO roles(id,workspace_id,name,purpose,kind,prompt,revision,display_name) VALUES(?,?,'lead','lead','dsh-lead',?,1,?)", `${id}:lead`, id, 'Help the user discuss and plan. Register all code work through RIFT tools; never bypass acceptance gates.', '主 Agent');
          // A discussion-only Host may have no execution providers yet.
          // Bind registered providers when available; otherwise retain inert discussion members.
          for (const { providerName, ...member } of this.host.defaultMembers()) createBrowserAgent(this.host.store, id, {
            ...member, displayName: member.name, chatConnection: null,
            ...(this.host.ctx.subagents.list().includes(providerName) ? { providerBindingId: this.host.executionBinding(id, providerName) } : {}),
          });
          return this.host.store.workspace(id);
        });
      }
      if (input.leadConnection) this.host.store.exec('UPDATE workspaces SET lead_connection=?,version=version+1 WHERE id=?', JSON.stringify(input.leadConnection), workspace.id);
      installWorkspaceSkill(this.host.store,workspace.id);
      this.host.chat.createConversation(workspace.id);
      return this.host.store.workspace(workspace.id);
    }
    if(name==='workspace.archive'){z.object({}).strict().parse(body);return this.execute({name:'workspace.archive-execute',id:workspaceId,input:{}});}
    if(name==='message.retry-delivery'){z.object({}).strict().parse(body);return this.host.collaboration.retryDelivery(workspaceId,id);}
    if(name==='task.list')return workspaceTasks(this.host.store,workspaceId,query);
    if(name.startsWith('repository.') || name==='worktree.list' || name==='worktree.create') {
      const repositoryId=id;
      if (name==='repository.list') return { repositories: this.host.repositories.list(workspaceId) };
      if (name==='repository.connect') return this.host.repositories.connect(workspaceId, z.object({ repositoryPath: z.string().min(1), baseRef: z.string().min(1).default('HEAD'), expectedVersion: z.number().int().nonnegative() }).strict().parse(body),command.validateRepository);
      if (name==='worktree.list') return { worktrees: this.host.repositories.worktrees(workspaceId, repositoryId), discovered: await this.host.repositories.discover(workspaceId, repositoryId), removals: await this.host.repositories.removals.list(workspaceId, repositoryId, command.removalActor) };
      if (name==='worktree.create') return this.host.repositories.createWorktree(workspaceId, repositoryId, z.object({ origin: z.enum(['managed','external']), path: z.string().min(1).optional(), baseRef: z.string().min(1).optional(), branch: z.string().min(1).max(200).optional() }).strict().parse(body));
    }
    if(name==='worktree.delete'||name==='worktree.reconcile-delete') {
      const kind=command.kind!,recordId=id;
      if (name==='worktree.reconcile-delete') return this.host.repositories.removals.reconcile(workspaceId, kind, recordId, z.object({ expectedVersion: z.string().min(1) }).strict().parse(body).expectedVersion);
      return this.host.repositories.removals.remove(workspaceId, kind, recordId, z.object({ expectedVersion: z.string().min(1), confirmDelete: z.literal(true) }).strict().parse(body), command.removalActor);
    }
    if(['worktree.archive','worktree.detach','worktree.takeover','worktree.reconcile'].includes(name)) {
      const treeId=id;
      if(name==='worktree.takeover')return this.host.repositories.takeover(workspaceId,treeId,z.object({expectedVersion:z.number().int().nonnegative(),confirmExclusiveOwnership:z.literal(true),destinationPath:z.string().min(1).optional()}).strict().parse(body));
      const input = z.object({ expectedVersion: z.number().int().nonnegative() }).strict().parse(body); if(name==='worktree.reconcile')return this.host.repositories.reconcile(workspaceId,treeId,input.expectedVersion);return name==='worktree.archive' ? this.host.repositories.archive(workspaceId,treeId,input.expectedVersion,command.removalActor) : this.host.repositories.detach(workspaceId,treeId,input.expectedVersion);
    }
    if(name==='run.reconcile'){const runId=id,run=this.host.store.run(runId);invariant(this.host.store.workflow(this.host.store.task(run.taskId).workflowId).workspaceId===workspaceId,'NOT_FOUND','Run does not belong to this workspace.');this.host.coordinator.reconcileRun(runId,z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body).expectedVersion);return this.host.store.require('SELECT id,task_id,status,version,cleanup_status,slot_released_at FROM runs WHERE id=?',runId);}
    if(name==='integration.reconcile'){const integrationId=id,integration=this.host.store.require<{taskId:string}>('SELECT task_id FROM integrations WHERE id=?',integrationId);invariant(this.host.store.workflow(this.host.store.task(integration.taskId).workflowId).workspaceId===workspaceId,'NOT_FOUND','Integration does not belong to this workspace.');return this.host.coordinator.reconcileIntegration(integrationId,z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body).expectedVersion);}
    if(['task.show','task.retry-dispatch','task.evidence','task.evidence-log','task.supplement-evidence'].includes(name)){
      const taskId=id,task=this.host.store.task(taskId);
      invariant(this.host.store.workflow(task.workflowId).workspaceId===workspaceId,'NOT_FOUND','Task does not belong to this workspace.');
      if(name==='task.show')return taskView(this.host.store,task);
      const evidenceContext = () => {
        const workflow = this.host.store.workflow(task.workflowId);
        const repository = this.host.store.require<{repositoryId:string;canonicalPath:string;commonGitDir:string;baseRef:string;baseCommit:string;integrationRef:string}>('SELECT f.*,r.canonical_path,r.common_git_dir,r.base_ref FROM workflow_repositories f JOIN repositories r ON r.id=f.repository_id WHERE f.workflow_id=? AND f.repository_id=?', workflow.id, task.repositoryId!);
        return { task, workflow: { ...workflow, baseCommit: repository.baseCommit, integrationRef: repository.integrationRef }, workspace: { ...this.host.store.workspace(workspaceId), repositoryPath: repository.canonicalPath, commonGitDir: repository.commonGitDir, baseRef: repository.baseRef } };
      };
      if(name==='task.supplement-evidence') {
        const input = z.object({ integrationId:z.string().min(1).max(160), candidateHead:z.string().regex(/^[a-f0-9]{40,64}$/), expectedVersion:z.number().int().nonnegative(), idempotencyKey:z.string().min(1).max(160) }).strict().parse(body);
        return this.host.coordinator.supplementEvidence({ taskId, ...input });
      }
      if(name==='task.evidence-log') {
        const input = z.object({ integrationId:z.string().min(1).max(160), checkId:z.string().uuid() }).strict().parse(Object.fromEntries(query));
        this.host.store.require('SELECT id FROM integrations WHERE id=? AND task_id=?', input.integrationId, taskId);
        return this.host.git.readCheckEvidence({ ...evidenceContext(), ...input });
      }

      if(name==='task.retry-dispatch'){
        this.host.coordinator.assertDevelopmentRetry(taskId);
        const workflow=this.host.store.workflow(task.workflowId);
        const latest=this.host.store.get<import('../contracts/index.js').Run>('SELECT * FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',taskId);
        const lastIntegration=this.host.store.get<{candidate:import('../contracts/index.js').Candidate|null}>('SELECT candidate FROM integrations WHERE task_id=? ORDER BY rowid DESC LIMIT 1',taskId);
        const formatFailed=latest?.stopReason==='INVALID_RESULT';
        const completedDevelopment=latest?.status==='succeeded'&&(latest.result as Partial<import('../contracts/index.js').DevelopmentResult>|null)?.outcome==='completed';
        if(task.kind==='change'&&task.status==='blocked'&&latest?.purpose!=='review'&&(formatFailed||completedDevelopment&&lastIntegration?.candidate?.readiness?.status!=='failed'))
          throw new RiftError(formatFailed?'RESULT_SUPPLEMENT_REQUIRED':'STAGE_RECOVERY_REQUIRED','Use supplement-result / recover for infrastructure recovery; use explicit task retry only for a code repair.');
        if(task.kind==='change'&&task.status==='blocked'&&latest?.purpose!=='review'&&['failed','interrupted'].includes(latest?.status??''))
          throw new RiftError('CONTINUATION_REQUIRED','Provider interruption requires explicit task retry with a continuation reason and preserved-checkout inspection, not automatic development replay.');
        if(workflow.baseCommit)await this.host.ensureLead(workflow.id);
        if(task.status==='blocked'&&task.sourceHead&&latest?.purpose==='review'&&latest.taskAttempt===task.attempt&&(['failed','interrupted'].includes(latest.status)||(latest.status==='succeeded'&&(latest.result as Partial<import('../contracts/index.js').ReviewResult>|null)?.verdict==='blocked'))){
          const input=z.object({expectedVersion:z.number().int().nonnegative(),reason:z.string().min(1)}).strict().parse(body);
          const request=this.host.coordinator.requestIntegration({taskId,sourceHead:task.sourceHead,expectedVersion:input.expectedVersion,idempotencyKey:`browser-review-retry:${taskId}:${input.expectedVersion}`});
          return{task:this.host.store.task(taskId),request};
        }
        const retried=await this.execute({name:'task.retry',id:taskId,input:body}) as import('../contracts/index.js').Task;
        const request=this.host.coordinator.dispatch({taskId,expectedVersion:retried.version,idempotencyKey:`browser-retry:${taskId}:${retried.attempt}`});
        return{task:this.host.store.task(taskId),request};
      }
      if(name==='task.evidence'){
        const records=this.host.store.all<{id:string;status:string;candidate:import('../contracts/index.js').Candidate|null}>('SELECT id,status,candidate FROM integrations WHERE task_id=? ORDER BY rowid DESC LIMIT 20',taskId);
        const current: NonNullable<import('@rift/protocol').TaskEvidence['currentCandidate']>[] = [];
        const integrations=await Promise.all(records.map(async record=>{
          try {
            const operation=await this.host.git.readOperation(this.host.store.workspace(workspaceId),record.id);
            invariant(operation.taskId===taskId,'CANDIDATE_EVIDENCE_MISMATCH','Evidence belongs to another task.');
            let readiness: import('@rift/protocol').EvidenceReadiness = {status:'waiting_evidence',requiredCheckIds:[],missingCheckIds:[],blockers:[{classification:'evidence_missing',commandId:'',reason:'Candidate is not yet available.'}]};
            if(record.candidate) {
              try {
                readiness=await this.host.git.candidateReadiness({ ...evidenceContext(),candidate:record.candidate });
                if(operation.binding?.attempt===task.attempt&&operation.sourceHead===task.sourceHead&&operation.binding.candidateHead===record.candidate.candidateHead)current.push({integrationId:record.id,candidateHead:record.candidate.candidateHead,sourceHead:operation.sourceHead,taskAttempt:operation.binding.attempt});
              } catch { readiness={status:'waiting_evidence',requiredCheckIds:[],missingCheckIds:[],blockers:[{classification:'evidence_missing',commandId:'',reason:'Historical or stale candidate binding; attachments remain read-only.'}]}; }
            }
            return {id:record.id,status:record.status,candidateHead:operation.candidateHead,checkPlan:operation.checkPlan,timings:operation.timings,baselines:operation.baselines?.map(previewBaseline),checks:(operation.checks??[]).map(previewCheck),review:operation.review??null,evidenceUnavailable:false,readiness};
          } catch {return {id:record.id,status:record.status,checks:[],review:null,evidenceUnavailable:true,readiness:{status:'waiting_evidence' as const,requiredCheckIds:[],missingCheckIds:[],blockers:[{classification:'evidence_missing' as const,commandId:'',reason:'Host evidence is unavailable or its binding could not be verified.'}]}};}
        }));
        return {taskId,acceptedCommit:task.acceptedCommit,currentCandidate:current.length===1?current[0]:null,integrations} satisfies import('@rift/protocol').TaskEvidence;
      }
    }
    if(name.startsWith('skill.')) {
      const skillId=id;
      if (name==='skill.list') return { skills: this.host.skills.list(workspaceId) };
      if (name==='skill.preview') return this.host.skills.previewImport({ workspaceId, ...z.object({ directory: z.string().min(1), name: z.string().max(120).optional(), description: z.string().max(2000).optional(), skillId: z.string().max(160).optional(), expectedRevision: z.number().int().nonnegative().optional(), runtimes: z.array(z.string()).max(20).optional() }).strict().parse(body) });
      if (name==='skill.import') {
        const result = this.host.skills.saveImport({ workspaceId, ...z.object({ previewId: z.string().min(1).max(160) }).strict().parse(body) });
        return { ...result, version: { ...result.version, resources: result.version.resources.map(({ contentBase64: _content, ...resource }) => resource) } };
      }
      if (name==='skill.shared') return this.host.skills.setShared(workspaceId, skillId, z.object({ versionId: z.string().min(1).max(160), enabled: z.boolean(), expectedRevision: z.number().int().nonnegative() }).strict().parse(body));
      if (name==='skill.archive') return this.host.skills.archive(workspaceId, skillId, z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(body).expectedRevision);
    }
    if(name==='skill.effective'||name==='skill.assign') {
      const agentId=command.agentId!,skillId=id;
      if (name==='skill.effective') { const effective = installedSkills(this.host.skills,this.host.config.home,workspaceId,agentId,query.get('runtime') ?? 'dsh'); return { ...effective, resources: effective.resources.map(({ contentBase64: _content, ...resource }) => resource) }; }
      if(name==='skill.assign') return this.host.skills.setAgent(workspaceId, agentId, skillId, z.object({ mode: z.enum(['include','exclude','inherit']), versionId: z.string().min(1).max(160).optional(), expectedRevision: z.number().int().nonnegative() }).strict().parse(body));
    }
    if(['workspace.update','agent.list','agent.create','agent.update','conversation.list','conversation.create','message.list','message.send','turn.stop','turn.reconcile','turn.show','workflow.resume-attached'].includes(name)) {
      const [section,action]=name.split('.'),entityId=id;
      this.host.store.workspace(workspaceId);
      if (name==='workspace.update') {
        const input = z.object({ expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(120).optional(), leadConnection: connectionSchema.optional() }).strict().parse(body);
        if (input.leadConnection) this.host.validateChatConnection(input.leadConnection);
        return this.host.store.transaction(() => {
          const workspace = this.host.store.workspace(workspaceId) as import('../contracts/index.js').Workspace & { version: number; leadConnection: ChatConnection | null };
          invariant(workspace.version === input.expectedVersion, 'VERSION_CONFLICT', 'Workspace configuration changed.');
          this.host.store.exec('UPDATE workspaces SET name=?,lead_connection=?,version=version+1 WHERE id=?', input.name ?? workspace.name, input.leadConnection ? JSON.stringify(input.leadConnection) : workspace.leadConnection ? JSON.stringify(workspace.leadConnection) : null, workspaceId);
          return this.host.store.workspace(workspaceId);
        });
      }
      if (section==='agent') {
        if (action==='list') return { agents: this.host.store.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY name', workspaceId) };
        if (action==='create') { const input = createAgentSchema.parse(body); if (input.chatConnection) this.host.validateChatConnection(input.chatConnection); invariant([input.executionConnection, input.executionProviderName, input.providerBindingId].filter(Boolean).length <= 1, 'INVALID_CONFIG', 'Select one execution connection.'); return this.host.store.transaction(() => createBrowserAgent(this.host.store, workspaceId, { ...input, ...(input.executionConnection ? { providerBindingId: this.host.configuredExecutionBinding(workspaceId, input.executionConnection) } : input.executionProviderName ? { providerBindingId: this.host.executionBinding(workspaceId, input.executionProviderName) } : {}) })); }
        if (action==='update') { const input = updateAgentSchema.parse(body); if(this.host.store.role(entityId).purpose==='lead'){
          if(input.chatConnection)this.host.validateChatConnection(input.chatConnection);
          if(input.executionConnection)this.host.validateChatConnection(input.executionConnection);
          invariant(!input.executionProviderName&&!input.providerBindingId,'INVALID_CONFIG','Use an explicit Lead execution connection.');
          return updateBrowserAgent(this.host.store,workspaceId,entityId,input);
        } if (input.chatConnection) this.host.validateChatConnection(input.chatConnection); invariant([input.executionConnection, input.executionProviderName, input.providerBindingId].filter(Boolean).length <= 1, 'INVALID_CONFIG', 'Select one execution connection.'); return this.host.store.transaction(() => updateBrowserAgent(this.host.store, workspaceId, entityId, { ...input, ...(input.executionConnection ? { providerBindingId: this.host.configuredExecutionBinding(workspaceId, input.executionConnection) } : input.executionProviderName ? { providerBindingId: this.host.executionBinding(workspaceId, input.executionProviderName) } : {}) })); }
      }
      if (section==='conversation'||section==='message') {
        if (name==='conversation.list') return { conversations: this.host.chat.list(workspaceId) };
        if (action==='create') return this.host.chat.createConversation(workspaceId, z.object({ title: z.string().trim().min(1).max(240).default('新对话') }).strict().parse(body).title);
        if (name==='message.list') return this.host.chat.page(workspaceId, entityId, query.get('before') ?? undefined, Number(query.get('limit') ?? 50), query.get('view')==='timeline', parseTimelineRefresh(query.get('refresh')));
        if (name==='message.send') return this.host.chat.send(workspaceId, entityId, sendMessageSchema.parse(body));
      }
      if (section==='turn' && name==='turn.stop') return this.host.chat.stop(workspaceId, entityId);
      if (section==='turn' && name==='turn.reconcile') return this.host.chat.reconcile(workspaceId, entityId, z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body).expectedVersion);
      if (section==='turn' && name==='turn.show') return this.host.chat.turn(workspaceId, entityId);
      if(name==='workflow.resume-attached'){const workflow=this.host.store.workflow(id);invariant(workflow.workspaceId===workspaceId,'NOT_FOUND','Workflow does not belong to this workspace.');if(workflow.baseCommit)await this.host.ensureLead(id);return this.execute({name:'workflow.resume',id,input:body});}
    }
    if(name==='host.doctor') return this.host.doctor();
    if(name==='workspace.raw-list') return this.host.store.all('SELECT * FROM workspaces ORDER BY id');
    if(name==='workspace.create-repository') {
      const input = schemas.workspaceSchema.parse(body), repo = await this.host.git.inspectRepository(input.repositoryPath,input.baseRef), id = `workspace-${randomUUID()}`;
      const workspace = this.host.store.transaction(() => { const workspace = this.host.project.createWorkspace({ id,name:input.name,rootPath:path.join(this.host.config.home,'workspaces',id),repositoryPath:repo.rootPath,commonGitDir:repo.commonGitDir,baseRef:input.baseRef }); this.host.defaults(id); return workspace; });
      installWorkspaceSkill(this.host.store,workspace.id);
      return workspace;
    }
    if(name==='workflow.start')return this.host.createChatWorkflow(undefined,body);
    const [entity,action]=name.split('.');
    if (entity==='workspace') {
      if (action==='roles') { const input = schemas.rolesSchema.parse(body); this.host.refreshProviders(); return this.host.project.configureRoles(id,input.bindings,input.roles); }
      if (action==='archive-execute') {
        const workspace = this.host.store.workspace(id);
        if(workspace.status==='archived')return workspace;
        invariant(!this.host.store.get("SELECT id FROM workspace_worktrees WHERE workspace_id=? AND status IN ('creating','creation_unknown','moving','move_unknown')",id),'WORKSPACE_ACTIVE','Reconcile unfinished worktree operations before archiving.');
        invariant(!this.host.store.get("SELECT id FROM agent_turns WHERE workspace_id=? AND status IN ('queued','running','stopping')", id) && !this.host.store.get('SELECT id FROM execution_leases WHERE workspace_id=? AND released_at IS NULL', id), 'WORKSPACE_ACTIVE', 'Finish or stop queued discussions and confirm all execution cleanup before archiving.');
        if (this.host.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','cancelled','failed')",id)) throw new RiftError('WORKSPACE_ACTIVE','Finish or cancel the active workflow first.');
        const trees=this.host.store.all<Worktree>('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=?',id);
        for(const worktree of trees) {
          if (worktree.status === 'archived') continue;
          const expectedVersion = await this.host.repositories.removals.versionFor(id, 'task', worktree.id);
          await this.host.repositories.removals.remove(id, 'task', worktree.id, { expectedVersion, confirmDelete: true });
        }
        this.host.store.exec('UPDATE workspaces SET status=? WHERE id=?','archived',id); return this.host.store.workspace(id);
      }
    }
    if (entity==='workflow') {
      if (action==='raw-show') return this.host.coordinator.status(id);
      if (action === 'report') { const report=this.host.coordinator.status(id);const folder=path.join(this.host.config.home,'workspaces',report.workflow.workspaceId,'reports');await mkdir(folder,{recursive:true});const file=path.join(folder,`${id}.json`);await writeFile(file,JSON.stringify(report,(_key,item)=>typeof item==='string'?redact(item):item,2));return{file,report}; }
      if (action === 'plan') return this.host.coordinator.submitPlan({workflowId:id,...schemas.planForCoordinator(schemas.planSchema.parse(body))});
      if (action === 'replan') return this.host.coordinator.replan({workflowId:id,...schemas.replanSchema.parse(body)});
      if (action === 'wait') return this.host.coordinator.wait({workflowId:id,...schemas.waitSchema.parse(body)});
      if (action === 'finish') return this.host.coordinator.finish({workflowId:id,...schemas.finishSchema.parse(body)});
      if (action === 'cancel') {
        let leadError: unknown;
        try { await this.host.leads.get(id)?.agent.cancel({kind:'user'} as Parameters<Agent['cancel']>[0]); } catch (error) { leadError = error; }
        const result = await this.host.coordinator.cancelWorkflow(id);
        if (leadError) {
          this.host.store.event(id,'lead.cancel_failed',{error:publicError(leadError)});
          throw new RiftError('LEAD_CANCEL_FAILED','Workflow work was cancelled, but Lead cancellation could not be confirmed.');
        }
        return result;
      }
      if (action === 'pause'||action === 'resume') {const input=z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body); if(action==='resume'&&this.host.store.workflow(id).baseCommit&&!this.host.leads.has(id))throw new RiftError('LIVE_LEAD_REQUIRED','Attach a new Lead before resuming queues.');return this.host.coordinator[action](id,input.expectedVersion);}
      if (action === 'lead') return this.host.startLead(id,z.object({instruction:z.string().trim().min(1).max(16000).optional()}).strict().parse(body).instruction);
    }
    if (entity==='task') {
      if (action==='raw-show') return this.host.store.task(id);
      if (action === 'dispatch') return this.host.coordinator.dispatch(schemas.dispatchSchema.parse({...body as object,taskId:id}));
      if (action === 'integration') return this.host.coordinator.requestIntegration(schemas.integrationSchema.parse({...body as object,taskId:id}));
      if (action === 'retry') return this.host.coordinator.retry(schemas.retrySchema.parse({...body as object,taskId:id}));
      if (action === 'supplement-result') return this.host.coordinator.supplementResult(schemas.supplementResultSchema.parse({...body as object,taskId:id}));
      if (action === 'recover') return this.host.coordinator.recoverTask(schemas.recoverTaskSchema.parse({...body as object,taskId:id}));
      if (action === 'recover-source') return this.host.coordinator.recoverSource(schemas.recoverSourceSchema.parse({...body as object,taskId:id}));
      if (action === 'cancel') return this.host.coordinator.cancelTask(id);
    }
    if (entity==='run') {
      if (action==='raw-show') return this.host.store.run(id);
      if (action === 'logs') {const run=this.host.store.run(id);return this.host.store.events(this.host.store.task(run.taskId).workflowId).filter(event=>event.runId===id);}
      if (action === 'cancel') return this.host.coordinator.cancelRun(id);
    }
    throw new RiftError('UNKNOWN_COMMAND','Unknown application command.');
  }
}
