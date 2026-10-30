// Declare Loader events even when this module is compiled without the Host entry.
import type {} from '@deepseek-ai/dsh-app-boot';
import type { ApiConnection, ConnectionVerification } from '@rift/protocol';
export type { ApiConnection, ConnectionVerification } from '@rift/protocol';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef as asCredentialRef } from '@deepseek-ai/dsh-credentials';
import { z } from 'zod';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { id, now, type RiftStore } from '../storage/database.js';
import { invariant, RiftError } from '../contracts/index.js';
import { publicError, redact, registerCredentialRedaction } from '../api/security.js';
import { DshChatRuntime } from '../chat/dsh-runtime.js';
import { normalizeApiEndpoint } from './api-endpoint.js';
import { assertConnectionUnused, cleanupConnectionCredential, type ConnectionDeletionRecord } from './connection-deletion.js';

// RIFT deployment policy: advertise a 1M context budget for saved API routes.
// This is independent of the output budget; upstream capacity/errors still
// apply. Native provider catalogs are not rewritten by this API-route policy.
export function connectionContextWindow(_model: string): number {
  return 1_000_000;
}

export const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  endpoint: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }, 'Use HTTPS or a loopback HTTP model endpoint, without credentials, query or fragment.'),
  model: z.string().trim().min(1).max(160),
  credentialRef: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, 'Use a Host credential reference, not a key value.').optional(),
  apiKey: z.string().trim().min(1).max(16384).optional(),
  parentId: z.string().min(1).max(160).optional(),
}).strict().refine(input => Number(input.apiKey !== undefined) + Number(input.credentialRef !== undefined) === 1, 'Supply either an API key or an existing credential reference.').transform(input=>({...input,endpoint:normalizeApiEndpoint(input.endpoint,input.protocol)}));

/** Call at the HTTP boundary before validation/idempotency diagnostics as well
 * as here: submitted secrets must never appear in downstream error messages. */
export function registerConnectionCredential(raw: unknown): void {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string,unknown>).apiKey === 'string') {
    const value = (raw as {apiKey:string}).apiKey;
    registerCredentialRedaction('RIFT_SUBMITTED_API_KEY', value);
    registerCredentialRedaction('RIFT_SUBMITTED_API_KEY', value.trim());
  }
}
/** Host-only storage record; never return this from a business command. */
interface ApiConnectionRecord extends ApiConnection { credentialRef: string }

/** Allowlist shared by live records and historical receipts; never refresh replay state. */
export function publicApiConnection(row: ApiConnection): ApiConnection {
  return {
    id: row.id, name: row.name, protocol: row.protocol, endpoint: row.endpoint, model: row.model,
    provider: row.provider, revision: row.revision, parentId: row.parentId, createdAt: row.createdAt,
    verifiedAt: row.verifiedAt, verificationStatus: row.verificationStatus,
    verificationError: row.verificationError, available: row.available,
    verification: row.verification ? {
      method: row.verification.method, conversation: row.verification.conversation,
      toolCalls: row.verification.toolCalls, reply: row.verification.reply,
      stopReason: row.verification.stopReason, cleanupConfirmed: row.verification.cleanupConfirmed,
      error: row.verification.error,
    } : null,
  };
}

/** Saved API routes are immutable. Editing creates another provider identity so
 * an already queued Turn/Run can never silently adopt a different endpoint.
 * Protocol conversion/auth/tool calls stay in the official DSH pi-ai adapter.
 */
export class ApiConnectionService {
  private fiber?: Fiber;
  private serial: Promise<unknown> = Promise.resolve();
  private verifying = false;
  private verifyController?: AbortController;
  private cleanupUnknown = false;
  private profileSnapshot = piAi.Config({ providers: {} }).providers.get();
  private closed = false;
  private unavailable: string | null = null;
  constructor(private readonly ctx: Context, private readonly store: RiftStore, private readonly home: string) {}
  private records(): ApiConnectionRecord[] {
    return this.store.all<ApiConnectionRecord>('SELECT id,name,protocol,endpoint,model,credential_ref,provider,revision,parent_id,created_at,verified_at,verification_status,verification_error FROM api_connections WHERE deleted_at IS NULL ORDER BY created_at,id').map(row => ({ ...row, verification:this.store.get<{result:ConnectionVerification}>('SELECT result FROM api_connection_verifications WHERE connection_id=? ORDER BY rowid DESC LIMIT 1',row.id)?.result??null, endpoint:normalizeApiEndpoint(row.endpoint,row.protocol), available: Boolean(this.ctx.llm?.listProviders().some(provider => provider.id === row.provider)) }));
  }
  list(): ApiConnection[] {
    return this.records().map(publicApiConnection);
  }
  get(connectionId: string): ApiConnection {
    const connection = this.list().find(item => item.id === connectionId);
    invariant(connection, 'NOT_FOUND', 'API connection does not exist.'); return connection;
  }
  private profiles(connections = this.records()): Record<string, PiAiProviderProfile> {
    return Object.fromEntries(connections.map(connection => [connection.provider, {
      displayName: connection.name, api: connection.protocol, baseURL: normalizeApiEndpoint(connection.endpoint,connection.protocol), apiKeyEnv: connection.credentialRef,
      models: [{ id: connection.model, input: ['text', 'image'], contextWindow: connectionContextWindow(connection.model), maxTokens: 128_000 }],
      // Keep transport failure explicit (no replay); use the adapter's maintained
      // idle policy instead of imposing a shorter 60s RIFT-specific deadline.
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    }]));
  }
  private async protectCredentials(connections: ApiConnectionRecord[]): Promise<void> {
    const credentials = this.ctx.get?.('credentials') as { resolve(reference: string): Promise<{ value: string } | undefined> } | undefined;
    for (const connection of connections) {
      registerCredentialRedaction(connection.credentialRef, process.env[connection.credentialRef]);
      try { registerCredentialRedaction(connection.credentialRef, (await credentials?.resolve(connection.credentialRef))?.value); } catch { /* Missing credentials are diagnosed by explicit verification. */ }
    }
  }
  private async mount(profiles: Record<string, PiAiProviderProfile>): Promise<void> {
    this.profileSnapshot = piAi.Config({ providers: profiles }).providers.get();
    this.fiber = await this.ctx.plugin({ name: 'rift-api-connections', inject: piAi.inject, apply: scope => piAi.apply(scope, { providers: { get: () => this.profileSnapshot } }) });
  }
  private replaceProfiles(profiles: Record<string, PiAiProviderProfile>): void {
    // Official volatile-config notification replaces provider registrations
    // atomically. No adapter is unloaded and existing route snapshots survive.
    this.profileSnapshot = piAi.Config({ providers: profiles }).providers.get();
    this.fiber!.ctx.emit('loader/volatile-update', [['providers']]);
  }
  async initialize(): Promise<void> {
    for(const deleted of this.store.all<ConnectionDeletionRecord>('SELECT * FROM api_connections WHERE deleted_at IS NOT NULL AND credential_deleted_at IS NULL')) {
      // A failed cleanup remains a durable pending fact. It never restores the
      // route, and DELETE with a fresh idempotency key can retry it explicitly.
      await cleanupConnectionCredential(this.ctx,this.store,deleted).catch(()=>undefined);
    }
    if (!this.ctx.llm || typeof this.ctx.plugin !== 'function') { this.unavailable = 'This Host does not mount the DSH model service.'; return; }
    if (this.list().length === 0) return;
    await this.protectCredentials(this.records());
    try { await this.mount(this.profiles()); }
    catch (error) { this.unavailable = publicError(error).message; }
  }
  configurationCapability(): { available: boolean; reason: string | null } { return { available: !this.closed && !this.unavailable && !this.cleanupUnknown && Boolean(this.ctx.llm) && typeof this.ctx.plugin === 'function', reason: this.cleanupUnknown ? 'Previous verification cleanup has not been confirmed.' : this.unavailable }; }
  create(raw: unknown): Promise<ApiConnection> {
    registerConnectionCredential(raw);
    const input = createConnectionSchema.parse(raw);
    const operation = this.serial.then(async () => {
      invariant(this.configurationCapability().available, 'API_CONFIGURATION_UNAVAILABLE', this.unavailable ?? 'API configuration is not mounted.');
      invariant(!this.verifying, 'CONFIG_IN_USE', 'Wait for connection verification to finish.');
      const parent = input.parentId ? this.get(input.parentId) : undefined;
      const connectionId = id('connection');
      const credentialRef = input.apiKey === undefined ? input.credentialRef! : `RIFT_API_${connectionId.replace(/^connection-/,'').replaceAll('-','').toUpperCase()}`;
      // Explicit projection is intentional: plaintext apiKey never enters a
      // connection DTO, profile, business database, or process environment.
      const row: ApiConnectionRecord = { name: input.name, protocol: input.protocol, endpoint: input.endpoint, model: input.model, credentialRef, id: connectionId, parentId: parent?.id ?? null, provider: `rift-api-${connectionId}`, revision: parent ? parent.revision + 1 : 1, createdAt: now(), verifiedAt: null, verificationStatus: 'not-verified', verificationError: null, available: false };
      const previous = this.profiles();
      const credentials = this.ctx.get?.('credentials') as Context['credentials'] | undefined;
      let stored = false;
      try {
        if (input.apiKey !== undefined) {
          invariant(credentials && typeof credentials.set === 'function' && typeof credentials.unset === 'function', 'CREDENTIAL_STORE_UNAVAILABLE', 'This Host does not mount a writable credential store.');
          await credentials.set(asCredentialRef(credentialRef), input.apiKey);
          stored = true;
        }
        await this.protectCredentials([row]);
        if (this.fiber) this.replaceProfiles(this.profiles([...this.records(), row]));
        else await this.mount(this.profiles([...this.records(), row]));
        invariant(!this.closed, 'HOST_CLOSING', 'Host closed while preparing the connection.');
        invariant(this.ctx.llm.listProviders().some(item => item.id === row.provider), 'API_CONFIGURATION_UNAVAILABLE', 'The DSH adapter did not register this API route.');
        this.store.exec('INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,parent_id,created_at,credential_owned) VALUES(?,?,?,?,?,?,?,?,?,?,?)', row.id, row.name, row.protocol, row.endpoint, row.model, row.credentialRef, row.provider, row.revision, row.parentId, row.createdAt,Number(input.apiKey!==undefined));
      } catch (error) {
        try { if (this.fiber) this.replaceProfiles(previous); }
        finally {
          // This generated reference belongs exclusively to this failed
          // immutable connection. Never unset an existing user reference.
          if (stored) await credentials!.unset(asCredentialRef(credentialRef));
        }
        throw error;
      }
      return this.get(row.id);
    });
    this.serial = operation.catch(() => undefined); return operation;
  }
  remove(connectionId:string):Promise<{id:string;deleted:true}> {
    const operation=this.serial.then(async()=>{
      invariant(!this.closed,'HOST_CLOSING','Host is closing.');
      invariant(!this.verifying&&!this.cleanupUnknown,'CONNECTION_IN_USE','Connection verification has not confirmed cleanup.');
      let connection=this.store.get<ConnectionDeletionRecord>('SELECT * FROM api_connections WHERE id=?',connectionId);
      invariant(connection,'NOT_FOUND','API connection does not exist.');
      if(!connection.deletedAt){
        const previous=this.profiles();
        try{
          this.store.transaction(()=>{
            assertConnectionUnused(this.store,connection!);
            this.store.exec('UPDATE api_connections SET deleted_at=? WHERE id=? AND deleted_at IS NULL',now(),connectionId);
            if(this.fiber)this.replaceProfiles(this.profiles());
            invariant(!this.ctx.llm?.listProviders().some(item=>item.id===connection!.provider),'CONNECTION_DELETE_FAILED','The API provider could not be withdrawn.');
          });
        }catch(error){if(this.fiber)this.replaceProfiles(previous);throw error;}
        connection=this.store.get<ConnectionDeletionRecord>('SELECT * FROM api_connections WHERE id=?',connectionId)!;
      }
      await cleanupConnectionCredential(this.ctx,this.store,connection);
      return{id:connectionId,deleted:true as const};
    });
    this.serial=operation.catch(()=>undefined);return operation;
  }
  verify(connectionId: string): Promise<{ connection: ApiConnection; passed: boolean; error?: string }> {
    const operation = this.serial.then(() => this.performVerification(connectionId));
    this.serial = operation.catch(() => undefined); return operation;
  }
  private async performVerification(connectionId: string): Promise<{ connection: ApiConnection; passed: boolean; error?: string }> {
    invariant(!this.closed && !this.verifying, 'CONFIG_IN_USE', 'A connection verification is already running.');
    invariant(!this.cleanupUnknown, 'CLEANUP_UNKNOWN', 'The previous verification runtime has not confirmed cleanup.');
    const connection = this.get(connectionId); invariant(connection.available, 'PROVIDER_UNAVAILABLE', 'The saved API route is not available.');
    this.verifying = true;
    const controller = this.verifyController = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const evidence:ConnectionVerification={method:'conversation-and-tool',conversation:false,toolCalls:0,reply:'',stopReason:null,cleanupConfirmed:false,error:null};
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new RiftError('API_VERIFICATION_CANCELLED', 'Connection verification was stopped or timed out.')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    void aborted.catch(() => undefined);
    let handle: Awaited<ReturnType<DshChatRuntime['start']>> | undefined, error: string | undefined, startAttempted = false, lateCleanupConfirmed = false;
    try {
      const cwd = path.resolve(this.home, 'connection-verification', connection.id); await mkdir(cwd, { recursive: true });
      startAttempted = true;
      const starting = new DshChatRuntime(this.ctx, connection.provider).start({ workspaceId: 'connection-verification', agentId: 'connection-verification', turnId: id('verify'), cwd, model: connection.model,
        instructions:'你是一位助手。请使用提供的只读工具获取示例订单，再自然地回答用户。工具只返回虚构数据，不访问文件、网络或真实订单。',
        messages:[{role:'user',content:'你好，请查询示例订单，告诉我有哪些商品，以及合计多少钱。'}],
        tools:[{name:'rift_sample_order',description:'读取一份虚构的示例订单，仅用于确认对话和工具调用是否正常，无外部访问或副作用。',inputSchema:{type:'object',properties:{},additionalProperties:false},execute:async(args,signal)=>{
          signal.throwIfAborted();controller.signal.throwIfAborted();z.object({}).strict().parse(args);
          evidence.toolCalls++;return{currency:'CNY',items:[{name:'笔记本',quantity:2,unitPrice:12},{name:'铅笔',quantity:3,unitPrice:2}],total:30};
        }}],signal:controller.signal });
      void starting.then(late => { if (controller.signal.aborted && !handle) { void late.result.catch(() => undefined); void late.dispose().then(() => { lateCleanupConfirmed = true; if (!this.closed) this.cleanupUnknown = false; }, () => undefined); } }, () => undefined);
      handle = await Promise.race([starting, aborted]);
      const result = await Promise.race([handle.result, aborted]);
      evidence.stopReason=result.stopReason;evidence.reply=redact(result.finalText??'',4096);
      evidence.conversation=result.stopReason==='completed'&&Boolean(evidence.reply.trim());
      if(result.stopReason!=='completed')throw new RiftError('API_VERIFICATION_FAILED',result.diagnostic??result.error??`本次对话未正常结束：${result.stopReason}。`);
      if(!evidence.toolCalls)throw new RiftError('API_TOOL_NOT_OBSERVED','本次请求未观察到工具执行；不能据此判断普通对话不可用。');
      if(!evidence.conversation)throw new RiftError('API_REPLY_NOT_OBSERVED','工具已执行，但本次请求没有返回最终文字回复。');
    } catch (failure) { error = publicError(failure).message; }
    finally {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([handle?.dispose(), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('cleanup timeout')), 5000); })]); evidence.cleanupConfirmed=Boolean(handle)||!startAttempted||lateCleanupConfirmed; }
      catch { error = 'Verification runtime cleanup could not be confirmed.'; this.unavailable = error; }
      finally { if (cleanupTimer) clearTimeout(cleanupTimer); clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); this.verifyController = undefined; }
      if (startAttempted && !handle && controller.signal.aborted && !lateCleanupConfirmed) { this.cleanupUnknown = true; error = 'Verification startup outcome and cleanup are unknown; wait for owned runtime cleanup.'; }
      this.verifying = false;
    }
    invariant(!this.closed, 'HOST_CLOSING', 'Host closed while verifying the connection.');
    evidence.error=error??null;
    // Verification records observations only. It never edits roles, bindings,
    // queued executions, or a user's model selection, including on failure.
    this.store.transaction(()=>{
      const timestamp=now();
      this.store.exec('INSERT INTO api_connection_verifications(id,connection_id,created_at,result) VALUES(?,?,?,?)',id('verification'),connectionId,timestamp,JSON.stringify(evidence));
      this.store.exec('UPDATE api_connections SET verified_at=?,verification_status=?,verification_error=? WHERE id=?', timestamp, error ? 'failed' : 'passed', error ?? null, connectionId);
    });
    return { connection: this.get(connectionId), passed: !error, ...(error ? { error } : {}) };
  }
  async close(): Promise<void> { this.closed = true; this.verifyController?.abort(); await this.serial; await this.fiber?.dispose(); }
}
