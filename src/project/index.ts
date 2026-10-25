import { RiftStore } from '../storage/database.js';
import { createWorkspace, type CreateWorkspaceInput } from './workspace.js';
import { configureRoles, type RoleConfiguration } from './agent-roles.js';
import type { ProviderBinding, Workspace, Role } from '../contracts/index.js';
export * from './workspace.js';
export * from './agent-roles.js';
export * from './provider-bindings.js';
export class ProjectService {
  constructor(readonly store:RiftStore,readonly registeredProviderNames:ReadonlySet<string>=new Set()) {}
  createWorkspace(input:CreateWorkspaceInput):Workspace {return createWorkspace(this.store,input);}
  configureRoles(workspaceId:string,bindings:ProviderBinding[],roles:RoleConfiguration[]):Role[] {return configureRoles(this.store,workspaceId,bindings,roles,this.registeredProviderNames);}
  listWorkspaces():Workspace[] {return this.store.all<Workspace>('SELECT w.*,r.canonical_path AS repository_path,r.common_git_dir,r.base_ref FROM workspaces w JOIN repositories r ON r.workspace_id=w.id ORDER BY w.name');}
}
