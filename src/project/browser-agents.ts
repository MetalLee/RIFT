import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant, type Role } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import type { ChatConnection } from '../chat/contracts.js';

export const connectionSchema = z.object({ runtime: z.enum(['dsh','codex']), provider: z.string().min(1).max(160).optional(), model: z.string().min(1).max(160), reasoningEffort: z.string().max(40).optional() }).strict().refine(value => value.runtime !== 'dsh' || Boolean(value.provider), 'DSH connections require a provider.');
export interface BrowserAgent extends Role { displayName: string; version: number; chatConnection: ChatConnection | null }
const fields = { displayName: z.string().trim().min(1).max(120), prompt: z.string().max(16000), chatConnection: connectionSchema.nullable() };
export const createAgentSchema = z.object({ ...fields, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).optional(), purpose: z.enum(['developer','reviewer']), providerBindingId: z.string().min(1).max(160).optional(), executionProviderName: z.string().min(1).max(160).optional() }).strict();
export const updateAgentSchema = z.object({ expectedVersion: z.number().int().nonnegative(), displayName: fields.displayName.optional(), prompt: fields.prompt.optional(), chatConnection: fields.chatConnection.optional(), enabled: z.boolean().optional(), providerBindingId: z.string().min(1).max(160).optional(), executionProviderName: z.string().min(1).max(160).optional() }).strict();

export function createBrowserAgent(store: RiftStore, workspaceId: string, input: z.infer<typeof createAgentSchema>): BrowserAgent {
  const workspace = store.workspace(workspaceId); invariant(workspace.status === 'active', 'WORKSPACE_ARCHIVED', 'Archived workspace cannot add agents.');
  return store.transaction(() => {
    const id = `agent-${randomUUID()}`, name = input.name ?? id;
    // Legacy execution requires a binding. Discussion-only members receive an inert binding,
    // never a fabricated registered provider or claimed authentication.
    const bindingId = input.providerBindingId ?? `discussion-${id}`;
    if (input.providerBindingId) invariant(store.get('SELECT b.id FROM provider_bindings b LEFT JOIN roles r ON r.provider_binding_id=b.id WHERE b.id=? AND (r.workspace_id=? OR b.workspace_id=?)', bindingId, workspaceId, workspaceId), 'BINDING_NOT_FOUND', 'Choose a binding already owned by this workspace.');
    else store.exec('INSERT INTO provider_bindings(id,provider_name,package_version,config_revision,capabilities,credential_refs) VALUES(?,?,?,1,?,?)', bindingId, 'discussion-only', 'none', '{}', '[]');
    store.exec('INSERT INTO roles(id,workspace_id,name,enabled,purpose,kind,provider_binding_id,prompt,revision,display_name,chat_connection) VALUES(?,?,?,1,?,?,?,?,1,?,?)', id, workspaceId, name, input.purpose, 'subagent', bindingId, input.prompt, input.displayName, input.chatConnection ? JSON.stringify(input.chatConnection) : null);
    return store.role(id) as BrowserAgent;
  });
}

export function updateBrowserAgent(store: RiftStore, workspaceId: string, agentId: string, input: z.infer<typeof updateAgentSchema>): BrowserAgent {
  return store.transaction(() => {
    const role = store.role(agentId) as BrowserAgent;
    invariant(role.workspaceId === workspaceId, 'NOT_FOUND', 'Agent does not belong to this workspace.');
    invariant(role.version === input.expectedVersion, 'VERSION_CONFLICT', 'Agent configuration changed.');
    invariant(role.purpose!=='lead'||input.chatConnection===undefined,'LEAD_CONNECTION_SCOPE','Configure the Lead connection through workspace settings.');
    if (input.providerBindingId) {
      invariant(role.purpose !== 'lead', 'UNSUPPORTED_ROLE', 'Configure the Lead discussion connection at workspace level.');
      invariant(!store.get('SELECT id FROM execution_leases WHERE agent_id=? AND released_at IS NULL',agentId),'CONFIG_IN_USE','Execution binding cannot change until this Agent has released its lease.');
      invariant(store.get('SELECT b.id FROM provider_bindings b LEFT JOIN roles r ON r.provider_binding_id=b.id WHERE b.id=? AND (r.workspace_id=? OR b.workspace_id=?)',input.providerBindingId,workspaceId,workspaceId),'BINDING_NOT_FOUND','Binding does not belong to this workspace.');
    }
    if (input.enabled === false) {
      invariant(role.purpose !== 'lead', 'LEAD_REQUIRED', 'The workspace requires one enabled Lead.');
      invariant(!store.get('SELECT id FROM execution_leases WHERE agent_id=? AND released_at IS NULL', agentId) && !store.get("SELECT id FROM agent_turns WHERE agent_id=? AND status='queued'", agentId) && !store.get("SELECT id FROM tasks WHERE role_id=? AND status NOT IN ('succeeded','failed','cancelled')", agentId), 'CONFIG_IN_USE', 'This Agent has unfinished work or unconfirmed cleanup.');
    }
    store.exec('UPDATE roles SET display_name=?,prompt=?,chat_connection=?,enabled=?,version=version+1,revision=revision+1 WHERE id=?', input.displayName ?? role.displayName ?? role.name, input.prompt ?? role.prompt, input.chatConnection === undefined ? (role.chatConnection ? JSON.stringify(role.chatConnection) : null) : input.chatConnection ? JSON.stringify(input.chatConnection) : null, input.enabled === undefined ? role.enabled ?? 1 : Number(input.enabled), agentId);
    if(input.providerBindingId)store.exec('UPDATE roles SET provider_binding_id=? WHERE id=?',input.providerBindingId,agentId);
    return store.role(agentId) as BrowserAgent;
  });
}
