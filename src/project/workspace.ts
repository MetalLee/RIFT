import { resolve } from 'node:path';
import { invariant, type Workspace } from '../contracts/index.js';
import { id, RiftStore } from '../storage/database.js';

export interface CreateWorkspaceInput { id?: string; name: string; rootPath: string; repositoryPath: string; commonGitDir: string; baseRef: string }
export function createWorkspace(store:RiftStore,input:CreateWorkspaceInput):Workspace {
  invariant(input.name.trim() && input.baseRef.trim(),'INVALID_WORKSPACE','Workspace name and base reference are required.');
  const workspaceId=input.id??id('workspace');
  invariant(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId),'INVALID_ID','Workspace ID must be a safe identifier.');
  if(input.id&&store.get('SELECT id FROM workspaces WHERE id=?',input.id)){const prior=store.workspace(input.id);invariant(prior.name===input.name&&prior.rootPath===resolve(input.rootPath)&&prior.repositoryPath===resolve(input.repositoryPath)&&prior.commonGitDir===resolve(input.commonGitDir)&&prior.baseRef===input.baseRef,'IDEMPOTENCY_CONFLICT','Workspace ID was used for different input.');return prior;}
  store.transaction(()=> {
    store.exec('INSERT INTO workspaces(id,name,root_path,status) VALUES(?,?,?,?)',workspaceId,input.name,resolve(input.rootPath),'active');
    store.exec('INSERT INTO repositories(id,workspace_id,canonical_path,common_git_dir,base_ref) VALUES(?,?,?,?,?)',id('repository'),workspaceId,resolve(input.repositoryPath),resolve(input.commonGitDir),input.baseRef);
    store.exec('UPDATE workspaces SET default_repository_id=(SELECT id FROM repositories WHERE workspace_id=? ORDER BY id LIMIT 1) WHERE id=?',workspaceId,workspaceId);
  });
  return store.workspace(workspaceId);
}
