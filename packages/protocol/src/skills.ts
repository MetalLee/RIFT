/** List and preview responses omit resource bytes. */
export interface SkillResourceSummary { path: string; bytes: number; sha256: string }
export interface SkillResource extends SkillResourceSummary { contentBase64: string }
export interface SkillRequirements { resources: boolean; scripts: boolean; runtimes: string[] }
export interface Skill { id: string; workspaceId: string; name: string; description: string; archived: number; revision: number; createdAt: string }
export interface SkillVersion { id: string; skillId: string; version: number; instructions: string; sourceDirectory: string; digest: string; resources: SkillResourceSummary[]; requirements: SkillRequirements; createdAt: string }
export interface SkillShared { workspaceId: string; skillId: string; versionId: string; enabled: number; revision: number }
export interface SkillAssignment { workspaceId: string; agentId: string; skillId: string; mode: 'include' | 'exclude' | 'inherit'; versionId: string | null; revision: number }
export interface SkillSnapshotVersion { skillId: string; versionId: string; version: number; name: string; digest: string; source: 'shared' | 'agent' }
export interface CompiledSkills { instructions: string; versions: SkillSnapshotVersion[]; resources: (SkillResource & { skillId: string; versionId: string })[] }
export interface LibrarySkill extends Skill { versions: SkillVersion[]; shared: SkillShared | null; assignments: SkillAssignment[] }
export interface SkillImportPreview {
  previewId: string; name: string; description: string; sourceDirectory: string;
  instructions: string; digest: string; requirements: SkillRequirements;
  resources: SkillResourceSummary[]; expiresAt: string; currentReferenceAgents: string[];
}
