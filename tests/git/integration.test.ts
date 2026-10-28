import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitContext, Run, ReviewResult, Candidate } from '../../src/contracts/index.js';
import { CandidateEvidenceError, fingerprint } from '../../src/git/evidence.js';
import { LocalGitService } from '../../src/git/integration.js';
import { sourceCheckoutClean, checkoutClean } from '../../src/git/worktree-binding.js';
import { gitOk,stageSourcePaths } from '../../src/git/process.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('rift-git-')) throw new Error('unsafe test cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rift-git-')); roots.push(root);
  const repositoryPath = path.join(root, '中文 仓库'); await mkdir(repositoryPath);
  await gitOk(repositoryPath, ['init', '-b', 'main']);
  await gitOk(repositoryPath, ['config', 'core.autocrlf', 'false']);
  await gitOk(repositoryPath, ['config', 'user.name', 'Test']); await gitOk(repositoryPath, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(repositoryPath, 'base.txt'), 'base\n');
  await writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.log\n');
  await gitOk(repositoryPath, ['add', '.']); await gitOk(repositoryPath, ['commit', '-m', 'base']);
  const baseCommit = await gitOk(repositoryPath, ['rev-parse', 'HEAD']);
  const service = new LocalGitService({ managedRoot: path.join(root, '管理 空间'), commands: [{ id: 'unit', executable: process.execPath, args: ['-e', 'process.stdout.write("verified")'] }] });
  const workspace: GitContext['workspace'] = { id: 'workspace', name: 'test', repositoryPath, rootPath: repositoryPath, commonGitDir: path.join(repositoryPath, '.git'), baseRef: 'main', status: 'active' };
  const workflow: GitContext['workflow'] = { id: 'workflow', workspaceId: workspace.id, goal: 'test', leadSessionId: null, planRevision: 1, version: 1, status: 'running', integrationRef: 'refs/heads/rift/integration/test', baseCommit, summary: null };
  const context = (id: string, expectedPaths: string[] = []): GitContext => ({ workspace, workflow, task: { id, workflowId: workflow.id, roleId: null, kind: 'change', title: id, instructions: id, expectedPaths, acceptanceCriteria: [], status: 'validating', attempt: 1, version: 1, acceptedCommit: null, sourceHead: null, blockingReason: null } });
  const run = (id: string): Run => ({ id: `run-${id}`, taskId: id, roleId: 'developer-a', purpose: 'develop', taskAttempt: 1, status: 'succeeded', providerSnapshot: {} as Run['providerSnapshot'], dshChildId: null, dshRunId: null, stopReason: 'end_turn', cleanupStatus: 'confirmed', slotReleasedAt: null, deadline: '', result: null, createdAt: '', startedAt: null, endedAt: null });
  const develop = async (id: string, file: string, value: string) => { const ctx = context(id); const execution = run(id); const worktree = await service.prepareTask({ ...ctx, run: execution }); await writeFile(path.join(worktree.path, file), value); const source = await service.collectSource({ ...ctx, run: execution, worktree }); return { ctx, execution, worktree, source }; };
  const approve = (ctx: GitContext, candidate: Candidate): ReviewResult => ({ schemaVersion: 1, taskId: ctx.task.id, runId: `review-${ctx.task.id}`, verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] });
  return { root, repositoryPath, baseCommit, service, workspace, workflow, context, run, develop, approve };
}
describe('real Git integration', () => {
  it('compares exact candidate commits using Host Git, with bounded redacted repair context',async()=>{
    const f=await fixture(),a=await f.develop('repair-context','a.txt','before');
    const first=await f.service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId:'context-first'});
    await f.service.abandonCandidate({...a.ctx,candidate:first,reason:'repair'});
    const b=await f.develop('repair-context-next','a.txt','after\n'+'x'.repeat(25000));
    const next=await f.service.prepareCandidate({...b.ctx,sourceHead:b.source.sourceHead,integrationId:'context-next'});
    const diff=await f.service.compareCandidates({...b.ctx,candidate:next,previousCandidateHead:first.candidateHead});
    expect(diff).toMatchObject({fromCommit:first.candidateHead,toCommit:next.candidateHead,changedPaths:['a.txt'],truncated:true});
    expect(diff.diff).toContain('-before');expect(diff.diff.length).toBeLessThan(24100);
    await expect(f.service.compareCandidates({...b.ctx,candidate:next,previousCandidateHead:'--bad-ref'})).rejects.toThrow('INVALID_COMMIT');
    await f.service.abandonCandidate({...b.ctx,candidate:next,reason:'done'});
  });
  it('collects existing committed source while preserving untracked pnpm stores in old worktrees',async()=>{
    const f=await fixture(),ctx=f.context('cache'),run=f.run('cache'),worktree=await f.service.prepareTask({...ctx,run});
    await writeFile(path.join(worktree.path,'feature.txt'),'feature');await gitOk(worktree.path,['add','feature.txt']);await gitOk(worktree.path,['commit','-m','candidate']);
    const head=await gitOk(worktree.path,['rev-parse','HEAD']);
    for(const folder of ['.pnpm-store/v10/files','nested/.pnpm-store/v10/files']){
      await mkdir(path.join(worktree.path,folder),{recursive:true});await writeFile(path.join(worktree.path,folder,'cache'),'CACHE_PRESERVED');
    }
    const source=await f.service.collectSource({...ctx,run,worktree});
    expect(source.sourceHead).toBe(head);expect(source.changedPaths).toEqual(['feature.txt']);
    expect(await sourceCheckoutClean(worktree.path)).toBe(true);expect(await checkoutClean(worktree.path)).toBe(false);
    expect(await readFile(path.join(worktree.path,'.pnpm-store/v10/files/cache'),'utf8')).toBe('CACHE_PRESERVED');
    await expect(f.service.archiveWorktree({workspace:f.workspace,worktree,active:false,cleanupConfirmed:true,artifactsSaved:true})).rejects.toThrow('ARCHIVE_BLOCKED');
  });
  it('still collects tracked cache-name files and detects modifications to them',async()=>{
    const f=await fixture(),ctx=f.context('tracked-cache'),run=f.run('tracked-cache'),worktree=await f.service.prepareTask({...ctx,run});
    await mkdir(path.join(worktree.path,'.pnpm-store'));await writeFile(path.join(worktree.path,'.pnpm-store','tracked.txt'),'tracked');
    await gitOk(worktree.path,['add','.pnpm-store/tracked.txt']);
    const source=await f.service.collectSource({...ctx,run,worktree});expect(source.changedPaths).toContain('.pnpm-store/tracked.txt');
    await writeFile(path.join(worktree.path,'.pnpm-store','tracked.txt'),'changed');expect(await sourceCheckoutClean(worktree.path)).toBe(false);
  });
  it('collects literal unusual filenames and staged deletions without pathspec expansion',async()=>{
    const f=await fixture(),ctx=f.context('literal'),run=f.run('literal'),worktree=await f.service.prepareTask({...ctx,run});
    const names=[' leading space.txt','[ab].txt','--option.txt',...process.platform==='win32'?[]:[':(glob)*','line\nbreak.txt']];
    for(const name of names)await writeFile(path.join(worktree.path,name),'exact');
    await rm(path.join(worktree.path,'base.txt'));
    const source=await f.service.collectSource({...ctx,run,worktree});
    expect(source.changedPaths.sort()).toEqual([...names,'base.txt'].sort());
    expect((await gitOk(worktree.path,['ls-files','-z'])).split('\0')).not.toContain('base.txt');
    expect(await sourceCheckoutClean(worktree.path)).toBe(true);
  });
  it('stages a legitimate source list larger than Linux ARG_MAX through stdin',async()=>{
    const f=await fixture(),ctx=f.context('large'),run=f.run('large'),worktree=await f.service.prepareTask({...ctx,run});
    const names=Array.from({length:12000},(_,n)=>`file-${String(n).padStart(5,'0')}-${'x'.repeat(175)}.txt`);
    for(let i=0;i<names.length;i+=100)await Promise.all(names.slice(i,i+100).map(name=>writeFile(path.join(worktree.path,name),'source')));
    expect(Buffer.byteLength(names.join('\0'))).toBeGreaterThan(2097152);
    await stageSourcePaths(worktree.path,names);
    expect((await gitOk(worktree.path,['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean)).toHaveLength(names.length);
    await gitOk(worktree.path,['commit','-m','large-source']);expect(await sourceCheckoutClean(worktree.path)).toBe(true);
  },60000);

  it('runs real Git checks in linked candidates with read-only common metadata', async () => {
    const f=await fixture(),a=await f.develop('git-check','feature.txt','feature');
    const service=new LocalGitService({managedRoot:path.join(f.root,'git-check-managed'),commands:[{id:'diff-check',executable:'git',args:['diff','--check','HEAD^','HEAD']},{id:'metadata-readonly',executable:process.execPath,args:['-e',`const fs=require('fs'),cp=require('child_process');const dir=cp.execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();try{fs.writeFileSync(dir+'/MUST_NOT_WRITE','bad');process.exit(1)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e;}console.log('GIT_READABLE_METADATA_READONLY');`]}]});
    const candidate=await service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId:'git-check'});
    expect(candidate.checks!.map(check=>check.exitCode)).toEqual([0,0]);
    expect(candidate.checks![1]!.stdout).toContain('GIT_READABLE_METADATA_READONLY');
    expect(await gitOk(f.repositoryPath,['rev-parse','HEAD'])).toBe(f.baseCommit);
  });

  it('isolates Chinese/space paths and rebuilds the second candidate on latest accepted HEAD', async () => {
    const f = await fixture();
    const a = await f.develop('a', '甲.txt', 'A'); const b = await f.develop('b', '乙.txt', 'B');
    expect(a.worktree.path).not.toBe(b.worktree.path); expect(a.worktree.baseCommit).toBe(b.worktree.baseCommit);
    const ca = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'ia' });
    await f.service.publishCandidate({ ...a.ctx, candidate: ca, review: f.approve(a.ctx, ca) });
    const cb = await f.service.prepareCandidate({ ...b.ctx, sourceHead: b.source.sourceHead, integrationId: 'ib' });
    expect(cb.expectedTargetHead).toBe(ca.candidateHead);
    expect(await readFile(path.join(cb.cwd, '甲.txt'), 'utf8')).toBe('A'); expect(await readFile(path.join(cb.cwd, '乙.txt'), 'utf8')).toBe('B');
    await f.service.publishCandidate({ ...b.ctx, candidate: cb, review: f.approve(b.ctx, cb) });
    expect(await gitOk(f.repositoryPath, ['rev-parse', 'main'])).toBe(f.baseCommit);
    expect(await f.service.recoverPublication({ ...b.ctx, candidate: cb })).toBe('published');
    const op = await f.service.readOperation(f.workspace, 'ib'); expect(op.checks?.every(c => c.candidateHead === cb.candidateHead)).toBe(true);
  });
  it('rejects mismatched review and releases integration ownership', async () => {
    const f = await fixture(); const a = await f.develop('a', 'a.txt', 'A');
    const candidate = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'invalid-review' });
    await expect(f.service.publishCandidate({ ...a.ctx, candidate, review: { ...f.approve(a.ctx, candidate), reviewedCommit: f.baseCommit } })).rejects.toThrow('INVALID_RESULT');
    const next = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'next' });
    await f.service.abandonCandidate({ ...a.ctx, candidate: next, reason: 'test finished' });
  });
  it('uses CAS and rejects review checkout mutations', async () => {
    const f = await fixture(); const a = await f.develop('a', 'a.txt', 'A');
    const candidate = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'cas' });
    await gitOk(f.repositoryPath, ['update-ref', f.workflow.integrationRef, a.source.sourceHead, f.baseCommit]);
    await expect(f.service.publishCandidate({ ...a.ctx, candidate, review: f.approve(a.ctx, candidate) })).rejects.toThrow('STALE_TARGET');
    const c2 = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'mutation' });
    await writeFile(path.join(c2.cwd, 'base.txt'), 'review changed tracked source');
    await expect(f.service.publishCandidate({ ...a.ctx, candidate: c2, review: f.approve(a.ctx, c2) })).rejects.toThrow('REVIEW_MODIFIED');
  });
  it('preserves accepted work on conflict and allows another candidate afterwards', async () => {
    const f = await fixture(); const a = await f.develop('a', 'base.txt', 'A\n'); const b = await f.develop('b', 'base.txt', 'B\n'); const c = await f.develop('c', 'c.txt', 'C');
    const first = await f.service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'first' }); await f.service.publishCandidate({ ...a.ctx, candidate: first, review: f.approve(a.ctx, first) });
    await expect(f.service.prepareCandidate({ ...b.ctx, sourceHead: b.source.sourceHead, integrationId: 'conflict' })).rejects.toThrow('CONFLICT');
    expect((await f.service.readOperation(f.workspace, 'conflict')).reason).toContain('base.txt');
    expect(await gitOk(f.repositoryPath, ['rev-parse', f.workflow.integrationRef])).toBe(first.candidateHead);
    const third = await f.service.prepareCandidate({ ...c.ctx, sourceHead: c.source.sourceHead, integrationId: 'third' }); await f.service.publishCandidate({ ...c.ctx, candidate: third, review: f.approve(c.ctx, third) });
    expect(await readFile(path.join(third.cwd, 'base.txt'), 'utf8')).toBe('A\n');
  });
  it('collects unlisted files but protects dirty contents, unknown cleanup and outside paths', async () => {
    const f = await fixture(); const ctx = f.context('scope', ['allowed']); const run = f.run('scope'); const worktree = await f.service.prepareTask({ ...ctx, run });
    await writeFile(path.join(worktree.path, 'outside.txt'), 'keep');
    await expect(f.service.collectSource({ ...ctx, run:{...run,cleanupStatus:'unknown'}, worktree })).rejects.toThrow('WORKTREE_OWNERSHIP');
    expect((await f.service.collectSource({ ...ctx, run, worktree })).changedPaths).toContain('outside.txt');
    await writeFile(path.join(worktree.path,'pending.txt'),'uncollected');
    const archive = { workspace: f.workspace, worktree, active: false, cleanupConfirmed: true, artifactsSaved: true };
    await expect(f.service.archiveWorktree(archive)).rejects.toThrow('ARCHIVE_BLOCKED');
    const a = await f.develop('a', 'a.txt', 'A'); await writeFile(path.join(a.worktree.path, 'ignored.log'), 'keep ignored');
    await expect(f.service.archiveWorktree({ ...archive, worktree: a.worktree })).rejects.toThrow('ARCHIVE_BLOCKED');
    await expect(f.service.archiveWorktree({ ...archive, cleanupConfirmed: false })).rejects.toThrow('ARCHIVE_BLOCKED');
    await expect(f.service.archiveWorktree({ ...archive, worktree: { ...worktree, path: f.repositoryPath } })).rejects.toThrow('UNSAFE_PATH');
    expect(await readFile(path.join(worktree.path, 'outside.txt'), 'utf8')).toBe('keep');
  });
  it('collects the final working tree without applying the legacy planned-file whitelist', async () => {
    const f = await fixture(); const ctx = f.context('staged', ['allowed.txt']); const run = f.run('staged');
    const worktree = await f.service.prepareTask({ ...ctx, run });
    await writeFile(path.join(worktree.path, 'base.txt'), 'hidden staged change'); await gitOk(worktree.path, ['add', 'base.txt']);
    await writeFile(path.join(worktree.path, 'base.txt'), 'base\n'); await writeFile(path.join(worktree.path, 'allowed.txt'), 'allowed');
    const collected=await f.service.collectSource({ ...ctx, run, worktree });
    expect(collected.changedPaths).toContain('base.txt');
    expect(await gitOk(worktree.path,['show',`${collected.sourceHead}:base.txt`])).toBe('base');
    expect(await gitOk(worktree.path,['show',`${collected.sourceHead}:allowed.txt`])).toBe('allowed');
  });
  it('accepts ignored build/cache outputs while preserving them against deletion',async()=>{
    const f=await fixture(),a=await f.develop('cache-build','a.txt','A');
    const service=new LocalGitService({managedRoot:f.service.managedRoot,commands:[{id:'build',executable:process.execPath,args:['-e',"require('fs').writeFileSync('ignored.log','build cache')"]}]});
    const candidate=await service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId:'cache-build'});
    expect(candidate.checks?.[0]?.exitCode).toBe(0);
    const operation=await service.readOperation(f.workspace,'cache-build');expect(await readFile(path.join(operation.candidatePath,'ignored.log'),'utf8')).toBe('build cache');
    const accepted=await service.publishCandidate({...a.ctx,candidate,review:f.approve(a.ctx,candidate)});expect(accepted.acceptedCommit).toBe(candidate.candidateHead);
    expect((await gitOk(f.repositoryPath,['ls-tree','--name-only',accepted.acceptedCommit])).split('\n')).not.toContain('ignored.log');
    await expect(service.archiveWorktree({workspace:f.workspace,worktree:{...a.worktree,kind:'candidate',path:operation.candidatePath},active:false,cleanupConfirmed:true,artifactsSaved:true})).rejects.toThrow('ARCHIVE_BLOCKED');
  });
  it('persists quarantine after a timed-out check and refuses default archive even after restart', async () => {
    const f = await fixture(); const a = await f.develop('timeout', 'a.txt', 'A');
    const options = { managedRoot: f.service.managedRoot, commands: [{ id: 'hang', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }] };
    const service = new LocalGitService(options);
    await expect(service.prepareCandidate({ ...a.ctx, sourceHead: a.source.sourceHead, integrationId: 'timeout-check' })).rejects.toThrow('EVIDENCE_NOT_READY');
    const operation = await service.readOperation(f.workspace, 'timeout-check');
    const restarted = new LocalGitService(options);
    await expect(restarted.archiveWorktree({ workspace: f.workspace, worktree: { ...a.worktree, kind: 'candidate', path: operation.candidatePath }, active: false, cleanupConfirmed: true, artifactsSaved: true })).rejects.toThrow('descendant cleanup is unconfirmed');
  });
  it.each([true, false])('makes timed-out checks a durable hard gate (required=%s), with reboot-only cleanup recovery', async required => {
    const f=await fixture(),a=await f.develop('timeout-gate','a.txt','A'),integrationId='timeout-gate';
    const unit={id:'unit',executable:process.execPath,args:['-e','process.exit(0)']};
    const hang={id:'hang',executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:100,required};
    const options={managedRoot:f.service.managedRoot,commands:[unit,hang]};
    const service=new LocalGitService(options);let candidate!:Candidate;
    try { await service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId}); }
    catch(error) { expect(error).toBeInstanceOf(CandidateEvidenceError);expect(error).toMatchObject({cleanupUnknown:true,readiness:{status:'environment_unavailable',cleanupStatus:'unknown'}});candidate=(error as CandidateEvidenceError).candidate; }
    const operation=await service.readOperation(f.workspace,integrationId);
    expect(operation.checks?.map(check=>check.exitCode)).toEqual([0,124]);
    await expect(lstat(operation.reviewPath)).rejects.toMatchObject({code:'ENOENT'});
    const restarted=new LocalGitService(options);
    expect(await restarted.candidateReadiness({...a.ctx,candidate})).toMatchObject({status:'environment_unavailable',cleanupStatus:'unknown'});
    await expect(restarted.publishCandidate({...a.ctx,candidate,review:f.approve(a.ctx,candidate)})).rejects.toMatchObject({cleanupUnknown:true});
    const attempts=await Promise.allSettled(['one','two'].map(idempotencyKey=>restarted.resumeCandidate({...a.ctx,integrationId,candidateHead:candidate.candidateHead,idempotencyKey})));
    expect(attempts.every(result=>result.status==='rejected')).toBe(true);
    expect((await restarted.readOperation(f.workspace,integrationId)).checks?.map(check=>check.id)).toEqual(candidate.checkIds);
    // Removing the sidecar or changing configuration cannot certify process cleanup.
    await rm(path.join(service.managedRoot,'quarantine'),{recursive:true});
    const repaired=new LocalGitService({managedRoot:service.managedRoot,commands:[unit]});
    expect(await repaired.candidateReadiness({...a.ctx,candidate})).toMatchObject({cleanupStatus:'unknown'});
    const before=`v1:${'a'.repeat(64)}:${'1'.repeat(64)}`,after=`v1:${'a'.repeat(64)}:${'2'.repeat(64)}`;
    await expect(repaired.reconcileCandidateCleanup({...a.ctx,candidate,previousBootId:before,currentBootId:before})).rejects.toThrow('CLEANUP_UNKNOWN');
    await expect(repaired.reconcileCandidateCleanup({...a.ctx,candidate,previousBootId:before,currentBootId:after.replace('a'.repeat(64),'b'.repeat(64))})).rejects.toThrow('CLEANUP_UNKNOWN');
    await repaired.reconcileCandidateCleanup({...a.ctx,candidate,previousBootId:before,currentBootId:after});
    expect((await repaired.readOperation(f.workspace,integrationId)).cleanupRebootProof).toEqual({previousBootId:before,currentBootId:after});
    const resumed=await repaired.resumeCandidate({...a.ctx,integrationId,candidateHead:candidate.candidateHead,idempotencyKey:'after-reboot'});
    expect(resumed.readiness).toMatchObject({status:'ready',cleanupStatus:'confirmed'});
    expect(await repaired.publishCandidate({...a.ctx,candidate:resumed,review:f.approve(a.ctx,resumed)})).toEqual({acceptedCommit:candidate.candidateHead});
  });
  it('persists immutable redacted Host attachments and rejects wrong bindings, log paths and forged sources', async () => {
    const f=await fixture(),a=await f.develop('evidence','a.txt','A');
    const options={managedRoot:f.service.managedRoot,commands:[{id:'log',executable:process.execPath,args:['-e',`console.log('token=private-credential-value');console.log('x'.repeat(70000))`]}]};
    const service=new LocalGitService(options),candidate=await service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId:'evidence'});
    const check=candidate.checks![0]!,operation=await service.readOperation(f.workspace,'evidence');
    expect(check.host).toMatchObject({executionSource:'host',workspaceId:f.workspace.id,taskId:a.ctx.task.id,attempt:1,integrationId:'evidence',candidateHead:candidate.candidateHead,exitStatus:'passed'});
    expect(check.truncated).toBe(true);expect(JSON.stringify(operation)).not.toContain('private-credential-value');
    const restarted=new LocalGitService(options),input={...a.ctx,integrationId:'evidence',checkId:check.id};
    const full=await restarted.readCheckEvidence(input);expect(full.stdout.length).toBeGreaterThan(check.stdout.length);expect(full.stdout).toContain('[REDACTED]');
    await expect(restarted.readOperation({...f.workspace,id:'foreign'},'evidence')).rejects.toThrow();
    await expect(restarted.readCheckEvidence({...input,checkId:'../../management.token'})).rejects.toThrow('UNSAFE_EVIDENCE_PATH');
    await expect(restarted.candidateReadiness({...a.ctx,candidate:{...candidate,candidateHead:f.baseCommit}})).rejects.toThrow('CANDIDATE_EVIDENCE_MISMATCH');
    await expect(restarted.candidateReadiness({...a.ctx,task:{...a.ctx.task,attempt:2},candidate})).rejects.toThrow('CANDIDATE_EVIDENCE_MISMATCH');
    expect((await restarted.readCheckEvidence({...input,task:{...a.ctx.task,attempt:2,sourceHead:f.baseCommit}})).id).toBe(check.id);
    const {key}=await import('../../src/git/worktree-binding.js');
    const actual=path.join(service.managedRoot,key(f.workspace.id),'operations',key('evidence'));
    const journal=path.join(actual,'operation.json'),saved=JSON.parse(await readFile(journal,'utf8'));
    saved.checks[0].host.executionSource='developer';await writeFile(journal,JSON.stringify(saved));
    await expect(restarted.readOperation(f.workspace,'evidence')).rejects.toThrow('CANDIDATE_EVIDENCE_MISMATCH');
    saved.checks=operation.checks;await writeFile(journal,JSON.stringify(saved));
    const attachment=path.join(actual,`${check.id}.json`);await rm(attachment);await symlink(path.join(f.repositoryPath,'base.txt'),attachment);
    await expect(restarted.readOperation(f.workspace,'evidence')).rejects.toThrow();
    await service.abandonCandidate({...a.ctx,candidate,reason:'done'}).catch(()=>{});
  });
  it('supplements the same persisted candidate after environment repair and invalidates changed check configuration', async () => {
    const f=await fixture(),a=await f.develop('supplement','a.txt','A'),integrationId='supplement';
    const bad={id:'unit',executable:'rift-missing-executable',args:[]};
    const service=new LocalGitService({managedRoot:f.service.managedRoot,commands:[bad]});
    await expect(service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId})).rejects.toMatchObject({readiness:{status:'environment_unavailable',blockers:[{classification:'environment_unavailable',commandId:'unit',reason:expect.any(String)}]}});
    const original=await service.readOperation(f.workspace,integrationId);
    const repaired=new LocalGitService({managedRoot:f.service.managedRoot,commands:[{id:'unit',executable:process.execPath,args:['-e','console.log("repaired")']},{id:'advisory',executable:process.execPath,args:['-e','process.exit(3)'],required:false}]});
    const candidate=await repaired.resumeCandidate({...a.ctx,integrationId,candidateHead:original.candidateHead!,idempotencyKey:'repair'});
    expect(candidate.candidateHead).toBe(original.candidateHead);expect(candidate.readiness).toMatchObject({status:'ready',blockers:[{classification:'optional'}]});
    const repeated=await repaired.resumeCandidate({...a.ctx,integrationId,candidateHead:original.candidateHead!,idempotencyKey:'repair'});
    expect(repeated.checkIds).toEqual(candidate.checkIds);
    expect((await repaired.readCheckEvidence({...a.ctx,integrationId,checkId:original.checks![0]!.id})).host?.exitStatus).toBe('environment_unavailable');
    const changed=new LocalGitService({managedRoot:f.service.managedRoot,commands:[{id:'unit',executable:process.execPath,args:['-e','console.log("changed")']}]});
    expect(await changed.candidateReadiness({...a.ctx,candidate})).toMatchObject({status:'waiting_evidence',missingCheckIds:['unit']});
    await expect(changed.publishCandidate({...a.ctx,candidate,review:f.approve(a.ctx,candidate)})).rejects.toThrow('EVIDENCE_NOT_READY');
    await expect(repaired.resumeCandidate({...a.ctx,integrationId,candidateHead:f.baseCommit,idempotencyKey:'wrong-head'})).rejects.toThrow('CANDIDATE_EVIDENCE_MISMATCH');
    await gitOk(f.repositoryPath,['update-ref',f.workflow.integrationRef,a.source.sourceHead]);
    await expect(repaired.resumeCandidate({...a.ctx,integrationId,candidateHead:original.candidateHead!,idempotencyKey:'stale-target'})).rejects.toThrow('STALE_TARGET');
  });
  it('publishes with an explicitly optional ordinary failure without claiming that check passed',async()=>{
    const f=await fixture(),a=await f.develop('optional','a.txt','A');
    const service=new LocalGitService({managedRoot:f.service.managedRoot,commands:[{id:'required',executable:process.execPath,args:['-e','process.exit(0)']},{id:'optional',executable:process.execPath,args:['-e','process.exit(3)'],required:false}]});
    const candidate=await service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId:'optional'});
    expect(candidate.readiness).toMatchObject({status:'ready',cleanupStatus:'confirmed',blockers:[{classification:'optional'}]});
    expect(candidate.checks?.[1]).toMatchObject({exitCode:3,host:{exitStatus:'failed'}});
    expect(await service.publishCandidate({...a.ctx,candidate,review:f.approve(a.ctx,candidate)})).toEqual({acceptedCommit:candidate.candidateHead});
  });
  it('keeps old records readable without treating legacy or interrupted checks as passed Host evidence', async () => {
    const f=await fixture(),a=await f.develop('legacy','a.txt','A');
    const candidate=await f.service.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId:'legacy'});
    await f.service.abandonCandidate({...a.ctx,candidate,reason:'simulate restart'});
    const {key}=await import('../../src/git/worktree-binding.js');
    const file=path.join(f.service.managedRoot,key(f.workspace.id),'operations',key('legacy'),'operation.json');
    const saved=JSON.parse(await readFile(file,'utf8'));delete saved.checks[0].host;await writeFile(file,JSON.stringify(saved));
    expect((await f.service.readOperation(f.workspace,'legacy')).checks).toHaveLength(1);
    expect(await f.service.candidateReadiness({...a.ctx,candidate})).toMatchObject({status:'waiting_evidence',missingCheckIds:['unit']});
    saved.evidenceRequests={[fingerprint('interrupted')]:{candidateHead:candidate.candidateHead,complete:false}};await writeFile(file,JSON.stringify(saved));
    const restarted=new LocalGitService({managedRoot:f.service.managedRoot,commands:[{id:'unit',executable:process.execPath,args:['-e','process.stdout.write("verified")']}]});
    await expect(restarted.resumeCandidate({...a.ctx,integrationId:'legacy',candidateHead:candidate.candidateHead,idempotencyKey:'interrupted'})).rejects.toThrow('REQUEST_PENDING');
    expect((await restarted.readOperation(f.workspace,'legacy')).checks![0]!.id).toBe(candidate.checkIds[0]);
  });

  it('keeps an unexecuted required configuration waiting and ignores only explicitly removed optional checks', async () => {
    const f=await fixture(),a=await f.develop('unconfigured','a.txt','A'),integrationId='unconfigured';
    const missing=new LocalGitService({managedRoot:f.service.managedRoot,commands:[]});
    await expect(missing.prepareCandidate({...a.ctx,sourceHead:a.source.sourceHead,integrationId})).rejects.toMatchObject({readiness:{status:'waiting_evidence',blockers:[{classification:'evidence_missing',commandId:'',reason:expect.any(String)}]}});
    const operation=await missing.readOperation(f.workspace,integrationId);expect(operation.checks??[]).toEqual([]);
    const unit={id:'unit',executable:process.execPath,args:['-e','console.log("required")']};
    const supplied=new LocalGitService({managedRoot:f.service.managedRoot,commands:[unit,{id:'optional',executable:process.execPath,args:['-e','process.exit(1)'],required:false}]});
    const candidate=await supplied.resumeCandidate({...a.ctx,integrationId,candidateHead:operation.candidateHead!,idempotencyKey:'configure'});
    const removed=new LocalGitService({managedRoot:f.service.managedRoot,commands:[unit]});
    expect(await removed.candidateReadiness({...a.ctx,candidate})).toMatchObject({status:'ready'});
    expect(await removed.publishCandidate({...a.ctx,candidate,review:f.approve(a.ctx,candidate)})).toEqual({acceptedCommit:operation.candidateHead});
  });

});
