import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { validateBinding } from '../../src/project/provider-bindings.js';
import { seedWorkspace } from './fixtures.js';

describe('A01/A10 independent persistence and configuration acceptance', () => {
  it('isolates workspace roles and rejects unknown provider or credential literals', () => {
    const store = new RiftStore();
    try {
      const first = seedWorkspace(store, 'first');
      const second = seedWorkspace(store, 'second');
      expect(first.roles).toHaveLength(4);
      expect(second.roles.every(role => role.workspaceId === 'second')).toBe(true);
      expect(new Set([...first.roles, ...second.roles].map(role => role.id)).size).toBe(8);
      expect(() => validateBinding({ ...first.bindings[0]!, providerName: 'missing' }, new Set(['claude-code-dev']))).toThrow(/not registered/);
      expect(() => validateBinding({ ...first.bindings[0]!, credentialRefs: ['sk-literal-secret'] }, new Set(['claude-code-dev']))).toThrow(/references/);
    } finally { store.close(); }
  });

  it('holds an exclusive host lock and persists only committed transactions on reopen', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'rift 验收 storage '));
    const database = path.join(temporary, 'rift.db');
    let store = new RiftStore(database);
    try {
      seedWorkspace(store, 'persisted');
      expect(() => new RiftStore(database)).toThrow(/holds this database/);
      expect(() => store.transaction(() => { seedWorkspace(store, 'rolled-back'); throw new Error('fault before commit'); })).toThrow('fault before commit');
      expect(store.get('SELECT id FROM workspaces WHERE id=?', 'rolled-back')).toBeUndefined();
      store.close();
      store = new RiftStore(database);
      expect(store.workspace('persisted').name).toBe('persisted');
      expect(store.all('SELECT * FROM roles WHERE workspace_id=?', 'persisted')).toHaveLength(4);
      expect(store.get('SELECT id FROM workspaces WHERE id=?', 'rolled-back')).toBeUndefined();
      expect(store.get<{ foreignKeys: number }>('PRAGMA foreign_keys')?.foreignKeys).toBe(1);
    } finally { store.close(); await rm(temporary, { recursive: true, force: true }); }
  });
});
