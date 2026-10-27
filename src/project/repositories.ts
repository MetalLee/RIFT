import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { invariant } from '../contracts/index.js';
import { id, now, type RiftStore } from '../storage/database.js';
import type { LocalGitService } from '../git/integration.js';
import { gitOk, worktreePorcelain } from '../git/process.js';
import { checkoutClean, key, managedPath, withMetadataLock } from '../git/worktree-binding.js';
import { provesPreviousBootExited } from '../agent/boot-identity.js';
import { WorktreeRemovalService } from './worktree-removals.js';

export interface Repository { id: string; workspaceId: string; canonicalPath: string; commonGitDir: string; baseRef: string }
export interface WorkspaceWorktree { id: string; workspaceId: string; repositoryId: string; origin: 'managed' | 'external'; path: string; pendingPath?: string | null; baseCommit: string; branch: string | null; status: string; version: number; createdAt: string }
export class RepositoryService {
  private bootIdentity:string|null=null;
  private readonly operationReceipts=new Set<string>();
  readonly removals: WorktreeRemovalService;
  constructor(private readonly store: RiftStore, private readonly git: LocalGitService) { this.removals = new WorktreeRemovalService(store, git); }
  setBootIdentity(identity:string|null):void{this.bootIdentity=identity;this.removals.setBootIdentity(identity);}
  private tree(worktreeId:string):WorkspaceWorktree{return this.store.require('SELECT id,workspace_id,repository_id,origin,path,pending_path,base_commit,branch,status,version,created_at FROM workspace_worktrees WHERE id=?',worktreeId);}
  list(workspaceId: string): Repository[] { this.store.workspace(workspaceId); return this.store.all('SELECT * FROM repositories WHERE workspace_id=? ORDER BY id', workspaceId); }
  get(workspaceId: string, repositoryId: string): Repository { return this.store.require('SELECT * FROM repositories WHERE workspace_id=? AND id=?', workspaceId, repositoryId); }
  async connect(workspaceId: string, input: { repositoryPath: string; baseRef: string; expectedVersion: number }, authorize?: (inspected: Awaited<ReturnType<LocalGitService['inspectRepository']>>) => void): Promise<Repository> {
    const inspected = await this.git.inspectRepository(input.repositoryPath, input.baseRef);
    authorize?.(inspected);
    return this.store.transaction(() => {
      const workspace = this.store.workspace(workspaceId) as ReturnType<RiftStore['workspace']> & { version: number };
      invariant(workspace.status === 'active', 'WORKSPACE_ARCHIVED', 'Archived workspace cannot connect repositories.');
      invariant(workspace.version === input.expectedVersion, 'VERSION_CONFLICT', 'Workspace changed; reload before connecting.');
      invariant(!this.store.get("SELECT id FROM workflows WHERE workspace_id=? AND status NOT IN ('completed','failed','cancelled')", workspaceId), 'WORKSPACE_ACTIVE', 'Finish the active workflow before changing its repository set.');
      const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
      invariant(!this.list(workspaceId).some(repo => canonical(repo.commonGitDir) === canonical(inspected.commonGitDir)), 'REPOSITORY_EXISTS', 'This Git repository is already connected to this workspace.');
      const repositoryId = id('repository');
      this.store.exec('INSERT INTO repositories(id,workspace_id,canonical_path,common_git_dir,base_ref) VALUES(?,?,?,?,?)', repositoryId, workspaceId, inspected.rootPath, inspected.commonGitDir, input.baseRef);
      this.store.exec('UPDATE workspaces SET default_repository_id=COALESCE(default_repository_id,?),version=version+1 WHERE id=?', repositoryId, workspaceId);
      return this.get(workspaceId, repositoryId);
    });
  }
  async discover(workspaceId: string, repositoryId: string): Promise<{ path: string; head: string; branch: string | null }[]> {
    const repo = this.get(workspaceId, repositoryId);
    const output = await worktreePorcelain(repo.canonicalPath);
    return output.split('\0\0').filter(Boolean).map(entry => {
      const fields = entry.split('\0');
      return { path: fields.find(field => field.startsWith('worktree '))?.slice(9) ?? '', head: fields.find(field => field.startsWith('HEAD '))?.slice(5) ?? '', branch: fields.find(field => field.startsWith('branch '))?.slice(7) ?? null };
    }).filter(entry => entry.path);
  }
  worktrees(workspaceId: string, repositoryId: string): WorkspaceWorktree[] { this.get(workspaceId, repositoryId); return this.store.all<{id:string}>('SELECT id FROM workspace_worktrees WHERE workspace_id=? AND repository_id=? ORDER BY created_at,id', workspaceId, repositoryId).map(row=>this.tree(row.id)); }
  async createWorktree(workspaceId: string, repositoryId: string, input: { origin: 'managed' | 'external'; path?: string; baseRef?: string; branch?: string }): Promise<WorkspaceWorktree> {
    invariant(this.store.workspace(workspaceId).status === 'active', 'WORKSPACE_ARCHIVED', 'Archived workspace cannot add worktrees.');
    const repo = this.get(workspaceId, repositoryId), worktreeId = id('worktree');
    let directory: string, head: string, branch: string | null;
    if (input.origin === 'external') {
      invariant(!input.branch && !input.baseRef, 'INVALID_WORKTREE', 'External association preserves the existing branch and HEAD.');
      invariant(input.path, 'WORKTREE_PATH_REQUIRED', 'An external worktree path is required.');
      directory = await realpath(input.path);
      const discovered = await this.discover(workspaceId, repositoryId);
      let found: typeof discovered[number] | undefined;
      for (const entry of discovered) if (await realpath(entry.path) === directory) { found = entry; break; }
      invariant(found, 'WORKTREE_OWNERSHIP', 'The selected path is not a registered worktree of this repository.');
      const inspected = await this.git.inspectRepository(directory, 'HEAD');
      invariant(inspected.rootPath === directory && inspected.commonGitDir === repo.commonGitDir, 'WORKTREE_OWNERSHIP', 'External worktree repository mismatch.');
      head = inspected.baseCommit; branch = found.branch;
      const prior=this.store.get<WorkspaceWorktree>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND path=? ORDER BY rowid DESC LIMIT 1',workspaceId,directory);
      if(prior){
        invariant(prior.origin==='external'&&prior.status==='detached'&&!prior.pendingPath&&prior.repositoryId===repositoryId,'WORKTREE_EXISTS','This worktree is already associated or owned.');
        this.store.exec("UPDATE workspace_worktrees SET status='active',base_commit=?,branch=?,version=version+1 WHERE id=?",head,branch,prior.id);
        return this.tree(prior.id);
      }
    } else {
      const inspected = await this.git.inspectRepository(repo.canonicalPath, input.baseRef ?? repo.baseRef);
      directory = await this.destination(workspaceId, worktreeId, input.path);
      head = inspected.baseCommit; branch = input.branch ?? `rift/ui/${worktreeId}`;
      invariant(branch.length <= 200, 'INVALID_BRANCH', 'Branch name is too long.');
      await gitOk(repo.canonicalPath, ['check-ref-format', '--branch', branch]);
      this.store.exec('INSERT INTO workspace_worktrees(id,workspace_id,repository_id,origin,path,base_commit,branch,status,created_at,runtime_boot_id) VALUES(?,?,?,?,?,?,?,?,?,?)', worktreeId, workspaceId, repositoryId, input.origin, directory, head, branch, 'creating', now(),this.bootIdentity);
      try {
        await withMetadataLock(repo.commonGitDir, async () => { await mkdir(path.dirname(directory), { recursive: true }); await gitOk(repo.canonicalPath, ['worktree', 'add', '-b', branch!, '--', directory, head]); });
        this.store.exec("UPDATE workspace_worktrees SET status='active',version=version+1 WHERE id=?", worktreeId);
        this.operationReceipts.add(worktreeId);
      } catch (error) { if(!/\(124\)|timed out/i.test(String(error)))this.operationReceipts.add(worktreeId);this.store.exec("UPDATE workspace_worktrees SET status='creation_unknown',version=version+1 WHERE id=?", worktreeId); throw error; }
      return this.tree(worktreeId);
    }
    this.store.exec('INSERT INTO workspace_worktrees(id,workspace_id,repository_id,origin,path,base_commit,branch,created_at) VALUES(?,?,?,?,?,?,?,?)', worktreeId, workspaceId, repositoryId, input.origin, directory, head, branch, now());
    return this.tree(worktreeId);
  }
  private async destination(workspaceId: string, worktreeId: string, requested?: string): Promise<string> {
    if (requested) invariant(path.isAbsolute(requested), 'UNSAFE_PATH', 'Choose an absolute directory inside the managed worktree root.');
    const directory = await managedPath(this.git.managedRoot, requested ?? path.join(this.git.managedRoot, key(workspaceId), 'user-worktrees', key(worktreeId)));
    try { await lstat(directory); invariant(false, 'WORKTREE_EXISTS', 'Choose a new destination directory.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return directory;
  }
  async takeover(workspaceId: string, worktreeId: string, input: { expectedVersion: number; confirmExclusiveOwnership: true; destinationPath?: string }): Promise<WorkspaceWorktree> {
    const tree = this.store.require<WorkspaceWorktree>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND id=?', workspaceId, worktreeId), repo = this.get(workspaceId, tree.repositoryId);
    invariant(input.confirmExclusiveOwnership === true, 'OWNERSHIP_CONFIRMATION_REQUIRED', 'Explicit exclusive ownership confirmation is required.');
    invariant(tree.origin === 'external' && tree.status === 'active', 'WORKTREE_OWNERSHIP', 'Only an active external association can be taken over.');
    invariant(tree.version === input.expectedVersion, 'VERSION_CONFLICT', 'Worktree state changed.');
    invariant(tree.path !== repo.canonicalPath, 'WORKTREE_OWNERSHIP', 'The repository primary checkout cannot be taken over or moved.');
    const destination = await this.destination(workspaceId, worktreeId, input.destinationPath);
    await withMetadataLock(repo.commonGitDir, async () => {
      const inspected = await this.git.inspectRepository(tree.path, 'HEAD');
      invariant(inspected.rootPath === await realpath(tree.path) && inspected.commonGitDir === repo.commonGitDir, 'WORKTREE_OWNERSHIP', 'External worktree repository changed.');
      invariant(await checkoutClean(tree.path), 'WORKTREE_DIRTY', 'Commit or preserve dirty, untracked and ignored contents before takeover.');
      invariant(!this.store.get('SELECT id FROM worktrees WHERE path=? AND writer_run_id IS NOT NULL', tree.path) && !this.store.get('SELECT l.id FROM execution_leases l JOIN repositories r ON r.workspace_id=l.workspace_id WHERE r.common_git_dir=? AND l.released_at IS NULL', repo.commonGitDir), 'WORKTREE_IN_USE', 'This repository still has an execution or unknown cleanup lease.');
      this.store.transaction(()=>{
        const current=this.tree(tree.id);
        invariant(current.version===input.expectedVersion,'VERSION_CONFLICT','Worktree changed during takeover verification.');
        invariant(current.origin==='external'&&current.status==='active'&&!current.pendingPath,'WORKTREE_STATE_UNKNOWN','Worktree is no longer available for takeover.');
        this.operationReceipts.delete(tree.id);
        this.store.exec("UPDATE workspace_worktrees SET status='moving',pending_path=?,runtime_boot_id=?,version=version+1 WHERE id=?", destination,this.bootIdentity, tree.id);
      });
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await gitOk(repo.canonicalPath, ['worktree', 'move', '--', tree.path, destination]);
        await managedPath(this.git.managedRoot, await realpath(destination));
        this.store.exec("UPDATE workspace_worktrees SET origin='managed',path=?,pending_path=NULL,base_commit=?,status='active',version=version+1 WHERE id=?", destination, inspected.baseCommit, tree.id);
        this.operationReceipts.add(tree.id);
      } catch (error) {if(!/\(124\)|timed out/i.test(String(error)))this.operationReceipts.add(tree.id); this.store.exec("UPDATE workspace_worktrees SET status='move_unknown',version=version+1 WHERE id=?", tree.id); throw error; }
    });
    return this.tree(tree.id);
  }
  async reconcile(workspaceId:string,worktreeId:string,expectedVersion:number):Promise<WorkspaceWorktree> {
    const tree=this.store.require<WorkspaceWorktree & {runtimeBootId:string|null}>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND id=?',workspaceId,worktreeId),repo=this.get(workspaceId,tree.repositoryId);
    invariant(tree.version===expectedVersion,'VERSION_CONFLICT','Worktree changed; reload before reconciliation.');
    invariant(['creating','creation_unknown','moving','move_unknown'].includes(tree.status),'INVALID_STATE','Only an unfinished creation or move needs reconciliation.');
    invariant(this.operationReceipts.has(tree.id)||provesPreviousBootExited(tree.runtimeBootId,this.bootIdentity),'CLEANUP_UNKNOWN','Git process cleanup needs an owned completion receipt or proof that the computer rebooted.');
    return withMetadataLock(repo.commonGitDir,async()=>{
      const target=tree.pendingPath??tree.path,registered=await this.discover(workspaceId,tree.repositoryId);
      const normalize=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
      const targetEntry=registered.find(entry=>normalize(entry.path)===normalize(target));
      let targetExists=true;try{await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')targetExists=false;else throw error;}
      if(targetEntry){
        await managedPath(this.git.managedRoot,await realpath(target));
        const actual=await this.git.inspectRepository(target,'HEAD');
        invariant(actual.commonGitDir===repo.commonGitDir,'WORKTREE_OWNERSHIP','Worktree repository changed.');
        invariant((targetEntry.branch??'').replace(/^refs\/heads\//,'')===(tree.branch??'').replace(/^refs\/heads\//,''),'WORKTREE_OWNERSHIP','Worktree branch does not match the saved intent.');
        await gitOk(target,['merge-base','--is-ancestor',tree.baseCommit,'HEAD']);
        this.store.transaction(()=>{invariant(this.store.require<{version:number}>('SELECT version FROM workspace_worktrees WHERE id=?',tree.id).version===expectedVersion,'VERSION_CONFLICT','Worktree changed during verification.');this.store.exec("UPDATE workspace_worktrees SET origin='managed',path=?,pending_path=NULL,status='active',version=version+1 WHERE id=?",target,tree.id);});
      }else if(!targetExists){
        if(tree.pendingPath)invariant(registered.some(entry=>normalize(entry.path)===normalize(tree.path)),'WORKTREE_STATE_UNKNOWN','Neither the old nor new registered worktree proves the move outcome.');
        this.store.transaction(()=>{invariant(this.store.require<{version:number}>('SELECT version FROM workspace_worktrees WHERE id=?',tree.id).version===expectedVersion,'VERSION_CONFLICT','Worktree changed during verification.');this.store.exec('UPDATE workspace_worktrees SET pending_path=NULL,status=?,version=version+1 WHERE id=?',tree.pendingPath?'active':'creation_failed',tree.id);});
      }else invariant(false,'WORKTREE_STATE_UNKNOWN','Destination exists without matching Git registration; preserve it for inspection.');
      return this.tree(tree.id);
    });
  }
  async archive(workspaceId: string, worktreeId: string, expectedVersion: number): Promise<WorkspaceWorktree> {
    const tree = this.store.require<WorkspaceWorktree>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND id=?', workspaceId, worktreeId);
    invariant(tree.origin === 'managed', 'WORKTREE_OWNERSHIP', 'External worktrees can only be detached; RIFT does not delete them.');
    invariant(tree.version === expectedVersion, 'VERSION_CONFLICT', 'Worktree state changed.');
    if (tree.status === 'archived') return this.tree(tree.id);
    invariant(tree.status === 'active', 'WORKTREE_STATE_UNKNOWN', 'Inspect the unfinished worktree operation before archiving.');
    const deletionVersion = await this.removals.versionFor(workspaceId, 'user', tree.id);
    // The legacy archive endpoint remains compatible, but shares all deletion
    // guards, persistent receipts and optimistic binding with the explicit API.
    invariant(this.tree(tree.id).version === expectedVersion, 'VERSION_CONFLICT', 'Worktree state changed.');
    await this.removals.remove(workspaceId, 'user', tree.id, { expectedVersion: deletionVersion, confirmDelete: true });
    return this.tree(tree.id);
  }
  detach(workspaceId: string, worktreeId: string, expectedVersion: number): WorkspaceWorktree {
    return this.store.transaction(() => {
      const tree = this.store.require<WorkspaceWorktree>('SELECT * FROM workspace_worktrees WHERE workspace_id=? AND id=?', workspaceId, worktreeId);
      invariant(tree.origin === 'external', 'WORKTREE_OWNERSHIP', 'Managed worktrees must pass archival checks.');
      invariant(tree.version === expectedVersion, 'VERSION_CONFLICT', 'Worktree state changed.');
      invariant((tree.status === 'active' || tree.status === 'detached') && !tree.pendingPath, 'WORKTREE_STATE_UNKNOWN', 'Reconcile the unfinished worktree move before detaching.');
      if (tree.status === 'detached') return this.tree(tree.id);
      this.store.exec("UPDATE workspace_worktrees SET status='detached',version=version+1 WHERE id=?", tree.id);
      return this.tree(tree.id);
    });
  }
}
