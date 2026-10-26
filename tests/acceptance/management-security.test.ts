import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { startLocalApi } from '../../src/api/local-api.js';
import { RiftHostService } from '../../src/api/host-service.js';
import { installLeadTools } from '../../src/tools/rift-tools.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { RiftStore } from '../../src/storage/database.js';
import type { ActivationBridge, GitService } from '../../src/contracts/index.js';
import { seedWorkspace } from './fixtures.js';
const exec = promisify(execFile);

describe('A10/A11 independent management identity and HTTP acceptance', () => {
  it('requires token, exact loopback Host, no Origin, and idempotency key before invoking writes', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 api '));
    const handle = vi.fn(async () => ({ text: 'token=not-a-real-secret-value' }));
    const api = await startLocalApi({ handle }, { home: temporary, port: 0 });
    try {
      const url = `http://127.0.0.1:${api.port}`;
      const token = (await readFile(path.join(temporary, 'management.token'), 'utf8')).trim();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://attacker.invalid' } })).status).toBe(401);
      const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.get(url, { headers: { Authorization: `Bearer ${token}`, Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject);
      });
      expect(invalidHostStatus).toBe(400);
      expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(400);
      expect(handle).not.toHaveBeenCalled();
      const accepted = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'test' }, body: '{}' });
      expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ text: 'token=[REDACTED]' });
      expect(handle).toHaveBeenCalledOnce();
    } finally { await api.close(); await rm(temporary, { recursive: true, force: true }); }
  });

  it('refreshes providers registered after host construction, creates one workspace per key and rejects conflicting reuse', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 host '));
    const repo = path.join(temporary, '仓库'); await mkdir(repo);
    await exec('git', ['init', '-q', repo]); await writeFile(path.join(repo, 'README.md'), 'test');
    await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, '-c', 'user.name=Acceptance', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    let registered: string[] = [];
    const ctx = { subagents: { list: () => registered, getProvider: (name: string) => registered.includes(name) ? { capabilities: {} } : undefined } } as unknown as Context;
    const service = new RiftHostService(ctx, { home: path.join(temporary, 'home'), port: 0, leadProvider: 'fake', leadModel: 'fake', checks: [{ id: 'check', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] });
    try {
      await service.initialize();
      registered = ['claude-code-dev', 'codex-review'];
      const body = { name: 'test', repositoryPath: repo, baseRef: 'HEAD' };
      const first = await service.handle('POST', '/v1/workspaces', body, 'create-one');
      expect(await service.handle('POST', '/v1/workspaces', body, 'create-one')).toEqual(first);
      expect(service.store.all('SELECT * FROM workspaces')).toHaveLength(1);
      expect(service.store.all('SELECT * FROM roles')).toHaveLength(3);
      await expect(service.handle('POST', '/v1/workspaces', { ...body, name: 'different' }, 'create-one')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    } finally { await service.close(); await rm(temporary, { recursive: true, force: true }); }
  });

  it('derives tool identity from the actual live Lead and denies inherited delegation tools', async () => {
    const store = new RiftStore(); const { workspace } = seedWorkspace(store);
    const coordinator = new TaskCoordinator({ store, bridge: {} as ActivationBridge, git: {} as GitService });
    const workflow = coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'test', integrationRef: 'refs/heads/rift/test', baseCommit: 'a'.repeat(40) });
    coordinator.submitPlan({ workflowId: workflow.id, expectedRevision: 0, tasks: [{ id: 'unfinished', kind: 'analysis', title: 'Unfinished', instructions: 'Must run', expectedPaths: [] }] });
    const lead = { id: 'live-lead' } as Agent;
    const definitions: ToolDefinition[] = [];
    const restrict = vi.fn();
    const ctx = { agents: { get: () => lead }, tools: { schemas: () => [{ name: 'subagent' }, { name: 'shell' }], restrict, register: (definition: ToolDefinition) => definitions.push(definition) } } as unknown as Context;
    try {
      installLeadTools(ctx, lead, workflow.id, coordinator);
      expect(restrict).toHaveBeenCalledOnce();
      const policy = restrict.mock.calls[0]![0] as { allow?: string[]; deny?: string[] };
      const inheritedAllowed = (name: string) => policy.allow ? policy.allow.includes(name) : !policy.deny?.includes(name);
      expect(['subagent', 'shell', 'registered-later-delegation'].some(inheritedAllowed)).toBe(false);
      expect(definitions).toHaveLength(8);
      const assertPureJson = (value: unknown): void => {
        if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
        if (Array.isArray(value)) { value.forEach(assertPureJson); return; }
        expect(typeof value).toBe('object');
        const record = value as Record<string, unknown>;
        expect(Reflect.ownKeys(record)).toEqual(Object.keys(record));
        Object.values(record).forEach(assertPureJson);
      };
      definitions.forEach(definition => assertPureJson(definition.parameters));
      const status = definitions.find(definition => definition.name === 'rift_status')!;
      const context = { agent: { id: lead.id }, signal: new AbortController().signal } as Parameters<typeof status.execute>[1];
      await expect(status.execute({}, context)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      const valid = { ...context, agent: lead };
      expect(await status.execute({}, valid)).toMatchObject({ workflow: { id: workflow.id } });
      await expect(status.execute({ workflowId: 'forged' }, valid)).rejects.toThrow();
      const finish = definitions.find(definition => definition.name === 'rift_workflow_finish')!;
      await expect(finish.execute({ summary: 'The model claims done' }, valid)).rejects.toMatchObject({ code: 'UNFINISHED_TASKS' });
    } finally { await coordinator.shutdown(); store.close(); }
  });

  it('persists plan-wide acceptance criteria on every task through both API and Lead tools', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 criteria '));
    const ctx = { subagents: { list: () => ['claude-code-dev', 'codex-review'], getProvider: () => ({ capabilities: {} }) } } as unknown as Context;
    const service = new RiftHostService(ctx, { home: temporary, port: 0, leadProvider: 'fake', leadModel: 'fake', checks: [] });
    try {
      const { workspace } = seedWorkspace(service.store);
      const workflow = service.coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'Criteria', integrationRef: 'refs/heads/rift/criteria', baseCommit: 'a'.repeat(40) });
      const tasks = (prefix: string) => [
        { id: `${prefix}-local`, kind: 'analysis', title: 'Local', instructions: 'Evaluate', expectedPaths: [], acceptanceCriteria: ['Task-specific evidence'] },
        { id: `${prefix}-global`, kind: 'analysis', title: 'Global only', instructions: 'Evaluate', expectedPaths: [] },
      ];
      await service.handle('POST', `/v1/workflows/${workflow.id}/plan`, { expectedRevision: 0, acceptanceCriteria: ['Plan-wide evidence'], tasks: tasks('api') }, 'criteria-plan');
      expect(service.store.task('api-local').acceptanceCriteria).toEqual(expect.arrayContaining(['Plan-wide evidence', 'Task-specific evidence']));
      expect(service.store.task('api-global').acceptanceCriteria).toEqual(['Plan-wide evidence']);
      const lead = { id: 'criteria-lead' } as Agent; const definitions: ToolDefinition[] = [];
      const scope = { agents: { get: () => lead }, tools: { restrict: () => undefined, register: (definition: ToolDefinition) => definitions.push(definition) } } as unknown as Context;
      installLeadTools(scope, lead, workflow.id, service.coordinator);
      const tool = definitions.find(definition => definition.name === 'rift_plan_submit')!;
      await tool.execute({ expectedRevision: 1, acceptanceCriteria: ['Tool plan-wide evidence'], tasks: tasks('tool') }, { agent: lead, signal: new AbortController().signal } as Parameters<typeof tool.execute>[1]);
      expect(service.store.task('tool-local').acceptanceCriteria).toEqual(expect.arrayContaining(['Tool plan-wide evidence', 'Task-specific evidence']));
      expect(service.store.task('tool-global').acceptanceCriteria).toEqual(['Tool plan-wide evidence']);
    } finally { await service.close(); await rm(temporary, { recursive: true, force: true }); }
  });
});
