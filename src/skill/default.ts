import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RiftStore } from '../storage/database.js';
import { now } from '../storage/database.js';

/** Seed once. Thereafter this is an ordinary, transferable, versioned Skill. */
export function installWorkspaceSkill(store: RiftStore, workspaceId: string): void {
  const lead = store.get<{id:string}>("SELECT id FROM roles WHERE workspace_id=? AND purpose='lead' AND enabled=1",workspaceId);
  if (!lead) return;
  const skillId = `skill-${workspaceId}-rift-cli`;
  if (store.get('SELECT id FROM skills WHERE id=?',skillId)) return;
  const instructions = readFileSync(new URL('../../skills/rift-workspace/SKILL.md',import.meta.url),'utf8');
  const versionId = `${skillId}-v1`, created = now();
  const requirements = {resources:false,scripts:false,runtimes:[]};
  const digest = createHash('sha256').update(JSON.stringify({instructions,resources:[],requirements})).digest('hex');
  store.transaction(()=>{
    store.exec('INSERT INTO skills(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)',skillId,workspaceId,'rift-workspace','Operate RIFT components in the current workspace through the scoped CLI.',created);
    store.exec('INSERT INTO skill_versions(id,skill_id,version,instructions,source_directory,digest,manifest_json,requirements_json,created_at) VALUES(?,?,1,?,?,?,?,?,?)',versionId,skillId,instructions,'builtin:rift-workspace',digest,'[]',JSON.stringify(requirements),created);
    store.exec("INSERT INTO skill_agent_assignments(workspace_id,agent_id,skill_id,mode,version_id,revision) VALUES(?,?,?,'include',?,1)",workspaceId,lead.id,skillId,versionId);
  });
}
