import type { SkillAssignment, SkillShared, SkillVersion } from '@rift/protocol';

export type AssignmentMode = SkillAssignment['mode'];
type Versions = Pick<SkillVersion, 'id' | 'version'>[];
export interface SkillView { versions: Versions; shared: SkillShared | null; archived: number }
export interface AssignmentDraft { agentId: string; mode: AssignmentMode; versionId: string; baseRevision: number }
export type SaveStatus = { kind: 'saving'; requestId: number } | { kind: 'saved' } | { kind: 'error'; message: string; conflict: boolean };
/** Drafts are keyed per member so switching rows never mixes one member's edit into another's. */
export interface AssignmentState { saved: Record<string, SkillAssignment>; drafts: Record<string, AssignmentDraft>; open: string | null; status: Record<string, SaveStatus | undefined> }
export type AssignmentAction =
  | { type: 'open'; agentId: string; skill: SkillView; current: SkillAssignment | undefined }
  | { type: 'close' }
  | { type: 'change'; agentId: string; mode?: AssignmentMode; versionId?: string }
  | { type: 'discard'; agentId: string }
  | { type: 'saveStart'; agentId: string; requestId: number }
  | { type: 'saveDone'; agentId: string; requestId: number; assignment: SkillAssignment }
  | { type: 'saveFailed'; agentId: string; requestId: number; message: string; conflict: boolean }
  | { type: 'reload'; agentId: string; skill: SkillView; current: SkillAssignment | undefined };

export const emptyAssignments: AssignmentState = { saved: {}, drafts: {}, open: null, status: {} };

/** The version the member actually receives today, else the newest version as a starting point. */
export function initialDraft(skill: SkillView, agentId: string, assignment: SkillAssignment | undefined): AssignmentDraft {
  const actual = assignment?.mode === 'include' ? assignment.versionId : assignment?.mode !== 'exclude' && skill.shared?.enabled ? skill.shared.versionId : null;
  return { agentId, mode: assignment?.mode ?? 'inherit', versionId: actual ?? skill.versions[0]?.id ?? '', baseRevision: assignment?.revision ?? 0 };
}

export function isDirty(draft: AssignmentDraft, assignment: SkillAssignment | undefined): boolean {
  const mode = assignment?.mode ?? 'inherit';
  return draft.mode !== mode || draft.mode === 'include' && draft.versionId !== assignment?.versionId;
}

/** Request body: inherit/exclude never carry a versionId; revision is the one the draft was based on. */
export function assignmentBody(draft: AssignmentDraft) {
  return { mode: draft.mode, ...(draft.mode === 'include' ? { versionId: draft.versionId } : {}), expectedRevision: draft.baseRevision };
}

/** Prefer whichever copy is newer: our saved result or the latest server list. */
export function newer<T extends { revision: number }>(a: T | null | undefined, b: T | null | undefined): T | undefined {
  return (a?.revision ?? 0) >= (b?.revision ?? 0) ? a ?? b ?? undefined : b ?? undefined;
}

export function memberSummary(skill: SkillView, assignment: SkillAssignment | undefined): { mode: AssignmentMode; label: string; detail: string } {
  const version = (id: string | null | undefined) => skill.versions.find(v => v.id === id)?.version ?? '未知';
  const mode = assignment?.mode ?? 'inherit';
  if (mode === 'include') return { mode, label: `专属 · 版本 ${version(assignment?.versionId)}`, detail: skill.archived ? 'Skill 已归档，此专属分配将导致执行失败；请改为继承或排除。' : '固定使用此版本，不随共享版本变化。' };
  if (mode === 'exclude') return { mode, label: '已排除', detail: '即使工作区共享，此成员也不会加载。' };
  return skill.shared?.enabled
    ? { mode, label: `继承共享 · 版本 ${version(skill.shared.versionId)}`, detail: '跟随工作区共享版本。' }
    : { mode, label: '继承 · 未生效', detail: '工作区未共享此 Skill，此成员当前不会加载。' };
}

export function assignmentReducer(state: AssignmentState, action: AssignmentAction): AssignmentState {
  const set = <K extends 'drafts' | 'status'>(key: K, agentId: string, value: AssignmentState[K][string] | undefined) => { const next = { ...state[key] } as Record<string, unknown>; if (value === undefined) delete next[agentId]; else next[agentId] = value; return next as AssignmentState[K]; };
  switch (action.type) {
    case 'open': return { ...state, open: action.agentId, drafts: state.drafts[action.agentId] ? state.drafts : set('drafts', action.agentId, initialDraft(action.skill, action.agentId, action.current)), status: state.status[action.agentId]?.kind === 'saved' ? set('status', action.agentId, undefined) : state.status };
    case 'close': return { ...state, open: null };
    case 'change': { const draft = state.drafts[action.agentId]; return draft ? { ...state, drafts: set('drafts', action.agentId, { ...draft, ...(action.mode ? { mode: action.mode } : {}), ...(action.versionId ? { versionId: action.versionId } : {}) }), status: state.status[action.agentId]?.kind === 'saving' ? state.status : set('status', action.agentId, undefined) } : state; }
    case 'discard': return { ...state, open: state.open === action.agentId ? null : state.open, drafts: set('drafts', action.agentId, undefined), status: set('status', action.agentId, undefined) };
    case 'saveStart': return { ...state, status: set('status', action.agentId, { kind: 'saving', requestId: action.requestId }) };
    case 'saveDone': case 'saveFailed': {
      const current = state.status[action.agentId];
      if (current?.kind !== 'saving' || current.requestId !== action.requestId) return state; // stale or superseded response
      if (action.type === 'saveFailed') return { ...state, status: set('status', action.agentId, { kind: 'error', message: action.message, conflict: action.conflict }) };
      return { saved: { ...state.saved, [action.agentId]: action.assignment }, drafts: set('drafts', action.agentId, undefined), open: state.open === action.agentId ? null : state.open, status: set('status', action.agentId, { kind: 'saved' }) };
    }
    // Explicit user choice after a conflict: rebase the draft on the latest server row.
    case 'reload': return { ...state, drafts: set('drafts', action.agentId, initialDraft(action.skill, action.agentId, action.current)), status: set('status', action.agentId, undefined) };
  }
}
