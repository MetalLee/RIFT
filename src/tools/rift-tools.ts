import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { TaskCoordinator } from '../task/coordinator.js';
import { RiftError } from '../contracts/index.js';
import { dispatchSchema, finishSchema, integrationSchema, planSchema, planForCoordinator, retrySchema, waitSchema } from '../api/schemas.js';
import { redact } from '../api/security.js';

export function installLeadTools(ctx: Context, lead: Agent, workflowId: string, coordinator: TaskCoordinator): void {
  // An unpublished Agent scope gets only the business tools below. Global
  // shell/delegation tools would bypass task registration and are masked.
  ctx.tools.restrict({ allow: [] });
  const taskOwned = (id: string): void => {
    if (coordinator.store.task(id).workflowId !== workflowId) throw new RiftError('CROSS_WORKFLOW', 'Task belongs to another workflow.');
  };
  const register = (name: string, description: string, schema: z.ZodType, execute: (args: any) => unknown): void => {
    const definition: ToolDefinition = {
      name, description,
      // Zod attaches non-enumerable Standard Schema metadata containing
      // functions. DSH accepts a lossless JSON boundary, so detach that metadata.
      parameters: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))) as ToolDefinition['parameters'],
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: redact(JSON.stringify(value)) }] },
      async execute(args, exec) {
        if (exec.agent !== lead || ctx.agents.get(lead.id) !== lead) throw new RiftError('UNAUTHORIZED', 'Only this workflow live Lead may manage it.');
        exec.signal.throwIfAborted();
        const value = await execute(schema.parse(args));
        return JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === 'string' ? redact(item) : item));
      },
    };
    ctx.tools.register(definition);
  };
  register('rift_plan_submit', 'Submit up to 10 tasks with explicit dependencies and expected paths. Use roleName developer-a / developer-b. Dispatch two independent tasks before waiting.', planSchema, input => coordinator.submitPlan({ workflowId, ...planForCoordinator(input) }));
  register('rift_task_dispatch', 'Accept or persistently queue a development request. Returns immediately; use the returned request id with rift_wait.', dispatchSchema, input => { taskOwned(input.taskId); return coordinator.dispatch(input); });
  register('rift_wait', 'Wait for any matching durable result or request event. Track eventSeq and accept out-of-order completion. Does not stop background work.', waitSchema, input => coordinator.wait({ workflowId, ...input }));
  register('rift_status', 'Read workflow tasks, versions, runs, cleanup, slots, queues and exact integration evidence.', z.object({}).strict(), () => coordinator.status(workflowId));
  register('rift_task_retry', 'Create a new repair attempt with prior evidence after cleanup. Then dispatch the new version.', retrySchema, input => { taskOwned(input.taskId); return coordinator.retry(input); });
  register('rift_integration_request', 'Request serial checking and exact-commit review. Completed development is automatically queued; repeated keys return the same operation.', integrationSchema, input => { taskOwned(input.taskId); return coordinator.requestIntegration(input); });
  register('rift_workflow_finish', 'Finish only after every task has actually passed gates and all executions are cleaned.', finishSchema, input => coordinator.finish({ workflowId, ...input }));
}
