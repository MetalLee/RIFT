import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { id, now, type RiftStore } from '../storage/database.js';
import { invariant } from '../contracts/index.js';
import type { RuntimeSession } from './runtime-types.js';

export interface NativeSessionRecord { id: string; threadId: string | null; runtimeHome: string; cwd: string }
export const codexHome = (env: NodeJS.ProcessEnv = process.env): string => path.resolve(env.CODEX_HOME || path.join(homedir(), '.codex'));

/** RIFT records ownership; Codex owns the actual persisted history and compaction. */
export function nativeSession(store: RiftStore, input: { workspaceId: string; scope: 'chat'|'task'; scopeId: string; agentId: string; configuration: unknown; cwd: string; runtimeHome?: string }): NativeSessionRecord {
  const runtimeHome = input.runtimeHome ?? codexHome();
  const key = createHash('sha256').update(JSON.stringify([input.configuration, runtimeHome, 'codex-0.164.0'])).digest('hex');
  return store.transaction(() => {
    invariant(store.get('SELECT id FROM roles WHERE id=? AND workspace_id=?',input.agentId,input.workspaceId),'NOT_FOUND','Native session member does not belong to this workspace.');
    const prior = store.get<NativeSessionRecord>('SELECT * FROM native_sessions WHERE workspace_id=? AND scope=? AND scope_id=? AND agent_id=? AND configuration_key=?', input.workspaceId,input.scope,input.scopeId,input.agentId,key);
    if (prior) return prior;
    const sessionId = id('native-session');
    store.exec('INSERT INTO native_sessions(id,workspace_id,scope,scope_id,agent_id,configuration_key,runtime_home,cwd,created_at) VALUES(?,?,?,?,?,?,?,?,?)',sessionId,input.workspaceId,input.scope,input.scopeId,input.agentId,key,runtimeHome,input.cwd,now());
    return store.require<NativeSessionRecord>('SELECT * FROM native_sessions WHERE id=?',sessionId);
  });
}

export function sessionCallbacks(store: RiftStore, session: NativeSessionRecord, executionId: string, cwd: string, accepted?: () => void): RuntimeSession {
  store.exec('INSERT INTO native_executions(execution_id,session_id,status,updated_at) VALUES(?,?,?,?)',executionId,session.id,'starting',now());
  return {
    threadId: session.threadId ?? undefined, runtimeHome: session.runtimeHome,
    onThread(threadId) {
      invariant(!session.threadId || session.threadId === threadId,'NATIVE_SCOPE_MISMATCH','Resume returned a different thread.');
      store.exec('UPDATE native_sessions SET thread_id=?,cwd=? WHERE id=?',threadId,cwd,session.id);
    },
    onTurn(turnId) {
      store.transaction(() => {
        store.exec("UPDATE native_executions SET native_turn_id=?,status='running',updated_at=? WHERE execution_id=?",turnId,now(),executionId);
        accepted?.();
      });
    },
    onSettled(status) { store.exec('UPDATE native_executions SET status=?,updated_at=? WHERE execution_id=?',status,now(),executionId); },
  };
}

export function acknowledgeMessages(store: RiftStore, sessionId: string, sources: {messageId:string;version:number}[]): void {
  for (const source of sources) store.exec('INSERT OR IGNORE INTO native_message_receipts(session_id,message_id,message_version) VALUES(?,?,?)',sessionId,source.messageId,source.version);
}
