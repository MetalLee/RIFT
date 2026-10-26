import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RiftError, type Operation, type Role, type Run, type Task, type TaskEvent, type Workflow, type Workspace, type ProviderBinding } from '../contracts/index.js';

type Row = Record<string, unknown>;
const jsonColumns = new Set(['expectedPaths','acceptanceCriteria','providerSnapshot','result','payload','capabilities','credentialRefs','checkIds','candidate','spawn','analysisItems','leadConnection','chatConnection','configuration']);
export function decode<T>(row: Row): T {
  const output: Row = {};
  for (const [key, value] of Object.entries(row)) { const name = key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()); output[name] = jsonColumns.has(name) && typeof value === 'string' ? JSON.parse(value) : value; }
  return output as T;
}
export const now = (): string => new Date().toISOString();
export const id = (prefix: string): string => `${prefix}-${randomUUID()}`;
/** Synchronous BEGIN IMMEDIATE keeps every quota/state/event decision in one transaction. */
export class RiftStore {
  readonly db: DatabaseSync;
  private lockPath: string | undefined;
  private hostLease:DatabaseSync|undefined;
  private lockToken = randomUUID();
  private inTransaction = false;
  readonly filePath:string;
  constructor(path: string = ':memory:', options: { lock?: boolean } = {}) {
    this.filePath=path;
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true }); if (options.lock !== false) this.acquireLock(`${path}.host.lock`); }
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      const migration = readFileSync(fileURLToPath(new URL('../../migrations/0001_initial.sql', import.meta.url)), 'utf8');
      if(!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"))this.transaction(() => this.db.exec(migration));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=2'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0002_result_artifact.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=3')){
        this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
        try{this.transaction(()=>{this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0003_scalable_scheduler.sql',import.meta.url)),'utf8'));if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Migration introduced invalid foreign keys.');});}
        finally{this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');}
      }
      if(!this.get('SELECT version FROM schema_migrations WHERE version=4'))this.transaction(()=>{this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0004_ui_domain.sql',import.meta.url)),'utf8'));if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('UI migration introduced invalid foreign keys.');});
      if(!this.get('SELECT version FROM schema_migrations WHERE version=5'))this.transaction(()=>{this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0005_skills.sql',import.meta.url)),'utf8'));if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Skill migration introduced invalid foreign keys.');});
      if(!this.get('SELECT version FROM schema_migrations WHERE version=6')) {
        this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
        try { this.transaction(()=>{this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0006_repositories.sql',import.meta.url)),'utf8'));if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Repository migration introduced invalid foreign keys.');}); }
        finally { this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;'); }
      }
      if(!this.get('SELECT version FROM schema_migrations WHERE version=7'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0007_chat_context_cleanup.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=8'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0008_api_connections.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=9'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0009_native_sessions.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=10'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0010_execution_reasoning.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=11'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0011_conversation_titles.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=12')) {
        this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
        try { this.transaction(()=>{this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0012_chat_orchestration.sql',import.meta.url)),'utf8'));if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Orchestration migration introduced invalid foreign keys.');}); }
        finally { this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;'); }
      }
      if(!this.get('SELECT version FROM schema_migrations WHERE version=13'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0013_turn_activities.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=14')) {
        this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
        try {this.transaction(()=>{this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0014_collaboration_messages.sql',import.meta.url)),'utf8'));if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Collaboration migration introduced invalid foreign keys.');});}
        finally {this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');}
      }
      if(!this.get('SELECT version FROM schema_migrations WHERE version=15'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0015_safe_chat_stream.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=16'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0016_coordination_causality.sql',import.meta.url)),'utf8')));
      if(!this.get('SELECT version FROM schema_migrations WHERE version=17'))this.transaction(()=>this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0017_api_connection_deletion.sql',import.meta.url)),'utf8')));
    } catch (error) { this.releaseLock(); throw error; }
  }
  private acquireLock(path: string): void {
    // The SQLite lease is the cross-process arbiter. Holding its exclusive
    // transaction closes the stale-PID unlink/create race and is released by
    // the OS when a host is killed. The adjacent JSON remains diagnostic only.
    const lease=new DatabaseSync(`${path}.db`);
    try {lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');this.hostLease=lease;}
    catch(error){lease.close();throw new RiftError('HOST_ALREADY_RUNNING','Another RIFT host holds this database.',{cause:(error as Error).message});}
    try {
    if (existsSync(path)) {
      let prior: { pid?: number };
      try { prior = JSON.parse(readFileSync(path, 'utf8')) as {pid?:number}; } catch { throw new RiftError('HOST_LOCK_UNKNOWN','Host lock is unreadable; inspect it before starting another host.'); }
      if (!Number.isInteger(prior.pid) || !prior.pid) throw new RiftError('HOST_LOCK_UNKNOWN','Host lock has no trustworthy owner.');
      try { process.kill(prior.pid, 0); throw new RiftError('HOST_ALREADY_RUNNING','Another RIFT host holds this database.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      unlinkSync(path);
    }
    const temporary=`${path}.${this.lockToken}.tmp`;
    const fd = openSync(temporary,'wx'); try { writeFileSync(fd,JSON.stringify({pid:process.pid,token:this.lockToken}));fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary,path);
    this.lockPath=path;
    }catch(error){this.releaseLock();throw error;}
  }
  private releaseLock(): void {try{if (this.lockPath && existsSync(this.lockPath)) { const owner = JSON.parse(readFileSync(this.lockPath,'utf8')) as {token?:string}; if (owner.token===this.lockToken) unlinkSync(this.lockPath); }}finally{this.lockPath=undefined;this.hostLease?.close();this.hostLease=undefined;} }
  close(): void { this.db.close(); this.releaseLock(); }
  transaction<T>(fn: () => T): T { if (this.inTransaction) return fn(); this.db.exec('BEGIN IMMEDIATE'); this.inTransaction=true; try { const result=fn(); this.db.exec('COMMIT'); return result; } catch(error) { this.db.exec('ROLLBACK'); throw error; } finally { this.inTransaction=false; } }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] { return (this.db.prepare(sql).all(...args) as Row[]).map(decode<T>); }
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined { const row=this.db.prepare(sql).get(...args) as Row|undefined; return row ? decode<T>(row) : undefined; }
  exec(sql: string, ...args: SQLInputValue[]): void { this.db.prepare(sql).run(...args); }
  require<T>(sql:string,...args:SQLInputValue[]):T { const row=this.get<T>(sql,...args); if (!row) throw new RiftError('NOT_FOUND','Requested business record does not exist.'); return row; }
  workspace(id:string):Workspace { return this.require<Workspace>("SELECT w.*,COALESCE(r.canonical_path,'') AS repository_path,COALESCE(r.common_git_dir,'') AS common_git_dir,COALESCE(r.base_ref,'') AS base_ref FROM workspaces w LEFT JOIN repositories r ON r.id=COALESCE(w.default_repository_id,(SELECT id FROM repositories WHERE workspace_id=w.id ORDER BY id LIMIT 1)) WHERE w.id=?",id); }
  workflow(id:string):Workflow { return this.require<Workflow>('SELECT * FROM workflows WHERE id=?',id); }
  task(id:string):Task { return this.require<Task>('SELECT * FROM tasks WHERE id=?',id); }
  run(id:string):Run { const {runtimeBootId:_boot,...run}=this.require<Run & {runtimeBootId:string|null}>('SELECT * FROM runs WHERE id=?',id);return run; }
  role(id:string):Role { return this.require<Role>('SELECT * FROM roles WHERE id=?',id); }
  binding(id:string):ProviderBinding { return this.require<ProviderBinding>('SELECT * FROM provider_bindings WHERE id=?',id); }
  operation(id:string):Operation { return this.require<Operation>('SELECT * FROM operations WHERE id=?',id); }
  event(workflowId:string,type:string,payload:unknown={},refs:{taskId?:string;runId?:string;requestId?:string}={}):void { this.exec('INSERT INTO task_events(workflow_id,task_id,run_id,request_id,type,payload,occurred_at) VALUES(?,?,?,?,?,?,?)',workflowId,refs.taskId??null,refs.runId??null,refs.requestId??null,type,JSON.stringify(payload),now()); }
  events(workflowId:string,afterEventSeq=0):TaskEvent[] { return this.all<TaskEvent>('SELECT * FROM task_events WHERE workflow_id=? AND event_seq>? ORDER BY event_seq',workflowId,afterEventSeq); }
}
