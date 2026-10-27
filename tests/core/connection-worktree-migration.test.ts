import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RiftStore } from '../../src/storage/database.js';

const migrations = new URL('../../migrations/', import.meta.url);
const sql = (name: string) => readFileSync(new URL(name, migrations), 'utf8');
const generatedId = 'connection-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const seed = `
  INSERT INTO workspaces(id,name,root_path,status) VALUES('w','Kept workspace','repo','active');
  INSERT INTO repositories(id,workspace_id,canonical_path,common_git_dir,base_ref) VALUES('repo','w','repo','repo/.git','main');
  INSERT INTO roles(id,workspace_id,name,kind,purpose,prompt,revision) VALUES('lead','w','lead','dsh-lead','lead','Keep prompt',1);
  INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at)
    VALUES('${generatedId}','Keep connection','openai-completions','https://example.invalid','keep-model','RIFT_API_${'A'.repeat(32)}','keep-provider',1,'before-upgrade');
  INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at)
    VALUES('user-key','User key','openai-completions','https://example.invalid','keep-model','RIFT_API_USER_MANAGED','user-provider',1,'before-upgrade');
`;

// Build actual pre-merge schemas from their SQL, rather than stripping columns
// from a current RiftStore (which could hide a missing migration registration).
function historical(filename: string, version: 16 | 17 | 18 | 'worktree-17'): void {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of readdirSync(migrations).filter(name => Number(name.slice(0, 4)) <= 16).sort()) {
      const rebuild = [3, 6, 12, 14].includes(Number(name.slice(0, 4)));
      if (rebuild) db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
      db.exec(`BEGIN IMMEDIATE; ${sql(name)} COMMIT;`);
      if (rebuild) db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON');
    }
    db.exec(seed);
    if (version === 'worktree-17') {
      // The published PR schema is unchanged except for the final version marker.
      db.exec(sql('0019_worktree_removals.sql').replace('VALUES(19,', 'VALUES(17,'));
      db.exec(`UPDATE schema_migrations SET applied_at='legacy-worktree-time' WHERE version=17;
        INSERT INTO worktree_removals(kind,record_id,workspace_id,repository_id,path,state,version,source_fingerprint,cleanup_status,runtime_boot_id,error,head_commit,preservation_ref,updated_at)
        VALUES('user','kept-removal','w','repo','managed/kept','unknown',7,'fingerprint','unknown','boot-before','keep diagnostic','abc','refs/rift/deleted-worktrees/kept','before-upgrade');`);
    } else if (version >= 17) {
      db.exec(sql('0017_api_connection_deletion.sql'));
      db.exec(`UPDATE schema_migrations SET applied_at='main-deletion-time' WHERE version=17;
        UPDATE api_connections SET deleted_at='tombstone-time',credential_deleted_at='cleanup-time' WHERE id='${generatedId}';`);
      if (version === 18) {
        db.exec(sql('0018_connection_verifications.sql'));
        db.exec(`UPDATE schema_migrations SET applied_at='main-verification-time' WHERE version=18;
          INSERT INTO api_connection_verifications VALUES('kept-verification','${generatedId}','before-upgrade','{"passed":true}');`);
      }
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
}

function fixture(run: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'rift-merge-migration-'));
  try { run(join(directory, 'rift.db')); }
  finally {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('rift-merge-migration-')) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertCombinedSchema(store: RiftStore): void {
  expect(store.all('SELECT version FROM schema_migrations ORDER BY version')).toEqual(Array.from({ length: 19 }, (_, i) => ({ version: i + 1 })));
  expect(store.all<{name:string}>('PRAGMA table_info(api_connections)').map(column => column.name)).toEqual(expect.arrayContaining(['deleted_at', 'credential_deleted_at', 'credential_owned']));
  expect(store.get("SELECT name FROM sqlite_master WHERE type='index' AND name='connection_verifications_latest'")).toBeDefined();
  expect(() => store.exec("INSERT INTO api_connection_verifications VALUES('invalid','missing','now','{}')")).toThrow(/FOREIGN KEY/);
  expect(() => store.exec("INSERT INTO api_connections(id,name,protocol,endpoint,model,credential_ref,provider,revision,created_at,credential_owned) VALUES('bad','Bad','openai-completions','endpoint','model','ref','bad',1,'now',2)")).toThrow(/CHECK/);
  const expectedTriggers = [...sql('0019_worktree_removals.sql').matchAll(/CREATE TRIGGER (\w+)/g)].map(match => match[1]);
  expect(store.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'removal_%'").map(row => row.name).sort()).toEqual(expectedTriggers.sort());
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

describe('main API 17/18 and published Worktree 17 migration reconciliation', () => {
  it('creates a fresh combined schema and reopens it idempotently', () => fixture(filename => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new RiftStore(filename);
      try { assertCombinedSchema(store); } finally { store.close(); }
    }
  }));

  it('rolls back legacy relabeling and API changes if a later migration fails, then retries safely', () => fixture(filename => {
    historical(filename, 'worktree-17');
    const old = new DatabaseSync(filename);
    // A conflicting object makes main's version 18 fail after 17 has run.
    old.exec('CREATE TABLE api_connection_verifications(block_migration TEXT)');
    const receipts = old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const removals = old.prepare('SELECT * FROM worktree_removals').all();
    old.close();
    expect(() => new RiftStore(filename)).toThrow(/already exists/);
    const inspection = new DatabaseSync(filename);
    try {
      expect(inspection.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(receipts);
      expect(inspection.prepare('SELECT * FROM worktree_removals').all()).toEqual(removals);
      expect(inspection.prepare('PRAGMA table_info(api_connections)').all().map(row => row.name)).not.toContain('deleted_at');
      inspection.exec('DROP TABLE api_connection_verifications');
    } finally { inspection.close(); }
    const repaired = new RiftStore(filename);
    try { assertCombinedSchema(repaired); } finally { repaired.close(); }
  }));

  it.each([16, 17, 18, 'worktree-17'] as const)('upgrades %s without losing data, receipts or safety fences', version => fixture(filename => {
    historical(filename, version);
    let snapshot: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new RiftStore(filename);
      try {
        assertCombinedSchema(store);
        expect(store.get("SELECT name FROM workspaces WHERE id='w'")).toEqual({ name: 'Kept workspace' });
        expect(store.get("SELECT prompt FROM roles WHERE id='lead'")).toEqual({ prompt: 'Keep prompt' });
        expect(store.get('SELECT model,credential_owned FROM api_connections WHERE id=?', generatedId)).toEqual({ model: 'keep-model', credentialOwned: 1 });
        expect(store.get("SELECT credential_owned FROM api_connections WHERE id='user-key'")).toEqual({ credentialOwned: 0 });
        if (version === 17 || version === 18) {
          expect(store.get('SELECT deleted_at,credential_deleted_at FROM api_connections WHERE id=?', generatedId)).toEqual({ deletedAt: 'tombstone-time', credentialDeletedAt: 'cleanup-time' });
          expect(store.get('SELECT applied_at FROM schema_migrations WHERE version=17')).toEqual({ appliedAt: 'main-deletion-time' });
        }
        if (version === 18) {
          expect(store.get("SELECT result FROM api_connection_verifications WHERE id='kept-verification'")).toEqual({ result: { passed: true } });
          expect(store.get('SELECT applied_at FROM schema_migrations WHERE version=18')).toEqual({ appliedAt: 'main-verification-time' });
        }
        if (version === 'worktree-17') {
          expect(store.get('SELECT applied_at FROM schema_migrations WHERE version=19')).toEqual({ appliedAt: 'legacy-worktree-time' });
          expect(store.get("SELECT * FROM worktree_removals WHERE record_id='kept-removal'")).toMatchObject({ state: 'unknown', version: 7, sourceFingerprint: 'fingerprint', cleanupStatus: 'unknown', runtimeBootId: 'boot-before', error: 'keep diagnostic', headCommit: 'abc', preservationRef: 'refs/rift/deleted-worktrees/kept', updatedAt: 'before-upgrade' });
          expect(() => store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES('blocked','turn','turn','w','lead','lead','now')")).toThrow('WORKTREE_DELETION_IN_PROGRESS');
          expect(() => store.exec("UPDATE repositories SET base_ref='unsafe' WHERE id='repo'")).toThrow('WORKTREE_DELETION_IN_PROGRESS');
        } else if (attempt === 0) {
          store.exec("INSERT INTO worktree_removals(kind,record_id,workspace_id,repository_id,path,state,source_fingerprint,cleanup_status,updated_at) VALUES('user','new-removal','w','repo','managed/new','unknown','fingerprint','unknown','now')");
          expect(() => store.exec("UPDATE repositories SET base_ref='unsafe' WHERE id='repo'")).toThrow('WORKTREE_DELETION_IN_PROGRESS');
          expect(store.get("SELECT type FROM workspace_events WHERE type='worktree.removal'")).toEqual({ type: 'worktree.removal' });
        }
        const current = ['schema_migrations', 'api_connections', 'api_connection_verifications', 'worktree_removals', 'workspace_events'].map(table => store.all(`SELECT * FROM ${table}`));
        if (attempt === 0) snapshot = current;
        else expect(current).toEqual(snapshot);
      } finally { store.close(); }
    }
  }));
});
