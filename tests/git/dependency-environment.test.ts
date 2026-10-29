import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Candidate, GitContext } from '../../src/contracts/index.js';
import { DependencyEnvironmentCache, npmEnvironmentKey, type DependencyEnvironment } from '../../src/git/dependency-environment.js';
import { LocalGitService } from '../../src/git/integration.js';
import { CandidateEvidenceError, configurationFingerprint } from '../../src/git/evidence.js';
import { key } from '../../src/git/worktree-binding.js';
import { execute, gitOk } from '../../src/git/process.js';
import { registerCredentialRedaction } from '../../src/api/security.js';
import type { CheckCommand } from '../../src/git/types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const environment: DependencyEnvironment = { kind: 'npm-ci', templateVersion: 'npm-script-free-v1', offline: true };
const beforeBoot = `v1:${'a'.repeat(64)}:${'1'.repeat(64)}`, afterBoot = `v1:${'a'.repeat(64)}:${'2'.repeat(64)}`;
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rift-dependency-environment-')); roots.push(root);
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await gitOk(repo, ['init', '-b', 'main']); await gitOk(repo, ['config', 'user.name', 'Test']); await gitOk(repo, ['config', 'user.email', 'test@localhost']);
  const pack = path.join(root, 'pack'); await mkdir(path.join(pack, 'package'), { recursive: true });
  await writeFile(path.join(pack, 'package', 'package.json'), JSON.stringify({ name: 'offline-dependency', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'exit 99' } }));
  await writeFile(path.join(pack, 'package', 'index.js'), 'module.exports="installed";\n');
  const tarball = path.join(repo, 'dependency.tgz');
  expect((await execute('tar', ['-czf', tarball, '-C', pack, 'package'], root)).exitCode).toBe(0);
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(tarball)).digest('base64');
  const manifest = { name: 'offline-fixture', version: '1.0.0', dependencies: { 'offline-dependency': 'file:dependency.tgz' }, scripts: { postinstall: 'exit 98' } };
  await writeFile(path.join(repo, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': manifest, 'node_modules/offline-dependency': { version: '1.0.0', resolved: 'file:dependency.tgz', integrity, hasInstallScript: true } } }));
  await writeFile(path.join(repo, 'input.txt'), 'base');
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await gitOk(repo, ['add', '.']); await gitOk(repo, ['commit', '-m', 'base']);
  const base = await gitOk(repo, ['rev-parse', 'HEAD']);
  const ctx: GitContext = {
    workspace: { id: 'workspace', name: 'Test', repositoryPath: repo, rootPath: repo, commonGitDir: path.join(repo, '.git'), baseRef: 'main', status: 'active' },
    workflow: { id: 'workflow', workspaceId: 'workspace', goal: 'Test', leadSessionId: null, planRevision: 1, version: 1, status: 'running', integrationRef: 'refs/heads/rift/dependency-environment', baseCommit: base, summary: null },
    task: { id: 'task', workflowId: 'workflow', roleId: null, kind: 'change', title: 'Task', instructions: 'Task', expectedPaths: [], acceptanceCriteria: [], status: 'validating', attempt: 1, version: 1, sourceHead: base, acceptedCommit: null, blockingReason: null },
  };
  const binding = { workspaceId: ctx.workspace.id, repositoryId: 'repository', repositoryFingerprint: 'repository-fingerprint', taskId: 'task', attempt: 1, integrationId: 'integration', candidateHead: base };
  const cacheRoot = path.join(root, 'cache'), options = { enabled: true, maxBytes: 1_000_000 };
  const cache = new DependencyEnvironmentCache(cacheRoot, options);
  let installs = 0;
  const install = async (cwd: string = repo, content = 'installed') => {
    installs++;
    await rm(path.join(cwd, 'node_modules'), { recursive: true, force: true });
    await mkdir(path.join(cwd, 'node_modules', 'dependency'), { recursive: true });
    await writeFile(path.join(cwd, 'node_modules', 'dependency', 'index.js'), content);
    return { exitCode: 0, stdout: 'installed', stderr: '', truncated: false };
  };
  const prepare = (extra: Partial<Parameters<typeof cache.prepare>[0]> = {}, target = cache) => target.prepare({ cwd: repo, binding, environment, install, ...extra });
  const clone = async (id: string) => { const cwd = path.join(root, id); await gitOk(repo, ['worktree', 'add', '--detach', cwd, base]); return cwd; };
  const command = (id = 'check', script = `const fs=require('fs'),assert=require('assert');assert.equal(require('offline-dependency'),'installed');assert(!fs.existsSync(process.env.HOME+'/marker'));fs.writeFileSync(process.env.HOME+'/marker','private');console.log('real check executed');`): CheckCommand => ({ id, executable: process.execPath, args: ['-e', script], environment });
  const managedRoot = path.join(root, 'managed');
  const service = (enabled = true, commands = [command()]) => new LocalGitService({ managedRoot, commands, checkPlan: { mode: 'dag' }, environmentCache: { enabled, maxBytes: 1_000_000 } });
  const candidate = async (git: LocalGitService, id: string, context = ctx, abandon = true) => {
    let candidate: Candidate;
    try { candidate = await git.prepareCandidate({ ...context, integrationId: id, sourceHead: context.task.sourceHead! }); }
    catch (error) { if (!(error instanceof CandidateEvidenceError)) throw error; candidate = error.candidate; }
    if (abandon) await git.abandonCandidate({ ...context, candidate, reason: 'Test complete' });
    return candidate;
  };
  return { root, repo, ctx, binding, cacheRoot, options, cache, prepare, clone, install, installs: () => installs, command, service, candidate, managedRoot };
}

it('runs real offline npm ci cold/warm, copies private writable inodes, and always executes exact candidate checks across tasks/restart', async () => {
  const f = await fixture();
  const cold = await f.candidate(f.service(), 'cold');
  expect(cold.readiness!.status).toBe('ready');
  expect(cold.checks![0]!.stdout).toContain('[dependency installation]');
  expect(cold.checks![0]!.stdout).toContain('added 1 package');
  expect(cold.checks![0]!.dependencyEnvironment).toMatchObject({ status: 'miss', restoreMs: 0 });
  const warmCtx = { ...f.ctx, task: { ...f.ctx.task, id: 'second-task' } };
  const warm = await f.candidate(f.service(), 'warm', warmCtx);
  expect(warm.readiness!.status).toBe('ready');
  expect(warm.checks![0]!.dependencyEnvironment).toMatchObject({ status: 'hit', installMs: 0 });
  expect(warm.checks![0]!.stdout).toContain('real check executed');
  expect(warm.checks![0]!.id).not.toBe(cold.checks![0]!.id);
  expect(warm.checks![0]!.host).toMatchObject({ taskId: 'second-task', candidateHead: warm.candidateHead });
  const inputs = path.join(f.managedRoot, key(f.ctx.workspace.id), 'check-inputs');
  const paths = (await readdir(inputs)).map(dir => path.join(inputs, dir, 'node_modules', 'offline-dependency', 'index.js'));
  expect(paths).toHaveLength(2);
  expect((await lstat(paths[0]!)).ino).not.toBe((await lstat(paths[1]!)).ino);
  expect((await lstat(paths[0]!)).nlink).toBe(1);
  await writeFile(paths[0]!, 'poisoned');
  expect(await readFile(paths[1]!, 'utf8')).toContain('installed');
  const third = await f.candidate(f.service(), 'third'); expect(third.readiness!.status).toBe('ready'); expect(third.checks![0]!.dependencyEnvironment!.status).toBe('hit');
  const evidence = await f.service().readCheckEvidence({ ...warmCtx, integrationId: 'warm', checkId: warm.checks![0]!.id });
  expect(evidence.dependencyEnvironment).toEqual(warm.checks![0]!.dependencyEnvironment);
  console.log('dependency npm-ci actual offline performance ms', JSON.stringify({ cold: cold.checks![0]!.dependencyEnvironment, warm: warm.checks![0]!.dependencyEnvironment, coldCheck: cold.checks![0]!.durationMs, warmCheck: warm.checks![0]!.durationMs }));
});

it('single-flights concurrent real DAG installs and restores each node before allowing writes', async () => {
  const f = await fixture();
  const git = f.service(true, [f.command('a'), f.command('b')]);
  const candidate = await f.candidate(git, 'concurrent');
  expect(candidate.readiness!.status).toBe('ready');
  expect(candidate.checks!.map(check => check.dependencyEnvironment!.status).sort()).toEqual(['hit', 'miss']);
  expect(candidate.checks!.filter(check => check.dependencyEnvironment!.installMs > 0)).toHaveLength(1);
  expect(candidate.checks!.every(check => check.stdout.includes('real check executed'))).toBe(true);
});

it('disabled snapshots still perform npm installation and real checks without creating cache state', async () => {
  const f = await fixture();
  const candidate = await f.candidate(f.service(false), 'disabled');
  expect(candidate.readiness!.status).toBe('ready');
  expect(candidate.checks![0]!.dependencyEnvironment).toMatchObject({ status: 'fallback', restoreMs: 0 });
  await expect(lstat(path.join(f.managedRoot, 'dependency-environments'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('falls back to a real private install for repository npm configuration rather than ignoring it or caching credentials', async () => {
  const f = await fixture();
  await writeFile(path.join(f.repo, '.npmrc'), 'registry=http://127.0.0.1:9/\n');
  await gitOk(f.repo, ['add', '.npmrc']); await gitOk(f.repo, ['commit', '-m', 'install configuration']);
  const head = await gitOk(f.repo, ['rev-parse', 'HEAD']);
  const context = { ...f.ctx, task: { ...f.ctx.task, sourceHead: head } };
  const candidate = await f.candidate(f.service(), 'configured', context);
  expect(candidate.readiness!.status).toBe('ready');
  expect(candidate.checks![0]!.dependencyEnvironment).toMatchObject({ status: 'fallback', restoreMs: 0 });
  expect(candidate.checks![0]!.dependencyEnvironment!.key).toBeUndefined();
  expect(candidate.checks![0]!.stdout).toContain('added 1 package');
  await expect(lstat(path.join(f.managedRoot, 'dependency-environments'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves only bounded relative dependency links and executable modes during private restore', async () => {
  const f = await fixture();
  const first = await f.prepare({ install: async () => {
    const result = await f.install();
    await chmod(path.join(f.repo, 'node_modules/dependency/index.js'), 0o755);
    await symlink('dependency/index.js', path.join(f.repo, 'node_modules/alias'));
    return result;
  } });
  expect(first.evidence.status).toBe('miss');
  const cwd = await f.clone('links');
  const second = await f.prepare({ cwd, install: () => f.install(cwd) }); expect(second.evidence.status).toBe('hit');
  expect(await readlink(path.join(cwd, 'node_modules/alias'))).toBe('dependency/index.js');
  expect((await lstat(path.join(cwd, 'node_modules/dependency/index.js'))).mode & 0o777).toBe(0o755);
  const ready = path.join(f.cacheRoot, 'ready', first.evidence.key!, 'node_modules/dependency/index.js');
  expect((await lstat(ready)).mode & 0o222).toBe(0);
});

it('a cache hit never suppresses a failing current candidate or supplies an independent approval', async () => {
  const f = await fixture(); await f.candidate(f.service(), 'first');
  const git = f.service(true, [f.command('check', 'require("offline-dependency");process.exit(7)')]);
  const candidate = await f.candidate(git, 'failure');
  expect(candidate.readiness!.status).toBe('failed');
  expect(candidate.checks![0]!.dependencyEnvironment!.status).toBe('hit');
  expect(candidate.checks![0]!.exitCode).toBe(7);
  expect((await git.readOperation(f.ctx.workspace, 'failure')).review).toBeUndefined();
  await expect(git.publishCandidate({ ...f.ctx, candidate, review: { schemaVersion: 1, taskId: f.ctx.task.id, runId: 'independent-review', verdict: 'approve', reviewedCommit: candidate.candidateHead, findings: [] } })).rejects.toThrow('EVIDENCE_NOT_READY');
});

it('keys bind complete source, manifests, lock/config, template/args and repository/workspace trust; restoration config changes evidence fingerprints', async () => {
  const f = await fixture(); const input = { cwd: f.repo, binding: f.binding, environment };
  const key = await npmEnvironmentKey(input);
  for (const binding of [{ ...f.binding, workspaceId: 'other' }, { ...f.binding, repositoryId: 'other' }, { ...f.binding, repositoryFingerprint: 'other' }]) expect(await npmEnvironmentKey({ ...input, binding })).not.toBe(key);
  for (const env of [{ ...environment, templateVersion: 'v2' }, { ...environment, offline: false }]) expect(await npmEnvironmentKey({ ...input, environment: env })).not.toBe(key);
  for (const file of ['input.txt', 'package.json', 'package-lock.json']) {
    const original = await readFile(path.join(f.repo, file), 'utf8');
    await writeFile(path.join(f.repo, file), original + '\n');
    expect(await npmEnvironmentKey(input)).not.toBe(key);
    await writeFile(path.join(f.repo, file), original);
  }
  const lockPath = path.join(f.repo, 'package-lock.json'), originalLock = await readFile(lockPath, 'utf8');
  const signed = JSON.parse(originalLock); signed.packages['node_modules/offline-dependency'].resolved = 'https://registry.example/pkg.tgz?signature=private';
  await writeFile(lockPath, JSON.stringify(signed));
  await expect(npmEnvironmentKey(input)).rejects.toThrow('authenticated');
  await writeFile(lockPath, originalLock);
  await writeFile(path.join(f.repo, '.npmrc'), 'ignore-scripts=false'); await gitOk(f.repo, ['add', '.npmrc']);
  await expect(npmEnvironmentKey(input)).rejects.toThrow('Uncacheable');
  const cmd = f.command();
  expect(configurationFingerprint(cmd, { mode: 'dag' }, [cmd], { enabled: true, maxBytes: 100 })).not.toBe(configurationFingerprint(cmd, { mode: 'dag' }, [cmd], { enabled: false, maxBytes: 100 }));
  expect(configurationFingerprint(cmd)).not.toBe(configurationFingerprint({ ...cmd, environment: { ...environment, templateVersion: 'v2' } }));
});

it('queues same-key builders but never merges their private writable destinations or HOME', async () => {
  const f = await fixture(), second = await f.clone('second');
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const first = f.prepare({ install: async () => { started(); await barrier; return f.install(); } });
  await entered;
  const next = f.prepare({ cwd: second, install: () => f.install(second) });
  await new Promise(resolve => setTimeout(resolve, 50)); expect(f.installs()).toBe(0); release();
  expect((await first).evidence.status).toBe('miss'); expect((await next).evidence.status).toBe('hit'); expect(f.installs()).toBe(1);
  const a = path.join(f.repo, 'node_modules/dependency/index.js'), b = path.join(second, 'node_modules/dependency/index.js');
  expect((await lstat(a)).ino).not.toBe((await lstat(b)).ino); await writeFile(b, 'mutated'); expect(await readFile(a, 'utf8')).toBe('installed');
});

it('failed installation publishes nothing and releases a proven-finished build lease', async () => {
  const f = await fixture();
  const failure = await f.prepare({ install: async () => ({ exitCode: 1, stdout: '', stderr: 'install failed', truncated: false }) });
  expect(failure.failure!.exitCode).toBe(1);
  expect(await readdir(path.join(f.cacheRoot, 'ready'))).toEqual([]); expect(await readdir(path.join(f.cacheRoot, 'leases'))).toEqual([]);
  expect((await f.prepare()).evidence.status).toBe('miss');
});

it.each([124, 130, 'lost-result'] as const)('retains persistent lease after interrupted installation %s and requires bound reconciliation', async code => {
  const f = await fixture();
  const prepare = f.prepare({ install: async () => { if (code === 'lost-result') throw Error('Host interrupted'); return { exitCode: code, stdout: '', stderr: 'interrupted', truncated: false }; } });
  if (code === 'lost-result') await expect(prepare).rejects.toThrow('ENVIRONMENT_INSTALL_CLEANUP_UNKNOWN'); else expect((await prepare).failure!.exitCode).toBe(code);
  const restarted = new DependencyEnvironmentCache(f.cacheRoot, f.options);
  await expect(f.prepare({}, restarted)).rejects.toThrow('ENVIRONMENT_LEASE_HELD'); expect(f.installs()).toBe(0);
  await restarted.reconcile({ ...f.binding, taskId: 'different-owner' });
  await expect(f.prepare({}, restarted)).rejects.toThrow('ENVIRONMENT_LEASE_HELD');
  await restarted.reconcile(f.binding); expect((await f.prepare({}, restarted)).evidence.status).toBe('miss');
});

it('never duplicates a builder in another Host process or steals its lease after SIGKILL', async () => {
  const f = await fixture(), marker = path.join(f.root, 'builder-entered');
  const key = await npmEnvironmentKey({ cwd: f.repo, binding: f.binding, environment });
  const moduleUrl = pathToFileURL(path.resolve('src/git/dependency-environment.ts')).href;
  const script = `
    import { DependencyEnvironmentCache } from ${JSON.stringify(moduleUrl)};
    import { mkdir, writeFile } from 'node:fs/promises';
    const cache = new DependencyEnvironmentCache(${JSON.stringify(f.cacheRoot)},${JSON.stringify(f.options)});
    await cache.prepare({cwd:${JSON.stringify(f.repo)},binding:${JSON.stringify(f.binding)},environment:${JSON.stringify(environment)},install:async()=>{
      await mkdir(${JSON.stringify(path.join(f.cacheRoot, 'staging', key))});
      await writeFile(${JSON.stringify(marker)},'running');
      await new Promise(()=>setInterval(()=>{},1000));
    }});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    let entered = false;
    for (let i = 0; i < 800; i++) {
      try { await lstat(marker); entered = true; break; } catch {}
      if (child.exitCode !== null) throw Error(stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(entered, stderr).toBe(true);
    await expect(f.prepare()).rejects.toThrow('ENVIRONMENT_LEASE_HELD'); expect(f.installs()).toBe(0);
    child.kill('SIGKILL'); await closed;
    const restarted = new DependencyEnvironmentCache(f.cacheRoot, f.options);
    await expect(f.prepare({}, restarted)).rejects.toThrow('ENVIRONMENT_LEASE_HELD'); expect(f.installs()).toBe(0);
    expect(await readdir(path.join(f.cacheRoot, 'staging'))).toEqual([key]);
    await restarted.reconcile(f.binding);
    expect(await readdir(path.join(f.cacheRoot, 'staging'))).toEqual([]);
    expect((await f.prepare({}, restarted)).evidence.status).toBe('miss');
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await closed; }
});

it.each(['bytes', 'missing-file', 'escaping-link', 'metadata'] as const)('cold-falls back on a completed corrupt snapshot (%s), never uses its contents', async corruption => {
  const f = await fixture(); const first = await f.prepare(); const key = first.evidence.key!;
  const ready = path.join(f.cacheRoot, 'ready', key), data = path.join(ready, 'node_modules/dependency/index.js');
  if (corruption === 'bytes') { await chmod(data, 0o600); await writeFile(data, 'corrupt'); }
  if (corruption === 'missing-file' || corruption === 'escaping-link') {
    await chmod(path.dirname(data), 0o700); await rm(data);
    if (corruption === 'escaping-link') await symlink('/etc/passwd', data);
  }
  if (corruption === 'metadata') { await chmod(path.join(ready, 'snapshot.json'), 0o600); await writeFile(path.join(ready, 'snapshot.json'), '{}'); }
  await rm(path.join(f.repo, 'node_modules'), { recursive: true });
  const next = await f.prepare(); expect(next.evidence.status).toBe('fallback'); expect(next.evidence.reason).toContain('corrupt'); expect(f.installs()).toBe(2);
  expect(await readFile(path.join(f.repo, 'node_modules/dependency/index.js'), 'utf8')).toBe('installed');
});

it.each(['.npmrc', '.env', '.netrc', 'credentials.json', 'secret.key', 'registered-secret', 'escaping-link'] as const)('excludes credentials/config/unsafe links from published snapshots (%s)', async name => {
  const f = await fixture();
  registerCredentialRedaction('rift-test-reference', 'rift-super-secret-test-value');
  const result = await f.prepare({ install: async () => {
    const result = await f.install(); const dir = path.join(f.repo, 'node_modules/dependency');
    if (name === 'escaping-link') await symlink('/etc/passwd', path.join(dir, 'escape'));
    else await writeFile(path.join(dir, name === 'registered-secret' ? 'ordinary.txt' : name), name === 'registered-secret' ? 'x'.repeat(65530) + 'rift-super-secret-test-value' : 'token=private');
    return result;
  } });
  expect(result.evidence.status).toBe('fallback'); expect(result.evidence.reason).toContain('excluded'); expect(await readdir(path.join(f.cacheRoot, 'ready'))).toEqual([]);
});

it('keeps reclaimable published capacity bounded, never evicts an entry with a persistent use lease', async () => {
  const f = await fixture(); const first = await f.prepare(); const firstKey = first.evidence.key!;
  const directory = path.join(f.cacheRoot, 'ready', firstKey);
  const bytes = (await readFile(path.join(directory, 'snapshot.json'))).length + 9;
  await writeFile(path.join(f.cacheRoot, 'leases', firstKey), JSON.stringify({ ...f.binding, integrationId: 'active-reader' }));
  const limited = new DependencyEnvironmentCache(f.cacheRoot, { enabled: true, maxBytes: bytes + 20 });
  await rm(path.join(f.repo, 'node_modules'), { recursive: true });
  const changed = { ...environment, templateVersion: 'next' };
  const blocked = await f.prepare({ environment: changed }, limited); expect(blocked.evidence.status).toBe('fallback');
  expect(await readdir(path.join(f.cacheRoot, 'ready'))).toEqual([firstKey]);
  await rm(path.join(f.cacheRoot, 'leases', firstKey)); await rm(path.join(f.repo, 'node_modules'), { recursive: true });
  const replacement = await f.prepare({ environment: changed }, limited); expect(replacement.evidence.status).toBe('miss');
  expect(await readdir(path.join(f.cacheRoot, 'ready'))).toEqual([replacement.evidence.key]);
});

it('does not treat orphan staging or malformed leases as ordinary completed corruption', async () => {
  const f = await fixture(); await f.prepare(); const key = await npmEnvironmentKey({ cwd: f.repo, binding: f.binding, environment });
  await rm(path.join(f.repo, 'node_modules'), { recursive: true });
  await mkdir(path.join(f.cacheRoot, 'staging', key)); await writeFile(path.join(f.cacheRoot, 'staging', key, 'unknown'), 'preserve');
  await expect(f.prepare()).rejects.toThrow('ENVIRONMENT_LEASE_UNKNOWN'); expect(f.installs()).toBe(1);
  expect(await readFile(path.join(f.cacheRoot, 'staging', key, 'unknown'), 'utf8')).toBe('preserve');
  await rm(path.join(f.cacheRoot, 'staging', key), { recursive: true });
  await writeFile(path.join(f.cacheRoot, 'leases', key), 'not-json');
  await expect(f.prepare()).rejects.toThrow('ENVIRONMENT_LEASE_HELD');
  await expect(f.cache.reconcile(f.binding)).rejects.toThrow(); expect(f.installs()).toBe(1);
});

it('reconciles environment leases through existing reboot proof, with downgrade-to-legacy still protected', async () => {
  const f = await fixture(); const git = f.service();
  // Interrupt after actual install has started: its own persistent environment lease survives.
  const controller = new AbortController();
  const pending = git.prepareCandidate({ ...f.ctx, sourceHead: f.ctx.task.sourceHead!, integrationId: 'interrupt', signal: controller.signal });
  const cacheRoot = path.join(f.managedRoot, 'dependency-environments');
  let found = false;
  for (let i = 0; i < 300; i++) {
    try { if ((await readdir(path.join(cacheRoot, 'leases'))).length) { found = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(found).toBe(true); controller.abort();
  let candidate: Candidate | undefined;
  try { await pending; } catch (error) { if (error instanceof CandidateEvidenceError) candidate = error.candidate; else throw error; }
  expect(candidate).toBeDefined(); expect(candidate!.readiness!.cleanupStatus).toBe('unknown');
  const legacy = new LocalGitService({ managedRoot: f.managedRoot, commands: [{ id: 'legacy', executable: process.execPath, args: ['-e', 'console.log("legacy")'] }] });
  await expect(legacy.prepareCandidate({ ...f.ctx, integrationId: 'blocked-legacy', sourceHead: f.ctx.task.sourceHead! })).rejects.toThrow(/CHECK_PLAN_LEASE_HELD|CLEANUP_UNKNOWN/);
  await expect(git.reconcileCandidateCleanup({ ...f.ctx, candidate: candidate!, previousBootId: beforeBoot, currentBootId: beforeBoot })).rejects.toThrow('CLEANUP_UNKNOWN');
  await git.reconcileCandidateCleanup({ ...f.ctx, candidate: candidate!, previousBootId: beforeBoot, currentBootId: afterBoot });
  expect(await readdir(path.join(cacheRoot, 'leases'))).toEqual([]);
  await git.abandonCandidate({ ...f.ctx, candidate: candidate!, reason: 'Cleanup proven' });
  const next = await f.candidate(f.service(), 'after-reconcile'); expect(next.readiness!.status).toBe('ready');
});

it('rejects malformed opt-ins and requires private writable DAG isolation', () => {
  const command: CheckCommand = { id: 'test', executable: process.execPath, args: [], environment };
  for (const cache of [{ enabled: 'true', maxBytes: 1 }, { enabled: true, maxBytes: 0 }, { enabled: true, maxBytes: 1.5 }, { enabled: true, maxBytes: 1, unknown: true }]) expect(() => new LocalGitService({ managedRoot: '/unused', environmentCache: cache as never })).toThrow('INVALID_CHECK_CONFIG');
  for (const env of [{ kind: 'arbitrary-script', templateVersion: 'x' }, { kind: 'npm-ci', templateVersion: '' }, { ...environment, args: ['--unsafe'] }]) expect(() => new LocalGitService({ managedRoot: '/unused', commands: [{ ...command, environment: env as never }], checkPlan: { mode: 'dag' } })).toThrow('INVALID_CHECK_CONFIG');
  for (const plan of [undefined, { mode: 'serial' as const }]) expect(() => new LocalGitService({ managedRoot: '/unused', commands: [command], checkPlan: plan })).toThrow('INVALID_CHECK_CONFIG');
  expect(() => new LocalGitService({ managedRoot: '/unused', commands: [{ ...command, isolation: 'read_only' }], checkPlan: { mode: 'dag' } })).toThrow('INVALID_CHECK_CONFIG');
});
