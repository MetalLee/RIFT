import { key } from '../git/worktree-binding.js';
import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { RiftStore } from '../storage/database.js';
import { invariant } from '../contracts/index.js';

export const containsPath = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
/** Resolve existing inputs without granting access from model-supplied paths. */
export function workspacePath(store: RiftStore, workspaceId: string, value: string, home: string): string {
  invariant(path.isAbsolute(value), 'PATH_SCOPE', 'Use an absolute path in this workspace.');
  invariant(!lstatSync(value).isSymbolicLink(), 'PATH_SCOPE', 'Choose a real path, not a symlink.');
  const target = realpathSync(value);
  const roots = [path.join(home,'workspaces',workspaceId),path.join(home,'workspaces',key(workspaceId)),
    ...store.all<{canonicalPath:string}>('SELECT canonical_path FROM repositories WHERE workspace_id=?',workspaceId).map(row=>row.canonicalPath),
    ...store.all<{path:string}>('SELECT path FROM workspace_path_grants WHERE workspace_id=?',workspaceId).map(row=>row.path)];
  invariant(roots.some(root=>{try{return containsPath(realpathSync(root),target);}catch{return false;}}), 'PATH_SCOPE', 'Path has not been granted to this workspace by the operator.');
  // Workspace data and another workspace's repositories are not import sources.
  invariant(!containsPath(path.resolve(home),target) || (containsPath(path.resolve(home,'workspaces',workspaceId),target)||containsPath(path.resolve(home,'workspaces',key(workspaceId)),target)), 'PATH_SCOPE', 'Host state is not a workspace resource.');
  for (const other of store.all<{canonicalPath:string}>('SELECT canonical_path FROM repositories WHERE workspace_id<>?',workspaceId)) {
    invariant(!containsPath(other.canonicalPath,target)&&!containsPath(target,other.canonicalPath),'PATH_SCOPE','Path overlaps another workspace repository.');
  }
  return target;
}
