import type { SkillResource, SkillRequirements, Skill, SkillShared, SkillAssignment, SkillSnapshotVersion, CompiledSkills } from '@rift/protocol';
export type { SkillResource, SkillRequirements, Skill, SkillShared, SkillAssignment, SkillSnapshotVersion, CompiledSkills } from '@rift/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { invariant, RiftError } from '../contracts/index.js';
import { RiftStore, now } from '../storage/database.js';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_FILES = 512;
const MAX_PROMPT = 256 * 1024;
/** Storage/execution includes resource bytes; public versions contain summaries only. */
export interface SkillVersion extends Omit<import('@rift/protocol').SkillVersion, 'resources'> { resources: SkillResource[] }
interface RawVersion extends Omit<SkillVersion, 'resources' | 'requirements'> { manifestJson: string; requirementsJson: string }
export interface SkillRuntime { runtime: string; resources?: boolean; scripts?: boolean }
export interface SkillImportInput { workspaceId: string; directory: string; name?: string; description?: string; skillId?: string; expectedRevision?: number; runtimes?: string[] }
interface Preview { id: string; input: SkillImportInput; name: string; description: string; sourceDirectory: string; instructions: string; digest: string; resources: SkillResource[]; requirements: SkillRequirements; createdAt: number; expectedRevision: number }
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const unpack = (row: RawVersion): SkillVersion => { const { manifestJson, requirementsJson, ...rest } = row; return { ...rest, resources: JSON.parse(manifestJson) as SkillResource[], requirements: JSON.parse(requirementsJson) as SkillRequirements }; };

/** Imports inert files and compiles immutable, explicit execution inputs. Never runs a package or its scripts. */
export class SkillService {
  private previews = new Map<string, Preview>();
  constructor(readonly store: RiftStore) {}

  private workspace(workspaceId: string) { return this.store.workspace(workspaceId); }
  private agent(workspaceId: string, agentId: string) { const role = this.store.role(agentId); invariant(role.workspaceId === workspaceId, 'WORKSPACE_MISMATCH', 'Agent does not belong to this workspace.'); return role; }
  private skill(workspaceId: string, skillId: string): Skill { const skill = this.store.require<Skill>('SELECT * FROM skills WHERE id=?', skillId); invariant(skill.workspaceId === workspaceId, 'WORKSPACE_MISMATCH', 'Skill does not belong to this workspace.'); return skill; }
  version(workspaceId: string, versionId: string): SkillVersion { const row = this.store.require<RawVersion>('SELECT * FROM skill_versions WHERE id=?', versionId); this.skill(workspaceId, row.skillId); return unpack(row); }
  private checkVersion(workspaceId: string, skillId: string, versionId: string) { const version = this.version(workspaceId, versionId); invariant(version.skillId === skillId, 'SKILL_VERSION_MISMATCH', 'Version belongs to another Skill.'); return version; }
  private revision(actual: number, expected: number) { invariant(actual === expected, 'VERSION_CONFLICT', `Configuration changed (current revision ${actual}); reload before saving.`); }

  list(workspaceId: string) {
    this.workspace(workspaceId);
    return this.store.all<Skill>('SELECT * FROM skills WHERE workspace_id=? ORDER BY name,id', workspaceId).map(skill => ({ ...skill,
      versions: this.store.all<RawVersion>('SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC', skill.id).map(row => { const version = unpack(row); return { ...version, resources: version.resources.map(({ contentBase64: _, ...r }) => r) }; }),
      shared: this.store.get<SkillShared>('SELECT * FROM skill_shared WHERE workspace_id=? AND skill_id=?', workspaceId, skill.id) ?? null,
      assignments: this.store.all<SkillAssignment>('SELECT * FROM skill_agent_assignments WHERE workspace_id=? AND skill_id=?', workspaceId, skill.id),
    }));
  }

  previewImport(input: SkillImportInput) {
    this.workspace(input.workspaceId);
    invariant(isAbsolute(input.directory), 'INVALID_SKILL_PATH', 'Choose an absolute Skill directory.');
    const selected = resolve(input.directory);
    invariant(!lstatSync(selected).isSymbolicLink() && lstatSync(selected).isDirectory(), 'INVALID_SKILL_PATH', 'Skill import root must be a real directory, not a symlink.');
    const root = realpathSync(selected);
    const existing = input.skillId ? this.skill(input.workspaceId, input.skillId) : undefined;
    if (existing) { invariant(!existing.archived, 'SKILL_ARCHIVED', 'Archived Skills cannot receive new versions.'); this.revision(existing.revision, input.expectedRevision ?? -1); }
    const name = (input.name ?? existing?.name ?? basename(root)).trim();
    const description = (input.description ?? existing?.description ?? '').trim();
    invariant(name.length > 0 && name.length <= 120 && description.length <= 2000, 'INVALID_SKILL_METADATA', 'Skill name or description exceeds its limit.');
    const resources: SkillResource[] = []; let total = 0; let count = 0; let entries = 0; let instructions = '';
    const walk = (directory: string, depth = 0) => {
      invariant(depth <= 32, 'SKILL_SIZE_LIMIT', 'Skill directory nesting exceeds 32 levels.');
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        invariant(++entries <= 2048, 'SKILL_SIZE_LIMIT', 'Skill package contains more than 2048 directory entries.');
        const absolute = join(directory, entry.name); const info = lstatSync(absolute);
        invariant(!info.isSymbolicLink(), 'SKILL_SYMLINK', 'Skill packages cannot contain symlinks or junctions.');
        const canonical = realpathSync(absolute); const within = relative(root, canonical);
        invariant(within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), 'SKILL_PATH_ESCAPE', 'Skill resource escapes the selected directory.');
        invariant(!['.git', 'node_modules'].includes(entry.name) && !/^\.env(?:\.|$)/i.test(entry.name), 'SKILL_UNSAFE_RESOURCE', 'Do not import repository internals, dependencies or environment credential files.');
        if (info.isDirectory()) { walk(absolute, depth + 1); continue; }
        invariant(info.isFile(), 'SKILL_UNSAFE_RESOURCE', 'Only regular files can be imported.');
        invariant(++count <= MAX_FILES && info.size <= MAX_FILE && total + info.size <= MAX_TOTAL, 'SKILL_SIZE_LIMIT', 'Skill package exceeds 512 files, 4 MiB per file, or 32 MiB total.');
        const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes: Buffer;
        try { const opened = fstatSync(descriptor); invariant(opened.isFile() && opened.dev === info.dev && opened.ino === info.ino && opened.size <= MAX_FILE, 'SKILL_PATH_CHANGED', 'Skill source changed while importing.'); bytes = readFileSync(descriptor); } finally { closeSync(descriptor); }
        invariant(bytes.byteLength <= MAX_FILE && total + bytes.byteLength <= MAX_TOTAL, 'SKILL_SIZE_LIMIT', 'Skill resource changed or exceeds the size limit.');
        // Recheck canonical identity after opening; snapshots use these bytes, never the source on execution.
        invariant(!lstatSync(absolute).isSymbolicLink() && realpathSync(absolute) === canonical, 'SKILL_PATH_CHANGED', 'Skill source changed while importing.');
        total += bytes.byteLength; const path = relative(root, absolute).split(sep).join('/');
        if (path === 'SKILL.md') { invariant(bytes.byteLength<=MAX_PROMPT,'SKILL_SIZE_LIMIT','SKILL.md exceeds 256 KiB.'); try { instructions = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RiftError('SKILL_ENCODING', 'SKILL.md must be valid UTF-8.'); } }
        else resources.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes), contentBase64: bytes.toString('base64') });
      }
    };
    walk(root);
    invariant(instructions.trim().length > 0, 'SKILL_ENTRY_MISSING', 'The selected directory must contain a non-empty SKILL.md.');
    const runtimes = [...new Set(input.runtimes ?? [])];
    invariant(runtimes.length <= 20 && runtimes.every(r => /^[A-Za-z0-9_.-]{1,80}$/.test(r)), 'INVALID_SKILL_RUNTIME', 'Invalid runtime compatibility list.');
    const requirements: SkillRequirements = { resources: resources.length > 0, scripts: resources.some(r => /(?:^scripts\/|\.(?:sh|ps1|bat|cmd|exe|dll|py|js|mjs|cjs|ts|wasm)$)/i.test(r.path)), runtimes };
    const digest = sha256(JSON.stringify({ instructions, resources, requirements }));
    const id = randomUUID(); const createdAt = Date.now();
    for (const [key, preview] of this.previews) if (createdAt - preview.createdAt > 15 * 60000) this.previews.delete(key);
    invariant(this.previews.size < 20, 'SKILL_PREVIEW_LIMIT', 'Too many pending previews; save or discard an existing preview first.');
    this.previews.set(id, { id, input, name, description, sourceDirectory: root, instructions, digest, resources, requirements, createdAt, expectedRevision: existing?.revision ?? 0 });
    const currentReferenceAgents = existing ? this.store.all<{id:string}>('SELECT id FROM roles WHERE workspace_id=?', input.workspaceId).filter(role => {
      const assignment = this.store.get<SkillAssignment>('SELECT * FROM skill_agent_assignments WHERE agent_id=? AND skill_id=?', role.id, existing.id);
      return assignment?.mode === 'include' || assignment?.mode !== 'exclude' && !!this.store.get('SELECT skill_id FROM skill_shared WHERE workspace_id=? AND skill_id=? AND enabled=1', input.workspaceId, existing.id);
    }).map(role => role.id) : [];
    return { previewId: id, name, description, sourceDirectory: root, instructions, digest, requirements, resources: resources.map(({ contentBase64: _, ...r }) => r), expiresAt: new Date(createdAt + 15 * 60000).toISOString(), currentReferenceAgents };
  }

  discardPreview(workspaceId: string, previewId: string) { const preview = this.previews.get(previewId); invariant(preview?.input.workspaceId === workspaceId, 'NOT_FOUND', 'Skill preview does not exist in this workspace.'); this.previews.delete(previewId); }

  saveImport(input: { workspaceId: string; previewId: string }) {
    const preview = this.previews.get(input.previewId);
    invariant(preview?.input.workspaceId === input.workspaceId && Date.now() - preview.createdAt <= 15 * 60000, 'SKILL_PREVIEW_EXPIRED', 'Skill preview expired or does not exist in this workspace; preview again.');
    const result = this.store.transaction(() => {
      this.workspace(input.workspaceId); const createdAt = now();
      let skillId = preview.input.skillId;
      if (skillId) { const skill = this.skill(input.workspaceId, skillId); invariant(!skill.archived, 'SKILL_ARCHIVED', 'Archived Skill cannot receive new versions.'); this.revision(skill.revision, preview.expectedRevision); this.store.exec('UPDATE skills SET name=?,description=?,revision=revision+1 WHERE id=?', preview.name, preview.description, skillId); }
      else { skillId = `skill-${randomUUID()}`; this.store.exec('INSERT INTO skills(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)', skillId, input.workspaceId, preview.name, preview.description, createdAt); }
      const version = (this.store.get<{ latest: number }>('SELECT MAX(version) AS latest FROM skill_versions WHERE skill_id=?', skillId)?.latest ?? 0) + 1;
      const versionId = `skill-version-${randomUUID()}`;
      this.store.exec('INSERT INTO skill_versions(id,skill_id,version,instructions,source_directory,digest,manifest_json,requirements_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', versionId, skillId, version, preview.instructions, preview.sourceDirectory, preview.digest, JSON.stringify(preview.resources), JSON.stringify(preview.requirements), createdAt);
      return { skill: this.skill(input.workspaceId, skillId), version: this.version(input.workspaceId, versionId) };
    });
    this.previews.delete(input.previewId); return result;
  }

  setShared(workspaceId: string, skillId: string, input: { versionId: string; enabled: boolean; expectedRevision: number }): SkillShared {
    return this.store.transaction(() => { const skill = this.skill(workspaceId, skillId); invariant(!skill.archived || !input.enabled, 'SKILL_ARCHIVED', 'Archived Skills cannot be enabled.'); this.checkVersion(workspaceId, skillId, input.versionId);
      const existing = this.store.get<SkillShared>('SELECT * FROM skill_shared WHERE workspace_id=? AND skill_id=?', workspaceId, skillId); this.revision(existing?.revision ?? 0, input.expectedRevision);
      this.store.exec('INSERT INTO skill_shared(workspace_id,skill_id,version_id,enabled,revision) VALUES(?,?,?,?,1) ON CONFLICT(workspace_id,skill_id) DO UPDATE SET version_id=excluded.version_id,enabled=excluded.enabled,revision=skill_shared.revision+1', workspaceId, skillId, input.versionId, Number(input.enabled));
      return this.store.require<SkillShared>('SELECT * FROM skill_shared WHERE workspace_id=? AND skill_id=?', workspaceId, skillId);
    });
  }

  setAgent(workspaceId: string, agentId: string, skillId: string, input: { mode: SkillAssignment['mode']; versionId?: string; expectedRevision: number }): SkillAssignment {
    return this.store.transaction(() => { this.agent(workspaceId, agentId); const skill = this.skill(workspaceId, skillId); invariant(['include', 'exclude', 'inherit'].includes(input.mode), 'INVALID_SKILL_MODE', 'Unknown assignment mode.'); invariant(!skill.archived || input.mode !== 'include', 'SKILL_ARCHIVED', 'Archived Skills cannot be assigned.');
      invariant(input.mode !== 'include' || !!input.versionId, 'SKILL_VERSION_REQUIRED', 'An explicit version is required for an Agent assignment.');
      if (input.versionId) this.checkVersion(workspaceId, skillId, input.versionId);
      const existing = this.store.get<SkillAssignment>('SELECT * FROM skill_agent_assignments WHERE agent_id=? AND skill_id=?', agentId, skillId); this.revision(existing?.revision ?? 0, input.expectedRevision);
      this.store.exec('INSERT INTO skill_agent_assignments(workspace_id,agent_id,skill_id,mode,version_id,revision) VALUES(?,?,?,?,?,1) ON CONFLICT(agent_id,skill_id) DO UPDATE SET mode=excluded.mode,version_id=excluded.version_id,revision=skill_agent_assignments.revision+1', workspaceId, agentId, skillId, input.mode, input.mode === 'include' ? input.versionId! : null);
      return this.store.require<SkillAssignment>('SELECT * FROM skill_agent_assignments WHERE agent_id=? AND skill_id=?', agentId, skillId);
    });
  }

  resolveEffective(workspaceId: string, agentId: string, runtime: string | SkillRuntime): CompiledSkills {
    this.workspace(workspaceId); this.agent(workspaceId, agentId);
    const support: SkillRuntime = typeof runtime === 'string' ? { runtime } : runtime;
    const selected = new Map<string, { versionId: string; source: 'shared' | 'agent' }>();
    for (const shared of this.store.all<SkillShared>('SELECT * FROM skill_shared WHERE workspace_id=? AND enabled=1', workspaceId)) selected.set(shared.skillId, { versionId: shared.versionId, source: 'shared' });
    for (const assignment of this.store.all<SkillAssignment>('SELECT * FROM skill_agent_assignments WHERE workspace_id=? AND agent_id=?', workspaceId, agentId)) {
      if (assignment.mode === 'exclude') selected.delete(assignment.skillId);
      else if (assignment.mode === 'include') selected.set(assignment.skillId, { versionId: assignment.versionId!, source: 'agent' });
    }
    const compiled: CompiledSkills = { instructions: '', versions: [], resources: [] }; const names = new Set<string>(); const sections: string[] = [];
    for (const [skillId, selection] of [...selected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const skill = this.skill(workspaceId, skillId); invariant(!skill.archived, 'SKILL_ARCHIVED', `Skill ${skill.name} is archived; remove or replace its assignment.`);
      const normalized = skill.name.normalize('NFKC').toLocaleLowerCase(); invariant(!names.has(normalized), 'SKILL_NAME_CONFLICT', `Multiple Skills named ${skill.name} are effective; select one source explicitly.`); names.add(normalized);
      const version = this.checkVersion(workspaceId, skillId, selection.versionId);
      invariant(!version.requirements.runtimes.length || version.requirements.runtimes.includes(support.runtime), 'SKILL_INCOMPATIBLE', `Skill ${skill.name} does not support runtime ${support.runtime}.`);
      invariant(!version.requirements.resources || support.resources === true, 'SKILL_INCOMPATIBLE', `Skill ${skill.name} requires resource loading, which this runtime has not verified.`);
      invariant(!version.requirements.scripts || support.scripts === true, 'SKILL_INCOMPATIBLE', `Skill ${skill.name} contains scripts; explicit runtime support is required.`);
      compiled.versions.push({ skillId, versionId: version.id, version: version.version, name: skill.name, digest: version.digest, source: selection.source });
      compiled.resources.push(...version.resources.map(resource => ({ ...resource, skillId, versionId: version.id })));
      sections.push(`\n--- Skill: ${skill.name} (version ${version.version}, ${version.id}) ---\nThese instructions do not grant additional tool or filesystem permissions.\n${version.instructions}`);
    }
    compiled.instructions = sections.join('\n');
    invariant(Buffer.byteLength(compiled.instructions) <= MAX_PROMPT, 'SKILL_CONTEXT_LIMIT', 'Effective Skill instructions exceed 256 KiB; reduce the selected set.');
    return compiled;
  }

  snapshotExecution(workspaceId: string, agentId: string, ownerType: 'turn' | 'run', ownerId: string, compiled: CompiledSkills) {
    this.agent(workspaceId, agentId); invariant(['turn', 'run'].includes(ownerType) && ownerId.length > 0, 'INVALID_SKILL_OWNER', 'An execution owner is required.');
    for (const version of compiled.versions) this.checkVersion(workspaceId, version.skillId, version.versionId);
    this.store.exec('INSERT INTO skill_execution_snapshots(owner_type,owner_id,workspace_id,agent_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?)', ownerType, ownerId, workspaceId, agentId, JSON.stringify(compiled), now());
    return compiled;
  }

  archive(workspaceId: string, skillId: string, expectedRevision: number) {
    return this.store.transaction(() => { const skill = this.skill(workspaceId, skillId); this.revision(skill.revision, expectedRevision); this.store.exec('UPDATE skills SET archived=1,revision=revision+1 WHERE id=?', skillId); return this.skill(workspaceId, skillId); });
  }
}
