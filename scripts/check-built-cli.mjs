import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RiftHostService } from '../dist/api/host-service.js';
import { startLocalApi } from '../dist/api/local-api.js';

// Compiled consumers only: no tsx, browser, UI assets, model or repository cwd.
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const home = await mkdtemp(path.join(tmpdir(), 'rift-built-cli-'));
const host = new RiftHostService({ subagents: { list: () => [], getProvider: () => undefined }, llm: { listProviders: () => [] } }, { home, port: 0, leadProvider: 'unused', leadModel: 'unused', checks: [], chatOrchestration: false, uiEnabled: false });
let api;
const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args, '--home', home, '--json'], { cwd: home, timeout: 15000 })).stdout);
try {
  assert.deepEqual(Object.keys(await import('@rift/protocol')), []);
  await host.initialize();
  api = await startLocalApi(host, { home, port: 0, uiEnabled: false });
  const workspace = await run('workspace', 'create', '--name', 'Built headless', '--key', 'create');
  assert.deepEqual(await run('workspace', 'create', '--name', 'Built headless', '--key', 'create'), workspace);
  const ws = (...args) => run('ws', ...args, '--workspace', workspace.id);
  const shown = await ws('workspace', 'show');
  assert.equal(shown.workspace.id, workspace.id);
  assert.equal(shown.hostCapacity, undefined);
  const body = JSON.stringify({ expectedVersion: shown.workspace.version, name: 'Updated' });
  const updated = await ws('workspace', 'update', '--data', body, '--key', 'rename');
  assert.equal(updated.name, 'Updated');
  assert.deepEqual(await ws('workspace', 'update', '--data', body, '--key', 'rename'), updated);
  await assert.rejects(ws('workspace', 'update', '--data', body, '--key', 'stale'), error => error.code === 1 && error.stderr.includes('VERSION_CONFLICT'));
  assert.equal((await run('connection', 'list')).savedConnections.length, 0);
  const workflow = await ws('workflow', 'start', '--data', JSON.stringify({ mode: 'analysis', goal: 'Headless protocol smoke', startLead: false }));
  const tasks = await ws('plan', 'submit', workflow.id, '--data', JSON.stringify({ expectedRevision: 0, tasks: [{ id: 'smoke-task', kind: 'analysis', title: 'Check', instructions: 'No model activation' }] }));
  assert.equal((await ws('task', 'show', tasks[0].id)).id, tasks[0].id);
  const page = await ws('event', 'list', '--data', '{"after":0}');
  assert(page.events.length > 0);
  const token = (await readFile(path.join(home, 'management.token'), 'utf8')).trim();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${api.port}/v1/workspaces/${workspace.id}/events?after=0`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(new TextDecoder().decode((await response.body.getReader().read()).value), /event: workspace\ndata: /);
  } finally { controller.abort(); }
  console.log('Built CLI: protocol ESM load, external cwd, UI disabled, workspace/plan/task commands, replay/version errors and SSE passed.');
} finally {
  await api?.close();
  await host.close();
  await rm(home, { recursive: true, force: true });
}
