import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { invariant, RiftError } from '../contracts/index.js';
import { now, type RiftStore } from '../storage/database.js';

export interface ConnectionDeletionRecord {
  id:string; provider:string; credentialRef:string; credentialOwned:number;
  deletedAt:string|null; credentialDeletedAt:string|null;
}

/** Current selections and unresolved executions retain their exact route.
 * Finished snapshots are audit history and intentionally do not prevent removal. */
export function assertConnectionUnused(store:RiftStore,connection:ConnectionDeletionRecord):void {
  const provider=connection.provider;
  const selected=store.get(`SELECT r.id FROM roles r LEFT JOIN provider_bindings b ON b.id=r.provider_binding_id
    WHERE json_extract(r.chat_connection,'$.provider')=? OR b.provider_name=? OR json_extract(b.spawn,'$.provider')=? LIMIT 1`,provider,provider,provider)
    ??store.get("SELECT id FROM workspaces WHERE json_extract(lead_connection,'$.provider')=? LIMIT 1",provider);
  invariant(!selected,'CONNECTION_IN_USE','An Agent or workspace still selects this API connection. Choose another connection before deleting it.');
  const turn=store.get(`SELECT t.id FROM agent_turns t WHERE
    (t.status IN ('queued','running','stopping') OR EXISTS(SELECT 1 FROM execution_leases l WHERE l.owner_type='turn' AND l.owner_id=t.id AND l.released_at IS NULL))
    AND EXISTS(SELECT 1 FROM json_tree(t.configuration) j WHERE j.key IN ('provider','providerName') AND j.value=?) LIMIT 1`,provider);
  const run=store.get(`SELECT r.id FROM runs r WHERE
    (r.status IN ('preparing','running','cancelling') OR r.slot_released_at IS NULL OR EXISTS(SELECT 1 FROM execution_leases l WHERE l.owner_type='run' AND l.owner_id=r.id AND l.released_at IS NULL))
    AND EXISTS(SELECT 1 FROM json_tree(r.provider_snapshot) j WHERE j.key IN ('provider','providerName') AND j.value=?) LIMIT 1`,provider);
  invariant(!turn&&!run,'CONNECTION_IN_USE','A queued or unresolved execution still uses this API connection. Wait for completion and confirmed cleanup before deleting it.');
  invariant(!connection.credentialOwned||!store.get('SELECT id FROM api_connections WHERE id<>? AND deleted_at IS NULL AND credential_ref=? LIMIT 1',connection.id,connection.credentialRef),'CONNECTION_IN_USE','Another saved API connection uses this credential. Delete that connection first.');
}

/** Tombstones are committed before asynchronous cleanup, so a crash or failed
 * unset cannot remount a deleted provider. Only a positively owned key is erased. */
export async function cleanupConnectionCredential(ctx:Context,store:RiftStore,connection:ConnectionDeletionRecord):Promise<void> {
  if(!connection.deletedAt||connection.credentialDeletedAt)return;
  if(connection.credentialOwned){
    try{
      const credentials=ctx.get('credentials');
      if(!credentials||typeof credentials.unset!=='function')throw new Error('Credential store unavailable');
      if(store.get('SELECT id FROM api_connections WHERE id<>? AND deleted_at IS NULL AND credential_ref=? LIMIT 1',connection.id,connection.credentialRef))throw new Error('Credential still referenced');
      await credentials.unset(credentialRef(connection.credentialRef));
    }catch{throw new RiftError('CREDENTIAL_CLEANUP_PENDING','The API connection is deleted, but its saved key could not yet be removed. Retry deletion to finish credential cleanup.');}
  }
  store.exec('UPDATE api_connections SET credential_deleted_at=? WHERE id=? AND deleted_at IS NOT NULL AND credential_deleted_at IS NULL',now(),connection.id);
}
