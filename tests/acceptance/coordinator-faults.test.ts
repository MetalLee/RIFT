import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { RiftStore } from '../../src/storage/database.js';
import type { ActivationBridge, ActivationResult, Candidate, GitService, Run } from '../../src/contracts/index.js';
import { seedWorkspace } from './fixtures.js';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const sha = (value: string) => createHash('sha1').update(value).digest('hex');
function harness(runTimeoutMs = 60_000, cleanupTimeoutMs = 30_000) {
  const store = new RiftStore(); const { workspace } = seedWorkspace(store);
  const starts: { input: Parameters<ActivationBridge['start']>[0]; result: ReturnType<typeof deferred<ActivationResult>>; dispose: ReturnType<typeof vi.fn<() => Promise<void>>>; cleanupGate?: ReturnType<typeof deferred<void>>; cleanupFails?: boolean }[] = [];
  const bridge: ActivationBridge = { start: async input => {
    const entry: (typeof starts)[number] = { input, result: deferred<ActivationResult>(), dispose: vi.fn<() => Promise<void>>() };
    entry.dispose.mockImplementation(async () => { if (entry.cleanupGate) await entry.cleanupGate.promise; if (entry.cleanupFails) throw new Error('Injected cleanup failure'); }); starts.push(entry);
    return { childId: `fake-${input.run.id}`, result: entry.result.promise, dispose: entry.dispose };
  } };
  let target = sha('base');
  const git: GitService = {
    prepareTask: vi.fn(async ({ task, run }) => ({ id: `wt-${run.id}`, taskId: task.id, attempt: task.attempt, kind: 'task' as const, path: `${process.cwd()}/fake-only/${run.id}`, baseCommit: target, writerRunId: run.id })),
    collectSource: vi.fn(async ({ task }) => ({ sourceHead: sha(task.id), changedPaths: [`${task.id}.ts`], diff: `diff for ${task.id}` })),
    prepareCandidate: vi.fn(async ({ sourceHead, integrationId }) => ({ integrationId, sourceHead, expectedTargetHead: target, candidateHead: sha(target + sourceHead), cwd: `${process.cwd()}/fake-only/review-${integrationId}`, checkIds: ['check-only-fake'] })),
    publishCandidate: vi.fn(async ({ candidate }) => { target = candidate.candidateHead; return { acceptedCommit: target }; }),
    containsCommit: vi.fn(async () => true), recoverPublication: vi.fn(async () => 'not-published' as const), abandonCandidate: vi.fn(async () => undefined),
  };
  const coordinator = new TaskCoordinator({ store, bridge, git, runTimeoutMs, cleanupTimeoutMs });
  const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Acceptance', integrationRef: 'refs/heads/rift/test', baseCommit: target });
  const plan = (tasks: { id: string; kind?: 'change' | 'analysis'; paths?: string[]; dependsOn?: string[] }[]) => coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: store.workflow(workflow.id).planRevision, tasks: tasks.map(task => ({ id: task.id, kind: task.kind ?? 'analysis', title: task.id, instructions: `Implement ${task.id}`, expectedPaths: task.paths ?? [`${task.id}.ts`], dependsOn: task.dependsOn })) });
  const dispatch = (taskId: string, key = `dispatch-${taskId}`) => coordinator.dispatch({ taskId, idempotencyKey: key, expectedVersion: store.task(taskId).version });
  const complete = (index: number, overrides: Record<string, unknown> = {}) => {
    const e = starts[index]!;
    const body = e.input.run.purpose === 'review'
      ? { schemaVersion: 1, taskId: e.input.task.id, runId: e.input.run.id, verdict: 'approve', reviewedCommit: (JSON.parse(e.input.prompt) as { candidate: Candidate }).candidate.candidateHead, findings: [] }
      : { schemaVersion: 1, taskId: e.input.task.id, runId: e.input.run.id, outcome: 'completed', summary: 'done', changedPaths: [], checksClaimed: [], blockingReasons: [] };
    e.result.resolve({ stopReason: 'completed', text: JSON.stringify({ ...body, ...overrides }) });
  };
  return { store, starts, git, coordinator, workflow, plan, dispatch, complete, close: async () => { await coordinator.shutdown(); store.close(); } };
}

describe('A01/A07/A13-A18 independent fake activation fault acceptance', () => {
  it('runs two developers, returns the later completion first and starts the queued third', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
      const one = h.dispatch('one'), two = h.dispatch('two'), three = h.dispatch('three');
      expect(h.dispatch('one').id).toBe(one.id);
      expect(three.phase).toBe('queued');
      await expect.poll(() => h.starts.length).toBe(2);
      expect(h.coordinator.status(h.workflow.id).slots).toEqual({ developers: 2, reviewers: 0, total: 2 });
      const cursor = h.coordinator.status(h.workflow.id).eventSeq;
      const waiting = h.coordinator.wait({ workflowId: h.workflow.id, requestIds: [one.id, two.id], afterEventSeq: cursor, timeoutMs: 1000 });
      h.complete(1);
      const result = await waiting;
      expect(result.timedOut).toBe(false); expect(result.events.some(event => event.taskId === 'two')).toBe(true);
      expect(h.store.run(h.starts[0]!.input.run.id).status).toBe('running');
      await expect.poll(() => h.starts.length).toBe(3);
      expect(h.store.operation(three.id).payload.runId).toBe(h.starts[2]!.input.run.id);
      h.complete(0); h.complete(2);
      await expect.poll(() => h.coordinator.status(h.workflow.id).tasks.every(task => task.status === 'succeeded')).toBe(true);
      expect(h.coordinator.finish({ workflowId: h.workflow.id, summary: 'all done' }).status).toBe('completed');
    } finally { await h.close(); }
  });

  it('retains failed cleanup slots and still cancels and cleans every sibling', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one' }, { id: 'two' }, { id: 'three' }]); h.dispatch('one'); h.dispatch('two'); h.dispatch('three');
      await expect.poll(() => h.starts.length).toBe(2);
      h.starts[0]!.cleanupFails = true;
      await h.coordinator.cancelWorkflow(h.workflow.id);
      await expect.poll(() => h.starts[1]!.dispose.mock.calls.length).toBe(1);
      expect(h.starts[0]!.dispose).toHaveBeenCalledOnce();
      expect(h.store.run(h.starts[0]!.input.run.id).slotReleasedAt).toBeNull();
      expect(h.store.run(h.starts[1]!.input.run.id).cleanupStatus).toBe('confirmed');
      expect(h.coordinator.status(h.workflow.id).slots.total).toBe(1);
      expect(h.starts.length).toBe(2);
      const other = seedWorkspace(h.store, 'other');
      expect(() => h.coordinator.createWorkflow({ workspaceId: h.workflow.workspaceId, goal: 'same workspace', integrationRef: 'refs/heads/rift/same', baseCommit: sha('base') })).toThrow(/workspace already owns/);
      const sibling = h.coordinator.createWorkflow({ workspaceId: other.workspace.id, goal: 'second', integrationRef: 'refs/heads/rift/other', baseCommit: sha('base') });
      expect(h.coordinator.status(sibling.id).globalSlots.total).toBe(1);
    } finally { await h.close(); }
  });

  it('bounds stuck cleanup and releases occupancy only after the owned late dispose succeeds', async () => {
    const h = harness(60_000, 30), cleanup = deferred<void>();
    try {
      h.plan([{ id: 'one' }, { id: 'two' }]); h.dispatch('one'); h.dispatch('two');
      await expect.poll(() => h.starts.length).toBe(2);
      h.starts[0]!.cleanupGate = cleanup;
      h.complete(0);
      await expect.poll(() => h.store.run(h.starts[0]!.input.run.id).cleanupStatus).toBe('unknown');
      const runId=h.starts[0]!.input.run.id;
      expect(h.store.run(runId).slotReleasedAt).toBeNull();
      h.complete(1);
      await expect.poll(() => h.store.task('two').status).toBe('succeeded');
      expect(h.coordinator.status(h.workflow.id).slots.total).toBe(1);
      expect(h.store.require<{releasedAt:string|null}>('SELECT released_at FROM execution_leases WHERE owner_id=?',runId).releasedAt).toBeNull();
      expect(h.store.require<{writerRunId:string|null}>('SELECT writer_run_id FROM worktrees WHERE task_id=?','one').writerRunId).toBe(runId);
      expect(()=>h.coordinator.reconcileRun(runId,h.store.require<{version:number}>('SELECT version FROM runs WHERE id=?',runId).version)).toThrow(/No owned cleanup receipt/);
      expect(h.store.task('one').status).toBe('blocked');
      cleanup.resolve();
      await expect.poll(() => h.store.run(runId).cleanupStatus).toBe('confirmed');
      expect(h.store.run(runId).slotReleasedAt).not.toBeNull();
      expect(h.store.require<{releasedAt:string|null}>('SELECT released_at FROM execution_leases WHERE owner_id=?',runId).releasedAt).not.toBeNull();
      expect(h.store.require<{writerRunId:string|null}>('SELECT writer_run_id FROM worktrees WHERE task_id=?','one').writerRunId).toBeNull();
      expect(h.coordinator.status(h.workflow.id).slots.total).toBe(0);
      expect(h.store.task('one').status).toBe('blocked');
      expect(h.starts).toHaveLength(2);
      expect(h.starts[0]!.dispose).toHaveBeenCalledTimes(1);
      const cleanupEvents=h.store.events(h.workflow.id).filter(event=>event.runId===runId&&event.type.startsWith('cleanup.')).map(event=>event.type);
      expect(cleanupEvents).toEqual(['cleanup.unknown','cleanup.confirmed']);
    } finally { cleanup.resolve(); await h.close(); }
  });

  it('does not consume paused queues and allows overlapping metadata in isolated task worktrees', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one', paths: ['src/shared'] }, { id: 'two', paths: ['src/shared/input.ts'] }, { id: 'three', paths: ['unrelated'] }]);
      h.dispatch('one'); h.dispatch('two'); h.dispatch('three');
      await expect.poll(() => h.starts.length).toBe(2);
      expect(h.starts.map(e => e.input.task.id)).toEqual(['one', 'two']);
      h.coordinator.pause(h.workflow.id); h.complete(0); h.complete(1);
      await expect.poll(() => h.coordinator.status(h.workflow.id).slots.total).toBe(0);
      expect(h.starts.length).toBe(2); h.coordinator.resume(h.workflow.id);
      await expect.poll(() => h.starts.length).toBe(3); expect(h.starts[2]!.input.task.id).toBe('three'); h.complete(2);
    } finally { await h.close(); }
  });

  it('rejects cycles and only releases successors after acceptance, while allowing 2 developers plus review', async () => {
    const h = harness();
    try {
      expect(() => h.plan([{ id: 'cycle-a', dependsOn: ['cycle-b'] }, { id: 'cycle-b', dependsOn: ['cycle-a'] }])).toThrow(/cycle/);
      expect(h.coordinator.status(h.workflow.id).tasks).toHaveLength(0);
      h.plan([{ id: 'first', kind: 'change' }, { id: 'second' }, { id: 'third' }, { id: 'dependent', dependsOn: ['first'] }]);
      h.dispatch('first'); h.dispatch('second'); h.dispatch('third'); h.dispatch('dependent');
      await expect.poll(() => h.starts.length).toBe(2); h.complete(h.starts.findIndex(entry=>entry.input.task.id==='first'));
      await expect.poll(() => h.coordinator.status(h.workflow.id).slots).toEqual({ developers: 2, reviewers: 1, total: 3 });
      expect(h.starts.some(e => e.input.task.id === 'dependent')).toBe(false);
      const reviewIndex = h.starts.findIndex(e => e.input.run.purpose === 'review'); h.complete(reviewIndex);
      await expect.poll(() => h.store.task('first').status).toBe('succeeded');
      h.complete(h.starts.findIndex(entry=>entry.input.task.id==='second'));
      await expect.poll(() => h.starts.some(e => e.input.task.id === 'dependent')).toBe(true);
    } finally { await h.close(); }
  });

  it('keeps a task cancelled when cancellation arrives during result cleanup', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one' }]); h.dispatch('one'); await expect.poll(() => h.starts.length).toBe(1);
      const gate = deferred<void>(); h.starts[0]!.cleanupGate = gate; h.complete(0);
      await expect.poll(() => h.store.run(h.starts[0]!.input.run.id).status).toBe('succeeded');
      const cancellation = h.coordinator.cancelTask('one'); gate.resolve(); await cancellation;
      await expect.poll(() => h.coordinator.status(h.workflow.id).operations[0]!.phase).not.toBe('started');
      expect(h.store.task('one').status).toBe('cancelled');
    } finally { await h.close(); }
  });

  it('times out one execution while a later sibling remains live and can finish', async () => {
    const h = harness(600);
    try {
      h.plan([{ id: 'one' }, { id: 'two' }]); h.dispatch('one'); await expect.poll(() => h.starts.length).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 300)); h.dispatch('two'); await expect.poll(() => h.starts.length).toBe(2);
      await expect.poll(() => h.store.task('one').status, { timeout: 1000 }).toBe('cancelled');
      expect(h.store.run(h.starts[1]!.input.run.id).status).toBe('running'); expect(h.starts[1]!.dispose).not.toHaveBeenCalled();
      expect(h.store.events(h.workflow.id).some(event => event.type === 'run.cancel_requested' && (event.payload as { reason: string }).reason === 'TIMEOUT')).toBe(true);
      h.complete(1); await expect.poll(() => h.store.task('two').status).toBe('succeeded');
    } finally { await h.close(); }
  });

  it('does not resurrect a cancelled task when source collection finishes later', async () => {
    const h = harness();
    const source = deferred<{ sourceHead: string; changedPaths: string[]; diff: string }>();
    vi.mocked(h.git.collectSource).mockImplementation(() => source.promise);
    try {
      h.plan([{ id: 'one', kind: 'change' }]); h.dispatch('one');
      await expect.poll(() => h.starts.length).toBe(1); h.complete(0);
      await expect.poll(() => vi.mocked(h.git.collectSource).mock.calls.length).toBe(1);
      await h.coordinator.cancelTask('one');
      source.resolve({ sourceHead: sha('one'), changedPaths: ['one.ts'], diff: 'source preserved' });
      await expect.poll(() => h.coordinator.status(h.workflow.id).operations[0]!.phase).not.toBe('started');
      expect(h.store.task('one').status).toBe('cancelled');
      expect(h.git.prepareCandidate).not.toHaveBeenCalled();
      expect(h.starts).toHaveLength(1);
    } finally { source.resolve({ sourceHead: sha('one'), changedPaths: ['one.ts'], diff: 'source preserved' }); await h.close(); }
  });

  it('does not dispatch a change successor if accepted ancestry was lost from the target', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'first', kind: 'change' }, { id: 'dependent', dependsOn: ['first'] }]);
      h.dispatch('first'); await expect.poll(() => h.starts.length).toBe(1); h.complete(0);
      await expect.poll(() => h.starts.length).toBe(2); h.complete(1);
      await expect.poll(() => h.store.task('first').status).toBe('succeeded');
      vi.mocked(h.git.containsCommit!).mockResolvedValue(false);
      h.dispatch('dependent');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(h.starts.some(entry => entry.input.task.id === 'dependent')).toBe(false);
    } finally { await h.close(); }
  });

  it('recovers an unknown reserved execution without releasing or replaying its role', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one' }, { id: 'two' }]);
      const role = h.store.role(`${h.workflow.workspaceId}:developer-a`);
      h.store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'crash-window', 'one', role.id, 'develop', 1, 'preparing', JSON.stringify({ role, binding: h.store.binding(role.providerBindingId!) }), new Date().toISOString(), new Date().toISOString());
      h.store.exec('UPDATE tasks SET status=? WHERE id=?', 'running', 'one');
      const recovered = await h.coordinator.recover();
      expect(recovered.interruptedRunIds).toEqual(['crash-window']);
      const run = h.store.run('crash-window'); expect(run.status).toBe('interrupted'); expect(run.cleanupStatus).toBe('unknown'); expect(run.slotReleasedAt).toBeNull();
      expect(h.starts).toHaveLength(0); expect(h.store.workflow(h.workflow.id).status).toBe('paused');
      expect(() => h.coordinator.retry({ taskId: 'one', reason: 'retry', expectedVersion: h.store.task('one').version })).toThrow(/cleanup/);
    } finally { await h.close(); }
  });

  it('recovers a published ref when the subsequent acceptance transaction fails without republishing', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one', kind: 'change' }]); h.dispatch('one'); await expect.poll(() => h.starts.length).toBe(1); h.complete(0);
      await expect.poll(() => h.starts.length).toBe(2);
      const originalExec = h.store.exec.bind(h.store); let injected = false;
      vi.spyOn(h.store, 'exec').mockImplementation((sql, ...args) => {
        if (!injected && sql === 'UPDATE integrations SET status=? WHERE id=?' && args[0] === 'accepted') { injected = true; throw new Error('Injected SQLite acceptance failure after ref publication'); }
        return originalExec(sql, ...args);
      });
      vi.mocked(h.git.recoverPublication!).mockResolvedValue('published'); h.complete(1);
      await expect.poll(() => h.store.task('one').blockingReason).toBe('PUBLICATION_REQUIRES_RECOVERY');
      expect(h.coordinator.status(h.workflow.id).integrations[0]!.status).toBe('publishing');
      expect(h.git.publishCandidate).toHaveBeenCalledOnce();
      const recovered = await h.coordinator.recover();
      expect(recovered.recoveredIntegrationIds).toHaveLength(1);
      expect(h.store.task('one').status).toBe('succeeded');
      expect(h.git.publishCandidate).toHaveBeenCalledOnce();
      expect(h.coordinator.status(h.workflow.id).operations.filter(operation => operation.kind === 'integration')[0]!.phase).toBe('completed');
    } finally { await h.close(); }
  });

  it('rejects new dispatches once host shutdown has started', async () => {
    const h = harness();
    try {
      h.plan([{ id: 'one' }]); await h.coordinator.shutdown();
      expect(() => h.dispatch('one')).toThrow(/stop|shut|clos/i);
      expect(h.coordinator.status(h.workflow.id).operations).toHaveLength(0);
      expect(h.starts).toHaveLength(0);
    } finally { await h.close(); }
  });

  it('supplies bound prior findings and Host repair differences without carrying approval to a new candidate',async()=>{
    const h=harness();
    try {
      h.git.compareCandidates=vi.fn(async input=>({fromCommit:input.previousCandidateHead,toCommit:input.candidate.candidateHead,diff:'Host repair diff',changedPaths:['one.ts'],truncated:false}));
      h.plan([{id:'one',kind:'change'}]);h.dispatch('one');await expect.poll(()=>h.starts.length).toBe(1);h.complete(0,{checksClaimed:['developer claims full coverage']});
      await expect.poll(()=>h.starts.length).toBe(2);
      const old=JSON.parse(h.starts[1]!.input.prompt).candidate as Candidate;
      const findings=[{severity:'high',file:'one.ts',line:1,reason:'Boundary defect',suggestion:'Repair boundary'}];
      h.complete(1,{verdict:'changes_requested',findings});await expect.poll(()=>h.store.task('one').status).toBe('blocked');
      h.coordinator.retry({taskId:'one',reason:'Fix boundary',expectedVersion:h.store.task('one').version});
      h.git.collectSource=vi.fn(async()=>({sourceHead:sha('repaired source'),diff:'whole change',changedPaths:['one.ts']}));
      h.dispatch('one','repair');await expect.poll(()=>h.starts.length).toBe(3);h.complete(2);
      await expect.poll(()=>h.starts.length).toBe(4);
      const prompt=JSON.parse(h.starts[3]!.input.prompt),current=prompt.candidate as Candidate;
      expect(current.candidateHead).not.toBe(old.candidateHead);
      expect(prompt.reviewContext).toMatchObject({previousVerdict:'changes_requested',previousReviewedCommit:old.candidateHead,findings,
        checkedScope:{checkIds:old.checkIds,checks:[]},repairDiff:{status:'available',fromCommit:old.candidateHead,toCommit:current.candidateHead,diff:'Host repair diff'},
        evidenceReferences:{previous:{integrationId:old.integrationId},current:{integrationId:current.integrationId}}});
      expect(prompt.reviewContext.instructions).toContain('discussion approval is not a formal review');
      expect(prompt.reviewContext.checkedScope).not.toHaveProperty('checksClaimed');
      expect(h.store.task('one').acceptedCommit).toBeNull();expect(h.git.publishCandidate).not.toHaveBeenCalled();
      h.complete(3,{reviewedCommit:old.candidateHead});await expect.poll(()=>h.store.task('one').status).toBe('blocked');
      expect(h.git.publishCandidate).not.toHaveBeenCalled();expect(h.store.all("SELECT id FROM runs WHERE purpose='review'")).toHaveLength(2);
    }finally{await h.close();}
  });

  it.each(['missing','error'])('creates a repair run retaining the old report when comparison is %s', async comparison => {
    const h = harness();
    try {
      h.plan([{ id: 'one', kind: 'change' }]); h.dispatch('one'); await expect.poll(() => h.starts.length).toBe(1); h.complete(0);
      await expect.poll(() => h.starts.length).toBe(2);
      h.complete(1, { verdict: 'changes_requested', findings: [{ severity: 'high', file: 'one.ts', line: 1, reason: 'Incorrect boundary', suggestion: 'Fix boundary' }] });
      await expect.poll(() => h.store.task('one').status).toBe('blocked');
      expect(h.git.publishCandidate).not.toHaveBeenCalled(); expect(h.git.abandonCandidate).toHaveBeenCalledOnce();
      const previousRunId = h.starts[0]!.input.run.id;
      const retried = h.coordinator.retry({ taskId: 'one', reason: 'Address review', expectedVersion: h.store.task('one').version });
      expect(retried.attempt).toBe(2); h.dispatch('one', 'repair-one'); await expect.poll(() => h.starts.length).toBe(3);
      expect(h.starts[2]!.input.run.id).not.toBe(previousRunId); expect(h.starts[2]!.input.run.purpose).toBe('repair');
      expect(h.store.run(previousRunId).status).toBe('succeeded');
      expect(h.starts[2]!.input.prompt).toContain('Incorrect boundary');
      expect(h.starts[2]!.input.prompt).toContain('diff for one');
      expect(h.starts[2]!.input.task.sourceHead).toBe(sha('one'));
      if(comparison==='error')h.git.compareCandidates=async()=>{throw new Error('comparison unavailable');};
      h.complete(2);await expect.poll(()=>h.starts.length).toBe(4);
      const context=JSON.parse(h.starts[3]!.input.prompt).reviewContext;
      expect(context.repairDiff.status).toBe('unavailable');expect(context.findings[0].reason).toBe('Incorrect boundary');
      expect(h.git.publishCandidate).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
});

