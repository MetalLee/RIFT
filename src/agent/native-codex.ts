import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { RiftError } from '../contracts/index.js';
import { publicError, redact } from '../api/security.js';
import type { AgentRuntime, RuntimeHandle, RuntimeTurnInput, RuntimeTurnResult } from './runtime-types.js';
import { createRepositoryReadTools } from './repository-read.js';

/** Shared app-server wire. Discussion exposes only Host-owned tools; task mode
 * uses full-access native development tools; formal read-only modes stay restricted.
 * Persistent thread identity always comes from the Host ledger.
 */
export interface NativeCodexOptions {
  /** Task mode exposes native repository tools; discussion stays restricted. */
  mode?: 'discussion' | 'develop' | 'review' | 'analysis';
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
  env?: NodeJS.ProcessEnv;
  /** A trusted Host/test provider route, never accepted from model tool arguments. */
  modelProvider?: { id: string; config: Record<string, unknown> };
}

/** Models whose native tool surface passed the pinned-payload boundary probe. */
export const VERIFIED_NATIVE_CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-astra'] as const;
const VERIFIED_CATALOG_DIGEST = '93e84243a536862c2b5c7a3a8ae354faf06fe143500cf7f7f7b2af3bfe6e722f';
const executeFile=promisify(execFile);
const canonicalPath=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);

/** Resolve only Host-associated repositories and their actual Git metadata.
 * A linked task worktree may live elsewhere, but must share one of these exact
 * common Git directories. No parent directory is broadened into a writable root. */
export async function nativeRepositoryRoots(cwd:string,repositoryPaths:readonly string[],signal:AbortSignal):Promise<string[]> {
  if(!repositoryPaths.length||repositoryPaths.length>64)throw new RiftError('NATIVE_REPOSITORY_SCOPE','Select 1–64 registered repository roots.');
  const directory=async(value:string)=>{
    if(!path.isAbsolute(value))throw new RiftError('NATIVE_REPOSITORY_SCOPE','Repository permissions require absolute Host paths.');
    const actual=await realpath(value);
    if(canonicalPath(actual)===canonicalPath(path.parse(actual).root)||!(await stat(actual)).isDirectory())throw new RiftError('NATIVE_REPOSITORY_SCOPE','A filesystem root or non-directory is not a repository capability.');
    return actual;
  };
  const inspect=async(location:string)=>{
    signal.throwIfAborted();const actual=await directory(location);
    const git=async(flag:string)=>{const result=await executeFile('git',['-C',actual,'rev-parse','--path-format=absolute',flag],{signal,timeout:10000,maxBuffer:65536,windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});return directory(result.stdout.trim());};
    const [root,gitDir,commonDir]=await Promise.all([git('--show-toplevel'),git('--git-dir'),git('--git-common-dir')]);
    return{actual,root,gitDir,commonDir};
  };
  const repositories=[];
  for(const location of repositoryPaths){const repo=await inspect(location);if(canonicalPath(repo.root)!==canonicalPath(repo.actual))throw new RiftError('NATIVE_REPOSITORY_SCOPE','Repository capabilities must name registered Git roots, not broader directories or arbitrary subdirectories.');repositories.push(repo);}
  const current=await inspect(cwd);
  if(!repositories.some(repo=>canonicalPath(repo.commonDir)===canonicalPath(current.commonDir)))throw new RiftError('NATIVE_REPOSITORY_SCOPE','Execution cwd is not part of a registered workspace repository.');
  const roots=new Map<string,string>();
  for(const repo of [...repositories,current])for(const root of [repo.root,repo.gitDir,repo.commonDir])roots.set(canonicalPath(root),root);
  signal.throwIfAborted();return[...roots.values()].sort((a,b)=>canonicalPath(a).localeCompare(canonicalPath(b)));
}

function verifiedCatalogPath(): string {
  const location = fileURLToPath(new URL('../../profiles/rift-native-models.json', import.meta.url));
  const catalog: unknown = JSON.parse(readFileSync(location, 'utf8'));
  if (createHash('sha256').update(JSON.stringify(catalog)).digest('hex') !== VERIFIED_CATALOG_DIGEST) throw new RiftError('NATIVE_CONFIGURATION_UNVERIFIED', 'The native tool-isolation catalog changed. Re-run the boundary probe before enabling this runtime.');
  return location;
}

export function nativeCodexPackage(): { version: string; argv: string[] } {
  verifiedCatalogPath();
  const require = createRequire(import.meta.url);
  const providerManifest = require.resolve('@deepseek-ai/dsh-subagent-codex/package.json');
  const manifestPath = createRequire(providerManifest).resolve('@openai/codex/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; bin: { codex: string } };
  // The generated protocol and the model-facing tool boundary are verified for
  // this pinned payload. New payloads must pass the capability probe first.
  if (manifest.version !== '0.164.0') throw new RiftError('NATIVE_RUNTIME_UNVERIFIED', 'The installed native Codex payload has not passed the RIFT tool-boundary probe.');
  return { version: manifest.version, argv: [process.execPath, path.resolve(path.dirname(manifestPath), manifest.bin.codex), 'app-server', '--stdio'] };
}

export function nativeCodexRestrictions(mcpNames: string[] = []): Record<string, unknown> {
  if (mcpNames.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new RiftError('NATIVE_CONFIGURATION', 'An inherited MCP name cannot be safely disabled by this native runtime version.');
  const features = {
    shell_tool: false, unified_exec: false, multi_agent: false, multi_agent_v2: false,
    apps: false, plugins: false, remote_plugin: false, hooks: false, browser_use: false,
    computer_use: false, image_generation: false, view_image: false, code_mode: false,
    code_mode_host: false, goals: false, sleep_tool: false, skill_search: false,
    skip_host_skill_discovery: true, memories: false, request_permissions_tool: false,
  };
  return {
    web_search: 'disabled',
    ...Object.fromEntries(Object.entries(features).map(([name, enabled]) => [`features.${name}`, enabled])),
    ...Object.fromEntries(mcpNames.map(name => [`mcp_servers.${name}.enabled`, false])),
    project_doc_max_bytes: 0,
  };
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RiftError('NATIVE_PROTOCOL', 'Invalid native runtime response.');
  return value as Record<string, any>;
}

export class NativeCodexRuntime implements AgentRuntime {
  readonly persistentSessions = true;
  constructor(private readonly options: NativeCodexOptions) {}

  async start(input: RuntimeTurnInput): Promise<RuntimeHandle> {
    const discussion = !this.options.mode || this.options.mode === 'discussion';
    const formalReadOnly=this.options.mode==='review'||this.options.mode==='analysis';
    const repositoryWrite=!formalReadOnly&&!!input.repositoryAccess?.repositoryPaths.length;
    const restrictedDiscussion=discussion&&!repositoryWrite;
    const restrictedTools=true; // Native file/shell tools are never an authority boundary.
    input.signal.throwIfAborted();
    if (!path.isAbsolute(input.cwd) || !input.model.trim()) throw new RiftError('NATIVE_CONFIGURATION', 'An absolute staging directory and a model are required.');
    if (discussion && !(VERIFIED_NATIVE_CODEX_MODELS as readonly string[]).includes(input.model)) throw new RiftError('NATIVE_MODEL_UNVERIFIED', 'This native model has not passed RIFT tool-isolation verification. Select a verified model.');
    const writableRoots=repositoryWrite?await nativeRepositoryRoots(input.cwd,input.repositoryAccess!.repositoryPaths,input.signal):[];
    const shell=repositoryWrite?await (await import('./repository-shell.js')).createRepositoryShell({spawn:this.options.spawn} as import('@deepseek-ai/cordis').Context['subprocess'],input):undefined;
    const runtimeTools=[...input.tools,...formalReadOnly?createRepositoryReadTools(input.cwd):[],...shell?[{...shell.tool,name:'rift_exec_command'}]:[]];
    const tools = new Map(runtimeTools.map(tool => [tool.name, tool]));
    if (tools.size !== runtimeTools.length || runtimeTools.some(tool => !/^rift_[a-z0-9_]+$/.test(tool.name))) throw new RiftError('NATIVE_TOOL_SCOPE', 'Native turns accept only unique RIFT tool names.');
    const controller = new AbortController();
    // A Host launched inside Codex must not let the child attach to the
    // desktop app's tool pipe or inherit its task/session authority.
    const env: NodeJS.ProcessEnv = { ...this.options.env };
    if (input.session) env.CODEX_HOME = input.session.runtimeHome;
    for (const name of new Set([...Object.keys(process.env),...Object.keys(env)])) if (name.startsWith('CODEX_') && name !== 'CODEX_HOME') env[name] = undefined;
    const catalogPath = verifiedCatalogPath();
    // Native task tools are retained, but nested delegation and inherited app
    // connections remain disabled. All accepted writes still pass RIFT gates.
    const restrictions = nativeCodexRestrictions();
    const processOverrides = Object.entries({ ...restrictions, ...(restrictedTools ? {model_catalog_json: catalogPath} : {}) }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    const child = this.options.spawn({
      argv: [...nativeCodexPackage().argv, ...processOverrides], cwd: input.cwd, env,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } }, graceMs: 3000,
    });
    if (!child.stdout || !child.stdin) {
      child.terminate();
      if (!await child.waitForExit(AbortSignal.timeout(10000))) throw new RiftError('CLEANUP_UNKNOWN', 'Native runtime startup cleanup could not be confirmed.');
      throw new RiftError('NATIVE_START_FAILED', 'Native runtime did not expose its protocol streams.');
    }
    const wire = new JsonRpcLineTransport(child.stdout, child.stdin);
    let resolveCompletion!: (value: RuntimeTurnResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = { promise: new Promise<RuntimeTurnResult>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; }), resolve: (value: RuntimeTurnResult) => resolveCompletion(value), reject: (error: unknown) => rejectCompletion(error) };
    completion.promise.catch(() => {});
    let threadId: string | undefined;
    let turnId: string | undefined;
    let startingTurn = false;
    let terminal = false;
    let closed = false;
    let partial = '';
    let final = '';
    let disposePromise: Promise<void> | undefined;
    const early: { method: string; params: unknown }[] = [];
    const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
    const fail = (error: unknown) => { if (!terminal) { terminal = true; try { input.session?.onSettled('unknown'); } finally { completion.reject(error); } } };
    const processFailure = child.done.then(() => {
      if (!closed && !terminal) fail(new RiftError('NATIVE_PROCESS_EXITED', 'Native runtime exited before confirming the turn outcome.'));
    }, () => { if (!closed) fail(new RiftError('NATIVE_PROCESS_FAILED', 'Native runtime process failed.')); });
    void processFailure;
    const checkScope = (params: Record<string, any>) => {
      if (!threadId || params.threadId !== threadId || !turnId || params.turnId !== turnId) throw new RiftError('NATIVE_SCOPE_MISMATCH', 'Native request does not belong to this server-bound turn.');
    };
    const notify = (method: string, raw: unknown) => {
      if (closed || terminal) return;
      try {
        const params = record(raw);
        if (!['item/agentMessage/delta', 'item/completed', 'turn/completed'].includes(method)) return;
        if (startingTurn && !turnId) { if (early.length >= 512) throw new RiftError('NATIVE_PROTOCOL_LIMIT', 'Native startup event buffer exceeded its limit.'); early.push({ method, params }); return; }
        // Notifications for unrelated threads cannot affect this turn.
        if (params.threadId !== threadId) return;
        const eventTurn = method === 'turn/completed' ? record(params.turn).id : params.turnId;
        if (eventTurn !== turnId) throw new RiftError('NATIVE_SCOPE_MISMATCH', 'Native event referenced another turn.');
        if (method === 'item/agentMessage/delta') {
          if (typeof params.delta !== 'string') throw new RiftError('NATIVE_PROTOCOL', 'Invalid native text delta.');
          if (partial.length + params.delta.length > 4 * 1024 * 1024) throw new RiftError('NATIVE_OUTPUT_LIMIT', 'Native output exceeded the turn limit.');
          partial += params.delta;
          input.onText?.(params.delta);
        }
        if (method === 'item/completed' && params.item?.type === 'agentMessage') {
          if (typeof params.item.text !== 'string') throw new RiftError('NATIVE_PROTOCOL', 'Invalid native final message.');
          if (params.item.phase === 'final_answer' || params.item.phase == null) final = params.item.text;
        }
        if (method === 'turn/completed') {
          const status = record(params.turn).status;
          if (!['completed', 'interrupted', 'failed'].includes(status)) throw new RiftError('NATIVE_PROTOCOL', 'Invalid native terminal state.');
          input.session?.onSettled(status);
          if (status === 'failed') { terminal = true; completion.reject(new RiftError('NATIVE_TURN_FAILED', redact(typeof params.turn.error?.message === 'string' ? params.turn.error.message : 'Native model turn failed without a diagnostic.'))); return; }
          terminal = true;
          completion.resolve({ text: final || partial, stopReason: status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed', nativeSessionId: threadId });
        }
      } catch (error) { fail(error); }
    };
    wire.onNotification(notify);
    wire.onRequest(async (method, raw) => {
      const params = record(raw);
      // Reject approvals, permission grants, elicitation and all unrecognized
      // requests. RIFT never grants native tools an extra execution authority.
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
      if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
      if (method !== 'item/tool/call') throw new RiftError('NATIVE_REQUEST_DENIED', 'This native request is not part of the RIFT tool gateway.');
      // A tool request arriving before the accepted turn/start reply has no
      // authoritative turn identity yet and must not execute.
      try {
        checkScope(params);
        if (terminal || closed || controller.signal.aborted || input.signal.aborted) throw new RiftError('TURN_STOPPED', 'This turn no longer accepts tools.');
        if (params.namespace != null || typeof params.tool !== 'string' || typeof params.callId !== 'string') throw new RiftError('NATIVE_TOOL_SCOPE', 'Invalid RIFT tool request.');
        const tool = tools.get(params.tool);
        if (!tool) throw new RiftError('NATIVE_TOOL_SCOPE', 'Tool is not in this turn scope.');
        const fingerprint = JSON.stringify([params.tool, params.arguments]);
        const prior = calls.get(params.callId);
        if (prior && prior.fingerprint !== fingerprint) throw new RiftError('IDEMPOTENCY_CONFLICT', 'Native call identity was reused for another operation.');
        if (!prior && calls.size >= 128) throw new RiftError('NATIVE_TOOL_LIMIT', 'Native turn reached its tool-call limit.');
        const result = prior?.result ?? Promise.resolve().then(() => tool.execute(params.arguments, controller.signal, { callId: String(params.callId) }));
        if (!prior) calls.set(params.callId, { fingerprint, result });
        const value = await result;
        return { contentItems: [{ type: 'inputText', text: redact(JSON.stringify(value ?? null), 256 * 1024) }], success: true };
      } catch (error) {
        return { contentItems: [{ type: 'inputText', text: JSON.stringify({ error: publicError(error) }) }], success: false };
      }
    });
    const cancel = () => {
      controller.abort(input.signal.reason);
      if (threadId && turnId && !closed) void wire.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      fail(new RiftError('TURN_CANCELLED', 'Native reply was stopped.'));
    };
    input.signal.addEventListener('abort', cancel, { once: true });
    const dispose = () => disposePromise ??= (async () => {
      if (!terminal) fail(new RiftError('TURN_CANCELLED','Native execution was disposed before completion.'));
      closed = true;
      controller.abort();
      input.signal.removeEventListener('abort', cancel);
      wire.close();
      try { child.stdin?.end(); } catch { /* The process may have exited. */ }
      child.terminate();
      const cleaned = await child.waitForExit(AbortSignal.timeout(10000));
      if (!cleaned) throw new RiftError('CLEANUP_UNKNOWN', 'Native runtime process cleanup could not be confirmed.');
      await child.done.catch(() => {});
      // Tool closures also belong to this lease; stopping the process alone
      // cannot release a turn while a Host operation is still in flight.
      await shell?.dispose();
      await Promise.allSettled([...calls.values()].map(call => call.result));
    })();
    const request = async (method: string, params: object) => {
      input.signal.throwIfAborted();
      return Promise.race([wire.request(method, params, input.signal), completion.promise.then(() => { throw new RiftError('NATIVE_PROTOCOL', 'Turn ended during startup.'); })]);
    };
    try {
      wire.start();
      await request('initialize', { clientInfo: { name: 'rift', title: 'RIFT', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      wire.notify('initialized');
      const loaded = record(await request('config/read', { includeLayers: false }));
      const mcpNames = Object.keys(loaded.config?.mcp_servers ?? {});
      const config: Record<string, unknown> = restrictedTools ? nativeCodexRestrictions(mcpNames) : { ...restrictions, ...Object.fromEntries(mcpNames.map(name => [`mcp_servers.${name}.enabled`, false])) };
      if (this.options.modelProvider) config.model_providers = { [this.options.modelProvider.id]: this.options.modelProvider.config };
      const resuming = Boolean(input.session?.threadId);
      const sandbox = 'read-only';
      const started = record(await request(resuming ? 'thread/resume' : 'thread/start', {
        cwd: input.cwd, model: input.model, ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider.id } : {}),
        ...(resuming ? { threadId: input.session!.threadId, excludeTurns: true } : { ephemeral: !input.session }),
        ...(restrictedTools?{environments: [],runtimeWorkspaceRoots: []}:repositoryWrite?{runtimeWorkspaceRoots:writableRoots}:{}),
        approvalPolicy: 'never', sandbox, config,
        ...(restrictedTools ? {baseInstructions: 'You are a RIFT workspace agent. Use only the provided RIFT tools. For repository commands use rift_exec_command when available; its Host-enforced sandbox fixes the filesystem and network boundary. Never delegate outside RIFT or claim acceptance from prose.'} : repositoryWrite?{baseInstructions:'You are a RIFT workspace agent. Native shell and file tools may operate on the Host-associated workspace repositories, including Git commits and authorized remote Git/PR operations. Stay within these repository capabilities. Use RIFT for task ownership and coordination; commits and PRs do not replace required checks, independent review, or workflow acceptance. Do not delegate outside RIFT.'}:{}),
        developerInstructions: `${input.instructions}${formalReadOnly?'\nFormal read-only execution: use rift_list_files and rift_read_file for this assigned checkout. They cannot execute commands, write files or Git metadata, or reach network services. Host check evidence supplies executed test results; do not invent tests you could not run.':''}`,
        // 0.164.0 restores dynamic tool declarations from its rollout on resume.
        // The Host binds fresh closures to this turn below; schemas are part of
        // the session configuration identity, so changed tools use a new thread.
        ...(!resuming ? {dynamicTools: runtimeTools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))} : {}),
      }));
      threadId = record(started.thread).id;
      if (typeof threadId !== 'string' || record(started.thread).ephemeral !== !input.session || started.approvalPolicy !== 'never' || started.sandbox?.type !== 'readOnly') throw new RiftError('NATIVE_RESTRICTIONS_UNCONFIRMED', `Native runtime did not confirm the required thread restrictions (expected ${sandbox}; received ${String(started.sandbox?.type)}, approval ${String(started.approvalPolicy)}, ephemeral ${String(record(started.thread).ephemeral)}).`);
      if(sandbox==='read-only'&&started.sandbox?.networkAccess!==false)throw new RiftError('NATIVE_RESTRICTIONS_UNCONFIRMED','Native read-only execution must also confirm network access is disabled.');
      if (input.session?.threadId && threadId !== input.session.threadId) throw new RiftError('NATIVE_SCOPE_MISMATCH', 'Native runtime resumed another thread.');
      if ((input.session||repositoryWrite) && (typeof started.cwd !== 'string' || canonicalPath(started.cwd) !== canonicalPath(input.cwd))) throw new RiftError('NATIVE_SCOPE_MISMATCH','Native runtime did not confirm the current working directory.');
      if (record(started.thread).status?.type === 'active') throw new RiftError('NATIVE_SESSION_BUSY', 'The saved native thread still has active work; reconcile before continuing.');
      input.session?.onThread(threadId);
      const prompt = input.messages.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`).join('\n\n');
      startingTurn = true;
      const turn = record(record(await request('turn/start', { threadId, cwd: input.cwd, clientUserMessageId: input.turnId, input: [{ type: 'text', text: prompt, text_elements: [] }], sandboxPolicy:{type:'readOnly',networkAccess:false}, ...(restrictedTools?{environments: []}:{}), ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}) })).turn);
      if (typeof turn.id !== 'string') throw new RiftError('NATIVE_PROTOCOL', 'Missing native turn identity.');
      turnId = turn.id;
      input.session?.onTurn(turnId);
      startingTurn = false;
      for (const event of early) notify(event.method, event.params);
      if (input.signal.aborted) cancel();
      return { result: completion.promise, dispose };
    } catch (error) {
      try { await dispose(); } catch { throw new RiftError('CLEANUP_UNKNOWN', 'Native startup failed and cleanup could not be confirmed.'); }
      throw new RiftError(error instanceof RiftError ? error.code : 'NATIVE_START_FAILED', publicError(error).message, {cleanupConfirmed:true});
    }
  }
}
