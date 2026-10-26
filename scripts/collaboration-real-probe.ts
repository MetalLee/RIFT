/** C2-C4: real Lead/developers/reviewer, explicit negative fixture, actual rejection and repair. */
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
const temporary = await mkdtemp(path.join(root, 'collaboration-real-'));
const repository = path.join(temporary, 'repository');
await mkdir(repository);
const command = promisify(execFile);
const git = (...args: string[]) => command('git', ['-C', repository, ...args], { windowsHide: true });
await git('init', '-b', 'main');
await git('config', 'user.name', 'RIFT Acceptance');
await git('config', 'user.email', 'rift-acceptance@localhost');
await writeFile(path.join(repository, 'README.md'), 'Isolated collaboration acceptance repository. Only edit assigned files; Host collects commits.\n');
await writeFile(path.join(repository, 'test.mjs'), "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nif(fs.existsSync('age.mjs')) {const {classifyAge}=await import('./age.mjs');assert.equal(classifyAge(0),'minor');assert.equal(classifyAge(30),'adult');assert.throws(()=>classifyAge(-1),RangeError);}\nif(fs.existsSync('label.mjs'))assert.equal((await import('./label.mjs')).label,'RIFT stable');\nconsole.log('Trusted smoke checks passed; full age boundary is independently reviewed.');\n");
await git('add', '.');
await git('commit', '-m', 'Acceptance baseline');
const baseline = (await git('rev-parse', 'HEAD')).stdout.trim();
process.env.DSH_HOME = path.join(temporary, 'dsh');
process.env.RIFT_HOME = path.join(temporary, 'plugin-home');
process.env.RIFT_PORT = '0';
initializeProfileFromDefault('chat-orchestration', 'sdk-minimal', process.env.DSH_HOME);
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('chat-orchestration'), profile: 'chat-orchestration', patchFiles: [path.resolve('profiles/rift.codex.patch.yml')], args: [] });
const leadModel=process.env.RIFT_PROBE_LEAD_MODEL??'gpt-6-astra';
const report: Record<string, unknown> = { date: new Date().toISOString(), mode: 'real models; isolated Git, SQLite and default-enabled Host; no browser; no injected task events or review verdicts', fixtureDisclosure:'Developer attempt 1 is explicitly instructed to implement age >= 21; actual acceptance is age >= 18. Trusted smoke checks deliberately omit the boundary; the independent reviewer must reject the real candidate. Repair must address actual findings.',payload: nativeCodexPackage().version, leadModel, temporary };
const calls: { turnId: string; name: string; at: string; outcome: string }[] = [];
let host: RiftHostService | undefined;
try {
  host = new RiftHostService(ctx, { home: path.join(temporary, 'host'), port: 0, leadProvider: 'deepseek-official', leadModel: 'deepseek-flash', developerProvider: 'codex-dev', reviewerProvider: 'codex-review', limits: { developers: 2, total: 3 }, checks: [{ id: 'behavior-smoke', executable: process.execPath, args: ['test.mjs'] }, { id: 'diff-check', executable: 'git', args: ['diff', '--check', 'HEAD^', 'HEAD'] }], runTimeoutMs: 240000 });
  const native = new NativeCodexRuntime({ spawn: spec => ctx.subprocess.spawn(spec) });
  host.registerChatRuntime('codex', { persistentSessions: true, start(input) { return native.start({ ...input, tools: input.tools.map(tool => ({ ...tool, async execute(args, signal) {
    try { const result = await tool.execute(args, signal); calls.push({ turnId: input.turnId, name: tool.name, at: new Date().toISOString(), outcome: 'completed' }); console.log(`${input.turnId}: ${tool.name}`); return result; }
    catch (error) { calls.push({ turnId: input.turnId, name: tool.name, at: new Date().toISOString(), outcome: publicError(error).code }); throw error; }
  } })) }); } }, VERIFIED_NATIVE_CODEX_MODELS);
  await host.initialize();
  const workspace = await host.handle('POST', '/v1/workspaces', { name: 'C2-C4 真实协作返工闭环', repositoryPath: repository, baseRef: 'main' }, 'workspace') as { id: string; version: number };
  await host.handleBrowser('PATCH', `/ui-api/v1/workspaces/${workspace.id}`, { expectedVersion: workspace.version, leadConnection: { runtime: 'codex', model: leadModel, reasoningEffort: 'high' } }, 'connection');
  const conversation = host.chat.createConversation(workspace.id, '成员协作与真实拒审返工');
  const roles=host.store.all<{id:string;name:string}>('SELECT id,name FROM roles WHERE workspace_id=?',workspace.id);
  const leadId=roles.find(role=>role.name==='lead')!.id;
  const prompt=`Complete a bounded collaboration acceptance in this isolated repository. Use rift_delegate for exactly two independent change tasks, assigned to developer-a and developer-b respectively; their IDs are ${JSON.stringify(roles)}. Start a code Workflow and delegate both tasks before yielding and ending your initial turn. Task age-boundary: ONLY age.mjs, export function classifyAge(age), reject non-integer or negative input with RangeError, return 'adult' iff age >= 18 and otherwise 'minor'. This is an explicit negative review fixture: developer attempt 1 MUST deliberately use age >= 21 instead of 18, preserving all other requirements; independent reviewer MUST reject against age >= 18, which remains the acceptance criterion. For attempt 2 or later fix the actual findings to >= 18. Task stable-label: ONLY label.mjs, export const label = 'RIFT stable';. test.mjs and README.md unchanged. Every developer must call rift_send_message once with kind progress and recipientAgentId ${leadId} to report its actual task progress from inside its Run, then return required result JSON. Include this request in task instructions. Do not require Git writes inside the developer sandbox: Host collects source commits and executes trusted checks. Trusted smoke tests deliberately omit ages 18-20 so the real reviewer must examine semantics. On events inspect actual status, request integration, retry age-boundary once after real changes_requested, dispatch repair to same developer, and preserve the independent accepted label. Do not treat the intentional fixture as grounds for reviewer approval. Finish only once both tasks have acceptedCommit, real check/review evidence and confirmed cleanup. Finish each coordination reply quickly with rift_yield when work is pending. No waiting tool. After actual completion say RIFT_COLLABORATION_OK.`;
  const sent = host.chat.send(workspace.id, conversation.id, { clientMessageId: 'collaboration-code', content:prompt });
  const deadline = Date.now() + 720000;
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
    if (['failed','cancelled','interrupted'].includes(turn.status)&&!host.store.get("SELECT id FROM agent_turns WHERE conversation_id=? AND status IN ('queued','running','stopping')",conversation.id)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const workflows = host.store.all<{ id: string; status: string }>('SELECT id,status,summary FROM workflows WHERE workspace_id=?', workspace.id);
  const tasks = host.store.all<{ id: string; status: string; acceptedCommit: string | null }>('SELECT t.id,t.status,t.accepted_commit,t.blocking_reason FROM tasks t JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?', workspace.id);
  const turns = host.store.all<{ id: string; messageId: string | null; status: string; cleanupStatus: string }>('SELECT id,message_id,trigger_id,status,cleanup_status,created_at,started_at,ended_at,error FROM agent_turns WHERE conversation_id=? ORDER BY created_at,id', conversation.id);
  const nativeExecutions = host.store.all<{ threadId: string; executionId: string }>("SELECT e.execution_id,s.thread_id,e.status FROM native_executions e JOIN native_sessions s ON s.id=e.session_id JOIN agent_turns t ON t.id=e.execution_id WHERE t.conversation_id=?", conversation.id);
  const finalWorkflow=workflows[0]?host.store.workflow(workflows[0].id):undefined;
  const accepted=finalWorkflow?.integrationRef&&tasks.some(task=>task.acceptedCommit)?(await git('rev-parse',finalWorkflow.integrationRef)).stdout.trim():undefined;
  const acceptedValue = accepted ? (await git('show', `${accepted}:age.mjs`)).stdout.trim() : null;
  const testUnchanged = accepted ? !(await git('diff', baseline, accepted, '--', 'test.mjs','README.md')).stdout.trim() : false;
  const reviews=host.store.all<{id:string;result:{verdict?:string;reviewedCommit?:string}|null}>("SELECT id,result FROM runs WHERE purpose='review'");
  const taskThreads=host.store.all<{scopeId:string;agentId:string;threadId:string;executionId:string}>('SELECT s.scope_id,s.agent_id,s.thread_id,e.execution_id FROM native_sessions s JOIN native_executions e ON e.session_id=s.id WHERE s.scope=\'task\'');
  report.taskNativeExecutions=taskThreads;
  report.reviews=reviews;
  const repaired=host.store.get<{taskId:string;id:string}>("SELECT id,task_id FROM runs WHERE purpose='repair'");
  const firstRun=repaired?host.store.get<{id:string}>("SELECT id FROM runs WHERE task_id=? AND purpose='develop'",repaired.taskId):undefined;
  report.acceptedCommit=accepted;report.acceptedSource=acceptedValue;
  if(accepted){const source=(await git('show',`${accepted}:age.mjs`)).stdout;const module=await import(`data:text/javascript,${encodeURIComponent(source)}`);for(const age of [0,1,17])if(module.classifyAge(age)!=='minor')throw Error('Wrong minor boundary');for(const age of [18,19,20,21,99])if(module.classifyAge(age)!=='adult')throw Error('Wrong adult boundary');for(const age of [-1,1.5,'18',null]){let rejected=false;try{module.classifyAge(age);}catch(error){rejected=error instanceof RangeError;}if(!rejected)throw Error('Invalid input accepted');}report.semanticBoundaryVerified=true;}
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
  report.checks = { firstReplyBeforeWorkflowComplete: firstEnd?.workflowStatus !== 'completed' && firstTurn.status === 'completed' && firstEnd?.cleanupStatus === 'confirmed', automaticTurnWithoutFakeUser: turns.some(turn => turn.messageId === null && turn.status === 'completed'), resumedSameThread: nativeExecutions.length >= 2 && new Set(nativeExecutions.map(item => item.threadId)).size === 1, noWaitTool: !calls.some(call => call.name === 'rift_wait'), atomicDelegates:calls.filter(call=>call.name==='rift_delegate'&&call.outcome==='completed').length>=2,workflowCompleted: workflows.length === 1 && workflows[0]?.status === 'completed',twoAcceptedTasks:tasks.length===2&&tasks.every(task=>task.status==='succeeded'&&task.acceptedCommit),actualReviewRejection:reviews.some(run=>run.result?.verdict==='changes_requested'),actualReviewApproval:reviews.filter(run=>run.result?.verdict==='approve').length>=2,repairSameTaskThread:!!repaired&&!!firstRun&&taskThreads.find(t=>t.executionId===repaired.id)?.threadId===taskThreads.find(t=>t.executionId===firstRun.id)?.threadId,runMessagesAttributed:host.store.all("SELECT DISTINCT sender_agent_id FROM messages WHERE run_id IS NOT NULL AND sender_type='agent' AND kind='progress'").length>=2, semanticBoundaryVerified:report.semanticBoundaryVerified===true,testUnchanged, repositoryClean };
  report.status = Object.values(report.checks as Record<string, boolean>).every(Boolean) ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = publicError(error); }
finally {
  report.toolCalls = calls;
  await host?.close(); await shutdown.shutdown(0);
  await writeFile(path.resolve(process.env.RIFT_COLLABORATION_PROBE_REPORT || 'docs/evidence/collaboration-real-probe.json'), JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value, 256 * 1024) : value, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, checks: report.checks }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
