import { readGithubSource } from './upstream-source.js';
import { key as workspaceKey, managedPath } from '../git/worktree-binding.js';
import { normalizeExpectedPaths } from '../task/scheduler.js';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RiftHostService } from './host-service.js';
import type { AgentTurn } from '../chat/contracts.js';
import { invariant, RiftError } from '../contracts/index.js';
import { WORKSPACE_COMMANDS, workspaceCommandHelp } from '../cli/workspace-commands.js';
import { workspacePath, containsPath } from './workspace-paths.js';
import { publicError, redact } from './security.js';
import * as schemas from './schemas.js';

export interface LegacyCliActor { legacy:true; workspaceId:string; agentId:string; assertLive():void }
type CliActor=AgentTurn|LegacyCliActor;
const chatActor=(actor:CliActor|undefined):actor is AgentTurn=>!!actor&&!('legacy' in actor);
export const cliEnvelope = z.object({argv:z.array(z.string().min(1).max(160)).min(2).max(3),input:z.record(z.string(),z.unknown()).default({})}).strict();
const version = z.number().int().nonnegative();
const objectId = z.string().min(1).max(160);
const empty = z.object({}).strict();
const expected = z.object({expectedVersion:version}).strict();
const readActions = new Set(['list','show','paths','effective','evidence','logs','removals','report','read']);
/** No caller-supplied HTTP paths, identity, SQL, or credentials cross this boundary. */
export class WorkspaceCli {
  constructor(private readonly host:RiftHostService,
    private readonly route:(method:string,path:string,body:unknown)=>Promise<unknown>,
    private readonly agentCommand:(turn:AgentTurn,name:string,input:unknown)=>Promise<unknown>) {}
  async execute(workspaceId:string,raw:unknown,actor?:CliActor,key?:string):Promise<unknown> {
    const command=cliEnvelope.parse(raw),[resource,action]=command.argv;
    invariant(resource! in WORKSPACE_COMMANDS && (WORKSPACE_COMMANDS[resource as keyof typeof WORKSPACE_COMMANDS] as readonly string[]).includes(action!), 'UNKNOWN_COMMAND', JSON.stringify(workspaceCommandHelp()));
    const workspace=this.host.store.workspace(workspaceId);
    if(actor)invariant(actor.workspaceId===workspaceId,'WORKSPACE_MISMATCH','Execution workspace changed.');
    const writing=!readActions.has(action!);
    if(actor&&'legacy' in actor)actor.assertLive();
    if(chatActor(actor))this.host.orchestration.authorize(actor,writing&&['workflow','plan','task','integration'].includes(resource!));
    if(writing)invariant(workspace.status==='active','WORKSPACE_ARCHIVED','Workspace is archived.');
    // Agent writes are durable and keyed by workspace + agent, never by untrusted scope.
    const receiptKey=actor&&writing?`workspace-cli:${workspaceId}:${actor.agentId}:${z.string().min(1).max(160).parse(key)}`:undefined;
    const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex');
    if(receiptKey){
      const prior=this.host.store.get<{fingerprint:string;status:string;response:string|null}>('SELECT * FROM management_requests WHERE key=?',receiptKey);
      if(prior){invariant(prior.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT','Key was used for another command.');invariant(prior.status==='completed','REQUEST_PENDING','Inspect state before retrying an uncertain command.');const saved=JSON.parse(prior.response!);if(saved.error)throw new RiftError(saved.error.code,saved.error.message);return saved.value;}
      this.host.store.exec("INSERT INTO management_requests(key,fingerprint,status) VALUES(?,?,'pending')",receiptKey,fingerprint);
    }
    try {
      const value=await this.dispatch(workspaceId,command,actor);
      const output=JSON.parse(JSON.stringify(value??null, (name,item)=> ['providerSnapshot','credentialRefs','runtimeBootId','hostCapacity','globalSlots'].includes(name)?undefined:typeof item==='string'?redact(item):item));
      if(receiptKey)this.host.store.exec("UPDATE management_requests SET status='completed',response=? WHERE key=?",JSON.stringify({value:output}),receiptKey);
      return output;
    }catch(error){if(receiptKey)this.host.store.exec("UPDATE management_requests SET status='completed',response=? WHERE key=?",JSON.stringify({error:publicError(error)}),receiptKey);throw error;}
  }
  private async dispatch(w:string,{argv,input:b}:z.infer<typeof cliEnvelope>,actor?:CliActor):Promise<unknown> {
    const [r,a,id]=argv, h=this.host,s=h.store;
    const need=()=>objectId.parse(id), enc=(value:string)=>encodeURIComponent(value), base=`/ui-api/v1/workspaces/${enc(w)}`;
    const ui=(method:string,suffix:string,body:unknown=b)=>this.route(method,base+suffix,body);
    const workflow=(value=need())=>{const item=s.workflow(value);invariant(item.workspaceId===w,'NOT_FOUND','Workflow does not belong to this workspace.');return item;};
    const task=(value=need())=>{const item=s.task(value);workflow(item.workflowId);return item;};
    const run=()=>{const item=s.run(need());task(item.taskId);return item;};
    const role=(value=need())=>{const item=s.role(value);invariant(item.workspaceId===w,'NOT_FOUND','Agent does not belong to this workspace.');return item;};
    const noId=()=>invariant(id===undefined,'INVALID_INPUT','This command does not accept an object id.');
    const current=()=>{const row=s.require<{id:string}>("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')",w);return workflow(row.id);};
    const legacy=(entity:string,entityId:string,action?:string,method='POST',body:unknown=b)=>this.route(method,`/v1/${entity}/${enc(entityId)}${action?`/${action}`:''}`,body);
    const versionCheck=(actual:number,expected:number)=>invariant(actual===expected,'VERSION_CONFLICT','Object changed; read it again.');
    // Any embedded id checked here remains checked again by its business service.
    if(r==='source'){noId();return readGithubSource(z.object({url:z.string().min(1).max(2048),maxBytes:z.number().int().min(1).max(131072).default(65536)}).strict().parse(b));}
    if(r==='workspace'){
      noId();
      if(a==='show'){empty.parse(b);return ui('GET','');}
      if(a==='update')return ui('PATCH','');
      if(a==='archive'){empty.parse(b);return legacy('workspaces',w,'archive');}
      if(a==='paths'){empty.parse(b);return {grants:s.all('SELECT path FROM workspace_path_grants WHERE workspace_id=?',w),repositories:h.repositories.list(w).map(x=>x.canonicalPath)};}
      invariant(!actor,'OPERATOR_REQUIRED','Path grants are set by the Host operator, not by workspace agents.');
      const input=z.object({path:z.string().min(1)}).strict().parse(b),directory=realpathSync(input.path);
      invariant(path.isAbsolute(input.path)&&directory!==path.parse(directory).root&&!containsPath(directory,path.resolve(h.config.home))&&!containsPath(path.resolve(h.config.home),directory),'PATH_SCOPE','Grant a dedicated project/resource directory, separate from Host state.');
      for(const other of s.all<{canonicalPath:string}>('SELECT canonical_path FROM repositories WHERE workspace_id<>?',w))invariant(!containsPath(directory,other.canonicalPath)&&!containsPath(other.canonicalPath,directory),'PATH_SCOPE','Grant overlaps another workspace.');
      if(a==='grant-path')s.exec('INSERT OR IGNORE INTO workspace_path_grants(workspace_id,path) VALUES(?,?)',w,directory);
      else s.exec('DELETE FROM workspace_path_grants WHERE workspace_id=? AND path=?',w,directory);
      return {path:directory,granted:a==='grant-path'};
    }
    if(r==='agent'){
      if(a==='list'){noId();empty.parse(b);return ui('GET','/agents');}
      if(a==='create'){noId();return ui('POST','/agents');}
      const member=role();
      if(a==='show'){empty.parse(b);return member;}
      if(a==='update')return ui('PATCH',`/agents/${enc(need())}`);
      const input=expected.parse(b);return ui('PATCH',`/agents/${enc(need())}`,{...input,enabled:a==='enable'});
    }
    if(r==='connection'){
      noId();empty.parse(b);
      // Only the workspace's current, nonsecret bindings; never the global API catalogue.
      const detail=await ui('GET','') as {bindings:unknown;leadConfiguration:unknown};
      return {bindings:detail.bindings,lead:detail.leadConfiguration};
    }
    if(r==='repository'){
      if(a==='list'){noId();empty.parse(b);return {repositories:h.repositories.list(w)};}
      if(a==='connect'){noId();const input=z.object({repositoryPath:z.string(),baseRef:z.string().default('HEAD'),expectedVersion:version}).strict().parse(b);input.repositoryPath=workspacePath(s,w,input.repositoryPath,h.config.home);
        return h.repositories.connect(w,input,inspected=>{
          invariant(inspected.rootPath===input.repositoryPath,'PATH_SCOPE','Register the exact Git root; a granted subdirectory does not grant its parent repository.');
          workspacePath(s,w,inspected.commonGitDir,h.config.home);
          if(actor&&'legacy' in actor)actor.assertLive();
          if(chatActor(actor))invariant(h.chat.turn(w,actor.id).status==='running','UNAUTHORIZED','This command execution has stopped.');
        });}
      const repo=h.repositories.get(w,need());
      if(a==='show'){empty.parse(b);return repo;}
      const input=z.object({expectedVersion:version,baseRef:z.string().min(1).optional()}).strict().parse(b);
      const ws=s.workspace(w);versionCheck(ws.version!,input.expectedVersion);
      invariant(!s.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')",w)&&!s.get('SELECT id FROM execution_leases WHERE workspace_id=? AND released_at IS NULL',w),'CONFIG_IN_USE','Repository configuration has active executions.');
      if(a==='update'){
        invariant(input.baseRef,'INVALID_INPUT','baseRef is required.');await h.git.inspectRepository(repo.canonicalPath,input.baseRef);
        return s.transaction(()=>{versionCheck(s.workspace(w).version!,input.expectedVersion);s.exec('UPDATE repositories SET base_ref=? WHERE id=?',input.baseRef!,repo.id);s.exec('UPDATE workspaces SET version=version+1 WHERE id=?',w);return h.repositories.get(w,repo.id);});
      }
      invariant(!s.get('SELECT repository_id FROM workflow_repositories WHERE repository_id=?',repo.id)&&!s.get('SELECT id FROM workspace_worktrees WHERE repository_id=?',repo.id),'RESOURCE_REFERENCED','Repository history/worktrees still reference this association.');
      s.transaction(()=>{s.exec('UPDATE workspaces SET default_repository_id=NULL,version=version+1 WHERE id=? AND default_repository_id=?',w,repo.id);s.exec('DELETE FROM repositories WHERE id=? AND workspace_id=?',repo.id,w);s.exec('UPDATE workspaces SET default_repository_id=COALESCE(default_repository_id,(SELECT id FROM repositories WHERE workspace_id=? ORDER BY id LIMIT 1)),version=version+1 WHERE id=?',w,w);});return {disconnected:repo.id};
    }
    if(r==='worktree'){
      if(['list','create','removals'].includes(a!)){
        const repo=h.repositories.get(w,need());
        if(a==='list'||a==='removals'){empty.parse(b);const result=await ui('GET',`/repositories/${enc(repo.id)}/worktrees`) as any;result.discovered=result.discovered.filter((entry:{path:string})=>{try{workspacePath(s,w,entry.path,h.config.home);return true;}catch{return false;}});return result;}
        const input=z.object({origin:z.enum(['managed','external']),path:z.string().optional(),baseRef:z.string().optional(),branch:z.string().max(200).optional()}).strict().parse(b);
        if(input.origin==='external')input.path=workspacePath(s,w,z.string().parse(input.path),h.config.home);
        else if(input.path)input.path=await managedPath(path.resolve(h.config.home,'workspaces',workspaceKey(w)),input.path);
        return ui('POST',`/repositories/${enc(repo.id)}/worktrees`,input);
      }
      if(a==='delete'||a==='reconcile-delete'){
        const input=z.object({kind:z.enum(['user','task','candidate','review']),expectedVersion:z.string().min(1),confirmDelete:z.literal(true).optional()}).strict().parse(b);
        return ui('POST',`/worktree-removals/${input.kind}/${enc(need())}/${a==='delete'?'delete':'reconcile'}`,{expectedVersion:input.expectedVersion,...a==='delete'?{confirmDelete:input.confirmDelete}:{}});
      }
      if(a==='takeover'&&b.destinationPath!==undefined)b={...b,destinationPath:await managedPath(path.resolve(h.config.home,'workspaces',workspaceKey(w)),z.string().parse(b.destinationPath))};
      return ui('POST',`/worktrees/${enc(need())}/${a}`);
    }
    if(r==='workflow'){
      if(a==='list'){noId();empty.parse(b);return {workflows:s.all('SELECT * FROM workflows WHERE workspace_id=? ORDER BY rowid DESC',w)};}
      if(a==='start'){noId();if(chatActor(actor))return this.agentCommand(actor,'rift_workflow_start',b);return this.route('POST','/v1/workflows',schemas.workflowSchema.parse({...b,workspaceId:w}));}
      const item=workflow();
      if(a==='yield')invariant(chatActor(actor),'EXECUTION_REQUIRED','Yield requires a live coordinating chat execution.');
      if(a==='show'||a==='report'){empty.parse(b);return h.coordinator.status(item.id);}
      if(chatActor(actor)&&['finish','wait','yield'].includes(a!)){invariant(current().id===item.id,'INVALID_STATE','Select the active workflow.');return this.agentCommand(actor,`rift_${a==='finish'?'workflow_finish':a==='yield'?'yield':'wait'}`,b);}
      if(a==='resume')return ui('POST',`/workflows/${enc(item.id)}/resume`);
      return legacy('workflows',item.id,a);
    }
    if(r==='plan'){
      const item=workflow();if(chatActor(actor)){invariant(current().id===item.id,'INVALID_STATE','Select the active workflow.');return this.agentCommand(actor,`rift_plan_${a}`,b);}
      return legacy('workflows',item.id,a==='submit'?'plan':'replan');
    }
    if(r==='task'){
      if(a==='list'){noId();const input=z.object({status:z.string().optional(),workflowId:objectId.optional(),roleId:objectId.optional(),repositoryId:objectId.optional(),kind:z.enum(['change','analysis']).optional(),limit:z.number().int().min(1).max(100).optional(),after:version.optional()}).strict().parse(b);return ui('GET','/tasks?'+new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])),{});}
      if(a==='delegate'){noId();invariant(chatActor(actor),'EXECUTION_REQUIRED','Delegation requires a live member execution; operators use plan + dispatch.');return this.agentCommand(actor,'rift_delegate',b);}
      const item=task();
      if(a==='show'||a==='evidence'){empty.parse(b);return ui('GET',`/tasks/${enc(item.id)}${a==='evidence'?'/evidence':''}`);}
      if(a==='update'){
        const input=z.object({expectedVersion:version,title:z.string().min(1).max(240).optional(),instructions:z.string().min(1).max(32000).optional(),expectedPaths:z.array(z.string()).max(100).optional(),acceptanceCriteria:z.array(z.string()).max(100).optional()}).strict().parse(b);
        return s.transaction(()=>{const latest=task();versionCheck(latest.version,input.expectedVersion);invariant(['pending','ready'].includes(latest.status)&&!s.get('SELECT id FROM runs WHERE task_id=?',latest.id)&&!s.get('SELECT id FROM operations WHERE entity_id=?',latest.id),'TASK_STARTED','Only undispatched tasks can be edited.');
          if(input.expectedPaths){input.expectedPaths=normalizeExpectedPaths(input.expectedPaths);invariant(latest.repositoryId||input.expectedPaths.length===0,'INVALID_PATH','Text analysis has no filesystem write paths.');}
          s.exec('UPDATE tasks SET title=?,instructions=?,expected_paths=?,acceptance_criteria=?,version=version+1 WHERE id=?',input.title??latest.title,input.instructions??latest.instructions,JSON.stringify(input.expectedPaths??latest.expectedPaths),JSON.stringify(input.acceptanceCriteria??latest.acceptanceCriteria),latest.id);s.event(latest.workflowId,'task.updated',{}, {taskId:latest.id});return task();});
      }
      if(chatActor(actor)&&a==='dispatch'){invariant(current().id===item.workflowId,'INVALID_STATE','Select the active workflow.');return this.agentCommand(actor,'rift_task_dispatch',{...b,taskId:item.id});}
      return legacy('tasks',item.id,a);
    }
    if(r==='run'){
      if(a==='list'){noId();empty.parse(b);return {runs:s.all('SELECT r.id,r.task_id,r.role_id,r.purpose,r.status,r.version,r.cleanup_status,r.slot_released_at,r.created_at,r.ended_at FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY r.rowid',w)};}
      const item=run();
      if(a==='reconcile')return ui('POST',`/runs/${enc(item.id)}/reconcile`);
      if(a==='show'||a==='logs'){empty.parse(b);return legacy('runs',item.id,a==='logs'?a:undefined,'GET');}
      empty.parse(b);return legacy('runs',item.id,'cancel');
    }
    if(r==='integration'){
      if(a==='list'){noId();empty.parse(b);return {integrations:s.all('SELECT i.id,i.task_id,i.status,i.candidate_head,i.source_head,i.error FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY i.rowid',w)};}
      if(a==='request'){const item=task();return legacy('tasks',item.id,'integration');}
      const item=s.require<{taskId:string}>('SELECT task_id FROM integrations WHERE id=?',need());task(item.taskId);return ui('POST',`/integrations/${enc(need())}/reconcile`);
    }
    if(r==='conversation'){
      if(a==='list'){noId();empty.parse(b);return ui('GET','/conversations');}
      if(a==='create'){noId();return ui('POST','/conversations');}
      const item=s.require<{id:string;version:number}>('SELECT * FROM conversations WHERE workspace_id=? AND id=?',w,need());
      if(a==='show'){empty.parse(b);return item;}
      const input=z.object({expectedVersion:version,title:z.string().trim().min(1).max(240).optional()}).strict().parse(b);
      return s.transaction(()=>{versionCheck(item.version,input.expectedVersion);
        if(a==='rename'){invariant(input.title,'INVALID_INPUT','title is required.');s.exec('UPDATE conversations SET title=?,version=version+1 WHERE id=?',input.title,item.id);}
        else{invariant(!s.get("SELECT id FROM agent_turns WHERE conversation_id=? AND status IN ('queued','running','stopping')",item.id)&&!s.get('SELECT l.id FROM execution_leases l JOIN agent_turns t ON t.id=l.owner_id WHERE l.owner_type=\'turn\' AND t.conversation_id=? AND l.released_at IS NULL',item.id)&&!s.get("SELECT c.workflow_id FROM workflow_conversations c JOIN workflows f ON f.id=c.workflow_id WHERE c.conversation_id=? AND f.status NOT IN ('completed','failed','cancelled')",item.id),'CONFIG_IN_USE','Conversation has unfinished work.');s.exec('UPDATE conversations SET archived=1,version=version+1 WHERE id=?',item.id);s.exec('UPDATE workspaces SET default_conversation_id=(SELECT id FROM conversations WHERE workspace_id=? AND archived=0 ORDER BY created_at DESC,id LIMIT 1),version=version+1 WHERE id=? AND default_conversation_id=?',w,w,item.id);}
        return s.require('SELECT * FROM conversations WHERE id=?',item.id);});
    }
    if(r==='message'){
      if(a==='retry-delivery')return ui('POST',`/messages/${enc(need())}/retry-delivery`);
      s.require('SELECT id FROM conversations WHERE workspace_id=? AND id=?',w,need());
      if(a==='list'){const input=z.object({before:objectId.optional(),limit:z.number().int().min(1).max(100).optional()}).strict().parse(b);return ui('GET',`/conversations/${enc(need())}/messages?`+new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])),{});}
      if(actor&&!chatActor(actor))throw new RiftError('EXECUTION_REQUIRED','Use a member chat execution for collaboration messages.');
      if(chatActor(actor)){invariant(actor.conversationId===id,'INVALID_INPUT','Member messages use the current conversation.');return this.agentCommand(actor,'rift_send_message',b);}
      return ui('POST',`/conversations/${enc(need())}/messages`);
    }
    if(r==='turn'){if(a==='show'){empty.parse(b);return ui('GET',`/turns/${enc(need())}`);}return ui('POST',`/turns/${enc(need())}/${a}`);}
    if(r==='skill'){
      if(a==='list'){noId();empty.parse(b);return {skills:h.skills.list(w)};}
      if(a==='preview'){noId();const directory=workspacePath(s,w,z.string().parse(b.directory),h.config.home);return ui('POST','/skills/preview',{...b,directory});}
      if(a==='import'){noId();return ui('POST','/skills/import');}
      if(a==='discard-preview'){empty.parse(b);h.skills.discardPreview(w,need());return {discarded:id};}
      if(a==='effective'){const member=role();const input=z.object({runtime:z.string().default('dsh')}).strict().parse(b);return ui('GET',`/agents/${enc(member.id)}/skills/effective?runtime=${enc(input.runtime)}`,{});}
      const skill=h.skills.list(w).find(skill=>skill.id===need());invariant(skill,'NOT_FOUND','Skill does not belong to this workspace.');
      if(a==='show'){empty.parse(b);return skill;}
      if(a==='shared')return ui('PUT',`/skills/${enc(skill.id)}/shared`);
      if(a==='assign'){const {agentId,...input}=z.object({agentId:objectId,mode:z.enum(['include','exclude','inherit']),versionId:objectId.optional(),expectedRevision:version}).strict().parse(b);role(agentId);return ui('PUT',`/agents/${enc(agentId)}/skills/${enc(skill.id)}`,input);}
      if(a==='restore'){const input=z.object({expectedRevision:version}).strict().parse(b);versionCheck(skill.revision,input.expectedRevision);s.exec('UPDATE skills SET archived=0,revision=revision+1 WHERE id=?',skill.id);return h.skills.list(w).find(x=>x.id===skill.id);}
      return ui('POST',`/skills/${enc(skill.id)}/archive`);
    }
    if(r==='event'){noId();const input=z.object({after:version.default(0)}).strict().parse(b);return h.browserEvents(w,input.after);}
    if(r==='queue'){noId();empty.parse(b);return {operations:s.all('SELECT o.* FROM operations o JOIN tasks t ON t.id=o.entity_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY o.rowid',w),leases:s.all('SELECT owner_type,owner_id,agent_id,capacity,cleanup_status FROM execution_leases WHERE workspace_id=? AND released_at IS NULL',w)};}
    if(r==='diagnostic'){noId();empty.parse(b);return {workspace:await ui('GET',''),queues:await this.dispatch(w,{argv:['queue','list'],input:{}},actor)};}
    throw new RiftError('UNKNOWN_COMMAND','Unknown workspace command.');
  }
}
