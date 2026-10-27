import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import { gitOk } from '../git/process.js';

/** Bump when runtime permission semantics change: old native threads must not resume. */
export const REPOSITORY_PERMISSION_VERSION = 'workspace-repositories-v5-full-access';
export interface RepositoryAccess { repositoryPaths: string[] }

/** Resolve only registered roots; model content and context references never grant access. */
export async function workspaceRepositoryAccess(store: RiftStore, workspaceId: string): Promise<RepositoryAccess | undefined> {
  const workspace = store.workspace(workspaceId);
  const rows = store.all<{canonicalPath:string;commonGitDir:string}>('SELECT canonical_path,common_git_dir FROM repositories WHERE workspace_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,id',workspaceId,workspace.defaultRepositoryId ?? null);
  const repositoryPaths:string[]=[];
  const canonical=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  for(const row of rows) {
    const resolved=await realpath(row.canonicalPath);
    invariant(canonical(resolved)===canonical(row.canonicalPath),'REPOSITORY_IDENTITY_CHANGED','A registered repository root changed. Reconnect the repository before granting runtime access.');
    invariant((await stat(resolved)).isDirectory(),'REPOSITORY_UNAVAILABLE','A registered repository root is not a directory.');
    const actualRoot=await realpath(await gitOk(resolved,['rev-parse','--show-toplevel']));
    const actualCommon=await realpath(await gitOk(resolved,['rev-parse','--path-format=absolute','--git-common-dir']));
    invariant(canonical(actualRoot)===canonical(resolved)&&canonical(actualCommon)===canonical(row.commonGitDir),'REPOSITORY_IDENTITY_CHANGED','The repository Git identity differs from its registered workspace association.');
    if(!repositoryPaths.some(value=>canonical(value)===canonical(resolved)))repositoryPaths.push(resolved);
  }
  return repositoryPaths.length?{repositoryPaths}:undefined;
}
