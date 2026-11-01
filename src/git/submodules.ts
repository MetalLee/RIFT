import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitOk } from './process.js';

/** Gitlinks are the authority, not arbitrary nested repositories or URLs. */
export async function gitlinks(cwd: string, ref = 'HEAD'): Promise<{ path: string; commit: string }[]> {
  const tree = await gitOk(cwd, ['ls-tree', '-rz', ref]);
  return tree.split('\0').filter(line => line.startsWith('160000 commit ')).map(line => {
    const separator = line.indexOf('\t');
    return { path: line.slice(separator + 1), commit: line.slice(14, separator) };
  });
}

async function indexedLinks(cwd: string): Promise<string[]> {
  const entries = await gitOk(cwd, ['ls-files', '--stage', '-z']);
  return entries.split('\0').filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
}

async function modulePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('UNSAFE_SUBMODULE_PATH');
  const base = await realpath(root), target = path.resolve(base, relative);
  const actual = await realpath(target);
  if (actual !== target || !actual.startsWith(base + path.sep)) throw new Error('UNSAFE_SUBMODULE_PATH');
  return actual;
}

export async function initializedModule(root: string, relative: string): Promise<string> {
  const cwd = await modulePath(root, relative);
  const metadata = await lstat(path.join(cwd, '.git'));
  if (metadata.isSymbolicLink() || await realpath(await gitOk(cwd, ['rev-parse', '--show-toplevel'])) !== cwd) throw new Error('UNSAFE_SUBMODULE_REPOSITORY');
  return cwd;
}

export async function validateSubmodules(cwd: string, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('SUBMODULE_DEPTH_LIMIT');
  const paths = new Set(await indexedLinks(cwd));
  for (const relative of paths) {
    try { await lstat(path.join(cwd, relative, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await validateSubmodules(await initializedModule(cwd, relative), depth + 1);
  }
}

/** Git treats deinitialized dependencies as clean; execution snapshots cannot. */
export async function submodulesPresent(cwd: string, depth = 0, includeIgnored = false): Promise<boolean> {
  if (depth > 32) throw new Error('SUBMODULE_DEPTH_LIMIT');
  for (const link of await gitlinks(cwd)) {
    let module: string;
    try { module = await initializedModule(cwd, link.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (await gitOk(module, ['rev-parse', 'HEAD']) !== link.commit) return false;
    if (await gitOk(module, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none', ...includeIgnored ? ['--ignored=matching'] : []])) return false;
    if (!await submodulesPresent(module, depth + 1, includeIgnored)) return false;
  }
  return true;
}

/** Materialize pinned dependencies from operator-prepared local repositories.
 * No remote URL from .gitmodules is contacted by the credential-bearing Host.
 * Independent clones keep concurrent task/review checkouts and metadata isolated.
 */
export async function prepareSubmodules(source: string, target: string, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('SUBMODULE_DEPTH_LIMIT');
  for (const link of await gitlinks(target)) {
    let origin: string;
    try {
      origin = await initializedModule(source, link.path);
      await gitOk(origin, ['cat-file', '-e', `${link.commit}^{commit}`]);
    } catch (error) {
      throw new Error(`SUBMODULE_NOT_PREPARED: initialize/fetch ${link.path} at ${link.commit} in ${source} before creating a worktree. ${String(error)}`);
    }
    const destination = await modulePath(target, link.path);
    // Fresh worktrees contain empty gitlink directories. Never overwrite an
    // existing checkout, including partially prepared or user-modified content.
    await gitOk(target, ['clone', '--no-hardlinks', '--dissociate', '--no-checkout', '--', origin, destination]);
    await gitOk(destination, ['checkout', '--detach', link.commit]);
    await prepareSubmodules(origin, destination, depth + 1);
  }
}

/** Parent commits cannot preserve uncommitted changes within a dependency. */
export async function assertModuleClean(cwd: string): Promise<void> {
  await validateSubmodules(cwd);
  const status = await gitOk(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  if (status || !await submodulesPresent(cwd)) throw new Error('SUBMODULE_DIRTY: commit dependency changes in its own repository before updating the parent gitlink.');
}
