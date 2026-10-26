import { bindingConnection } from '../agent/execution-connection.js';
import type { ProviderBinding, Role, Workflow } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import type { UiBinding, UiCapabilities, UiIntegration, UiPresence, UiRun, UiTask, UiWorkspaceDetail, UiWorkspaceList, UiWorkspaceSummary } from './ui-contracts.js';
import type { AgentTurn, ChatConnection } from '../chat/contracts.js';
import type { BrowserAgent } from '../project/browser-agents.js';
import { invariant } from '../contracts/index.js';

const unavailable = (reason: string) => ({ available: false, reason });
export function uiCapabilities(): UiCapabilities {
  return {
    workspaceCreate: { available: true, reason: 'Start with one Lead, one developer and one reviewer, with an optional Git repository. Code execution requires executable developer/reviewer connections.' },
    chat: { available: true, reason: 'Persistent conversations and explicit recipient routing; requires a registered connection. Output is buffered until settled for credential redaction.' },
    agentConfiguration: { available: true, reason: 'Stable Agent IDs, display names and versioned discussion connections. Existing execution snapshots remain immutable.' },
    skills: { available: true, reason: 'Versioned instructions and assignments. Resource/script Skills require verified runtime support.' },
    multipleRepositories: { available: true, reason: 'Each workflow freezes its selected repository commits; every task selects exactly one repository.' },
    worktreeManagement: { available: true, reason: 'Managed worktrees support guarded creation/archival. External worktrees are read-only associations until explicit clean takeover into the managed root.' },
    workflowActions: { available: true, reason: 'Scoped pause, resume and cancel reuse the existing execution gates.' },
    events: { available: true, reason: 'Workspace SSE supports a global cursor and 10,000-event replay window; expired cursors require a fresh snapshot.' },
    pagination: { available: true, reason: 'Task and conversation APIs support bounded keyset pages and database snapshot cursors.' },
  };
}

export function workspaceTasks(store: RiftStore, workspaceId: string, query: URLSearchParams) {
  store.workspace(workspaceId);
  const limit=Number(query.get('limit')??50),after=Number(query.get('after')??0);
  invariant(Number.isInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(after)&&after>=0,'INVALID_PAGE','Use a limit of 1–100 and a nonnegative task cursor.');
  const statuses=query.get('status')?.split(',')??[];
  invariant(statuses.length<=10&&statuses.every(status=>['pending','ready','running','validating','integrating','succeeded','blocked','failed','cancelled'].includes(status)),'INVALID_FILTER','Unknown task status.');
  const clauses=['f.workspace_id=?'],values:(string|number)[]=[workspaceId];
  for(const [param,column] of [['workflowId','t.workflow_id'],['roleId','t.role_id'],['repositoryId','t.repository_id']] as const){
    const value=query.get(param);if(!value)continue;
    if(param==='workflowId')invariant(store.workflow(value).workspaceId===workspaceId,'NOT_FOUND','Workflow filter does not belong to this workspace.');
    if(param==='roleId')invariant(store.role(value).workspaceId===workspaceId,'NOT_FOUND','Agent filter does not belong to this workspace.');
    if(param==='repositoryId')invariant(store.get('SELECT id FROM repositories WHERE id=? AND workspace_id=?',value,workspaceId),'NOT_FOUND','Repository filter does not belong to this workspace.');
    clauses.push(`${column}=?`);values.push(value);
  }
  const kind=query.get('kind');if(kind){invariant(['change','analysis'].includes(kind),'INVALID_FILTER','Unknown task kind.');clauses.push('t.kind=?');values.push(kind);}
  if(statuses.length){clauses.push(`t.status IN (${statuses.map(()=>'?').join(',')})`);values.push(...statuses);}
  return store.transaction(()=>{
    const where=clauses.join(' AND ');
    const totalCount=store.require<{count:number}>(`SELECT COUNT(*) AS count FROM tasks t JOIN workflows f ON f.id=t.workflow_id WHERE ${where}`,...values).count;
    const rows=store.all<UiTask & {rowNumber:number}>(`SELECT t.*,t.rowid AS row_number FROM tasks t JOIN workflows f ON f.id=t.workflow_id WHERE ${where} AND t.rowid>? ORDER BY t.rowid LIMIT ?`,...values,after,limit+1);
    const more=rows.length>limit;rows.splice(limit);
    const nextAfter=more?String(rows.at(-1)!.rowNumber):null;
    const tasks=rows.map(({rowNumber:_position,...task})=>({...task,dependsOn:store.all<{dependsOnTaskId:string}>('SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id',task.id).map(row=>row.dependsOnTaskId)}));
    return {tasks,nextAfter,totalCount,snapshotCursor:store.require<{cursor:number}>('SELECT COALESCE(MAX(seq),0) AS cursor FROM workspace_events').cursor,observedAt:new Date().toISOString()};
  });
}

function summary(store: RiftStore, id: string): UiWorkspaceSummary {
  return {
    ...store.workspace(id) as UiWorkspaceSummary,
    workflowCount: store.require<{count:number}>('SELECT COUNT(*) AS count FROM workflows WHERE workspace_id=?', id).count,
    activeWorkflowId: store.get<{id:string}>("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", id)?.id ?? null,
    taskCount: store.require<{count:number}>('SELECT COUNT(*) AS count FROM tasks t JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=?', id).count,
  };
}

export function workspaceList(store: RiftStore): UiWorkspaceList {
  return store.transaction(() => ({
    workspaces: store.all<{id:string}>('SELECT id FROM workspaces ORDER BY name,id').map(row => summary(store, row.id)),
    capabilities: uiCapabilities(), observedAt: new Date().toISOString(),
  }));
}

/** Conservative ledger projection: absence of a live Run never proves idle. */
export function workspaceDetail(store: RiftStore, id: string, providers: ReadonlySet<string>, lead: {provider: string; model: string}): UiWorkspaceDetail {
  return store.transaction(() => {
    const workspace = summary(store, id), observedAt = new Date().toISOString();
    const roles = store.all<BrowserAgent>('SELECT *,COALESCE(display_name,name) AS display_name FROM roles WHERE workspace_id=? ORDER BY name', id);
    const bindings = store.all<ProviderBinding>('SELECT DISTINCT b.* FROM provider_bindings b JOIN roles r ON r.provider_binding_id=b.id WHERE r.workspace_id=? ORDER BY b.id', id).map((binding): UiBinding => ({
      id: binding.id, providerName: binding.providerName, packageVersion: binding.packageVersion,
      configRevision: binding.configRevision, capabilities: binding.capabilities, runtime: binding.runtime ?? null,
      executionConnection: bindingConnection(binding),
      model: binding.spawn?.model ?? binding.model ?? null, registered: providers.has(binding.providerName), authentication: 'not-verified',
    }));
    const workflows = store.all<Workflow>('SELECT * FROM workflows WHERE workspace_id=? ORDER BY rowid DESC', id);
    const tasks = store.all<UiTask>('SELECT t.* FROM tasks t JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY t.rowid', id).map(task => ({
      ...task, dependsOn: store.all<{dependsOnTaskId:string}>('SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id', task.id).map(row => row.dependsOnTaskId),
    }));
    // Deliberately exclude providerSnapshot/result: these may contain runtime credentials or arbitrary provider output.
    const runs = store.all<UiRun>('SELECT r.id,r.task_id,r.role_id,r.purpose,r.status,r.version,r.cleanup_status,r.slot_released_at,r.created_at,r.started_at,r.ended_at,r.stop_reason FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY r.created_at,r.id', id);
    const integrations = store.all<UiIntegration & {candidate: {cwd?:string} | null;runtimeBootId:string|null}>('SELECT i.* FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY i.rowid', id).map(({candidate,runtimeBootId:_boot, ...integration}) => ({ ...integration, candidatePath: candidate?.cwd ?? null }));
    const queued = store.all<{taskId:string;roleId:string | null}>("SELECT t.id AS task_id,COALESCE(json_extract(o.payload,'$.roleId'),t.role_id) AS role_id FROM operations o JOIN tasks t ON t.id=o.entity_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? AND o.phase='queued'", id);
    const presence = roles.map((role): UiPresence => {
      const active = runs.filter(run => run.roleId === role.id && run.slotReleasedAt === null);
      const turns = store.all<AgentTurn>("SELECT * FROM agent_turns WHERE agent_id=? AND (status IN ('queued','running','stopping') OR EXISTS(SELECT 1 FROM execution_leases l WHERE l.owner_type='turn' AND l.owner_id=agent_turns.id AND l.released_at IS NULL)) ORDER BY rowid", role.id);
      const queue = queued.filter(item => item.roleId === role.id);
      const binding = bindings.find(item => item.id === role.providerBindingId);
      const latestTurn=store.get<AgentTurn>('SELECT * FROM agent_turns WHERE agent_id=? ORDER BY rowid DESC LIMIT 1',role.id);
      const legacyLead=role.kind==='dsh-lead'&&workflows.some(workflow=>!['completed','failed','cancelled'].includes(workflow.status)&&workflow.leadSessionId);
      let state: UiPresence['state'] = 'unknown', reason = 'No live execution evidence; runtime availability and idleness are not verified.';
      if (turns.some(turn => turn.cleanupStatus === 'unknown') || active.some(run => ['unknown','failed'].includes(run.cleanupStatus) || ['interrupted','failed','cancelled','succeeded'].includes(run.status))) { state = 'cleanup_unknown'; reason = 'An execution still owns an unreleased lease; cleanup requires confirmation.'; }
      else if (turns.some(turn => turn.status === 'stopping') || active.some(run => run.status === 'cancelling')) { state = 'stopping'; reason = 'The ledger records cancellation in progress.'; }
      else if (turns.some(turn => turn.status === 'running') || active.length) { state = 'running'; reason = 'The ledger records an active Turn or Run.'; }
      else if (role.enabled === 0) { state = 'disabled'; reason = 'This role is disabled.'; }
      else if (turns.some(turn => turn.status === 'queued') || queue.length) { state = 'queued'; reason = 'A durable queued message or operation references this role.'; }
      else if (role.kind === 'subagent' && !binding?.registered && !role.chatConnection) { state = 'unavailable'; reason = 'The configured provider is not registered in this Host.'; }
      else if(latestTurn&&['completed','failed','cancelled','interrupted'].includes(latestTurn.status)&&latestTurn.cleanupStatus==='confirmed'&&!legacyLead){state='idle';reason=`Last recorded discussion ${latestTurn.status}; cleanup is confirmed and no execution lease remains. Runtime authentication is separate.`;}
      else if (role.kind === 'dsh-lead') reason = 'Lead lifecycle is not persisted. An attached session alone does not prove activity or idleness.';
      return { roleId: role.id, state, reason, runIds: active.map(run => run.id), turnIds: turns.map(turn => turn.id), taskIds: [...new Set([...active.map(run => run.taskId), ...queue.map(item => item.taskId)])], observedAt };
    });
    return {
      workspace, roles, bindings, workflows, tasks, runs, integrations, presence, observedAt, capabilities: uiCapabilities(), leadConfiguration: workspace.leadConnection ? { source: 'workspace', runtime: workspace.leadConnection.runtime, provider: workspace.leadConnection.provider ?? '', model: workspace.leadConnection.model } : { source: 'host', runtime: 'dsh', ...lead },
      conversations: store.all('SELECT * FROM conversations WHERE workspace_id=? ORDER BY created_at DESC,id', id),
      snapshotCursor: store.require<{cursor:number}>('SELECT COALESCE(MAX(seq),0) AS cursor FROM workspace_events').cursor,
      managedWorktrees: store.all<import('../project/repositories.js').WorkspaceWorktree & {runtimeBootId:string|null}>('SELECT * FROM workspace_worktrees WHERE workspace_id=? ORDER BY created_at,id',id).map(({runtimeBootId:_boot,...tree})=>tree),
      workflowRepositories: store.all('SELECT r.* FROM workflow_repositories r JOIN workflows f ON f.id=r.workflow_id WHERE f.workspace_id=? ORDER BY f.rowid,r.repository_id',id),
      hostCapacity: { limits: store.require('SELECT developers,1 AS reviewers,total,lead_turns AS lead FROM scheduler_limits WHERE id=1'), occupied: store.require("SELECT COALESCE(SUM(capacity='developer'),0) AS developers,COALESCE(SUM(capacity='reviewer'),0) AS reviewers,COALESCE(SUM(capacity<>'lead'),0) AS total,COALESCE(SUM(capacity='lead'),0) AS lead FROM execution_leases WHERE released_at IS NULL") },
      repositories: store.all('SELECT * FROM repositories WHERE workspace_id=? ORDER BY id', id),
      worktrees: store.all('SELECT w.* FROM worktrees w JOIN tasks t ON t.id=w.task_id JOIN workflows f ON f.id=t.workflow_id WHERE f.workspace_id=? ORDER BY w.id', id),
    };
  });
}
