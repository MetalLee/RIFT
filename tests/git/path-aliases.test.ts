import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { managedPath } from '../../src/git/worktree-binding.js';

it('normalizes both directions of root aliases while rejecting escapes and root aliases', async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'rift-alias-')));
  const real = path.join(temporary, 'real'), alias = path.join(temporary, 'alias');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await mkdir(path.join(real, 'managed', 'existing'), { recursive: true });
  await symlink(real, alias, kind);
  const root = path.join(real, 'managed'), aliasRoot = path.join(alias, 'managed');
  try {
    for (const r of [root, aliasRoot]) for (const c of [root, aliasRoot]) {
      expect(await managedPath(r, path.join(c, 'existing'))).toBe(path.join(root, 'existing'));
      expect(await managedPath(r, path.join(c, 'new', 'leaf'))).toBe(path.join(root, 'new', 'leaf'));
      await expect(managedPath(r, c)).rejects.toThrow('UNSAFE_PATH');
      await expect(managedPath(r, path.join(c, '..', 'managed-other', 'leaf'))).rejects.toThrow('UNSAFE_PATH');
    }
    await symlink(temporary, path.join(root, 'escape'), kind);
    await expect(managedPath(aliasRoot, path.join(aliasRoot, 'escape', 'missing'))).rejects.toThrow('UNSAFE_PATH');
    await symlink(root, path.join(root, 'self'), kind);
    await expect(managedPath(root, path.join(root, 'self'))).rejects.toThrow('UNSAFE_PATH');
    await symlink(path.join(temporary, 'absent'), path.join(root, 'dangling'), kind);
    await expect(managedPath(root, path.join(root, 'dangling', 'leaf'))).rejects.toThrow('UNSAFE_PATH');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

it('accepts an uncanonicalized OS temporary-directory path', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'rift-native-alias-'));
  try {
    expect(await managedPath(await realpath(temporary), path.join(temporary, 'leaf'))).toBe(path.join(await realpath(temporary), 'leaf'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
