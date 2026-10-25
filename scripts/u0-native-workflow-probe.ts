import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { RiftHostService } from '../src/api/host-service.js';
import { NativeCodexRuntime, VERIFIED_NATIVE_CODEX_MODELS } from '../src/agent/native-codex.js';
import type { AgentTurn } from '../src/chat/contracts.js';
import { publicError, redact } from '../src/api/security.js';

if (!process.argv.includes('--real')) throw new Error('This credentialed probe calls real native models. Pass --real to run it deliberately.');
const root = path.resolve('.runtime-evidence'); await mkdir(root, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'u0-native-workflow-'));
const repository = path.join(temporary, 'repository'); await mkdir(repository);
const command = promisify(execFile);
const git = (...args: string[]) => command('git', ['-C', repository, ...args], { windowsHide: true });
await git('init', '-b', 'main'); await git('config', 'user.name', 'RIFT Acceptance'); await git('config', 'user.email', 'rift-acceptance@localhost');
await writeFile(path.join(repository, 'README.md'), '# Runtime acceptance\nNo modifications are requested by this probe.\n');
await git('add', '.'); await git('commit', '-m', 'Acceptance baseline');
process.env.DSH_HOME = path.join(temporary, 'dsh'); process.env.RIFT_HOME = path.join(temporary, 'plugin-home'); process.env.RIFT_PORT = '0';
initializeProfileFromDefault('u0-workflow', 'sdk-minimal', process.env.DSH_HOME);
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('u0-workflow'), profile: 'u0-workflow', patchFiles: [path.resolve('profiles/rift.codex.patch.yml')], args: [] });
if (process.argv.includes('--inspect-connections')) { console.log(JSON.stringify({ providers: ctx.llm.listProviders(), configurable: ctx.llm.listConfigurableProviders().map(item => ({provider:item.provider,ns:item.settingsNs,path:item.settingsPath})), settings: Boolean(ctx.get('settings')) }, null, 2)); await shutdown.shutdown(0); process.exit(0); }
const apiMode = process.argv.includes('--dsh');
const report: Record<string, unknown> = { date: new Date().toISOString(), mode: apiMode ? 'real DSH DeepSeek API main agent and real native child, isolated Git/SQLite/Host' : 'real native main agent and real registered native child, isolated Git/SQLite/Host', mainModel: apiMode ? 'deepseek-flash' : 'gpt-6.1-sol', nativePayload: '0.164.0', childProvider: 'codex-dev' };
let host: RiftHostService | undefined;
const calls: { name: string; outcome: string }[] = [];
try {
  host = new RiftHostService(ctx, { home: path.join(temporary, 'host'), port: 0, leadProvider: 'deepseek-official', leadModel: 'deepseek-flash', developerProvider: 'codex-dev', reviewerProvider: 'codex-review', limits: { developers: 1, total: 2 }, checks: [{ id: 'diff-check', executable: 'git', args: ['diff', '--check'] }], runTimeoutMs: 120000 });
  const native = new NativeCodexRuntime({ spawn: spec => ctx.subprocess.spawn(spec) });
  host.registerChatRuntime('codex', { start(input) { return native.start({ ...input, tools: input.tools.map(tool => ({ ...tool, async execute(args, signal) { try { const result = await tool.execute(args, signal); calls.push({ name: tool.name, outcome: 'completed' }); console.log(`Native tool completed: ${tool.name}`); return result; } catch (error) { calls.push({ name: tool.name, outcome: publicError(error).code }); throw error; } } })) }); } }, VERIFIED_NATIVE_CODEX_MODELS);
  await host.initialize();
  const workspace = await host.handle('POST', '/v1/workspaces', { name: '原生主 Agent 验收', repositoryPath: repository, baseRef: 'main' }, 'workspace') as { id: string; version: number };
  await host.handleBrowser('PATCH', `/ui-api/v1/workspaces/${workspace.id}`, { expectedVersion: workspace.version, leadConnection: apiMode ? { runtime: 'dsh', provider: 'deepseek-official', model: 'deepseek-flash' } : { runtime: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' } }, 'native-connection');
  const conversation = host.chat.createConversation(workspace.id, 'Native workflow acceptance');
  const sent = host.chat.send(workspace.id, conversation.id, {
    clientMessageId: 'native-workflow-probe',
    content: 'Run a bounded acceptance of the RIFT workflow tools. Start a workflow with goal "Read the acceptance README without changing files". Submit exactly one analysis task, assigned to developer-a, with expectedPaths [] and acceptance criteria ["Read README.md; change no file and make no commit"]. Ask the child to return the required RIFT result JSON with outcome completed, summary confirming the README title, changedPaths [], checksClaimed [], blockingReasons []. Dispatch it using current versions. Wait for the actual registered child result; inspect status and finish the workflow only after the analysis task succeeds and cleanup is confirmed. Do not create change tasks or edit files. Once rift_workflow_finish succeeds, reply RIFT_NATIVE_WORKFLOW_OK. If blocked, explain the exact tool error and stop.',
  });
  const deadline = Date.now() + 180000;
  let turn: AgentTurn = sent.turn;
  while (Date.now() < deadline) {
    turn = host.chat.turn(workspace.id, sent.turn.id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) { host.chat.stop(workspace.id, turn.id); throw new Error('Native workflow probe deadline exceeded.'); }
  const workflows = host.store.all<{id:string;status:string}>('SELECT id,status FROM workflows WHERE workspace_id=?', workspace.id);
  const tasks = host.store.all('SELECT t.id,t.status,t.kind,t.accepted_commit FROM tasks t JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?', workspace.id);
  const runs = host.store.all('SELECT r.id,r.status,r.cleanup_status,r.slot_released_at,r.dsh_child_id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?', workspace.id);
  report.turn = turn; report.workflows = workflows; report.tasks = tasks; report.runs = runs; report.toolCalls = calls;
  report.messages = host.chat.page(workspace.id, conversation.id).messages;
  report.repositoryClean = !(await git('status', '--porcelain')).stdout.trim();
  report.status = turn.status === 'completed' && workflows.length === 1 && workflows[0]!.status === 'completed' && runs.length > 0 && (apiMode || (calls.some(call => call.name === 'rift_task_dispatch' && call.outcome === 'completed') && calls.some(call => call.name === 'rift_workflow_finish' && call.outcome === 'completed'))) && report.repositoryClean ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = publicError(error); report.toolCalls = calls; }
finally {
  await host?.close(); await shutdown.shutdown(0);
  await writeFile(path.resolve(apiMode ? 'docs/evidence/ui-dsh-workflow-probe.json' : 'docs/evidence/u0-native-workflow-probe.json'), JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value, 256 * 1024) : value, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, toolCalls: calls, workflow: report.workflows }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
