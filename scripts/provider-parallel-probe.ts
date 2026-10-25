import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import '@deepseek-ai/dsh-agent';
import { redact } from '../src/api/security.js';

if (!process.argv.includes('--run')) {
  console.log('No model execution requested. Run with --run after official Claude and Codex authentication is available.');
  process.exit(0);
}

const evidenceRoot = path.resolve('.runtime-evidence');
const probeId = `provider-parallel-${Date.now()}-${randomUUID().slice(0, 8)}`;
const root = path.join(evidenceRoot, probeId);
await mkdir(root, { recursive: true });
process.env.DSH_HOME = path.join(root, 'dsh-home');
process.env.RIFT_HOME = path.join(root, 'rift-home');
process.env.RIFT_PORT = '0';
process.env.RIFT_CLAUDE_MODEL ??= 'claude-opus-5-5';
process.env.RIFT_CODEX_MODEL ??= 'gpt-6.1-sol';
const now = () => new Date().toISOString();
const began = Date.now();
const expires = began + 90_000;
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error('Parallel probe 90-second deadline exceeded.')), 90_000);
const report: Record<string, unknown> = {
  probeId, startedAt: now(), node: process.version, platform: process.platform,
  scope: 'Official Provider activation overlap, selected activation disposal and sibling completion only.',
  notVerified: ['Full four-role business workflow', 'Lead model orchestration', 'OS subprocess-tree cancellation', 'Arbitrary shell permissions'],
  models: { claude: process.env.RIFT_CLAUDE_MODEL, codex: process.env.RIFT_CODEX_MODEL },
  permissionModes: { claude: 'acceptEdits', codex: 'never' },
  deadlineMs: 90_000, hostFilePollMs: 250, maximumModelGateReads: 20,
};
type Child = {
  key: string; provider: string; cwd: string; ready: string; done: string;
  activation?: SubagentActivation; observation?: Promise<void>; result?: SubagentResult; resultError?: string;
  cleanup?: Promise<void>; evidence: Record<string, unknown>;
};
const children: Child[] = [
  { key: 'claude-a', provider: 'claude-code-dev' },
  { key: 'claude-b', provider: 'claude-code-dev' },
  { key: 'codex-review', provider: 'codex-review' },
].map(value => ({ ...value, cwd: path.join(root, `中文 空格 ${value.key} worktree`), ready: `${probeId}:${value.key}:READY`, done: `${probeId}:${value.key}:DONE`, evidence: { providerName: value.provider } }));
report.children = Object.fromEntries(children.map(child => [child.key, child.evidence]));
let host: Awaited<ReturnType<typeof runProfile>> | undefined;
let disposeParent: (() => Promise<void>) | undefined;
let failure = false;

// Bound every awaited lifecycle call by the same deadline. A timeout records
// unknown cleanup; it never claims that the Provider's process tree was killed.
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  const remaining = expires - Date.now();
  if (remaining <= 0) { void operation.catch(() => undefined); throw new Error(`${label}: total probe deadline exceeded`); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: total probe deadline exceeded`)), remaining); })]); }
  finally { clearTimeout(timer); }
}
function cleanup(child: Child): Promise<void> {
  if (!child.activation) return Promise.resolve();
  if (!child.cleanup) {
    child.evidence.cleanupRequestedAt = now();
    child.cleanup = child.activation.dispose().then(() => {
      child.evidence.cleanup = 'confirmed'; child.evidence.cleanedAt = now();
    }, error => {
      child.evidence.cleanup = 'failed'; child.evidence.cleanupError = redact(String(error)); failure = true; throw error;
    });
  }
  return child.cleanup;
}
abort.signal.addEventListener('abort', () => {
  for (const child of children) void cleanup(child).catch(() => undefined);
}, { once: true });
const fileText = (file: string) => readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });

try {
  const require = createRequire(import.meta.url);
  const codexProviderPath = require.resolve('@deepseek-ai/dsh-subagent-codex/package.json');
  const claudeProviderPath = require.resolve('@deepseek-ai/dsh-subagent-claude-code/package.json');
  const version = async (file: string) => (JSON.parse(await readFile(file, 'utf8')) as { version: string }).version;
  const codexPackage = createRequire(codexProviderPath).resolve('@openai/codex/package.json');
  const claudeEntry = createRequire(claudeProviderPath).resolve('@anthropic-ai/claude-agent-sdk');
  const claudePackage = path.join(path.dirname(claudeEntry), 'package.json');
  const libcSuffix = process.platform === 'linux' && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? '-musl' : '';
  report.versions = {
    dsh: await version(require.resolve('@deepseek-ai/dsh/package.json')),
    codexProvider: await version(codexProviderPath), claudeProvider: await version(claudeProviderPath),
    codex: await version(codexPackage), claudeAgentSdk: await version(claudePackage),
    codexPlatform: await version(createRequire(codexPackage).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)),
    claudePlatform: await version(createRequire(claudePackage).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libcSuffix}/package.json`)),
  };
  const repository = path.join(root, '临时 Git 仓库');
  await mkdir(repository, { recursive: true });
  const git = async (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args], { windowsHide: true, timeout: Math.max(1, expires - Date.now()) });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'RIFT Probe'); await git('config', 'user.email', 'rift-probe@localhost');
  await writeFile(path.join(repository, 'baseline.txt'), 'RIFT parallel Provider probe\n');
  await git('add', 'baseline.txt'); await git('commit', '-m', 'RIFT parallel probe baseline');
  const baseHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const child of children) {
    await git('worktree', 'add', '--detach', child.cwd, 'HEAD');
    await writeFile(path.join(child.cwd, 'gate.json'), JSON.stringify({ probeId, child: child.key, release: false }));
    child.evidence.cwd = child.cwd; child.evidence.baseHead = baseHead;
  }

  initializeProfileFromDefault('rift-parallel-probe', 'sdk-minimal', process.env.DSH_HOME);
  const startedHost = await bounded(runProfile({ environment: loadLayeredEnv('rift-parallel-probe'), profile: 'rift-parallel-probe', patchFiles: [path.resolve('profiles/rift.patch.yml')], args: [] }).then(loaded => {
    host = loaded;
    if (abort.signal.aborted) void loaded.shutdown.shutdown(1).catch(() => undefined);
    return loaded;
  }), 'host startup');
  host = startedHost;
  const { ctx } = startedHost;
  const parent = await bounded(ctx.agents.create({ sessionId: SessionId(probeId), meta: { cwd: root } }).then(created => {
    disposeParent = () => created.dispose();
    if (abort.signal.aborted) void created.dispose().catch(() => undefined);
    return created;
  }), 'parent creation');
  disposeParent = () => parent.dispose();
  if (ctx.agents.get(parent.agent.id) !== parent.agent) throw new Error('Exact live parent Agent was not obtained.');
  report.providers = ctx.subagents.list();

  const admissions = children.map(async child => {
    child.evidence.startRequestedAt = now();
    const gateReadCommand = `Get-Content -LiteralPath '${path.join(child.cwd, 'gate.json').replace(/'/g, "''")}'`;
    const fileToolPolicy = child.provider === 'codex-review'
      ? `Use apply_patch for writes. To read gate.json, your exec_command tool may run only this exact PowerShell command: ${gateReadCommand}\nDo not add, chain or substitute any command, argument, redirection, pipeline or script. No other shell command, subprocess, sleep command or code interpreter is allowed. Do not access or modify another directory.`
      : 'Use only the direct Read, Write and Edit file tools. Do not run a shell, terminal, subprocess, sleep command or code interpreter. Do not access or modify another directory.';
    child.evidence.gateReadPolicy = child.provider === 'codex-review' ? { tool: 'exec_command', exactCommand: gateReadCommand } : { tool: 'Read', exactPath: path.join(child.cwd, 'gate.json') };
    const activation = await ctx.subagents.startActivation({
      provider: child.provider, label: `RIFT parallel probe ${child.key}`, delivery: 'caller', signal: abort.signal,
      request: { parent: parent.agent, cwd: child.cwd, prompt: [{ type: 'text', text: [
        `This is a bounded isolated Provider lifecycle probe. Your exact cwd is ${child.cwd}.`,
        fileToolPolicy,
        `First write exactly ${child.ready} into ready.txt in this cwd. Never change gate.json or baseline.txt.`,
        `gate.json already exists. Read it using only the gate-reading tool permitted above, one read at a time, at most 20 reads total. The host will change release from false to true.`,
        `While release is false, stay in this same activation and read gate.json again. Do not finish, claim success or write done.txt before seeing release:true for probeId ${probeId} and child ${child.key}.`,
        `If 20 reads are exhausted without release, or the permitted tools are unavailable, return GATE_LIMIT or FILE_TOOLS_UNAVAILABLE and do not write done.txt.`,
        `After reading the matching release:true gate, write exactly ${child.done} into done.txt and return your absolute cwd and that exact DONE marker.`,
        `Only ready.txt and done.txt may be written. Do not delegate. Do not keep working after completion.`,
      ].join('\n') }] },
    });
    child.activation = activation; child.evidence.childId = activation.childId; child.evidence.acceptedAt = now();
    child.observation = activation.result.then(result => {
      child.result = result; child.evidence.endedAt = now(); child.evidence.stopReason = result.stopReason;
      child.evidence.output = result.output.filter(value => value.type === 'text').map(value => value.text).join('\n');
      child.evidence.diagnostic = result.diagnostic;
    }, error => { child.resultError = redact(String(error)); child.evidence.endedAt = now(); child.evidence.resultError = child.resultError; });
    if (abort.signal.aborted) await cleanup(child);
  });
  await bounded(Promise.all(admissions), 'three activation admissions');
  if (new Set(children.map(child => child.activation!.childId)).size !== 3) throw new Error('Child IDs are not distinct.');

  for (;;) {
    abort.signal.throwIfAborted();
    if (children.some(child => child.result || child.resultError)) throw new Error('A child terminated before the three ready markers and overlap were confirmed.');
    for (const child of children) {
      if (!child.evidence.readyAt && (await fileText(path.join(child.cwd, 'ready.txt'))).trim() === child.ready) child.evidence.readyAt = now();
    }
    if (children.every(child => child.evidence.readyAt)) break;
    await bounded(new Promise(resolve => setTimeout(resolve, 250)), 'ready markers');
  }
  // One host polling interval separates ready evidence from the cancellation.
  await bounded(new Promise(resolve => setTimeout(resolve, 250)), 'overlap observation');
  if (children.some(child => child.result || child.resultError)) throw new Error('A child ended before cancellation; simultaneous live overlap was not proven.');
  const overlapAt = now();
  report.overlap = { status: 'pass', confirmedAt: overlapAt, readyMarkers: 3, unsettledResults: 3, distinctWorktrees: 3, sameClaudeProvider: 'claude-code-dev' };

  const [a, b, codex] = children as [Child, Child, Child];
  a.evidence.cancelRequestedAt = now();
  await bounded(cleanup(a), 'Claude A selected disposal');
  await bounded(a.observation!, 'Claude A result after disposal');
  // The installed public SubagentStopReason union spells disposal as `aborted`.
  if (a.result?.stopReason !== 'aborted') throw new Error(`Claude A cancellation expected official stopReason aborted; received ${a.result?.stopReason ?? a.resultError ?? 'unknown'}.`);
  if ((await fileText(path.join(a.cwd, 'done.txt'))).trim()) throw new Error('Claude A wrote done.txt without gate release.');
  if (b.result || b.resultError || codex.result || codex.resultError) throw new Error('A sibling ended before its gate was released after Claude A cancellation.');
  report.selectedCancellation = { status: 'pass', child: a.key, stopReason: a.result.stopReason, siblingsStillUnsettledAt: now() };

  for (const child of [b, codex]) {
    const gate = path.join(child.cwd, 'gate.json');
    await writeFile(`${gate}.pending`, JSON.stringify({ probeId, child: child.key, release: true }));
    await rename(`${gate}.pending`, gate);
    child.evidence.gateReleasedAt = now();
  }
  await bounded(Promise.all([b.observation!, codex.observation!]), 'uncancelled sibling completion');
  for (const child of [b, codex]) {
    const done = (await fileText(path.join(child.cwd, 'done.txt'))).trim();
    child.evidence.doneVerified = done === child.done;
    if (child.result?.stopReason !== 'completed' || done !== child.done) throw new Error(`${child.key} failed sibling completion or its unique done marker.`);
  }
  if ((await git('rev-parse', 'HEAD')).stdout.trim() !== baseHead) throw new Error('Probe changed the user-managed baseline branch.');
  report.siblingCompletion = { status: 'pass', children: [b.key, codex.key], completedAt: now() };
} catch (error) { failure = true; report.error = redact(String(error)); }
finally {
  abort.abort();
  // Start every owned disposal before awaiting individual results, so one failed
  // cleanup cannot stop the remaining children from receiving disposal.
  const cleanups = children.map(child => cleanup(child).then(() => ({ ok: true as const }), error => ({ ok: false as const, error })));
  for (const [index, child] of children.entries()) {
    if (!child.activation) { child.evidence.cleanup = 'unknown'; child.evidence.cleanupReason = 'No accepted handle available to verify cleanup.'; continue; }
    try { const outcome = await bounded(cleanups[index]!, `${child.key} cleanup`); if (!outcome.ok) throw outcome.error; }
    catch (error) { failure = true; child.evidence.cleanup = 'unknown'; child.evidence.cleanupError = redact(String(error)); }
  }
  if (disposeParent) {
    try { await bounded(disposeParent(), 'parent cleanup'); report.parentCleanup = { status: 'pass', endedAt: now() }; }
    catch (error) { failure = true; report.parentCleanup = { status: 'fail', error: redact(String(error)) }; }
  } else report.parentCleanup = { status: 'unknown', reason: 'No parent handle was available for cleanup verification.' };
  if (host) {
    try { await bounded(host.shutdown.shutdown(failure ? 1 : 0), 'host unload'); report.hostUnload = { status: 'pass', endedAt: now() }; }
    catch (error) { failure = true; report.hostUnload = { status: 'fail', error: redact(String(error)) }; }
  } else report.hostUnload = { status: 'unknown', reason: 'No host handle was available for cleanup verification.' };
  clearTimeout(deadline);
  const lockRemains = await access(path.join(process.env.RIFT_HOME, 'rift.db.host.lock')).then(() => true, () => false);
  report.databaseLockReleased = !lockRemains;
  if (lockRemains) failure = true;
  report.status = failure ? 'fail' : 'pass'; report.endedAt = now(); report.elapsedMs = Date.now() - began;
  report.exitCode = failure ? 1 : 0; process.exitCode = failure ? 1 : 0;
  const safe = (value: unknown): unknown => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, safe(nested)])) : value;
  const serialized = JSON.stringify(safe(report), null, 2);
  await writeFile(path.join(root, 'report.json'), serialized, { flag: 'wx' });
  await writeFile(path.join(evidenceRoot, `${probeId}.json`), serialized, { flag: 'wx' });
  await writeFile(path.join(evidenceRoot, 'provider-parallel-probe.json'), serialized);
  console.log(serialized);
}
