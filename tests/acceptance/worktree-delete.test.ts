import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftHostService } from '../../src/api/host-service.js';
import { gitOk } from '../../src/git/process.js';
import * as gitProcess from '../../src/git/process.js';
import { key } from '../../src/git/worktree-binding.js';
import type { Candidate, GitContext, Run, Worktree } from '../../src/contracts/index.js';
import { WorktreeRemovalService, type RemovalKind, type WorktreeRemovalTarget } from '../../src/project/worktree-removals.js';
import { seedWorkspace } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'rift-worktree-delete-'));
  cleanups.push(async () => {
    if (!path.basename(home).startsWith('rift-worktree-delete-') || path.dirname(home) !== path.resolve(tmpdir())) throw new Error('unsafe fixture cleanup');
    await rm(home, { recursive: true, force: true });
  });
  const host = new RiftHostService({ subagents: { list: () => [] } } as unknown as Context, {
    home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [{ id: 'check', executable: process.execPath, args: ['-e', 'process.stdout.write("checked")'] }],
  });
  cleanups.push(() => host.close());
  const { workspace, roles } = seedWorkspace(host.store);
  const repositoryPath = path.join(home, '仓库 with spaces'); await mkdir(repositoryPath);
  await gitOk(repositoryPath, ['init', '-b', 'main']);
  await gitOk(repositoryPath, ['config', 'user.name', 'Test']); await gitOk(repositoryPath, ['config', 'user.email', 'test@example.invalid']);
  await gitOk(repositoryPath, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repositoryPath, 'base.txt'), 'base\n'); await writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.log\n');
  await gitOk(repositoryPath, ['add', '.']); await gitOk(repositoryPath, ['commit', '-m', 'base']);
  const inspected = await host.git.inspectRepository(repositoryPath, 'HEAD'), base = inspected.baseCommit;
  const repo = host.repositories.list(workspace.id)[0]!;
  host.store.exec('UPDATE repositories SET canonical_path=?,common_git_dir=?,base_ref=? WHERE id=?', inspected.rootPath, inspected.commonGitDir, 'main', repo.id);
  const root = `/ui-api/v1/workspaces/${workspace.id}`;
  const list = () => host.repositories.removals.list(workspace.id, repo.id);
  const target = async (kind: RemovalKind, id: string) => (await list()).find(item => item.kind === kind && item.recordId === id)!;
  const remove = async (item: WorktreeRemovalTarget, operationKey: string = crypto.randomUUID()) => host.handleBrowser('POST', `${root}/worktree-removals/${item.kind}/${encodeURIComponent(item.recordId)}/delete`, { expectedVersion: item.expectedVersion, confirmDelete: true }, operationKey);
  const user = () => host.repositories.createWorktree(workspace.id, repo.id, { origin: 'managed' });
  const task = async () => {
    const role = roles.find(item => item.name === 'developer-a')!;
    host.store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Delete safely','running','refs/heads/rift/integration/delete',?)", workspace.id, base);
    host.store.exec("INSERT INTO workflow_repositories(workflow_id,repository_id,base_commit,integration_ref) VALUES('workflow',?,?,'refs/heads/rift/integration/delete')", repo.id, base);
    host.store.exec("INSERT INTO tasks(id,workflow_id,repository_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES('task','workflow',?,?,'change','Task','Task','[]','[]','validating',1)", repo.id, role.id);
    host.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,cleanup_status,slot_released_at,result) VALUES('run','task',?,'develop',1,'succeeded','{}','later','now','confirmed','now','{\"summary\":\"Saved result\"}')", role.id);
    const context: GitContext = { workspace: host.store.workspace(workspace.id), workflow: host.store.workflow('workflow'), task: host.store.task('task') };
    const run = host.store.run('run') as Run;
    const tree = await host.git.prepareTask({ ...context, run });
    await writeFile(path.join(tree.path, 'change.txt'), 'task source\n');
    const source = await host.git.collectSource({ ...context, run, worktree: tree });
    host.store.exec('INSERT INTO worktrees(id,task_id,attempt,kind,path,branch,base_commit,head_commit,writer_run_id) VALUES(?,?,?,?,?,?,?,?,NULL)', tree.id, tree.taskId, tree.attempt, tree.kind, tree.path, tree.branch!, tree.baseCommit, source.sourceHead);
    host.store.event('workflow', 'source.collected', source, { taskId: 'task', runId: run.id });
    return { context, tree: { ...tree, writerRunId: null } as Worktree, source };
  };
  const finish = () => {
    host.store.exec("UPDATE tasks SET status='succeeded',version=version+1 WHERE id='task'");
    host.store.exec("UPDATE workflows SET status='completed',version=version+1 WHERE id='workflow'");
  };
  return { host, home, workspace, roles, repo, root, base, repositoryPath, list, target, remove, user, task, finish };
}

describe('safe Worktree deletion: real Git, service and browser Host API', () => {
  it('deletes only the confirmed managed checkout, preserves branches/commits, refreshes state and handles replay/stale versions', async () => {
    const f = await fixture(), tree = await f.user(), item = await f.target('user', tree.id);
    expect(item.canDelete).toBe(true);
    const key = 'same-delete-request', result = await f.remove(item, key);
    expect(result).toMatchObject({ state: 'deleted', canDelete: false });
    expect(await f.remove(item, key)).toEqual(result); // Host response replay, not another Git remove.
    await expect(f.remove(item)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(lstat(tree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gitOk(f.repositoryPath, ['rev-parse', tree.branch!])).toBe(f.base);
    expect(await readFile(path.join(f.repositoryPath, 'base.txt'), 'utf8')).toBe('base\n');
    const snapshot = await f.host.handleBrowser('GET', `${f.root}/repositories/${f.repo.id}/worktrees`, null) as { worktrees: { id: string; status: string }[]; removals: WorktreeRemovalTarget[] };
    expect(snapshot.worktrees.find(row => row.id === tree.id)?.status).toBe('archived');
    expect(snapshot.removals.find(row => row.recordId === tree.id)).toMatchObject({ state: 'deleted' });
    expect(f.host.store.require('SELECT * FROM worktree_removals WHERE record_id=?', tree.id)).toMatchObject({ state: 'deleted', cleanupStatus: 'confirmed', headCommit: f.base, preservationRef: expect.stringContaining('refs/rift/deleted-worktrees/') });
  });

  it.each(['dirty','untracked','ignored'] as const)('refuses %s data, retains a retryable error and succeeds only after it is saved', async mode => {
    const f = await fixture(), tree = await f.user(), old = await f.target('user', tree.id);
    const file = path.join(tree.path, mode === 'dirty' ? 'base.txt' : mode === 'ignored' ? 'ignored.log' : 'untracked.txt');
    await writeFile(file, 'must preserve');
    expect(await f.target('user', tree.id)).toMatchObject({ canDelete: false, reason: expect.stringContaining('dirty, untracked or ignored') });
    await expect(f.remove(old)).rejects.toThrow('ARCHIVE_BLOCKED');
    expect(await readFile(file, 'utf8')).toBe('must preserve');
    expect(await f.target('user', tree.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('ARCHIVE_BLOCKED'), canReconcile: true });
    await expect(f.remove(old)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await gitOk(tree.path, ['add', '-f', '.']); await gitOk(tree.path, ['commit', '-m', 'save local content']);
    const head = await gitOk(tree.path, ['rev-parse', 'HEAD']);
    await f.remove(await f.target('user', tree.id));
    expect(await gitOk(f.repositoryPath, ['rev-parse', tree.branch!])).toBe(head);
  });

  it('rejects external paths and main checkout, including a primary checkout inside managedRoot', async () => {
    const f = await fixture(), external = await f.host.repositories.createWorktree(f.workspace.id, f.repo.id, { origin: 'external', path: f.repositoryPath });
    await expect(f.remove(await f.target('user', external.id))).rejects.toMatchObject({ code: 'WORKTREE_OWNERSHIP' });
    f.host.repositories.detach(f.workspace.id, external.id, external.version);
    expect(await readFile(path.join(external.path, 'base.txt'), 'utf8')).toBe('base\n');
    const primary = path.join(f.host.git.managedRoot, 'primary'); await mkdir(primary, { recursive: true });
    await gitOk(primary, ['init','-b','main']); await writeFile(path.join(primary, 'keep'), 'keep');
    await gitOk(primary,['add','.']); await gitOk(primary,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base']);
    const inspected = await f.host.git.inspectRepository(primary, 'HEAD');
    await expect(f.host.git.archiveWorktree({ workspace: { ...f.host.store.workspace(f.workspace.id), repositoryPath: primary, commonGitDir: inspected.commonGitDir }, worktree: { id: 'primary', taskId: '', attempt: 0, kind: 'task', path: primary, baseCommit: inspected.baseCommit }, active: false, cleanupConfirmed: true, artifactsSaved: true })).rejects.toThrow('primary');
    expect(await readFile(path.join(primary, 'keep'), 'utf8')).toBe('keep');
  });

  it('rejects path injection, unconfirmed requests and cross-workspace IDs at the API boundary', async () => {
    const f = await fixture(), tree = await f.user(), item = await f.target('user', tree.id);
    const route = `${f.root}/worktree-removals/user/${tree.id}/delete`;
    await expect(f.host.handleBrowser('POST', route, { expectedVersion: item.expectedVersion, path: f.repositoryPath, confirmDelete: true }, 'injection')).rejects.toThrow();
    await expect(f.host.handleBrowser('POST', route, { expectedVersion: item.expectedVersion }, 'unconfirmed')).rejects.toThrow();
    await expect(f.host.handleBrowser('POST', route.replace(f.workspace.id, 'unknown-workspace'), { expectedVersion: item.expectedVersion, confirmDelete: true }, 'cross-scope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await realpath(tree.path)).toBe(tree.path);
  });

  it.each(['assume-unchanged','skip-worktree','git-operation','locked'] as const)('preserves hidden contents and resumable Git state: %s', async mode => {
    const f = await fixture(), tree = await f.user(), item = await f.target('user',tree.id);
    if (mode === 'assume-unchanged' || mode === 'skip-worktree') {
      await gitOk(tree.path,['update-index',`--${mode}`,'base.txt']);
      await writeFile(path.join(tree.path,'base.txt'),'hidden local data');
    } else if (mode === 'git-operation') {
      const marker = await gitOk(tree.path,['rev-parse','--path-format=absolute','--git-path','CHERRY_PICK_HEAD']);
      await writeFile(marker,f.base);
    } else await gitOk(f.repositoryPath,['worktree','lock','--',tree.path]);
    expect(await f.target('user',tree.id)).toMatchObject({canDelete:false});
    await expect(f.remove(item)).rejects.toThrow('ARCHIVE_BLOCKED');
    expect(await readFile(path.join(tree.path,'base.txt'),'utf8')).toBe(mode === 'assume-unchanged' || mode === 'skip-worktree' ? 'hidden local data' : 'base\n');
  });

  it('checks managed containment, symlink escapes and Git repository ownership without removing anything', async () => {
    const f = await fixture(), tree = await f.user();
    const linked = path.join(f.home, 'outside'); await gitOk(f.repositoryPath, ['worktree','add','--detach',linked,'HEAD']);
    const archive = (directory: string) => f.host.git.archiveWorktree({ workspace: f.host.store.workspace(f.workspace.id), worktree: { id: 'unsafe', taskId: '', attempt: 0, kind: 'task' as const, path: directory, baseCommit: f.base }, active: false, cleanupConfirmed: true, artifactsSaved: true });
    await expect(archive(linked)).rejects.toThrow('UNSAFE_PATH');
    const alias = path.join(f.host.git.managedRoot, 'escape'); await symlink(linked, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(archive(alias)).rejects.toThrow('UNSAFE_PATH');
    const other = path.join(f.home,'other'); await gitOk(f.repositoryPath,['clone','--no-local',f.repositoryPath,other]);
    await gitOk(other,['config','core.autocrlf','false']);
    const foreign = path.join(f.host.git.managedRoot,'foreign'); await gitOk(other,['worktree','add','--detach',foreign,'HEAD']);
    await expect(archive(foreign)).rejects.toThrow('repository mismatch');
    expect(await readFile(path.join(linked,'base.txt'),'utf8')).toBe('base\n');
    expect(await readFile(path.join(foreign,'base.txt'),'utf8')).toBe('base\n');
    expect(await realpath(tree.path)).toBe(tree.path);
  });

  it('deletes terminal task, candidate AND reviewer directories while preserving exact integration/run/event/check evidence and detached HEAD reachability', async () => {
    const f = await fixture(), task = await f.task();
    const candidate: Candidate = await f.host.git.prepareCandidate({ ...task.context, sourceHead: task.source.sourceHead, integrationId: 'integration' });
    await f.host.git.publishCandidate({ ...task.context, candidate, review: { schemaVersion: 1, taskId: 'task', runId: 'review', verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] } });
    f.host.store.exec("INSERT INTO integrations(id,task_id,source_head,expected_target_head,candidate_head,status,candidate) VALUES('integration','task',?,?,?,'accepted',?)", candidate.sourceHead, candidate.expectedTargetHead, candidate.candidateHead, JSON.stringify(candidate));
    f.host.store.exec("UPDATE tasks SET accepted_commit=?,source_head=? WHERE id='task'", candidate.candidateHead, candidate.sourceHead);
    f.finish();
    const evidence = ['tasks','runs','integrations'].map(table => f.host.store.all(`SELECT * FROM ${table}`));
    const operation = await f.host.git.readOperation(task.context.workspace, 'integration');
    const sourceEvent = f.host.store.events('workflow').find(event => event.type === 'source.collected');
    for (const [kind, id] of [['candidate','integration'],['review','integration'],['task',task.tree.id]] as const) {
      const item = await f.target(kind, id); expect(item.canDelete).toBe(true);
      await f.remove(item); await expect(lstat(item.path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(['tasks','runs','integrations'].map(table => f.host.store.all(`SELECT * FROM ${table}`))).toEqual(evidence);
    expect(await f.host.git.readOperation(task.context.workspace, 'integration')).toEqual(operation);
    expect(f.host.store.events('workflow')).toContainEqual(sourceEvent);
    const receipts = f.host.store.all<{ preservationRef: string; headCommit: string }>('SELECT * FROM worktree_removals');
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) expect(await gitOk(f.repositoryPath, ['rev-parse',receipt.preservationRef])).toBe(receipt.headCommit);
    expect(await gitOk(f.repositoryPath,['rev-parse',task.tree.branch!])).toBe(task.source.sourceHead);
  });

  it.each(['writer','run-cleanup','operation','integration','integration-timeout'] as const)('disables and refuses deletion for busy/unfinished %s state', async mode => {
    const f = await fixture(), task = await f.task(); f.finish();
    const item = await f.target('task', task.tree.id);
    if (mode === 'writer') f.host.store.exec('UPDATE worktrees SET writer_run_id=? WHERE id=?','run', task.tree.id);
    if (mode === 'run-cleanup') f.host.store.exec("UPDATE runs SET cleanup_status='unknown' WHERE id='run'");
    if (mode === 'operation') f.host.store.exec("INSERT INTO operations(id,kind,dedupe_key,entity_id,phase,payload,created_at) VALUES('pending','dispatch','pending','task','started','{}','now')");
    if (mode === 'integration') f.host.store.exec("INSERT INTO integrations(id,task_id,source_head,status) VALUES('unknown','task',?,'cleanup_unknown')", task.source.sourceHead);
    if (mode === 'integration-timeout') f.host.store.exec("INSERT INTO integrations(id,task_id,source_head,status,error) VALUES('timeout','task',?,'blocked','CHECK_FAILED: check (124)')", task.source.sourceHead);
    const current = await f.target('task', task.tree.id); expect(current.canDelete).toBe(false);
    if (current.expectedVersion !== item.expectedVersion) await expect(f.remove(item)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(f.remove(current)).rejects.toThrow();
    expect(await readFile(path.join(task.tree.path,'change.txt'),'utf8')).toBe('task source\n');
  });

  it('serializes duplicate requests, fences late executions/source changes, then releases the fence after a confirmed Git failure', async () => {
    const f = await fixture(), tree = await f.user(), item = await f.target('user', tree.id);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const archive = vi.spyOn(f.host.git, 'archiveWorktree').mockImplementationOnce(async () => { await gate; throw new Error('Git remove failed (1): locked checkout'); });
    const first = f.remove(item);
    await expect.poll(() => archive.mock.calls.length).toBe(1);
    await expect(f.remove(item)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(() => f.host.store.exec("UPDATE workspace_worktrees SET version=version+1 WHERE id=?",tree.id)).toThrow('WORKTREE_DELETION_IN_PROGRESS');
    expect(() => f.host.store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('late','turn','late',?,?,'developer','now')",f.workspace.id,f.roles.find(role=>role.name==='developer-a')!.id)).toThrow('WORKTREE_DELETION_IN_PROGRESS');
    release(); await expect(first).rejects.toThrow('locked checkout');
    expect(await f.target('user', tree.id)).toMatchObject({ state: 'failed', canDelete: true, error: expect.stringContaining('locked checkout') });
    await f.remove(await f.target('user',tree.id));
  });

  it('keeps timeout cleanup unknown across service restarts and only reconciles with same-machine reboot proof', async () => {
    const f = await fixture(), tree = await f.user(), item = await f.target('user',tree.id);
    const boot = (value: string) => `v1:${'a'.repeat(64)}:${value.repeat(64)}`;
    f.host.repositories.setBootIdentity(boot('b'));
    vi.spyOn(f.host.git,'archiveWorktree').mockRejectedValueOnce(new Error('Git worktree failed (124): timed out'));
    await expect(f.remove(item)).rejects.toThrow('timed out');
    const unknown = await f.target('user',tree.id); expect(unknown).toMatchObject({ state: 'unknown', canDelete: false, canReconcile: true });
    const restarted = new WorktreeRemovalService(f.host.store,f.host.git);
    restarted.setBootIdentity(boot('b'));
    const reconcile = () => restarted.reconcile(f.workspace.id,'user',tree.id,unknown.expectedVersion);
    await expect(reconcile()).rejects.toMatchObject({ code: 'CLEANUP_UNKNOWN' });
    restarted.setBootIdentity(`v1:${'c'.repeat(64)}:${'d'.repeat(64)}`);
    await expect(reconcile()).rejects.toMatchObject({ code: 'CLEANUP_UNKNOWN' }); // other machine is not reboot evidence
    restarted.setBootIdentity(boot('c'));
    await expect(reconcile()).resolves.toMatchObject({ state: 'failed', canDelete: true });
    await f.remove(await f.target('user',tree.id));
  });

  it('reconciles an interrupted post-remove receipt without deleting again or losing commit evidence', async () => {
    const f = await fixture(), tree = await f.user(), item = await f.target('user',tree.id);
    const boot = (value:string) => `v1:${'a'.repeat(64)}:${value.repeat(64)}`;
    f.host.repositories.setBootIdentity(boot('b'));
    const original = f.host.git.archiveWorktree.bind(f.host.git);
    vi.spyOn(f.host.git,'archiveWorktree').mockImplementationOnce(async input => { await original(input); throw new Error('simulated post-remove timeout: timed out'); });
    await expect(f.remove(item)).rejects.toThrow('timed out');
    await expect(lstat(tree.path)).rejects.toMatchObject({code:'ENOENT'});
    const unknown = await f.target('user',tree.id);
    f.host.repositories.setBootIdentity(boot('c'));
    await expect(f.host.repositories.removals.reconcile(f.workspace.id,'user',tree.id,unknown.expectedVersion)).resolves.toMatchObject({state:'deleted'});
    const receipt = f.host.store.require<{preservationRef:string;headCommit:string}>('SELECT * FROM worktree_removals WHERE record_id=?',tree.id);
    expect(await gitOk(f.repositoryPath,['rev-parse',receipt.preservationRef])).toBe(receipt.headCommit);
  });

  it('quarantines stale candidate evidence rather than accepting an arbitrary managed path from operation metadata', async () => {
    const f = await fixture(), task = await f.task(), user = await f.user();
    f.host.store.exec("INSERT INTO integrations(id,task_id,source_head,status) VALUES('forged','task',?,'blocked')",task.source.sourceHead);
    const directory = path.join(f.host.git.managedRoot,key(f.workspace.id),'operations',key('forged')); await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'operation.json'),JSON.stringify({integrationId:'forged',taskId:'task',sourceHead:task.source.sourceHead,expectedTargetHead:f.base,candidatePath:user.path,reviewPath:user.path,phase:'blocked'}));
    f.finish();
    expect(await f.target('candidate','forged')).toMatchObject({ canDelete:false, state:'unavailable' });
    await expect(f.remove(await f.target('candidate','forged'))).rejects.toThrow();
    expect(await readFile(path.join(user.path,'base.txt'),'utf8')).toBe('base\n');
  });

  it('revalidates contents after the final service callback, preserving newly introduced ignored data', async () => {
    const f = await fixture(), tree = await f.user();
    await expect(f.host.git.archiveWorktree({ workspace: f.host.store.workspace(f.workspace.id),
      worktree: { id: tree.id, taskId: '', attempt: 0, kind: 'task', path: tree.path, baseCommit: tree.baseCommit },
      active: false, cleanupConfirmed: true, artifactsSaved: true,
      beforeRemove: () => writeFile(path.join(tree.path,'ignored.log'),'late data'),
    })).rejects.toThrow('dirty, untracked or ignored');
    expect(await readFile(path.join(tree.path,'ignored.log'),'utf8')).toBe('late data');
  });

  it('fences task/workflow/repository metadata and late associations while a terminal task deletion is running', async () => {
    const f = await fixture(), task = await f.task(); f.finish();
    const item = await f.target('task',task.tree.id);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.host.git.archiveWorktree.bind(f.host.git);
    const archive = vi.spyOn(f.host.git,'archiveWorktree').mockImplementationOnce(async input => { await gate; return original(input); });
    const pending = f.remove(item);
    try {
      await expect.poll(() => archive.mock.calls.length).toBe(1);
      expect(() => f.host.store.exec("UPDATE tasks SET status='ready' WHERE id='task'")).toThrow('WORKTREE_DELETION_IN_PROGRESS');
      expect(() => f.host.store.exec("UPDATE workflows SET status='running' WHERE id='workflow'")).toThrow('WORKTREE_DELETION_IN_PROGRESS');
      expect(() => f.host.store.exec("UPDATE repositories SET base_ref='HEAD' WHERE id=?",f.repo.id)).toThrow('WORKTREE_DELETION_IN_PROGRESS');
      await expect(f.host.repositories.createWorktree(f.workspace.id,f.repo.id,{origin:'external',path:task.tree.path})).rejects.toThrow('WORKTREE_DELETION_IN_PROGRESS');
    } finally { release(); }
    await expect(pending).resolves.toMatchObject({state:'deleted'});
  });

  it('does not trust a resolved snapshot if metadata changes before the deletion reservation', async () => {
    const f = await fixture(), task = await f.task();
    const candidate = await f.host.git.prepareCandidate({...task.context,sourceHead:task.source.sourceHead,integrationId:'stale'});
    await f.host.git.abandonCandidate({...task.context,candidate,reason:'done'});
    f.host.store.exec("INSERT INTO integrations(id,task_id,source_head,status) VALUES('stale','task',?,'blocked')",task.source.sourceHead);
    f.finish();
    const item = await f.target('candidate','stale'); expect(item.canDelete).toBe(true);
    const read = f.host.git.readOperation.bind(f.host.git);
    vi.spyOn(f.host.git,'readOperation').mockImplementationOnce(async (...args) => {
      const operation = await read(...args);
      f.host.store.exec("UPDATE tasks SET version=version+1 WHERE id='task'");
      return operation;
    });
    await expect(f.remove(item)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    expect(f.host.store.get("SELECT record_id FROM worktree_removals WHERE record_id='stale'")).toBeUndefined();
    expect(await realpath(item.path)).toBe(item.path);
  });
});

async function liveLead(f: Awaited<ReturnType<typeof fixture>>) {
  const lead = f.roles.find(role => role.purpose === 'lead')!;
  const conversation = f.host.chat.createConversation(f.workspace.id);
  const configuration = { connection: { runtime: 'dsh', provider: 'test', model: 'test' }, agent: { id: lead.id, displayName: 'Lead', prompt: '', version: 1, purpose: 'lead' }, runtimeAccess: { permissionVersion: 'test', cwd: f.repositoryPath, repositoryPaths: [f.repositoryPath] } };
  f.host.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at) VALUES('cleanup-message',?,?,'user','Clean completed worktrees','completed','now')", f.workspace.id, conversation.id);
  f.host.store.exec("INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('cleanup-turn',?,?,'cleanup-message',?,'running',?,'now')", f.workspace.id, conversation.id, lead.id, JSON.stringify(configuration));
  f.host.store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('cleanup-lease','turn','cleanup-turn',?,?,'lead','now')", f.workspace.id, lead.id);
  const actor = f.host.chat.turn(f.workspace.id, 'cleanup-turn');
  const call = (argv: string[], input: Record<string, unknown> = {}, key: string = crypto.randomUUID()) => f.host.workspaceCli.execute(f.workspace.id, { argv, input }, actor, key);
  const targets = async () => (await call(['worktree', 'removals', f.repo.id]) as { removals: WorktreeRemovalTarget[] }).removals;
  return { actor, call, targets, lead };
}

describe('workspace Lead managed worktree cleanup', () => {
  it('lets a live workspace Lead list and delete all four managed worktree kinds without blocking on itself', async () => {
    const f = await fixture(), user = await f.user(), task = await f.task();
    const candidate = await f.host.git.prepareCandidate({ ...task.context, sourceHead: task.source.sourceHead, integrationId: 'integration' });
    await f.host.git.publishCandidate({ ...task.context, candidate, review: { schemaVersion: 1, taskId: 'task', runId: 'review', verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] } });
    f.host.store.exec("INSERT INTO integrations(id,task_id,source_head,expected_target_head,candidate_head,status,candidate) VALUES('integration','task',?,?,?,'accepted',?)", candidate.sourceHead, candidate.expectedTargetHead, candidate.candidateHead, JSON.stringify(candidate));
    f.finish();
    const lead = await liveLead(f);
    for (const [kind, id] of [['user',user.id],['candidate','integration'],['review','integration'],['task',task.tree.id]] as const) {
      const item = (await lead.targets()).find(item => item.kind === kind && item.recordId === id)!;
      expect(item.canDelete).toBe(true);
      const input = { kind, expectedVersion: item.expectedVersion, confirmDelete: true }, key = `delete-${kind}`;
      const result = await lead.call(['worktree','delete',id], input, key);
      expect(result).toMatchObject({ state: 'deleted' });
      expect(await lead.call(['worktree','delete',id], input, key)).toEqual(result);
      await expect(lstat(item.path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(f.host.store.require('SELECT status FROM agent_turns WHERE id=?', lead.actor.id)).toEqual({ status: 'running' });
    expect(f.host.store.require('SELECT released_at FROM execution_leases WHERE id=?', 'cleanup-lease')).toEqual({ releasedAt: null });
    expect(f.host.store.all('SELECT * FROM worktree_removals')).toHaveLength(4);
  });
});

describe('Lead cleanup scope and lifetime', () => {
  it('also supports the managed archive command from the live Lead', async () => {
    const f = await fixture(), tree = await f.user(), lead = await liveLead(f);
    expect(await lead.call(['worktree','archive',tree.id], { expectedVersion: tree.version })).toMatchObject({ status: 'archived' });
    await expect(lstat(tree.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['other-lease','other-turn','unknown-own-lease','stopped','disabled','non-lead','own-cwd','foreign-workspace'] as const)('does not exempt %s from deletion checks', async mode => {
    const f = await fixture(), tree = await f.user(), lead = await liveLead(f);
    const item = (await lead.targets()).find(item => item.recordId === tree.id)!;
    const s = f.host.store;
    if (mode === 'other-lease') s.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('other','turn','other',?,?,'developer','now')", f.workspace.id, f.roles.find(role => role.name === 'developer-b')!.id);
    if (mode === 'other-turn') {
      s.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at) VALUES('other-message',?,?,'user','Other execution','completed','now')",f.workspace.id,lead.actor.conversationId);
      s.exec("INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('other',?,?,'other-message',?,'queued','{}','now')", f.workspace.id, lead.actor.conversationId, f.roles.find(role => role.name === 'developer-b')!.id);
    }
    if (mode === 'unknown-own-lease') s.exec("UPDATE execution_leases SET cleanup_status='unknown' WHERE id='cleanup-lease'");
    if (mode === 'stopped') s.exec("UPDATE agent_turns SET status='stopping' WHERE id='cleanup-turn'");
    if (mode === 'disabled') s.exec('UPDATE roles SET enabled=0 WHERE id=?',lead.lead.id);
    if (mode === 'non-lead') s.exec("UPDATE roles SET purpose='developer',kind='subagent',provider_binding_id=? WHERE id=?",f.roles.find(role => role.name === 'developer-b')!.providerBindingId!,lead.lead.id);
    if (mode === 'own-cwd') s.exec('UPDATE agent_turns SET configuration=? WHERE id=?',JSON.stringify({...lead.actor.configuration,runtimeAccess:{...lead.actor.configuration.runtimeAccess,cwd:tree.path}}),lead.actor.id);
    if (mode === 'foreign-workspace') {
      s.exec("INSERT INTO workspaces(id,name,root_path,status) VALUES('other','Other',?,'active')",path.join(f.home,'other'));
      s.exec("UPDATE workspace_worktrees SET workspace_id='other' WHERE id=?", tree.id);
    }
    await expect(lead.call(['worktree','delete',tree.id],{kind:'user',expectedVersion:item.expectedVersion,confirmDelete:true})).rejects.toThrow();
    expect(await realpath(tree.path)).toBe(tree.path);
  });
  it('rejects untrusted actor overrides and unconfirmed deletion input', async () => {
    const f = await fixture(), tree = await f.user(), lead = await liveLead(f);
    const item = (await lead.targets()).find(item => item.recordId === tree.id)!;
    await expect(lead.call(['worktree','delete',tree.id],{kind:'user',expectedVersion:item.expectedVersion,confirmDelete:true,removalActor:{turnId:'other'}})).rejects.toThrow();
    await expect(lead.call(['worktree','delete',tree.id],{kind:'user',expectedVersion:item.expectedVersion})).rejects.toThrow();
    // An HTTP body cannot manufacture the trusted CLI context either.
    await expect(f.host.handleBrowser('POST', `${f.root}/worktree-removals/user/${tree.id}/delete`, {expectedVersion:item.expectedVersion,confirmDelete:true,removalActor:{turnId:lead.actor.id,agentId:lead.actor.agentId}}, 'forged-actor')).rejects.toThrow();
    expect(await realpath(tree.path)).toBe(tree.path);
  });
  it('revalidates the initiating Lead after awaits and before actual Git deletion', async () => {
    const f = await fixture(), tree = await f.user(), lead = await liveLead(f);
    const item = (await lead.targets()).find(item => item.recordId === tree.id)!;
    const original = f.host.git.archiveWorktree.bind(f.host.git);
    vi.spyOn(f.host.git,'archiveWorktree').mockImplementationOnce(async input => {
      f.host.store.exec("UPDATE agent_turns SET status='stopping' WHERE id=?",lead.actor.id);
      return original(input);
    });
    await expect(lead.call(['worktree','delete',tree.id],{kind:'user',expectedVersion:item.expectedVersion,confirmDelete:true})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    expect(await realpath(tree.path)).toBe(tree.path);
    expect(f.host.store.require('SELECT state FROM worktree_removals WHERE record_id=?', tree.id)).toEqual({state:'failed'});
  });
  it('retains busy task protections for the Lead rather than bypassing every lease', async () => {
    const f = await fixture(), task = await f.task(), lead = await liveLead(f);
    f.host.store.exec("UPDATE runs SET cleanup_status='pending',slot_released_at=NULL WHERE id='run'");
    const item = (await lead.targets()).find(item => item.kind === 'task' && item.recordId === task.tree.id)!;
    expect(item.canDelete).toBe(false);
    await expect(lead.call(['worktree','delete',task.tree.id],{kind:'task',expectedVersion:item.expectedVersion,confirmDelete:true})).rejects.toMatchObject({code:'CLEANUP_UNKNOWN'});
  });
});

describe('removed directory presentation', () => {
  it('reports manually removed and unregistered worktrees as missing without inventing deletion receipts', async () => {
    const f = await fixture(), tree = await f.user();
    await gitOk(f.repositoryPath,['worktree','remove',tree.path]);
    expect(await f.target('user',tree.id)).toMatchObject({state:'missing',canDelete:false,canReconcile:false,reason:expect.stringContaining('目录已不存在')});
    expect(f.host.store.all('SELECT * FROM worktree_removals')).toEqual([]);
    expect(f.host.repositories.worktrees(f.workspace.id,f.repo.id)[0]?.status).toBe('active');
  });
  it('keeps missing-but-still-registered worktrees visible instead of claiming confirmed absence', async () => {
    const f = await fixture(), tree = await f.user();
    await rm(tree.path,{recursive:true});
    expect(await f.target('user',tree.id)).toMatchObject({state:'available',canDelete:false});
  });
});

// Large historical lists must finish before the UI's periodic refresh cancels them.
it('uses one Git registration snapshot for multiple missing historical directories', async () => {
  const f = await fixture(), first = await f.user(), second = await f.user();
  await gitOk(f.repositoryPath, ['worktree','remove',first.path]);
  await gitOk(f.repositoryPath, ['worktree','remove',second.path]);
  const listing = vi.spyOn(gitProcess, 'worktreePorcelain');
  expect((await f.list()).map(item => item.state)).toEqual(['missing','missing']);
  expect(listing).toHaveBeenCalledTimes(1);
});

it.each(['running','paused','blocked'])('deletes an idle task worktree while its workflow is %s and unrelated work is active',async status=>{
 const f=await fixture(),task=await f.task();
 f.host.store.exec("UPDATE workflows SET status=? WHERE id='workflow'",status);
 f.host.store.exec("UPDATE tasks SET status='blocked' WHERE id='task'");
 f.host.store.exec("UPDATE runs SET status='running' WHERE id='run'");
 f.host.store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('unrelated','turn','unrelated',?,?,'developer','now')",f.workspace.id,f.roles.find(role=>role.name==='developer-b')!.id);
 const item=await f.target('task',task.tree.id);expect(item.canDelete).toBe(true);
 await f.remove(item);await expect(lstat(task.tree.path)).rejects.toMatchObject({code:'ENOENT'});
 expect(f.host.store.run('run').status).toBe('running');
});

it.each(['dist','node_modules','packages/protocol/dist','packages/protocol/node_modules'])('removes approved ignored build directory %s',async directory=>{
  const f=await fixture(),tree=await f.user();
  await writeFile(path.join(tree.path,'.gitignore'),'ignored.log\n'+directory+'/\n');
  await gitOk(tree.path,['add','.gitignore']);await gitOk(tree.path,['commit','-m','ignore build output']);
  await mkdir(path.join(tree.path,directory),{recursive:true});
  await writeFile(path.join(tree.path,directory,'generated.txt'),'generated');
  const item=await f.target('user',tree.id);expect(item.canDelete).toBe(true);
  expect(await readFile(path.join(tree.path,directory,'generated.txt'),'utf8')).toBe('generated');
  await f.remove(item);await expect(lstat(tree.path)).rejects.toMatchObject({code:'ENOENT'});
});

it.each(['untracked','tracked'])('retains %s source content inside a build-named directory',async mode=>{
  const f=await fixture(),tree=await f.user();
  await mkdir(path.join(tree.path,'dist'));
  const file=path.join(tree.path,'dist','source.txt');await writeFile(file,'source');
  if(mode==='tracked'){
    await gitOk(tree.path,['add','dist']);await gitOk(tree.path,['commit','-m','tracked source']);
    await writeFile(path.join(tree.path,'.gitignore'),'ignored.log\ndist/\n');
    await gitOk(tree.path,['add','.gitignore']);await gitOk(tree.path,['commit','-m','ignore output']);
    await writeFile(file,'modified source');
  }
  const item=await f.target('user',tree.id);expect(item.canDelete).toBe(false);
  await expect(f.remove(item)).rejects.toThrow('ARCHIVE_BLOCKED');
  expect(await readFile(file,'utf8')).toBe(mode==='tracked'?'modified source':'source');
});
