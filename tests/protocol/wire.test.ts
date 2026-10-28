import { expect, it } from 'vitest';
import type * as Protocol from '@rift/protocol';
import type * as Ui from '../../src/api/ui-contracts.js';
import type * as Chat from '../../src/chat/contracts.js';
import type * as Skill from '../../src/skill/service.js';
import type { WorkspaceEvent, WorkspaceEventPage } from '../../src/events/workspace-events.js';
import type { BrowserAgent } from '../../src/project/browser-agents.js';
import type { WorkspaceWorktree } from '../../src/project/repositories.js';
import type { WorktreeRemovalTarget } from '../../src/project/worktree-removals.js';
import type { CheckEvidence, ReviewReport } from '../../src/git/types.js';

type Compatible<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
// UUID branding from node:crypto is not part of the JSON wire format.
// Both directions catch dropped required fields and narrowed unions without executing server code.
const compatible: [
  Compatible<Protocol.UiSession, Ui.UiSession>,
  Compatible<Protocol.UiWorkspaceCreate, Ui.UiWorkspaceCreate>,
  Compatible<Protocol.UiWorkspaceList, Ui.UiWorkspaceList>,
  Compatible<Protocol.UiWorkspaceDetail, Ui.UiWorkspaceDetail>,
  Compatible<Protocol.ChatPage, Chat.ChatPage>,
  Compatible<Protocol.AgentTurn, Chat.AgentTurn>,
  Compatible<Protocol.WorkspaceEvent, WorkspaceEvent>,
  Compatible<Protocol.WorkspaceEventPage, WorkspaceEventPage>,
  Compatible<Protocol.BrowserAgent, BrowserAgent>,
  Compatible<Protocol.WorkspaceWorktree, WorkspaceWorktree>,
  Compatible<Protocol.WorktreeRemovalTarget, WorktreeRemovalTarget>,
  Compatible<Protocol.CheckEvidence, CheckEvidence>,
  Compatible<Protocol.ReviewReport, ReviewReport>,
  Compatible<Protocol.LibrarySkill[], ReturnType<Skill.SkillService['list']>>,
  Compatible<Protocol.SkillImportPreview, Omit<ReturnType<Skill.SkillService['previewImport']>, 'previewId'> & { previewId: string }>,
  Compatible<Protocol.CompiledSkills, Skill.CompiledSkills>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
it('retains all current browser wire shapes', () => { expect(compatible.every(Boolean)).toBe(true); });
