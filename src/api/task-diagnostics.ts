import type { Task } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import type { UiTask, UiTaskDiagnostics } from './ui-contracts.js';
import { redact } from './security.js';

/** Project persisted facts only. Member reports are not independent check evidence. */
export function taskDiagnostics(store: RiftStore, task: Task): UiTaskDiagnostics | null {
  const run = store.get<{id:string;taskAttempt:number;status:string;stopReason:string|null;roleId:string;result:unknown}>(
    'SELECT id,task_attempt,status,stop_reason,role_id,result FROM runs WHERE task_id=? AND task_attempt=? ORDER BY rowid DESC LIMIT 1', task.id, task.attempt);
  if (!run) return null;
  const workspaceId = store.workflow(task.workflowId).workspaceId;
  const report = store.get<NonNullable<UiTaskDiagnostics['report']>>(
    `SELECT id,content,created_at,kind FROM messages WHERE workspace_id=? AND workflow_id=? AND task_id=? AND run_id=?
     AND sender_agent_id=? AND sender_type='agent' AND origin='model' AND visibility='public'
     AND kind IN ('progress','blocker','result') ORDER BY rowid DESC LIMIT 1`, workspaceId, task.workflowId, task.id, run.id, run.roleId);
  // A workflow-wide failure must not be attributed to an unrelated task/run.
  const trigger = store.get<{turnId:string;error:string|null;createdAt:string;status:string}>(
    `SELECT turn_id,error,created_at,status FROM turn_triggers WHERE workspace_id=? AND workflow_id=?
     AND EXISTS (SELECT 1 FROM json_each(turn_triggers.payload,'$.events') e
       WHERE json_extract(e.value,'$.taskId')=? AND json_extract(e.value,'$.runId')=?)
     ORDER BY rowid DESC LIMIT 1`, workspaceId, task.workflowId, task.id, run.id);
  const error = run.result && typeof run.result === 'object' && 'error' in run.result && typeof run.result.error === 'string' ? run.result.error : null;
  return {
    runId: run.id, attempt: run.taskAttempt, status: run.status,
    stopReason: run.stopReason ? redact(run.stopReason, 1024) : null,
    error: error ? redact(error, 4096) : null,
    report: report ? { ...report, content: redact(report.content, 8192) } : null,
    coordination: trigger?.status === 'failed' && trigger.error ? { turnId: trigger.turnId, error: redact(trigger.error, 4096), createdAt: trigger.createdAt } : null,
  };
}

export function taskView(store: RiftStore, task: Task): UiTask {
  return { ...task, dependsOn: store.all<{dependsOnTaskId:string}>(
    'SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id', task.id).map(row => row.dependsOnTaskId),
    diagnostics: taskDiagnostics(store, task) };
}
