import { z } from 'zod';
const id = z.string().min(1).max(160);
const version = z.number().int().nonnegative();
export const roleNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const priority = z.number().int().min(-100).max(100);
export const planTaskSchema = z.object({ id: id.optional(), kind: z.enum(['change', 'analysis']), title: z.string().min(1).max(240), instructions: z.string().min(1).max(32000), expectedPaths: z.array(z.string()).max(100), acceptanceCriteria: z.array(z.string()).optional(), roleName: roleNameSchema.optional(), dependsOn: z.array(id).max(1000).optional(), priority: priority.optional(), analysisItems: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), prompt: z.string().min(1).max(32000) }).strict()).min(1).max(32).optional() }).strict().refine(task => !task.analysisItems || task.kind === 'analysis', 'Only analysis tasks may contain analysisItems.');
export const planSchema = z.object({
  expectedRevision: version,
  acceptanceCriteria: z.array(z.string()).default([]),
  tasks: z.array(planTaskSchema).min(1).max(1000),
}).strict();
export const replanSchema = z.object({
  expectedRevision: version,
  updates: z.array(z.object({ taskId: id, expectedVersion: version, dependsOn: z.array(id).max(1000).optional(), priority: priority.optional() }).strict()).max(1000),
  tasks: z.array(planTaskSchema).max(1000).optional(),
}).strict();
export const limitsSchema = z.object({ developers: z.number().int().min(1).max(128).optional(), total: z.number().int().min(2).max(129).optional(), maxTasks: z.number().int().min(1).max(10000).optional(), maxReplans: z.number().int().min(0).max(1000).optional(), agingMs: z.number().int().min(1).max(3600000).optional() }).strict();
/** Workflow-level acceptance criteria must follow every task into its Run prompt. */
export function planForCoordinator(input: z.infer<typeof planSchema>) {
  return { expectedRevision: input.expectedRevision, tasks: input.tasks.map(task => ({
    ...task, acceptanceCriteria: [...new Set([...input.acceptanceCriteria, ...(task.acceptanceCriteria ?? [])])],
  })) };
}
export const dispatchSchema = z.object({ taskId: id, expectedVersion: version, idempotencyKey: id, roleName: roleNameSchema.optional() }).strict();
export const integrationSchema = z.object({ taskId: id, sourceHead: z.string().regex(/^[a-f0-9]{40,64}$/), expectedVersion: version, idempotencyKey: id }).strict();
export const retrySchema = z.object({ taskId: id, expectedVersion: version, reason: z.string().min(1).max(16000) }).strict();
export const waitSchema = z.object({ runIds: z.array(id).max(1000).optional(), requestIds: z.array(id).max(1000).optional(), afterEventSeq: version.default(0), timeoutMs: z.number().int().min(0).max(30000).default(10000) }).strict().refine(v => Boolean(v.runIds?.length || v.requestIds?.length), 'Provide runIds or requestIds.');
export const finishSchema = z.object({ summary: z.string().min(1).max(16000) }).strict();
export const workspaceSchema = z.object({ name: z.string().min(1).max(120), repositoryPath: z.string().min(1), baseRef: z.string().min(1) }).strict();
export const workflowSchema = z.object({ workspaceId: id, goal: z.string().min(1).max(32000), startLead: z.boolean().default(true) }).strict();
export const rolesSchema = z.object({
  bindings: z.array(z.object({ id, providerName: id, packageVersion: id, configRevision: z.number().int().positive(), capabilities: z.record(z.string(), z.boolean()), credentialRefs: z.array(z.string()).max(20), runtime: z.enum(['dsh','codex','claude']).nullable().optional(), model: z.string().min(1).max(160).nullable().optional(), spawn: z.object({ provider: id, model: id, reasoningEffort: z.string().min(1).max(40).optional(), agentPreset: id.optional(), maxTokens: z.number().int().positive().optional() }).strict().nullable().optional() }).strict()).min(1).max(130),
  roles: z.array(z.object({ name: roleNameSchema, purpose: z.enum(['lead','developer','reviewer']).optional(), kind: z.enum(['dsh-lead','subagent']), providerBindingId: id.optional(), prompt: z.string().max(16000), revision: z.number().int().positive() }).strict()).min(3).max(130),
}).strict();
