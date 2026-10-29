import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DependencyEnvironmentEvidence, EvidenceBinding } from '@rift/protocol';
import { privateEntry } from '../agent/filesystem-sandbox.js';
import { redact, redactionTailLength } from '../api/security.js';
import { environmentFingerprint, fingerprint } from './evidence.js';
import type { CommandResult } from './process.js';
import { gitOk } from './process.js';
import { managedPath, withMetadataLock } from './worktree-binding.js';

export interface EnvironmentCacheOptions { enabled: boolean; maxBytes: number }
export interface DependencyEnvironment { kind: 'npm-ci'; templateVersion: string; offline?: boolean }
export const npmInstallArgs = (environment: DependencyEnvironment): string[] => ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(environment.offline ? ['--offline'] : [])];
export function validateEnvironmentConfig(cache: EnvironmentCacheOptions | undefined, environment: DependencyEnvironment | undefined): void {
  if (cache !== undefined && (!cache || typeof cache.enabled !== 'boolean' || !Number.isSafeInteger(cache.maxBytes) || cache.maxBytes < 1 || Object.keys(cache).some(key => !['enabled', 'maxBytes'].includes(key)))) throw new Error('INVALID_CHECK_CONFIG: environment cache');
  if (environment !== undefined && (!environment || environment.kind !== 'npm-ci' || typeof environment.templateVersion !== 'string' || !environment.templateVersion.trim() || environment.templateVersion.length > 160 || environment.offline !== undefined && typeof environment.offline !== 'boolean' || Object.keys(environment).some(key => !['kind', 'templateVersion', 'offline'].includes(key)))) throw new Error('INVALID_CHECK_CONFIG: dependency environment');
}
const hashFile = async (file: string, excludeCredentials = false): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Unsupported dependency file');
    const hash = createHash('sha256');
    let tail = Buffer.alloc(0);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      if (excludeCredentials) {
        const content = Buffer.concat([tail, Buffer.from(chunk)]), text = content.toString('utf8');
        if (redact(text, Number.MAX_SAFE_INTEGER) !== text) throw new Error('Credential content excluded from dependency snapshot');
        tail = content.subarray(Math.max(0, content.length - redactionTailLength()));
      }
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
};
const sensitive = (name: string): boolean => privateEntry(name) || /^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|_netrc|\.git|\.git-credentials|\.pypirc|.*\.(?:pem|key|p12|pfx))$/i.test(name);
interface Tree { digest: string; bytes: number }
/** Only relative, in-tree links survive; never follow package-controlled links on the Host. */
async function tree(directory: string, options: { copyTo?: string; immutable?: boolean; credentials?: boolean; maxBytes?: number } = {}): Promise<Tree> {
  const hash = createHash('sha256'); let bytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const source = path.join(directory, relative), stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      const target = await readlink(source), resolved = path.resolve(path.dirname(source), target);
      if (path.isAbsolute(target) || !resolved.startsWith(directory + path.sep)) throw new Error('Dependency symlink escapes snapshot');
      // realpath also detects chained escapes and dangling/cyclic links.
      if (!(await realpath(source)).startsWith(directory + path.sep)) throw new Error('Dependency symlink escapes snapshot');
      hash.update(JSON.stringify([relative, 'link', target]));
      if (options.copyTo) await symlink(target, path.join(options.copyTo, relative));
    } else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, 'directory']));
      if (options.copyTo) await mkdir(path.join(options.copyTo, relative), { mode: 0o700 });
      for (const name of (await readdir(source)).sort()) {
        if (options.credentials && sensitive(name)) throw new Error('Credential/configuration path excluded from dependency snapshot');
        await walk(path.join(relative, name));
      }
      if (options.copyTo) await chmod(path.join(options.copyTo, relative), options.immutable ? 0o555 : 0o755);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) throw new Error('Dependency snapshot exceeds capacity');
      const executable = !!(stat.mode & 0o111);
      hash.update(JSON.stringify([relative, 'file', executable, await hashFile(source, options.credentials)]));
      if (options.copyTo) {
        await copyFile(source, path.join(options.copyTo, relative), constants.COPYFILE_EXCL);
        await chmod(path.join(options.copyTo, relative), options.immutable ? executable ? 0o555 : 0o444 : executable ? 0o755 : 0o644);
      }
    } else throw new Error('Special file excluded from dependency snapshot');
  };
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Dependency root must be a private directory');
  await walk('');
  return { digest: hash.digest('hex'), bytes };
}

/** Fixed script-free npm template. Full source tree binds workspaces/local package inputs too. */
export async function npmEnvironmentKey(input: { cwd: string; binding: EvidenceBinding; environment: DependencyEnvironment }): Promise<string> {
  const files = (await gitOk(input.cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
  if (!files.includes('package.json') || !files.includes('package-lock.json') || files.some(file => file.split('/').some(sensitive) || file.split('/').includes('node_modules'))) throw new Error('Uncacheable manifest, credential configuration or tracked dependency output');
  const inputs: [string, string][] = [];
  for (const file of files.sort()) {
    const source = path.join(input.cwd, file), stat = await lstat(source);
    if (!stat.isFile()) throw new Error('Source links/submodules require a fresh install');
    inputs.push([file, await hashFile(source)]);
  }
  const lock = await readFile(path.join(input.cwd, 'package-lock.json'), 'utf8');
  // npm can embed credentials in URLs; do not persist a snapshot from such an installation.
  if (/(?:https?:\/\/[^\s"/]*@|_auth|token|password)/i.test(lock)) throw new Error('Credential-bearing lockfile excluded');
  const packages = JSON.parse(lock).packages;
  if (!packages || typeof packages !== 'object') throw new Error('Unsupported lockfile');
  for (const item of Object.values(packages) as { resolved?: string; integrity?: string; link?: boolean }[]) {
    if (item.link) throw new Error('Linked dependencies require fresh install');
    if (!item.resolved) continue;
    if (item.resolved.startsWith('file:')) {
      const local = path.relative(input.cwd, path.resolve(input.cwd, item.resolved.slice(5)));
      if (!files.includes(local) || !local.endsWith('.tgz')) throw new Error('External/mutable local dependency requires fresh install');
    } else {
      const remote = new URL(item.resolved);
      if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash || !item.integrity) throw new Error('Unbounded or authenticated dependency source');
    }
  }
  const npm = await realpath('/usr/local/bin/npm'), npmRoot = path.resolve(path.dirname(npm), '..');
  const version = JSON.parse(await readFile(path.join(npmRoot, 'package.json'), 'utf8')).version;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string; glibcVersionCompiler?: string } };
  return fingerprint({ schema: 1, trust: [input.binding.workspaceId, input.binding.repositoryId, input.binding.repositoryFingerprint], inputs,
    tree: await gitOk(input.cwd, ['rev-parse', 'HEAD^{tree}']), environment: input.environment, args: npmInstallArgs(input.environment),
    sandbox: environmentFingerprint(), abi: process.versions.modules, libc: report.header?.glibcVersionRuntime, node: await hashFile(await realpath('/usr/local/bin/node')),
    npm: { path: npm, version, tree: await tree(npmRoot) } });
}

// Published trees are read-only; make only directories removable, without following links.
async function removeSnapshot(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await chmod(directory, 0o700);
      for (const name of await readdir(directory)) await removeSnapshot(path.join(directory, name));
    }
    await rm(directory, { recursive: true, force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

const flights = new Map<string, Promise<unknown>>();
export class DependencyEnvironmentCache {
  constructor(readonly root: string, readonly options: EnvironmentCacheOptions) {}
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await realpath(this.root) !== this.root) throw new Error('UNSAFE_ENVIRONMENT_CACHE_PATH');
    for (const name of ['ready', 'leases', 'staging']) {
      const target = path.join(this.root, name); await mkdir(target, { recursive: true, mode: 0o700 });
      if (await realpath(target) !== target) throw new Error('UNSAFE_ENVIRONMENT_CACHE_PATH');
    }
  }
  private async release(key: string): Promise<void> { await unlink(path.join(this.root, 'leases', key)); }
  private async collect(reserve: number, protectedKey: string): Promise<boolean> {
    let total = 0;
    const entries: { key: string; bytes: number; time: number }[] = [];
    for (const key of await readdir(path.join(this.root, 'ready'))) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const directory = path.join(this.root, 'ready', key);
      try {
        await managedPath(this.root, directory);
        const stat = await lstat(directory);
        if (!stat.isDirectory()) continue;
        const measured = await tree(directory);
        total += measured.bytes; entries.push({ key, bytes: measured.bytes, time: stat.mtimeMs });
      } catch { return false; } // Unknown state is not permission to reclaim it.
    }
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (total + reserve <= this.options.maxBytes) break;
      if (entry.key === protectedKey) continue;
      try { await lstat(path.join(this.root, 'leases', entry.key)); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await removeSnapshot(path.join(this.root, 'ready', entry.key)); total -= entry.bytes;
    }
    return total + reserve <= this.options.maxBytes;
  }
  /** Called only after the candidate's existing same-machine reboot proof gate. */
  async reconcile(binding: EvidenceBinding): Promise<void> {
    try { await lstat(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await this.initialize();
    await withMetadataLock(this.root, async () => {
      for (const key of await readdir(path.join(this.root, 'leases'))) {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('ENVIRONMENT_LEASE_UNKNOWN');
        const file = path.join(this.root, 'leases', key);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ENVIRONMENT_LEASE_UNKNOWN');
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (fingerprint(saved) !== fingerprint(binding)) continue;
        await removeSnapshot(path.join(this.root, 'staging', key));
        await this.release(key);
      }
    });
  }
  async prepare(input: { cwd: string; binding: EvidenceBinding; environment: DependencyEnvironment; install: () => Promise<CommandResult> }): Promise<{ evidence: DependencyEnvironmentEvidence; installation?: CommandResult; failure?: CommandResult }> {
    const started = performance.now();
    const evidence: DependencyEnvironmentEvidence = { status: 'fallback', prepareMs: 0, installMs: 0, restoreMs: 0 };
    const install = async () => {
      const start = performance.now(); const result = await input.install(); evidence.installMs += performance.now() - start;
      return result;
    };
    const fresh = async (reason: string) => {
      evidence.reason = reason;
      const result = await install().catch(() => { throw new Error('ENVIRONMENT_INSTALL_CLEANUP_UNKNOWN: installation lost its result'); }); evidence.prepareMs = performance.now() - started;
      return { evidence, installation: result, ...(result.exitCode ? { failure: result } : {}) };
    };
    if (!this.options.enabled) return fresh('Dependency snapshots disabled; fresh npm install');
    let key: string;
    try { key = await npmEnvironmentKey(input); }
    catch { return fresh('Inputs/toolchain not safely cacheable; download cache and fresh install only'); }
    evidence.key = key;
    const flightKey = path.join(this.root, key), previous = flights.get(flightKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.initialize();
      // A persistent lease is never stolen based on PID, timeout or malformed state.
      await withMetadataLock(this.root, async () => {
        const lease = await open(path.join(this.root, 'leases', key), 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('ENVIRONMENT_LEASE_HELD: active/interrupted environment requires cleanup proof'); throw error; });
        try { await lease.writeFile(JSON.stringify(input.binding)); await lease.sync(); } finally { await lease.close(); }
      });
      let uncertain = false, completed = false;
      const ready = path.join(this.root, 'ready', key), staging = path.join(this.root, 'staging', key), destination = path.join(input.cwd, 'node_modules');
      try {
        try { await lstat(staging); throw new Error('ENVIRONMENT_LEASE_UNKNOWN: orphan staging requires operator repair'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try {
          await lstat(ready); completed = true;
          await managedPath(this.root, ready);
          const stat = await lstat(ready);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid snapshot root');
          const manifestFile = path.join(ready, 'snapshot.json');
          if ((await lstat(manifestFile)).isSymbolicLink()) throw new Error('Invalid snapshot metadata');
          const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
          const source = path.join(ready, 'node_modules'), measured = await tree(source, { credentials: true, maxBytes: this.options.maxBytes });
          if (manifest.key !== key || manifest.digest !== measured.digest || manifest.bytes !== measured.bytes) throw new Error('Snapshot checksum mismatch');
          // Restore only into a fresh candidate snapshot, never merge with previous task writes.
          try { await lstat(destination); throw new Error('DEPENDENCY_DESTINATION_EXISTS'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const start = performance.now();
          const copied = await tree(source, { copyTo: destination, credentials: true, maxBytes: this.options.maxBytes });
          if (copied.digest !== manifest.digest || (await tree(destination)).digest !== manifest.digest) throw new Error('Snapshot changed during restore');
          evidence.restoreMs = performance.now() - start; evidence.status = 'hit'; evidence.prepareMs = performance.now() - started;
          return { evidence };
        } catch (error) {
          if (String(error).includes('DEPENDENCY_DESTINATION_EXISTS')) {
            uncertain = true;
            const result = await fresh('Private dependency destination already exists; fresh install');
            uncertain = !!result.failure && [124, 130].includes(result.failure.exitCode);
            return result;
          }
          if (completed || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            evidence.reason = 'Completed snapshot corrupt/unsafe; fresh install';
            // The key lease excludes readers and builders; only completed entries may be retired here.
            await removeSnapshot(ready);
            await rm(destination, { recursive: true, force: true });
          }
        }
        uncertain = true;
        const result = await install().catch(() => { throw new Error('ENVIRONMENT_INSTALL_CLEANUP_UNKNOWN: installation lost its result'); });
        uncertain = [124, 130].includes(result.exitCode);
        if (result.exitCode) { evidence.reason = 'Install failed; no snapshot published'; evidence.prepareMs = performance.now() - started; return { evidence, installation: result, failure: result }; }
        try {
          const measured = await tree(destination, { credentials: true, maxBytes: this.options.maxBytes });
          await mkdir(staging, { mode: 0o700 });
          const copied = await tree(destination, { copyTo: path.join(staging, 'node_modules'), immutable: true, credentials: true, maxBytes: this.options.maxBytes });
          if (measured.digest !== copied.digest || (await tree(path.join(staging, 'node_modules'))).digest !== measured.digest) throw new Error('Dependencies changed during publication');
          const metadata = JSON.stringify({ key, ...measured });
          const file = await open(path.join(staging, 'snapshot.json'), 'wx', 0o400);
          try { await file.writeFile(metadata); await file.sync(); } finally { await file.close(); }
          await chmod(staging, 0o555);
          await withMetadataLock(this.root, async () => {
            if (!await this.collect(measured.bytes + Buffer.byteLength(metadata), key)) throw new Error('Environment cache capacity/leases prevent publication');
            await rename(staging, ready);
          });
          evidence.status = evidence.reason ? 'fallback' : 'miss';
        } catch {
          evidence.reason ??= 'Snapshot excluded (credentials, links, changed inputs or capacity); fresh install retained';
          await removeSnapshot(staging);
        }
        evidence.prepareMs = performance.now() - started;
        return { evidence, installation: result };
      } finally {
        if (!uncertain) await withMetadataLock(this.root, () => this.release(key));
      }
    });
    flights.set(flightKey, next);
    try { return await next; } finally { if (flights.get(flightKey) === next) flights.delete(flightKey); }
  }
}
