/** Credentialed C1 smoke: real chat Lead, developer and reviewer in an isolated repository. */
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { RiftHostService } from '../src/api/host-service.js';
import { NativeCodexRuntime, nativeCodexPackage, VERIFIED_NATIVE_CODEX_MODELS } from '../src/agent/native-codex.js';
import { publicError, redact } from '../src/api/security.js';

if (!process.argv.includes('--real')) throw new Error('Pass --real to run credentialed model calls in a temporary Git repository.');
const root = path.resolve('.runtime-evidence');
await mkdir(root, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'chat-orchestration-'));
const repository = path.join(temporary, 'repository');
await mkdir(repository);
const command = promisify(execFile);
const git = (...args: string[]) => command('git', ['-C', repository, ...args], { windowsHide: true });
await git('init', '-b', 'main');
await git('config', 'user.name', 'RIFT Acceptance');
await git('config', 'user.email', 'rift-acceptance@localhost');
await writeFile(path.join(repository, 'feature.mjs'), 'export const value = 0;\n');
await writeFile(path.join(repository, 'test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from './feature.mjs';\nassert.equal(value, 42);\n");
await git('add', '.');
await git('commit', '-m', 'Acceptance baseline');
const baseline = (await git('rev-parse', 'HEAD')).stdout.trim();
process.env.DSH_HOME = path.join(temporary, 'dsh');
process.env.RIFT_HOME = path.join(temporary, 'plugin-home');
process.env.RIFT_PORT = '0';
initializeProfileFromDefault('chat-orchestration', 'sdk-minimal', process.env.DSH_HOME);
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('chat-orchestration'), profile: 'chat-orchestration', patchFiles: [path.resolve('profiles/rift.codex.patch.yml')], args: [] });
const report: Record<string, unknown> = { date: new Date().toISOString(), mode: 'real models; isolated Git, SQLite and Host; no browser; no injected task events', payload: nativeCodexPackage().version, leadModel: 'gpt-6.1-sol', temporary };
const calls: { turnId: string; name: string; at: string; outcome: string }[] = [];
let host: RiftHostService | undefined;
try {
  host = new RiftHostService(ctx, { home: path.join(temporary, 'host'), port: 0, chatOrchestration: true, leadProvider: 'deepseek-official', leadModel: 'deepseek-flash', developerProvider: 'codex-dev', reviewerProvider: 'codex-review', limits: { developers: 1, total: 2 }, checks: [{ id: 'behavior-test', executable: process.execPath, args: ['--test', 'test.mjs'] }, { id: 'diff-check', executable: 'git', args: ['diff', '--check', 'HEAD^', 'HEAD'] }], runTimeoutMs: 180000 });
  const native = new NativeCodexRuntime({ spawn: spec => ctx.subprocess.spawn(spec) });
  host.registerChatRuntime('codex', { persistentSessions: true, start(input) { return native.start({ ...input, tools: input.tools.map(tool => ({ ...tool, async execute(args, signal) {
    try { const result = await tool.execute(args, signal); calls.push({ turnId: input.turnId, name: tool.name, at: new Date().toISOString(), outcome: 'completed' }); console.log(`${input.turnId}: ${tool.name}`); return result; }
    catch (error) { calls.push({ turnId: input.turnId, name: tool.name, at: new Date().toISOString(), outcome: publicError(error).code }); throw error; }
  } })) }); } }, VERIFIED_NATIVE_CODEX_MODELS);
  await host.initialize();
  const workspace = await host.handle('POST', '/v1/workspaces', { name: 'C1 实际代码闭环', repositoryPath: repository, baseRef: 'main' }, 'workspace') as { id: string; version: number };
  await host.handleBrowser('PATCH', `/ui-api/v1/workspaces/${workspace.id}`, { expectedVersion: workspace.version, leadConnection: { runtime: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' } }, 'connection');
  const conversation = host.chat.createConversation(workspace.id, 'C1 短轮次与自动续办验收');
  const sent = host.chat.send(workspace.id, conversation.id, { clientMessageId: 'c1-code', content: 'Please complete one bounded RIFT code task. Start a code workflow, submit exactly one change task assigned to developer-a that changes ONLY feature.mjs to export const value = 42;. expectedPaths must be ["feature.mjs"]. Acceptance: the Host candidate check node --test test.mjs passes; test.mjs is unchanged; only feature.mjs is committed by the Host. The developer should edit feature.mjs and return the required RIFT result JSON. RIFT collectSource will stage and commit the actual diff, and Host candidate validation runs node --test test.mjs outside the developer sandbox. Do not require the developer to write Git metadata or spawn node test-runner subprocesses; the developer can check behavior with node test.mjs. Dispatch the task and yield immediately, then finish your current reply. Do not wait for the developer in this reply. Continue later when Host events wake you. Use actual task/check/review evidence, request integration if needed, retry at most once on a known rejection, and finish the workflow only after acceptedCommit and confirmed cleanup. If blocked, state the actual blocker. After actual workflow completion say RIFT_CHAT_ORCHESTRATION_OK.' });
  const deadline = Date.now() + 480000;
  let firstEnd: { at: string; workflowStatus: string | null; taskStatuses: string[]; cleanupStatus: string } | undefined;
  let last = '';
  while (Date.now() < deadline) {
    const turn = host.chat.turn(workspace.id, sent.turn.id);
    const workflow = host.store.get<{ id: string; status: string }>('SELECT id,status FROM workflows WHERE workspace_id=?', workspace.id);
    const tasks = workflow ? host.store.all<{ status: string }>('SELECT status FROM tasks WHERE workflow_id=?', workflow.id) : [];
    if (!firstEnd && ['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) firstEnd = { at: new Date().toISOString(), workflowStatus: workflow?.status ?? null, taskStatuses: tasks.map(task => task.status), cleanupStatus: turn.cleanupStatus };
    const state = JSON.stringify({ firstTurn: turn.status, workflow: workflow?.status, tasks: tasks.map(task => task.status) });
    if (state !== last) { console.log(state); last = state; }
    if (workflow?.status === 'completed' && !host.store.get("SELECT id FROM agent_turns WHERE conversation_id=? AND status IN ('queued','running','stopping')", conversation.id)) break;
    if (firstEnd && workflow && host.store.get('SELECT workflow_id FROM workflow_conversations WHERE workflow_id=? AND blocked_reason IS NOT NULL', workflow.id) && host.store.get("SELECT id FROM agent_turns WHERE conversation_id=? AND trigger_id IS NOT NULL AND status='completed'", conversation.id) && !host.store.get("SELECT id FROM agent_turns WHERE conversation_id=? AND status IN ('queued','running','stopping')", conversation.id)) break;
    if (['failed', 'cancelled', 'interrupted'].includes(turn.status) && !workflow) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const workflows = host.store.all<{ id: string; status: string }>('SELECT id,status,summary FROM workflows WHERE workspace_id=?', workspace.id);
  const tasks = host.store.all<{ id: string; status: string; acceptedCommit: string | null }>('SELECT t.id,t.status,t.accepted_commit,t.blocking_reason FROM tasks t JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?', workspace.id);
  const turns = host.store.all<{ id: string; messageId: string | null; status: string; cleanupStatus: string }>('SELECT id,message_id,trigger_id,status,cleanup_status,created_at,started_at,ended_at,error FROM agent_turns WHERE conversation_id=? ORDER BY created_at,id', conversation.id);
  const nativeExecutions = host.store.all<{ threadId: string; executionId: string }>("SELECT e.execution_id,s.thread_id,e.status FROM native_executions e JOIN native_sessions s ON s.id=e.session_id JOIN agent_turns t ON t.id=e.execution_id WHERE t.conversation_id=?", conversation.id);
  const accepted = tasks[0]?.acceptedCommit;
  const acceptedValue = accepted ? (await git('show', `${accepted}:feature.mjs`)).stdout.trim() : null;
  const testUnchanged = accepted ? !(await git('diff', baseline, accepted, '--', 'test.mjs')).stdout.trim() : false;
  const repositoryClean = !(await git('status', '--porcelain')).stdout.trim();
  const firstTurn = host.chat.turn(workspace.id, sent.turn.id);
  report.firstTurn = { id: firstTurn.id, status: firstTurn.status, cleanupStatus: firstTurn.cleanupStatus, firstEnd };
  report.workflows = workflows; report.tasks = tasks; report.turns = turns;
  report.events = workflows[0] ? host.store.events(workflows[0].id) : [];
  report.messages = host.chat.page(workspace.id, conversation.id).messages;
  report.runs = host.store.all('SELECT r.id,r.status,r.cleanup_status,r.purpose,r.task_attempt FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?', workspace.id);
  report.integrations = host.store.all('SELECT i.id,i.status,i.candidate_head,i.review_run_id,i.error FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?', workspace.id);
  report.nativeExecutions = nativeExecutions;
  report.coordination = host.store.all('SELECT workflow_id,conversation_id,automatic_turns,blocked_reason FROM workflow_conversations WHERE workspace_id=?', workspace.id);
  report.checks = { firstReplyBeforeWorkflowComplete: firstEnd?.workflowStatus !== 'completed' && firstTurn.status === 'completed' && firstEnd?.cleanupStatus === 'confirmed', automaticTurnWithoutFakeUser: turns.some(turn => turn.messageId === null && turn.status === 'completed'), resumedSameThread: nativeExecutions.length >= 2 && new Set(nativeExecutions.map(item => item.threadId)).size === 1, noWaitTool: !calls.some(call => call.name === 'rift_wait'), workflowCompleted: workflows.length === 1 && workflows[0]?.status === 'completed', acceptedValue: acceptedValue === 'export const value = 42;', testUnchanged, repositoryClean };
  report.status = Object.values(report.checks as Record<string, boolean>).every(Boolean) ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = publicError(error); }
finally {
  report.toolCalls = calls;
  await host?.close(); await shutdown.shutdown(0);
  await writeFile(path.resolve(process.env.RIFT_CHAT_ORCHESTRATION_PROBE_REPORT || 'docs/evidence/chat-orchestration-real-probe.json'), JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value, 256 * 1024) : value, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, checks: report.checks }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
