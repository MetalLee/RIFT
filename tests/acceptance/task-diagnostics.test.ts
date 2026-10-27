import { expect, it } from 'vitest';
import { RiftStore } from '../../src/storage/database.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import type { ActivationBridge, GitService } from '../../src/contracts/index.js';
import { taskView } from '../../src/api/task-diagnostics.js';
import { workspaceDetail, workspaceTasks } from '../../src/api/workspace-views.js';
import { seedWorkspace } from './fixtures.js';

it('keeps timeout, reported test blockers and correlated coordination failures visible across task views', async () => {
  const store = new RiftStore();
  const { workspace, roles } = seedWorkspace(store);
  const coordinator = new TaskCoordinator({ store, bridge: {} as ActivationBridge, git: {} as GitService });
  try {
    const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'diagnostics', integrationRef: 'refs/heads/rift/diagnostics', baseCommit: 'a'.repeat(40) });
    coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [
      { id: 'problem', kind: 'change', title: 'Problem', instructions: 'test', expectedPaths: [] },
      { id: 'unrelated', kind: 'change', title: 'Unrelated', instructions: 'test', expectedPaths: [] },
    ] });
    const developer = roles.find(role => role.name === 'developer-a')!.id;
    const lead = roles.find(role => role.name === 'lead')!.id;
    store.exec("UPDATE tasks SET status='cancelled',attempt=1,blocking_reason='CANCELLED' WHERE id='problem'");
    store.exec(`INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,stop_reason,deadline,result,created_at)
      VALUES('run-problem','problem',?,'develop',1,'cancelled',?,'TIMEOUT','later',?,'2026-10-26T13:30:45Z')`, developer,
      JSON.stringify({ secret: 'provider-private' }), JSON.stringify({ error: 'Run was cancelled. token=private-token', output: 'private raw output' }));
    store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('chat',?,'chat','now')",workspace.id);
    const report = (id:string, visibility:string, content:string) => store.exec(`INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at,kind,sender_type,sender_agent_id,origin,visibility,workflow_id,task_id,run_id)
      VALUES(?,?,'chat','assistant',?,'completed','2026-10-26T13:44:44Z','progress','agent',?,'model',?,?,'problem','run-problem')`,id,workspace.id,content,developer,visibility,workflow.id);
    report('reported','public','Vitest failed before running tests: spawn EPERM; token=report-secret');
    report('internal','internal','private internal report');
    const trigger = (id:string, taskId:string, status:string, error:string|null) => store.exec(`INSERT INTO turn_triggers(id,workflow_id,workspace_id,conversation_id,agent_id,kind,dedupe_key,payload,status,turn_id,error,created_at)
      VALUES(?,?,?,'chat',?,'task_event',?,?,?,?,?,'2026-10-26T14:00:46Z')`,id,workflow.id,workspace.id,lead,id,JSON.stringify({ events: [{taskId,runId:'run-problem'}] }),status,`turn-${id}`,error);
    trigger('failure','problem','failed','thread lead already has an active writer');
    trigger('other','unrelated','failed','unrelated failure');
    const task = taskView(store, store.task('problem'));
    expect(task.diagnostics).toMatchObject({ stopReason:'TIMEOUT',status:'cancelled',report:{id:'reported'},coordination:{error:'thread lead already has an active writer'} });
    expect(task.diagnostics!.report!.content).toContain('spawn EPERM');
    const wire = JSON.stringify(task);
    for (const secret of ['provider-private','private raw output','private-token','report-secret','private internal report','unrelated failure']) expect(wire).not.toContain(secret);
    expect(workspaceTasks(store,workspace.id,new URLSearchParams('status=cancelled')).tasks[0]).toEqual(task);
    expect(workspaceDetail(store,workspace.id,new Set(),{provider:'test',model:'test'}).tasks.find(t=>t.id==='problem')).toEqual(task);
    expect(taskView(store,store.task('unrelated')).diagnostics).toBeNull();
    trigger('recovered','problem','consumed',null);
    expect(taskView(store,store.task('problem')).diagnostics!.coordination).toBeNull();
    store.exec("UPDATE tasks SET attempt=2,status='ready',blocking_reason=NULL WHERE id='problem'");
    expect(taskView(store,store.task('problem')).diagnostics).toBeNull();
  } finally { await coordinator.shutdown(); store.close(); }
});
