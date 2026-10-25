import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { SessionId } from '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-subagent';
import { redact } from '../src/api/security.js';

const root = path.resolve('.runtime-evidence');
await mkdir(root, { recursive: true });
const require = createRequire(import.meta.url);
const providerManifestPath = require.resolve('@deepseek-ai/dsh-subagent-codex/package.json');
const providerManifest = JSON.parse(await readFile(providerManifestPath, 'utf8')) as { version: string };
// Resolve from the provider's installed dependency graph, including pnpm overrides.
const codexManifestPath = createRequire(providerManifestPath).resolve('@openai/codex/package.json');
const codexManifest = JSON.parse(await readFile(codexManifestPath, 'utf8')) as { version: string };
const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
const platformManifestPath = createRequire(codexManifestPath).resolve(`${platformPackage}/package.json`);
const platformManifest = JSON.parse(await readFile(platformManifestPath, 'utf8')) as { version: string };
const claudeProviderPath = require.resolve('@deepseek-ai/dsh-subagent-claude-code/package.json');
const claudeProviderManifest = JSON.parse(await readFile(claudeProviderPath, 'utf8')) as { version: string };
// Resolve only the public SDK entry, then read adjacent metadata. No SDK runtime
// is imported or used as an alternate backend; execution stays in DSH's Provider.
const claudeSdkEntry = createRequire(claudeProviderPath).resolve('@anthropic-ai/claude-agent-sdk');
const claudeSdkManifestPath = path.join(path.dirname(claudeSdkEntry), 'package.json');
const claudeSdkManifest = JSON.parse(await readFile(claudeSdkManifestPath, 'utf8')) as { version: string; claudeCodeVersion?: string };
const libcSuffix = process.platform === 'linux' && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? '-musl' : '';
const claudePlatformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libcSuffix}`;
const claudePlatformPath = createRequire(claudeSdkManifestPath).resolve(`${claudePlatformPackage}/package.json`);
const claudePlatformManifest = JSON.parse(await readFile(claudePlatformPath, 'utf8')) as { version: string };
const codexModel = process.env.RIFT_CODEX_MODEL ?? 'gpt-6.1-sol';
const claudeModel = process.env.RIFT_CLAUDE_MODEL ?? 'claude-opus-5-5';
process.env.RIFT_CODEX_MODEL = codexModel;
process.env.RIFT_CLAUDE_MODEL = claudeModel;
const modelFileId = (model: string): string => {
  const sanitized = model.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'model';
  return sanitized === model ? sanitized : `${sanitized}-${createHash('sha256').update(model).digest('hex').slice(0, 10)}`;
};
const runtimes = [
  { key: 'codex', name: 'Codex', provider: 'codex-review', model: codexModel, marker: 'RIFT_P0_CODEX', selected: process.argv.includes('--codex') },
  { key: 'claude', name: 'Claude', provider: 'claude-code-dev', model: claudeModel, marker: 'RIFT_P0_CLAUDE', selected: process.argv.includes('--claude') },
] as const;
process.env.DSH_HOME = path.join(root, 'dsh-home');
process.env.RIFT_HOME = path.join(root, 'rift-home');
process.env.RIFT_PORT = '0';
initializeProfileFromDefault('rift-probe', 'sdk-minimal', process.env.DSH_HOME);
const report: Record<string, unknown> = {
  date: new Date().toISOString(), node: process.version, platform: process.platform, dsh: '0.2.1-rc.3',
  codexConfiguration: { providerName: 'codex-review', model: codexModel, permissionMode: 'never', providerVersion: providerManifest.version, codexPayloadVersion: codexManifest.version, codexPlatformPackage: platformPackage, codexPlatformPayloadVersion: platformManifest.version },
  claudeConfiguration: { providerName: 'claude-code-dev', model: claudeModel, permissionMode: 'acceptEdits', providerVersion: claudeProviderManifest.version, claudeAgentSdkVersion: claudeSdkManifest.version, claudeCodeVersion: claudeSdkManifest.claudeCodeVersion ?? null, claudePlatformPackage, claudePlatformPayloadVersion: claudePlatformManifest.version },
};
for (const runtime of runtimes) report[runtime.key] = { status: 'skipped', reason: runtime.selected ? 'Selected probe has not started.' : `Not selected; use --${runtime.key} to run this credentialed provider probe.` };
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('rift-probe'), profile: 'rift-probe', patchFiles: [path.resolve('profiles/rift.patch.yml')], args: [] });
try {
  const endpoint = JSON.parse(await readFile(path.join(process.env.RIFT_HOME, 'endpoint.json'), 'utf8')) as {url:string};
  const token = (await readFile(path.join(process.env.RIFT_HOME, 'management.token'), 'utf8')).trim();
  const health = await fetch(`${endpoint.url}/v1/doctor`, {headers:{Authorization:`Bearer ${token}`}});
  if (!health.ok) throw new Error('RIFT plugin management API was not loaded.');
  report.managementApi = { status: 'pass', loopback: new URL(endpoint.url).hostname, doctor: await health.json() };
  const parent = await ctx.agents.create({ sessionId: SessionId(`rift-probe-${Date.now()}`), meta: { cwd: process.cwd() } });
  try {
    const liveParent = ctx.agents.get(parent.agent.id) === parent.agent;
    report.plugin = { status: liveParent ? 'pass' : 'fail', providers: ctx.subagents.list(), liveParent };
    if (!liveParent) throw new Error('Probe parent is not the exact live DSH Agent.');
    // No flags means no model calls. Selected providers run sequentially.
    for (const runtime of runtimes.filter(value => value.selected)) {
    try {
    const preAbortKey = runtime.key === 'codex' ? 'preAbort' : 'claudePreAbort';
    const capabilityKey = runtime.key === 'codex' ? 'capabilityRejection' : 'claudeCapabilityRejection';
    const before = new AbortController(); before.abort();
    let unexpectedActivation: Awaited<ReturnType<typeof ctx.subagents.startActivation>> | undefined;
    try {
      unexpectedActivation = await ctx.subagents.startActivation({ provider: runtime.provider, label: `${runtime.name} pre-aborted probe`, request: { parent: parent.agent, cwd: process.cwd(), prompt: [{ type: 'text', text: 'Do not execute.' }] }, signal: before.signal, delivery: 'caller' }); report[preAbortKey] = 'fail';
    } catch (error) {
      const expected = error === before.signal.reason || (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'CANCELLED')));
      report[preAbortKey] = expected ? 'pass' : 'fail'; report[`${preAbortKey}Diagnostic`] = redact(String(error));
    } finally {
      if (report[preAbortKey] !== 'pass') process.exitCode = 1;
      if (unexpectedActivation) await unexpectedActivation.dispose();
    }
    unexpectedActivation = undefined;
    try {
      unexpectedActivation = await ctx.subagents.startActivation({ provider: runtime.provider, label: `${runtime.name} unsupported capability probe`, request: { parent: parent.agent, prompt: [{ type: 'text', text: 'Do not execute.' }], outputSchema: { type: 'object', properties: {} } }, signal: new AbortController().signal, delivery: 'caller' }); report[capabilityKey] = 'fail';
    } catch (error) {
      const expected = error instanceof Error && 'code' in error && error.code === 'UNSUPPORTED_CAPABILITY';
      report[capabilityKey] = expected ? 'pass' : 'fail'; report[`${capabilityKey}Diagnostic`] = redact(String(error));
    } finally {
      if (report[capabilityKey] !== 'pass') process.exitCode = 1;
      if (unexpectedActivation) await unexpectedActivation.dispose();
    }
    if (report[preAbortKey] !== 'pass' || report[capabilityKey] !== 'pass') throw new Error(`${runtime.name} negative lifecycle probe failed; marker execution was not started.`);
    {
      const stamp = Date.now();
      const repository = path.join(root, `${runtime.key}-probe-repository-${stamp}`);
      const cwd = path.join(root, `中文 空格 ${runtime.name} worktree ${stamp}`);
      const git = async (...args:string[]) => promisify(execFile)('git', ['-C', repository, ...args], { windowsHide:true });
      await mkdir(repository, { recursive: true });
      await git('init', '-b', 'main');
      await git('config', 'user.name', 'RIFT Probe'); await git('config', 'user.email', 'rift-probe@localhost');
      await writeFile(path.join(repository, 'baseline.txt'), 'RIFT P0 baseline\n');
      await git('add', 'baseline.txt'); await git('commit', '-m', 'RIFT P0 baseline');
      await git('worktree', 'add', '--detach', cwd, 'HEAD');
      const startedAt = new Date().toISOString();
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 60000);
      let activation: Awaited<ReturnType<typeof ctx.subagents.startActivation>> | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => cleanupPromise ??= activation!.dispose();
      try {
        activation = await ctx.subagents.startActivation({ provider: runtime.provider, label: `RIFT P0 ${runtime.name} marker`, request: { parent: parent.agent, cwd, prompt: [{ type: 'text', text: `RIFT isolated runtime probe. Write exactly ${runtime.marker} to marker.txt in your current working directory, then return the absolute current directory and ${runtime.marker}. Do not touch other files.` }] }, signal: controller.signal, delivery: 'caller' });
        const aborted = new Promise<never>((_, reject) => {
          const cancel = () => { void cleanup().catch(() => { process.exitCode = 1; }); reject(new Error(`${runtime.name} probe deadline exceeded.`)); };
          if (controller.signal.aborted) cancel(); else controller.signal.addEventListener('abort', cancel, { once: true });
        });
        const result = await Promise.race([activation.result, aborted]);
        const marker = await readFile(path.join(cwd, 'marker.txt'), 'utf8').catch(() => '');
        const passed = !controller.signal.aborted && result.stopReason === 'completed' && marker.trim() === runtime.marker;
        report[runtime.key] = { status: passed ? 'pass' : 'fail', model: runtime.model, providerName: runtime.provider, childId: activation.childId, stopReason: result.stopReason, text: result.output.filter(x => x.type === 'text').map(x => x.text).join('\n'), diagnostic: result.diagnostic, markerVerified: marker.trim() === runtime.marker, cwd, startedAt, endedAt: new Date().toISOString() };
        if (!passed) process.exitCode = 1;
      } catch (error) { report[runtime.key] = { status: 'fail', model: runtime.model, providerName: runtime.provider, cwd, startedAt, endedAt: new Date().toISOString(), error: redact(String(error)) }; process.exitCode = 1; }
      finally {
        clearTimeout(deadline);
        if (activation) {
          try { await cleanup(); report[`${runtime.key}Cleanup`] = { status: 'pass', activationReleased: true }; }
          catch (error) { report[`${runtime.key}Cleanup`] = { status: 'fail', activationReleased: false, error: redact(String(error)) }; process.exitCode = 1; }
        } else report[`${runtime.key}Cleanup`] = { status: 'skipped', activationReleased: false, reason: 'No activation handle was accepted; cleanup was not independently verified.' };
      }
    }
    } catch (error) { report[runtime.key] = { status: 'fail', model: runtime.model, providerName: runtime.provider, error: redact(String(error)) }; process.exitCode = 1; }
    }
  } finally {
    try { await parent.dispose(); report.parentCleanup = { status: 'pass' }; }
    catch (error) { report.parentCleanup = { status: 'fail', error: redact(String(error)) }; process.exitCode = 1; }
  }
} catch (error) { report.error = redact(String(error)); process.exitCode = 1; }
finally {
  let shutdownError: unknown;
  try { await shutdown.shutdown(Number(process.exitCode ?? 0)); }
  catch (error) { shutdownError = error; process.exitCode = 1; }
  const lockRemains = await access(path.join(process.env.RIFT_HOME, 'rift.db.host.lock')).then(() => true, () => false);
  report.pluginUnload = { status: lockRemains || shutdownError ? 'fail' : 'pass', databaseLockReleased: !lockRemains, ...(shutdownError ? { error: redact(String(shutdownError)) } : {}) };
  if (lockRemains || shutdownError) process.exitCode = 1;
  if (report.error || Object.values(report).some(value => value === 'fail' || (value && typeof value === 'object' && 'status' in value && value.status === 'fail'))) process.exitCode = 1;
  report.exitCode = Number(process.exitCode ?? 0);
  const safeValue = (value: unknown): unknown => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(safeValue) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, safeValue(nested)])) : value;
  const serialized = JSON.stringify(safeValue(report), null, 2);
  const preserveAndWrite = async (file: string) => {
    const previous = await readFile(path.join(root, file), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; });
    if (previous) await writeFile(path.join(root, `${path.parse(file).name}-previous-${Date.now()}.json`), previous, { flag: 'wx' });
    await writeFile(path.join(root, file), serialized);
  };
  const selected = runtimes.filter(runtime => runtime.selected);
  if (!selected.length) await preserveAndWrite('runtime-probe.json');
  for (const runtime of selected) {
    await preserveAndWrite(`${runtime.key}-runtime-probe.json`);
    await preserveAndWrite(`${runtime.key}-runtime-probe-${modelFileId(runtime.model)}.json`);
  }
  console.log(serialized);
}
