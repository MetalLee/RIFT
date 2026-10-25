import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { RiftHostService } from '../src/api/host-service.js';
import { publicError, redact } from '../src/api/security.js';

if (!process.argv.includes('--real')) throw new Error('Pass --real for real native main/developer/reviewer model calls in temporary repositories.');
const root = path.resolve('.runtime-evidence'); await mkdir(root, { recursive: true });
const temporary = await mkdtemp(path.join(root, 'ui-code-workflow-'));
const command = promisify(execFile);
const git = (cwd: string, ...args: string[]) => command('git', ['-C', cwd, ...args], { windowsHide: true });
const repositories: string[] = [];
for (const [name, value] of [['alpha', 11], ['beta', 22]] as const) {
  const repository = path.join(temporary, name); repositories.push(repository); await mkdir(repository);
  await git(repository, 'init', '-b', 'main'); await git(repository, 'config', 'user.name', 'RIFT Acceptance'); await git(repository, 'config', 'user.email', 'rift-acceptance@localhost');
  await writeFile(path.join(repository, 'feature.mjs'), 'export const value = 0;\n');
  await writeFile(path.join(repository, 'test.mjs'), `import assert from 'node:assert/strict';\nimport { value } from './feature.mjs';\nassert.equal(value, ${value});\n`);
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', 'Acceptance baseline');
}
process.env.DSH_HOME = path.join(temporary, 'dsh'); process.env.RIFT_HOME = path.join(temporary, 'plugin-home'); process.env.RIFT_PORT = '0';
initializeProfileFromDefault('ui-code', 'sdk-minimal', process.env.DSH_HOME);
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('ui-code'), profile: 'ui-code', patchFiles: [path.resolve('profiles/rift.codex.patch.yml')], args: [] });
const host = new RiftHostService(ctx, { home: path.join(temporary, 'host'), port: 0, leadProvider: 'deepseek-official', leadModel: 'deepseek-flash', developerProvider: 'codex-dev', reviewerProvider: 'codex-review', limits: { developers: 2, total: 3 }, checks: [{ id: 'behavior-test', executable: process.execPath, args: ['--test', 'test.mjs'] }, { id: 'diff-check', executable: 'git', args: ['diff', '--check'] }], runTimeoutMs: 180000 });
const report: Record<string, unknown> = { date: new Date().toISOString(), mode: 'real native main + real Astra developer/reviewer, two real isolated Git repositories, functional Node tests, chat-triggered orchestration', mainModel: 'gpt-6.1-sol', childModel: 'gpt-6-astra', payload: '0.164.0' };
try {
  await host.initialize();
  const workspace = await host.handle('POST', '/v1/workspaces', { name: '跨仓库聊天代码验收', repositoryPath: repositories[0], baseRef: 'main' }, 'workspace') as { id: string; version: number };
  await host.repositories.connect(workspace.id, { repositoryPath: repositories[1]!, baseRef: 'main', expectedVersion: workspace.version });
  const current = host.store.workspace(workspace.id) as ReturnType<typeof host.store.workspace> & { version: number };
  await host.handleBrowser('PATCH', `/ui-api/v1/workspaces/${workspace.id}`, { expectedVersion: current.version, leadConnection: { runtime: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' } }, 'connection');
  const repos = host.repositories.list(workspace.id);
  const alpha = repos.find(repo => repo.canonicalPath === repositories[0])!, beta = repos.find(repo => repo.canonicalPath === repositories[1])!;
  const conversation = host.chat.createConversation(workspace.id, '跨仓库功能验收');
  const sent = host.chat.send(workspace.id, conversation.id, { clientMessageId: 'two-repo-code', contextRefs: repos.map(repo => ({ type: 'repository' as const, id: repo.id })),
    content: `Execute this bounded end-to-end RIFT acceptance entirely using your provided tools. First start a workflow selecting BOTH repository ids ${alpha.id} and ${beta.id}. Plan exactly two CHANGE tasks: alpha assigned developer-a in repository ${alpha.id}, changes ONLY feature.mjs to export const value = 11; beta assigned developer-b in repository ${beta.id}, changes ONLY feature.mjs to export const value = 22 and depends on the alpha task. Each expectedPaths is ["feature.mjs"]. Each acceptanceCriteria includes "node --test test.mjs passes; test.mjs unchanged; only feature.mjs is committed". Tell both developers to make the commit and return the required RIFT result JSON. Dispatch alpha, wait for its real result, request integration using current sourceHead and expectedVersion, wait for real checks and independent review and acceptedCommit. Only after alpha succeeds dispatch beta and do the same integration. Read status between phases and finish the workflow only after both tasks are succeeded and all cleanup is confirmed. If a task fails, inspect the specific evidence and retry at most once. Do not change tests or call external tools. After successful workflow_finish reply RIFT_UI_CODE_WORKFLOW_OK.`,
  });
  const deadline = Date.now() + 420000;
  let last = '';
  while (Date.now() < deadline) {
    const turn = host.chat.turn(workspace.id, sent.turn.id);
    const tasks = host.store.all<{title:string;status:string}>('SELECT t.title,t.status FROM tasks t JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=? ORDER BY t.id',workspace.id);
    const summary = JSON.stringify(tasks); if (summary !== last) { console.log(summary); last = summary; }
    if (['completed','failed','cancelled','interrupted'].includes(turn.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const turn = host.chat.turn(workspace.id, sent.turn.id);
  if (!['completed','failed','cancelled','interrupted'].includes(turn.status)) host.chat.stop(workspace.id, turn.id);
  const workflows = host.store.all<{id:string;status:string}>('SELECT id,status FROM workflows WHERE workspace_id=?',workspace.id);
  const tasks = host.store.all<{id:string;status:string;repositoryId:string;acceptedCommit:string}>('SELECT t.* FROM tasks t JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?',workspace.id);
  const snapshots = host.store.all<{repositoryId:string;integrationRef:string}>('SELECT * FROM workflow_repositories WHERE workflow_id=?',workflows[0]?.id ?? 'none');
  const values = [];
  for (const repo of [alpha,beta]) { const snapshot = snapshots.find(item => item.repositoryId === repo.id); values.push(snapshot ? (await git(repo.canonicalPath,'show',`${snapshot.integrationRef}:feature.mjs`)).stdout.trim() : null); }
  const runs = host.store.all('SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id WHERE w.workspace_id=?',workspace.id);
  report.turn = turn; report.workflows = workflows; report.tasks = tasks; report.runs = runs; report.values = values;
  report.messages = host.chat.page(workspace.id,conversation.id).messages;
  report.status = turn.status === 'completed' && workflows[0]?.status === 'completed' && tasks.length === 2 && tasks.every(task=>task.status==='succeeded'&&task.acceptedCommit) && values[0]==='export const value = 11;' && values[1]==='export const value = 22;' ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = publicError(error); }
finally {
  await host.close(); await shutdown.shutdown(0);
  await writeFile(path.resolve('docs/evidence/ui-code-workflow-probe.json'), JSON.stringify(report, (_key,value)=>typeof value==='string'?redact(value,256*1024):value,2));
  console.log(JSON.stringify({ status:report.status,error:report.error,values:report.values },null,2));
  if(report.status!=='pass')process.exitCode=1;
}
