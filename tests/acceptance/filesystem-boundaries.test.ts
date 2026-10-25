import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { assertSafeFiles, checkoutClean, managedPath } from '../../src/git/worktree-binding.js';

const exec = promisify(execFile);

describe('A09 independent filesystem boundary acceptance', () => {
  it('rejects sibling-prefix paths, the managed root itself, and escaping junctions', async () => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'rift 验收 paths ')));
    const root = path.join(temporary, 'managed');
    const outside = path.join(temporary, 'managed-other');
    await mkdir(root); await mkdir(outside);
    try {
      await expect(managedPath(root, root)).rejects.toThrow(/UNSAFE_PATH/);
      await expect(managedPath(root, path.join(outside, 'candidate'))).rejects.toThrow(/UNSAFE_PATH/);
      await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(managedPath(root, path.join(root, 'escape', 'candidate'))).rejects.toThrow(/UNSAFE_PATH/);
      await expect(assertSafeFiles(root, ['escape/secret.txt'])).rejects.toThrow(/UNSAFE_PATH/);
      await expect(assertSafeFiles(root, ['../secret.txt'])).rejects.toThrow(/UNSAFE_PATH/);
      await expect(assertSafeFiles(root, ['.git/config'])).rejects.toThrow(/UNSAFE_PATH/);
      expect(await managedPath(root, path.join(root, 'safe', 'new'))).toBe(path.join(root, 'safe', 'new'));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it('treats ignored content as unsaved content even when ordinary git status is clean', async () => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'rift 验收 dirty ')));
    try {
      await exec('git', ['init', '-q', temporary]);
      await writeFile(path.join(temporary, '.gitignore'), 'private.log\n');
      await exec('git', ['-C', temporary, 'add', '.gitignore']);
      await exec('git', ['-C', temporary, '-c', 'user.name=RIFT Test', '-c', 'user.email=rift@example.invalid', 'commit', '-qm', 'base']);
      expect(await checkoutClean(temporary)).toBe(true);
      await writeFile(path.join(temporary, 'private.log'), 'unsaved ignored data');
      expect((await exec('git', ['-C', temporary, 'status', '--porcelain'])).stdout.trim()).toBe('');
      expect(await checkoutClean(temporary)).toBe(false);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
