import { lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { git, gitOk } from './process.js';
import type { RepositoryInfo } from './types.js';

export const key = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
export async function managedPath(root: string, candidate: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root), absolute = path.resolve(candidate);
  // Resolve the existing ancestor before comparing: macOS /var and /private/var
  // (and Windows junction aliases) must be in the same coordinate system.
  let existing = absolute;
  for (;;) {
    try {
      const canonical = await realpath(existing);
      const resolved = path.resolve(canonical, path.relative(existing, absolute));
      if (!inside(canonicalRoot, resolved)) throw new Error('UNSAFE_PATH: outside managed root or escaping symlink');
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink must not become an apparently safe missing directory.
      try { if ((await lstat(existing)).isSymbolicLink()) throw new Error('UNSAFE_PATH: dangling symlink'); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
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
// This is an existence check, not a file inventory. Group ignored/untracked
// directories so dependency trees cannot overflow the bounded Git evidence log.
/** Checks validate committed source, not ignored build/cache outputs. Deletion
 * and takeover still use checkoutClean to preserve every ignored file. */
export async function sourceCheckoutClean(cwd:string):Promise<boolean> {return (await gitOk(cwd,['status','--porcelain=v1','--untracked-files=normal'])).length===0;}
export async function checkoutClean(cwd: string): Promise<boolean> { return (await gitOk(cwd, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching'])).length === 0; }
const metadataTails = new Map<string, Promise<unknown>>();
export async function withMetadataLock<T>(commonGitDir: string, operation: () => Promise<T>): Promise<T> {
  const directory=await realpath(commonGitDir);
  const identity=process.platform==='win32'?directory.toLowerCase():directory;
  const previous = metadataTails.get(identity) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async()=>{
    // SQLite's OS-backed lease also serializes separate RIFT hosts sharing a
    // repository. A dead process releases it without unsafe stale-lock deletion.
    const lease=new DatabaseSync(path.join(directory,'rift-metadata.lock.db'));
    try{
      lease.exec('PRAGMA busy_timeout=0;');
      const deadline=Date.now()+30_000;
      for(;;){try{lease.exec('BEGIN EXCLUSIVE');break;}catch(error){
        if(!/locked|busy/i.test(String(error))||Date.now()>=deadline)throw error;
        await new Promise(resolve=>setTimeout(resolve,20));
      }}
      return await operation();
    }finally{lease.close();}
  });
  metadataTails.set(identity, next);
  try { return await next; } finally { if (metadataTails.get(identity) === next) metadataTails.delete(identity); }
}
