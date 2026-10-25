import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLocalApi } from '../../src/api/local-api.js';
import { RiftError } from '../../src/contracts/index.js';
const exec = promisify(execFile);
const cli = (...args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd: process.cwd(), timeout: 10000 });

describe('P2.9/P3.6 independent thin CLI acceptance', () => {
  it('provides help and an offline doctor without starting a model or a host', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 cli '));
    try {
      expect((await cli('--help')).stdout).toContain('serve owns its DSH Host');
      const doctor = JSON.parse((await cli('doctor', '--home', temporary, '--json')).stdout);
      expect(doctor).toMatchObject({ host: 'not-started', nativeAuthentication: 'not-verified' });
      await expect(cli('unknown-command', '--home', temporary, '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('UNKNOWN_COMMAND') });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it('reads task version before retry and reports API failures as nonzero structured errors', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 client '));
    const requests: { method: string; pathname: string; body: unknown; key?: string }[] = [];
    const api = await startLocalApi({ async handle(method, pathname, body, key) {
      requests.push({ method, pathname, body, key });
      if (method === 'GET' && pathname === '/v1/tasks/task-one') return { id: 'task-one', version: 7 };
      if (method === 'POST' && pathname === '/v1/tasks/task-one/retry') return { id: 'task-one', attempt: 2 };
      throw new RiftError('VERSION_CONFLICT', 'Version changed; token=synthetic-secret-value');
    } }, { home: temporary, port: 0 });
    try {
      const result = await cli('retry', '--home', temporary, '--task', 'task-one', '--reason', 'Fix review', '--key', 'retry-key', '--json');
      expect(JSON.parse(result.stdout)).toEqual({ id: 'task-one', attempt: 2 });
      expect(requests).toEqual([
        { method: 'GET', pathname: '/v1/tasks/task-one', body: {}, key: undefined },
        { method: 'POST', pathname: '/v1/tasks/task-one/retry', body: { expectedVersion: 7, reason: 'Fix review' }, key: 'retry-key' },
      ]);
      await expect(cli('status', '--home', temporary, '--workflow', 'bad', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('VERSION_CONFLICT') });
      try { await cli('status', '--home', temporary, '--workflow', 'bad', '--json'); } catch (error) { expect((error as { stderr: string }).stderr).not.toContain('synthetic-secret-value'); }
    } finally { await api.close(); await rm(temporary, { recursive: true, force: true }); }
  });

  it('returns structured JSON even when argument parsing fails before a command runs', async () => {
    try { await cli('doctor', '--home'); throw new Error('Expected argument parsing to fail'); }
    catch (error) {
      const failure = error as { code: number; stderr: string };
      expect(failure.code).toBe(1);
      expect(JSON.parse(failure.stderr)).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } });
      expect(failure.stderr).not.toContain('at file:');
    }
  });

  it('submits dynamic dependency updates through the replan command without dropping versions', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift e1 cli '));
    const body = { expectedRevision: 3, updates: [{ taskId: 'later', expectedVersion: 2, dependsOn: ['earlier'], priority: 5 }] };
    const inputFile = path.join(temporary, 'replan.json'); await writeFile(inputFile, JSON.stringify(body));
    const handle = async (method: string, pathname: string, input: unknown, key?: string) => {
      expect({ method, pathname, input, key }).toEqual({ method: 'POST', pathname: '/v1/workflows/workflow-one/replan', input: body, key: 'replan-key' });
      return { accepted: true };
    };
    const api = await startLocalApi({ handle }, { home: temporary, port: 0 });
    try {
      const result = await cli('replan', '--home', temporary, '--workflow', 'workflow-one', '--file', inputFile, '--key', 'replan-key', '--json');
      expect(JSON.parse(result.stdout)).toEqual({ accepted: true });
    } finally { await api.close(); await rm(temporary, { recursive: true, force: true }); }
  });
});
