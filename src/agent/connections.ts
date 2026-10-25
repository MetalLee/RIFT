import type { Context, Fiber } from '@deepseek-ai/cordis';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { z } from 'zod';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { id, now, type RiftStore } from '../storage/database.js';
import { invariant, RiftError } from '../contracts/index.js';
import { publicError, registerCredentialRedaction } from '../api/security.js';
import { DshChatRuntime } from '../chat/dsh-runtime.js';

export const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  endpoint: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }, 'Use HTTPS or a loopback HTTP model endpoint, without credentials, query or fragment.'),
  model: z.string().trim().min(1).max(160),
  credentialRef: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, 'Use a Host environment-variable credential reference, not a key value.'),
  parentId: z.string().min(1).max(160).optional(),
}).strict();
export interface ApiConnection {
  id: string; name: string; protocol: z.infer<typeof createConnectionSchema>['protocol']; endpoint: string; model: string;
  credentialRef: string; provider: string; revision: number; parentId: string | null; createdAt: string;
  verifiedAt: string | null; verificationStatus: 'not-verified' | 'passed' | 'failed'; verificationError: string | null;
  available: boolean;
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
  list(): ApiConnection[] {
    return this.store.all<ApiConnection>('SELECT * FROM api_connections ORDER BY created_at,id').map(row => ({ ...row, available: Boolean(this.ctx.llm?.listProviders().some(provider => provider.id === row.provider)) }));
  }
  get(connectionId: string): ApiConnection {
    const connection = this.list().find(item => item.id === connectionId);
    invariant(connection, 'NOT_FOUND', 'API connection does not exist.'); return connection;
  }
  private profiles(connections = this.list()): Record<string, PiAiProviderProfile> {
    return Object.fromEntries(connections.map(connection => [connection.provider, {
      displayName: connection.name, api: connection.protocol, baseURL: connection.endpoint, apiKeyEnv: connection.credentialRef,
      models: [{ id: connection.model, input: ['text'], contextWindow: 64000, maxTokens: 8192 }],
      retryPolicy: { mode: 'normal', maxRetries: 0 }, streamIdleTimeoutMs: 60000,
    }]));
  }
  private async protectCredentials(connections: ApiConnection[]): Promise<void> {
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
    if (!this.ctx.llm || typeof this.ctx.plugin !== 'function') { this.unavailable = 'This Host does not mount the DSH model service.'; return; }
    if (this.list().length === 0) return;
    await this.protectCredentials(this.list());
    try { await this.mount(this.profiles()); }
    catch (error) { this.unavailable = publicError(error).message; }
  }
  configurationCapability(): { available: boolean; reason: string | null } { return { available: !this.closed && !this.unavailable && !this.cleanupUnknown && Boolean(this.ctx.llm) && typeof this.ctx.plugin === 'function', reason: this.cleanupUnknown ? 'Previous verification cleanup has not been confirmed.' : this.unavailable }; }
  create(raw: unknown): Promise<ApiConnection> {
    const input = createConnectionSchema.parse(raw);
    const operation = this.serial.then(async () => {
      invariant(this.configurationCapability().available, 'API_CONFIGURATION_UNAVAILABLE', this.unavailable ?? 'API configuration is not mounted.');
      invariant(!this.verifying, 'CONFIG_IN_USE', 'Wait for connection verification to finish.');
      const parent = input.parentId ? this.get(input.parentId) : undefined;
      const connectionId = id('connection');
      const row: ApiConnection = { ...input, id: connectionId, parentId: parent?.id ?? null, provider: `rift-api-${connectionId}`, revision: parent ? parent.revision + 1 : 1, createdAt: now(), verifiedAt: null, verificationStatus: 'not-verified', verificationError: null, available: false };
      const previous = this.profiles();
      await this.protectCredentials([row]);
      try {
        if (this.fiber) this.replaceProfiles(this.profiles([...this.list(), row]));
        else await this.mount(this.profiles([...this.list(), row]));
        invariant(!this.closed, 'HOST_CLOSING', 'Host closed while preparing the connection.');
        invariant(this.ctx.llm.listProviders().some(item => item.id === row.provider), 'API_CONFIGURATION_UNAVAILABLE', 'The DSH adapter did not register this API route.');
        this.store.exec('INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,parent_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', row.id, row.name, row.protocol, row.endpoint, row.model, row.credentialRef, row.provider, row.revision, row.parentId, row.createdAt);
      } catch (error) {
        if (this.fiber) this.replaceProfiles(previous); throw error;
      }
      return this.get(row.id);
    });
    this.serial = operation.catch(() => undefined); return operation;
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
    const timer = setTimeout(() => controller.abort(), 30000);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new RiftError('API_VERIFICATION_CANCELLED', 'Connection verification was stopped or timed out.')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    void aborted.catch(() => undefined);
    let handle: Awaited<ReturnType<DshChatRuntime['start']>> | undefined, error: string | undefined, startAttempted = false, lateCleanupConfirmed = false;
    try {
      const cwd = path.resolve(this.home, 'connection-verification', connection.id); await mkdir(cwd, { recursive: true });
      startAttempted = true;
      const starting = new DshChatRuntime(this.ctx, connection.provider).start({ workspaceId: 'connection-verification', agentId: 'connection-verification', turnId: id('verify'), cwd, model: connection.model, instructions: 'Connection verification only. Reply exactly RIFT_API_OK. No tools are available.', messages: [{ role: 'user', content: 'Reply RIFT_API_OK.' }], tools: [], signal: controller.signal });
      void starting.then(late => { if (controller.signal.aborted && !handle) { void late.result.catch(() => undefined); void late.dispose().then(() => { lateCleanupConfirmed = true; if (!this.closed) this.cleanupUnknown = false; }, () => undefined); } }, () => undefined);
      handle = await Promise.race([starting, aborted]);
      const result = await Promise.race([handle.result, aborted]);
      if (result.stopReason !== 'completed' || !result.text.includes('RIFT_API_OK')) throw new RiftError('API_VERIFICATION_FAILED', 'The model did not complete the verification response.');
    } catch (failure) { error = publicError(failure).message; }
    finally {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([handle?.dispose(), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('cleanup timeout')), 5000); })]); }
      catch { error = 'Verification runtime cleanup could not be confirmed.'; this.unavailable = error; }
      finally { if (cleanupTimer) clearTimeout(cleanupTimer); clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); this.verifyController = undefined; }
      if (startAttempted && !handle && controller.signal.aborted && !lateCleanupConfirmed) { this.cleanupUnknown = true; error = 'Verification startup outcome and cleanup are unknown; wait for owned runtime cleanup.'; }
      this.verifying = false;
    }
    invariant(!this.closed, 'HOST_CLOSING', 'Host closed while verifying the connection.');
    this.store.exec('UPDATE api_connections SET verified_at=?,verification_status=?,verification_error=? WHERE id=?', now(), error ? 'failed' : 'passed', error ?? null, connectionId);
    return { connection: this.get(connectionId), passed: !error, ...(error ? { error } : {}) };
  }
  async close(): Promise<void> { this.closed = true; this.verifyController?.abort(); await this.serial; await this.fiber?.dispose(); }
}
