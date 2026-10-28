import { agentSandboxMode, type AgentSandboxMode } from './sandbox-mode.js';
import { workspaceSkillRoot } from '../skill/runtime.js';
import { realpath, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import { gitOk } from '../git/process.js';

/** Bump when runtime permission semantics change: old native threads must not resume. */
export const REPOSITORY_PERMISSION_VERSION = 'workspace-repositories-v10-explicit-agent-sandbox';
export interface RepositoryAccess { sandboxMode?:AgentSandboxMode; repositoryPaths: string[]; protectedPaths?: string[]; shellHome?:string; skillResources?:string; workspaceDirectory?:string }

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
  const skillResources=store.filePath===':memory:'?undefined:workspaceSkillRoot(path.dirname(path.resolve(store.filePath)),workspaceId);
  if(skillResources)await mkdir(skillResources,{recursive:true,mode:0o700});
  const workspaceDirectory=skillResources?path.join(path.dirname(skillResources),'workspace'):undefined;
  if(workspaceDirectory)await mkdir(workspaceDirectory,{recursive:true,mode:0o700});
  return repositoryPaths.length||workspaceDirectory?{repositoryPaths,...agentSandboxMode()==='unrestricted'?{sandboxMode:'unrestricted' as const}:{},...store.filePath===':memory:'?{}:{skillResources,workspaceDirectory,shellHome:path.join(path.dirname(path.resolve(store.filePath)),'workspaces',workspaceId,'shell-home'),protectedPaths:[path.dirname(path.resolve(store.filePath)),...store.all<{canonicalPath:string;commonGitDir:string}>('SELECT canonical_path,common_git_dir FROM repositories WHERE workspace_id<>?',workspaceId).flatMap(row=>[row.canonicalPath,row.commonGitDir])]} }:undefined;
}
