import { z } from 'zod';
const id = z.string().min(1).max(160);
const version = z.number().int().nonnegative();
export const planSchema = z.object({
  expectedRevision: version,
  acceptanceCriteria: z.array(z.string()).default([]),
  tasks: z.array(z.object({ id: id.optional(), kind: z.enum(['change', 'analysis']), title: z.string().min(1).max(240), instructions: z.string().min(1).max(32000), expectedPaths: z.array(z.string()).max(100), acceptanceCriteria: z.array(z.string()).optional(), roleName: z.enum(['developer-a', 'developer-b']).optional(), dependsOn: z.array(id).optional() }).strict()).min(1).max(10),
}).strict();
/** Workflow-level acceptance criteria must follow every task into its Run prompt. */
export function planForCoordinator(input: z.infer<typeof planSchema>) {
  return { expectedRevision: input.expectedRevision, tasks: input.tasks.map(task => ({
    ...task, acceptanceCriteria: [...new Set([...input.acceptanceCriteria, ...(task.acceptanceCriteria ?? [])])],
  })) };
}
export const dispatchSchema = z.object({ taskId: id, expectedVersion: version, idempotencyKey: id, roleName: z.enum(['developer-a', 'developer-b']).optional() }).strict();
export const integrationSchema = z.object({ taskId: id, sourceHead: z.string().regex(/^[a-f0-9]{40,64}$/), expectedVersion: version, idempotencyKey: id }).strict();
export const retrySchema = z.object({ taskId: id, expectedVersion: version, reason: z.string().min(1).max(16000) }).strict();
export const waitSchema = z.object({ runIds: z.array(id).max(20).optional(), requestIds: z.array(id).max(20).optional(), afterEventSeq: version.default(0), timeoutMs: z.number().int().min(0).max(30000).default(10000) }).strict().refine(v => Boolean(v.runIds?.length || v.requestIds?.length), 'Provide runIds or requestIds.');
export const finishSchema = z.object({ summary: z.string().min(1).max(16000) }).strict();
export const workspaceSchema = z.object({ name: z.string().min(1).max(120), repositoryPath: z.string().min(1), baseRef: z.string().min(1) }).strict();
export const workflowSchema = z.object({ workspaceId: id, goal: z.string().min(1).max(32000), startLead: z.boolean().default(true) }).strict();
export const rolesSchema = z.object({
  bindings: z.array(z.object({ id, providerName: id, packageVersion: id, configRevision: z.number().int().positive(), capabilities: z.record(z.string(), z.boolean()), credentialRefs: z.array(z.string()).max(20) }).strict()).min(1).max(4),
  roles: z.array(z.object({ name: z.enum(['lead','developer-a','developer-b','reviewer']), kind: z.enum(['dsh-lead','subagent']), providerBindingId: id.optional(), prompt: z.string().max(16000), revision: z.number().int().positive() }).strict()).length(4),
}).strict();
