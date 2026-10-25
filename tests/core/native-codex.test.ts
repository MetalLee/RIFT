import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime } from '../../src/agent/native-codex.js';
import type { RuntimeHandle, RuntimeTurnInput } from '../../src/agent/runtime-types.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.allSettled(disposers.splice(0).map(dispose => dispose())); });
function harness(options: { sandbox?: string; cleanup?: boolean; resumeId?:string; resumeActive?:boolean; resumeMissing?:boolean } = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const peer = new JsonRpcLineTransport(stdin, stdout);
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let terminateCount = 0, spawnSpec: SubprocessSpawnSpec | undefined;
  let exit!: (value: { exitCode: number; signal: null }) => void;
  const done = new Promise<{ exitCode: number; signal: null }>(resolve => { exit = resolve; });
  const child: SubprocessHandle = {
    stdin, stdout, stderr: undefined, control: undefined, collected: {}, done,
    terminate() { terminateCount++; exit({ exitCode: 0, signal: null }); },
    async waitForExit() { return options.cleanup !== false; },
  };
  peer.onRequest(async (method, params) => {
    requests.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { mcp_servers: { legacy: { command: 'never-start' } } } };
    if (method === 'thread/start') return { cwd:params.cwd,thread: { id: 'native-thread', ephemeral: params.ephemeral }, approvalPolicy: 'never', sandbox: { type: options.sandbox ?? 'readOnly' } };
    if (method === 'thread/resume') {
      if (options.resumeMissing) throw new Error('Thread missing');
      return { cwd:params.cwd,thread: { id:options.resumeId??'native-thread',ephemeral:false,status:{type:options.resumeActive?'active':'idle'} },approvalPolicy:'never',sandbox:{type:options.sandbox??'readOnly'} };
    }
    if (method === 'turn/start') return { turn: { id: 'native-turn', status: 'inProgress' } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method ${method}`);
  });
  peer.start();
  const runtime = new NativeCodexRuntime({ spawn(spec) { spawnSpec = spec; return child; } });
  const controller = new AbortController();
  const calls: unknown[] = [];
  const input: RuntimeTurnInput = {
    workspaceId: 'one', agentId: 'lead-one', turnId: 'turn-one', cwd: process.cwd(), model: 'gpt-6.1-sol',
    instructions: 'Use scoped tools.', messages: [{ role: 'user', content: 'Inspect status.' }], signal: controller.signal,
    tools: [{ name: 'rift_status', description: 'Status', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(args) { calls.push(args); return { workspaceId: 'one' }; } }],
  };
  const toolCall = (overrides: Record<string, unknown> = {}) => peer.request('item/tool/call', { threadId: 'native-thread', turnId: 'native-turn', callId: 'call-one', namespace: null, tool: 'rift_status', arguments: {}, ...overrides }) as Promise<{ success: boolean; contentItems: { text: string }[] }>;
  const complete = () => {
    peer.notify('item/completed', { threadId: 'native-thread', turnId: 'native-turn', item: { type: 'agentMessage', text: 'Verified', phase: 'final_answer' } });
    peer.notify('turn/completed', { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } });
  };
  return { runtime, input, calls, peer, toolCall, complete, requests, controller, get terminateCount() { return terminateCount; }, get spawnSpec() { return spawnSpec; }, async start() { const handle = await runtime.start(input); disposers.push(handle.dispose); return handle; } };
}

describe('native Codex Host-owned tool gateway', () => {
  it('persists the thread before accepting a turn and resumes with fresh tool closures', async () => {
    const recorded:string[]=[];
    const h=harness();
    h.input.session={runtimeHome:process.cwd(),onThread:id=>recorded.push(`thread:${id}`),onTurn:id=>recorded.push(`turn:${id}`),onSettled:status=>recorded.push(status)};
    const first=await h.start();
    expect(recorded).toEqual(['thread:native-thread','turn:native-turn']);
    expect(h.spawnSpec!.env!.CODEX_HOME).toBe(process.cwd());
    h.complete();await first.result;await first.dispose();
    const next=harness();next.input.session={...h.input.session,threadId:'native-thread'};
    await next.start();
    expect(next.requests.some(r=>r.method==='thread/start')).toBe(false);
    expect(next.requests.find(r=>r.method==='thread/resume')!.params).toMatchObject({threadId:'native-thread',cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only'});
    expect(next.requests.find(r=>r.method==='thread/resume')!.params).not.toHaveProperty('dynamicTools');
    expect((await next.toolCall()).success).toBe(true);
    expect(next.calls).toHaveLength(1);expect(h.calls).toHaveLength(0);
  });

  it.each([{resumeMissing:true},{resumeId:'foreign'},{resumeActive:true}])('never silently replaces an unavailable or mismatched persisted thread: %j',async options=>{
    const h=harness(options);
    h.input.session={threadId:'native-thread',runtimeHome:process.cwd(),onThread(){},onTurn(){},onSettled(){}};
    await expect(h.start()).rejects.toThrow();
    expect(h.requests.some(r=>r.method==='turn/start'||r.method==='thread/start')).toBe(false);
    expect(h.terminateCount).toBe(1);
  });
  it('binds tools to the authoritative thread and turn and rejects inherited authority', async () => {
    const h = harness(); const handle = await h.start();
    for (const mismatch of [{ threadId: 'other-workspace' }, { turnId: 'other-turn' }, { namespace: 'functions' }, { tool: 'exec_command' }]) expect((await h.toolCall(mismatch)).success).toBe(false);
    expect(h.calls).toEqual([]);
    expect((await h.toolCall()).success).toBe(true);
    expect(h.calls).toEqual([{}]);
    const started = h.requests.find(request => request.method === 'thread/start')!.params;
    expect(started.environments).toEqual([]);
    expect((started.config as Record<string, unknown>)['mcp_servers.legacy.enabled']).toBe(false);
    expect(h.spawnSpec!.argv).toContain('features.shell_tool=false');
    h.complete(); await expect(handle.result).resolves.toMatchObject({ text: 'Verified', stopReason: 'completed' });
  });

  it('does not repeat tool side effects on call replay or allow call identity mutation', async () => {
    const h = harness(); await h.start();
    const [first, duplicate] = await Promise.all([h.toolCall(), h.toolCall()]);
    expect(first.success && duplicate.success).toBe(true); expect(h.calls).toHaveLength(1);
    expect((await h.toolCall({ arguments: { different: true } })).success).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it('revokes tools on stop and confirms managed-range cleanup separately', async () => {
    const h = harness(); const handle = await h.start();
    h.controller.abort();
    await expect(handle.result).rejects.toMatchObject({ code: 'TURN_CANCELLED' });
    expect((await h.toolCall()).success).toBe(false);
    await handle.dispose();
    expect(h.terminateCount).toBe(1); expect(h.calls).toHaveLength(0);
  });

  it('does not publish a runtime with unconfirmed restrictions or cleanup', async () => {
    const bad = harness({ sandbox: 'dangerFullAccess' });
    await expect(bad.start()).rejects.toMatchObject({ code: 'NATIVE_RESTRICTIONS_UNCONFIRMED' });
    expect(bad.terminateCount).toBe(1);
    const h = harness({ cleanup: false }); const handle = await h.start();
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'CLEANUP_UNKNOWN' });
  });

  it('fails before spawning when a model has not passed native tool isolation', async () => {
    const h = harness(); h.input.model = 'gpt-6-astra';
    await expect(h.start()).rejects.toMatchObject({ code: 'NATIVE_MODEL_UNVERIFIED' });
    expect(h.spawnSpec).toBeUndefined();
  });

  it('keeps cleanup pending until Host tool operations are also quiescent', async () => {
    const h = harness(); let finish!: () => void;
    h.input.tools[0]!.execute = () => new Promise(resolve => { finish = () => resolve({ done: true }); });
    const handle = await h.start();
    const call = h.toolCall(); void call.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    let released = false; const disposal = handle.dispose().then(() => { released = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(released).toBe(false);
    finish(); await disposal; expect(released).toBe(true);
  });
});
