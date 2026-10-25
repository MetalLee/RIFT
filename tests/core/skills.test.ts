import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { SkillService } from '../../src/skill/service.js';
import { seedWorkspace } from '../acceptance/fixtures.js';

const stores: RiftStore[] = []; const folders: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() { const store = new RiftStore(); stores.push(store); const { workspace, roles } = seedWorkspace(store, 'skills-workspace'); return { store, workspaceId: workspace.id, agentId: roles.find(r => r.kind === 'dsh-lead')!.id, service: new SkillService(store) }; }
function directory(content = 'Follow the project conventions.') { const folder = mkdtempSync(join(tmpdir(), 'rift-skill-test-')); folders.push(folder); writeFileSync(join(folder, 'SKILL.md'), content); return folder; }
function importSkill(f: ReturnType<typeof fixture>, name = 'Conventions', content?: string) { const preview = f.service.previewImport({ workspaceId: f.workspaceId, directory: directory(content), name }); return f.service.saveImport({ workspaceId: f.workspaceId, previewId: preview.previewId }); }

describe('Skill versions and assignment resolution', () => {
  it('keeps the preview bytes and fixed execution snapshots when source or defaults change', () => {
    const f = fixture(); const dir = directory('Original instructions');
    const preview = f.service.previewImport({ workspaceId: f.workspaceId, directory: dir, name: 'Practice' });
    writeFileSync(join(dir, 'SKILL.md'), 'Changed after preview');
    const first = f.service.saveImport({ workspaceId: f.workspaceId, previewId: preview.previewId });
    expect(first.version.instructions).toBe('Original instructions');
    f.service.setShared(f.workspaceId, first.skill.id, { versionId: first.version.id, enabled: true, expectedRevision: 0 });
    const compiled = f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh');
    f.service.snapshotExecution(f.workspaceId, f.agentId, 'turn', 'turn-fixed', compiled);
    const next = f.service.previewImport({ workspaceId: f.workspaceId, directory: dir, skillId: first.skill.id, expectedRevision: 1 });
    const second = f.service.saveImport({ workspaceId: f.workspaceId, previewId: next.previewId });
    f.service.setShared(f.workspaceId, first.skill.id, { versionId: second.version.id, enabled: true, expectedRevision: 1 });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').instructions).toContain('Changed after preview');
    expect(f.store.require<{ snapshotJson: string }>('SELECT snapshot_json FROM skill_execution_snapshots WHERE owner_id=?', 'turn-fixed').snapshotJson).toContain('Original instructions');
    expect(() => f.store.exec('UPDATE skill_versions SET instructions=? WHERE id=?', 'tamper', first.version.id)).toThrow(/immutable/);
    expect(() => f.store.exec('DELETE FROM skill_versions WHERE id=?', first.version.id)).toThrow(/retained/);
  });
  it('applies shared defaults, explicit exclusion and explicit version override including Lead', () => {
    const f = fixture(); const { skill, version } = importSkill(f);
    f.service.setShared(f.workspaceId, skill.id, { versionId: version.id, enabled: true, expectedRevision: 0 });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').versions).toHaveLength(1);
    f.service.setAgent(f.workspaceId, f.agentId, skill.id, { mode: 'exclude', expectedRevision: 0 });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').versions).toHaveLength(0);
    f.service.setAgent(f.workspaceId, f.agentId, skill.id, { mode: 'include', versionId: version.id, expectedRevision: 1 });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').versions[0]?.source).toBe('agent');
    f.service.setAgent(f.workspaceId, f.agentId, skill.id, { mode: 'inherit', expectedRevision: 2 });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').versions[0]?.source).toBe('shared');
    expect(() => f.service.setShared(f.workspaceId, skill.id, { versionId: version.id, enabled: false, expectedRevision: 0 })).toThrow(/changed/);
  });
  it('refuses ambiguous same-name sources and cross-workspace assignments', () => {
    const f = fixture(); const a = importSkill(f, 'Same name'); const b = importSkill(f, 'Same name');
    for (const x of [a, b]) f.service.setShared(f.workspaceId, x.skill.id, { versionId: x.version.id, enabled: true, expectedRevision: 0 });
    expect(() => f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh')).toThrow(/Multiple Skills/);
    const other = seedWorkspace(f.store, 'other-skills-workspace');
    expect(() => f.service.version(other.workspace.id, a.version.id)).toThrow(/workspace/);
    expect(() => f.service.setAgent(other.workspace.id, f.agentId, a.skill.id, { mode: 'include', versionId: a.version.id, expectedRevision: 0 })).toThrow(/workspace/);
    expect(() => f.service.setAgent(f.workspaceId, f.agentId, a.skill.id, { mode: 'include', versionId: b.version.id, expectedRevision: 0 })).toThrow(/another Skill/);
  });
  it('archives without deleting history and makes stale assignments explicitly unavailable', () => {
    const f = fixture(); const x = importSkill(f);
    f.service.setShared(f.workspaceId, x.skill.id, { versionId: x.version.id, enabled: true, expectedRevision: 0 });
    f.service.archive(f.workspaceId, x.skill.id, 1);
    expect(f.service.version(f.workspaceId, x.version.id).instructions).toBeTruthy();
    expect(() => f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh')).toThrow(/archived/);
    f.service.setShared(f.workspaceId, x.skill.id, { versionId: x.version.id, enabled: false, expectedRevision: 1 });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').versions).toEqual([]);
  });
  it('publishes scoped metadata events for changes without leaking instruction text', () => {
    const f = fixture(); const x = importSkill(f, 'Events', 'PRIVATE_INSTRUCTION_TEXT');
    f.service.setShared(f.workspaceId, x.skill.id, { versionId: x.version.id, enabled: true, expectedRevision: 0 });
    f.service.setAgent(f.workspaceId, f.agentId, x.skill.id, { mode: 'exclude', expectedRevision: 0 });
    const events = f.store.all<{ type: string; workspaceId: string }>("SELECT * FROM workspace_events WHERE type LIKE 'skill.%'");
    expect(events.map(event => event.type)).toEqual(['skill.created', 'skill.version', 'skill.shared', 'skill.assignment']);
    expect(events.every(event => event.workspaceId === f.workspaceId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_INSTRUCTION_TEXT');
  });
  it('previews current references including inherited members without implying automatic version upgrades', () => {
    const f = fixture(); const x = importSkill(f);
    f.service.setShared(f.workspaceId, x.skill.id, { versionId: x.version.id, enabled: true, expectedRevision: 0 });
    const excluded = `${f.workspaceId}:developer-a`;
    f.service.setAgent(f.workspaceId, excluded, x.skill.id, { mode: 'exclude', expectedRevision: 0 });
    const preview = f.service.previewImport({ workspaceId: f.workspaceId, skillId: x.skill.id, expectedRevision: x.skill.revision, directory: directory('New version') });
    expect(preview.currentReferenceAgents).toContain(f.agentId);
    expect(preview.currentReferenceAgents).not.toContain(excluded);
    f.service.saveImport({ workspaceId: f.workspaceId, previewId: preview.previewId });
    expect(f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh').versions[0]?.versionId).toBe(x.version.id);
  });
});

describe('inert import and explicit runtime compatibility', () => {
  it('requires verified resource and script support, retains exact bytes, and never executes code', () => {
    const f = fixture(); const dir = directory(); mkdirSync(join(dir, 'scripts')); writeFileSync(join(dir, 'scripts', 'tool.js'), 'throw new Error("MUST NOT EXECUTE")');
    const preview = f.service.previewImport({ workspaceId: f.workspaceId, directory: dir, runtimes: ['dsh'] });
    expect(preview.requirements).toEqual({ resources: true, scripts: true, runtimes: ['dsh'] });
    const x = f.service.saveImport({ workspaceId: f.workspaceId, previewId: preview.previewId });
    f.service.setShared(f.workspaceId, x.skill.id, { versionId: x.version.id, enabled: true, expectedRevision: 0 });
    expect(() => f.service.resolveEffective(f.workspaceId, f.agentId, 'codex')).toThrow(/does not support/);
    expect(() => f.service.resolveEffective(f.workspaceId, f.agentId, 'dsh')).toThrow(/resource loading/);
    expect(() => f.service.resolveEffective(f.workspaceId, f.agentId, { runtime: 'dsh', resources: true })).toThrow(/scripts/);
    const compiled = f.service.resolveEffective(f.workspaceId, f.agentId, { runtime: 'dsh', resources: true, scripts: true });
    expect(Buffer.from(compiled.resources[0]!.contentBase64, 'base64').toString()).toContain('MUST NOT EXECUTE');
    expect(compiled.instructions).toContain('do not grant additional');
  });
  it('rejects directory escape through junctions, credential files, missing entry and oversized files', () => {
    const f = fixture(); const dir = directory(); const external = directory('Outside');
    symlinkSync(external, join(dir, 'escape'), 'junction');
    expect(() => f.service.previewImport({ workspaceId: f.workspaceId, directory: dir })).toThrow(/symlinks/);
    const secretDir = directory(); writeFileSync(join(secretDir, '.env'), 'SECRET=not-importable');
    expect(() => f.service.previewImport({ workspaceId: f.workspaceId, directory: secretDir })).toThrow(/credential/);
    const oversized = directory('x'.repeat(256 * 1024 + 1));
    expect(() => f.service.previewImport({ workspaceId: f.workspaceId, directory: oversized })).toThrow(/exceeds/);
    const empty = directory('');
    expect(() => f.service.previewImport({ workspaceId: f.workspaceId, directory: empty })).toThrow(/non-empty/);
  });
});
