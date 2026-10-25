import { lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, gitOk } from './process.js';
import type { RepositoryInfo } from './types.js';

export const key = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
export async function managedPath(root: string, candidate: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root), absolute = path.resolve(candidate);
  if (!inside(canonicalRoot, absolute)) throw new Error('UNSAFE_PATH: outside managed root');
  let existing = absolute;
  for (;;) {
    try { const canonical = await realpath(existing); if (canonical !== canonicalRoot && !inside(canonicalRoot, canonical)) throw new Error('UNSAFE_PATH: symlink escapes managed root'); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; existing = path.dirname(existing); }
  }
  return absolute;
}
export async function inspectRepository(repositoryPath: string, baseRef: string): Promise<RepositoryInfo> {
  const rootPath = await realpath(await gitOk(repositoryPath, ['rev-parse', '--show-toplevel']));
  const commonGitDir = await realpath(await gitOk(rootPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if ((await git(rootPath, ['config', '--bool', 'core.sparseCheckout'])).stdout.trim() === 'true') throw new Error('UNSUPPORTED_REPOSITORY: sparse checkout');
  const entries = await gitOk(rootPath, ['ls-files', '--stage']);
  if (entries.split('\n').some(line => line.startsWith('160000 '))) throw new Error('UNSUPPORTED_REPOSITORY: submodules');
  const baseCommit = await gitOk(rootPath, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
  return { rootPath, commonGitDir, baseCommit };
}
export async function assertSafeFiles(root: string, files: string[]): Promise<void> {
  const canonicalRoot = await realpath(root);
  for (const file of files) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(segment => segment === '..' || segment.toLowerCase() === '.git')) throw new Error('UNSAFE_PATH: invalid changed file');
    const resolved = path.resolve(canonicalRoot, file);
    if (!inside(canonicalRoot, resolved)) throw new Error('UNSAFE_PATH: changed path outside checkout');
    let current = canonicalRoot;
    for (const segment of file.split('/')) {
      current = path.join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) { const target = await realpath(current); if (target !== canonicalRoot && !inside(canonicalRoot, target)) throw new Error('UNSAFE_PATH: symlink or junction escapes checkout'); }
        if (stat.isDirectory()) { const contents = await readdir(current); if (contents.some(name => name.toLowerCase() === '.git')) throw new Error('UNSUPPORTED_REPOSITORY: nested repository'); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
export async function checkoutClean(cwd: string): Promise<boolean> { return (await gitOk(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])).length === 0; }
const metadataTails = new Map<string, Promise<unknown>>();
export async function withMetadataLock<T>(commonGitDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = metadataTails.get(commonGitDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  metadataTails.set(commonGitDir, next);
  try { return await next; } finally { if (metadataTails.get(commonGitDir) === next) metadataTails.delete(commonGitDir); }
}
