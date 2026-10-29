import { RiftError } from '../contracts/index.js';
import type { ApplicationCommand } from '../application/commands.js';

/** Explicit transport allowlist. Session, static assets and SSE stay in local-api. */
export const HTTP_COMMAND_ROUTES: {method:string;path:string;name:string}[] = [];
const route=(method:string,path:string,name:string)=>HTTP_COMMAND_ROUTES.push({method,path,name});
for(const prefix of ['/v1','/ui-api/v1']) {
  route('GET',`${prefix}/connections`,'connection.catalogue');
  route('POST',`${prefix}/connections`,'connection.create');
  route('POST',`${prefix}/connections/:id/verify`,'connection.verify');
  route('DELETE',`${prefix}/connections/:id`,'connection.delete');
  route('POST',`${prefix}/workspaces`,'workspace.create');
  route('POST',`${prefix}/workspaces/:workspaceId/archive`,'workspace.archive');
}
route('GET','/v1/doctor','host.doctor');
route('GET','/v1/workspace-summaries','workspace.list');
route('GET','/v1/workspaces','workspace.raw-list');
route('POST','/v1/workspaces/:workspaceId/cli','workspace.cli');
route('PUT','/v1/workspaces/:id/roles','workspace.roles');
route('POST','/v1/workflows','workflow.start');
for(const [entity,actions] of Object.entries({
  workflow:['plan','replan','wait','finish','cancel','pause','resume','lead'],
  task:['dispatch','integration','retry','recover-source','supplement-result','recover','cancel'],run:['cancel'],
})) {
  route('GET',`/v1/${entity}s/:id`,`${entity}.raw-show`);
  for(const action of actions)route('POST',`/v1/${entity}s/:id/${action}`,`${entity}.${action}`);
}
route('GET','/v1/workflows/:id/report','workflow.report');
route('GET','/v1/runs/:id/logs','run.logs');
const w='/ui-api/v1/workspaces/:workspaceId';
route('GET','/ui-api/v1/workspaces','workspace.list');
route('GET',w,'workspace.show');
route('GET',`${w}/snapshot`,'workspace.show');
route('PATCH',w,'workspace.update');
for(const [section,resource] of [['agents','agent'],['conversations','conversation'],['repositories','repository'],['skills','skill']] as const) {
  route('GET',`${w}/${section}`,`${resource}.list`);
  if(resource!=='skill')route('POST',`${w}/${section}`,`${resource}.${resource==='repository'?'connect':'create'}`);
}
route('PATCH',`${w}/agents/:id`,'agent.update');
for(const method of ['GET','POST'])route(method,`${w}/conversations/:id/messages`,`message.${method==='GET'?'list':'send'}`);
route('POST',`${w}/messages/:id/retry-delivery`,'message.retry-delivery');
route('GET',`${w}/turns/:id`,'turn.show');
for(const action of ['stop','reconcile'])route('POST',`${w}/turns/:id/${action}`,`turn.${action}`);
route('GET',`${w}/tasks`,'task.list');
route('GET',`${w}/tasks/:id`,'task.show');
route('GET',`${w}/tasks/:id/evidence`,'task.evidence');
route('POST',`${w}/tasks/:id/evidence`,'task.supplement-evidence');
route('GET',`${w}/tasks/:id/evidence/log`,'task.evidence-log');
route('GET','/v1/workspaces/:workspaceId/tasks/:id/evidence','task.evidence');
route('POST','/v1/workspaces/:workspaceId/tasks/:id/evidence','task.supplement-evidence');
route('GET','/v1/workspaces/:workspaceId/tasks/:id/evidence/log','task.evidence-log');
route('POST',`${w}/tasks/:id/retry`,'task.retry-dispatch');
route('POST',`${w}/runs/:id/reconcile`,'run.reconcile');
route('POST',`${w}/integrations/:id/reconcile`,'integration.reconcile');
for(const action of ['pause','resume','cancel','replan'])route('POST',`${w}/workflows/:id/${action}`,`workflow.${action==='resume'?'resume-attached':action}`);
for(const method of ['GET','POST'])route(method,`${w}/repositories/:id/worktrees`,`worktree.${method==='GET'?'list':'create'}`);
for(const action of ['archive','detach','takeover','reconcile'])route('POST',`${w}/worktrees/:id/${action}`,`worktree.${action}`);
for(const action of ['delete','reconcile'])route('POST',`${w}/worktree-removals/:kind/:id/${action}`,`worktree.${action==='delete'?'delete':'reconcile-delete'}`);
for(const action of ['preview','import'])route('POST',`${w}/skills/${action}`,`skill.${action}`);
route('PUT',`${w}/skills/:id/shared`,'skill.shared');
route('POST',`${w}/skills/:id/archive`,'skill.archive');
route('GET',`${w}/agents/:agentId/skills/effective`,'skill.effective');
route('PUT',`${w}/agents/:agentId/skills/:id`,'skill.assign');
// Management snapshot aliases retain the same business projection and pagination.
route('GET','/v1/workspaces/:workspaceId/turns/:id','turn.show');
route('GET','/v1/workspaces/:workspaceId/conversations/:id/messages','message.list');
const compiled=HTTP_COMMAND_ROUTES.map(item=>({...item,pattern:new RegExp('^'+item.path.replace(/:([A-Za-z]+)/g,'(?<$1>[^/]+)')+'$')}));
export function resolveHttpCommand(method:string,pathname:string,input:unknown):ApplicationCommand {
  const url=new URL(pathname,'http://rift.local');
  for(const route of compiled) {
    if(route.method!==method)continue;
    const match=route.pattern.exec(url.pathname);if(!match)continue;
    const params=Object.fromEntries(Object.entries(match.groups??{}).map(([key,value])=>[key,decodeURIComponent(value)]));
    if(params.kind&&!['user','task','candidate','review'].includes(params.kind))break;
    return {name:route.name,...params,input,query:url.searchParams} as ApplicationCommand;
  }
  throw new RiftError('NOT_FOUND','Unknown API route.');
}
