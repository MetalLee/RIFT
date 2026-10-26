import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { execute } from '../../src/git/process.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); spawn.mockReset(); });
it.each(['darwin', 'linux'])('kills the owned %s process group and bounds inherited-pipe waiting', async platform => {
  vi.useFakeTimers();
  const kill = vi.fn();
  vi.stubGlobal('process', { ...process, platform, kill });
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const result = execute('git', ['status'], '/work', { timeoutMs: 100 });
  child.stdout.write('partial');
  child.emit('exit', 0); // close is deliberately never emitted: a descendant owns the pipes.
  await vi.advanceTimersByTimeAsync(100);
  expect((await result).exitCode).toBe(124);
  expect((await result).stdout).toBe('partial');
  expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  expect(spawn).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({ detached: true, shell: false }));
  expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
});

it('falls back to the Windows parent when taskkill reports failure, without POSIX group signaling', async () => {
  vi.useFakeTimers();
  const kill = vi.fn();
  vi.stubGlobal('process', { ...process, platform: 'win32', kill });
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
  spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
  const result = execute('git', [], 'C:/work', { timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  killer.emit('close', 1);
  expect((await result).exitCode).toBe(124);
  expect(spawn).toHaveBeenNthCalledWith(1, 'git', [], expect.objectContaining({ detached: false }));
  expect(spawn).toHaveBeenNthCalledWith(2, 'taskkill.exe', ['/PID', '12345', '/T', '/F'], expect.objectContaining({ windowsHide: true }));
  expect(child.kill).toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
});
