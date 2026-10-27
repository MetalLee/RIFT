import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UiWorkspaceDetail } from '../../src/api/ui-contracts';
import type { SkillAssignment } from '../../src/skill/service';
import { assignmentBody, assignmentReducer, emptyAssignments, initialDraft, isDirty, memberSummary, newer, type AssignmentState } from './skill-assignment';

// Render without the app-only Tailwind/Radix aliases.
const passthrough = (tag: string) => ({ asChild: _a, variant: _v, ...props }: Record<string, unknown>) => React.createElement(asChildTag(_a, tag), props);
const asChildTag = (asChild: unknown, tag: string) => asChild ? React.Fragment : tag;
vi.mock('./components/ui/button', () => ({ Button: passthrough('button') }));
vi.mock('./components/ui/card', () => ({ Card: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./components/ui/input', () => ({ Input: passthrough('input') }));
vi.mock('./components/ui/native-select', () => ({ NativeSelect: passthrough('select'), NativeSelectOption: passthrough('option') }));
vi.mock('./components/ui/tabs', () => ({ Tabs: passthrough('div'), TabsList: passthrough('div'), TabsTrigger: passthrough('button'), TabsContent: passthrough('div') }));
vi.mock('./MessageBody', () => ({ MessageBody: ({ text }: { text: string }) => React.createElement('div', { className: 'md' }, text) }));
vi.mock('./App', () => ({
  Copy: ({ value }: { value: string }) => React.createElement('code', null, value), Empty: ({ title, children }: { title: string; children: React.ReactNode }) => React.createElement('div', { className: 'empty' }, title, children),
  Heading: () => null, Icon: () => null, Notice: ({ children }: { children: React.ReactNode }) => React.createElement('div', { className: 'notice' }, children), Pill: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}));
const { SkillDetail } = await import('./SkillLibrary');

const versions = [{ id: 'v3', version: 3 }, { id: 'v2', version: 2 }, { id: 'v1', version: 1 }];
const shared = { workspaceId: 'w', skillId: 's', versionId: 'v2', enabled: 1, revision: 4 };
const skill = { versions, shared, archived: 0 };
const row = (agentId: string, mode: SkillAssignment['mode'], versionId: string | null, revision: number): SkillAssignment => ({ workspaceId: 'w', agentId, skillId: 's', mode, versionId, revision });

describe('member assignment drafts', () => {
  it('starts include from the member\'s actual version, independent of shared/preview selection', () => {
    expect(initialDraft(skill, 'a', row('a', 'include', 'v1', 2))).toEqual({ agentId: 'a', mode: 'include', versionId: 'v1', baseRevision: 2 });
    expect(initialDraft(skill, 'b', undefined)).toMatchObject({ mode: 'inherit', versionId: 'v2', baseRevision: 0 });
    expect(initialDraft({ ...skill, shared: null }, 'b', undefined).versionId).toBe('v3');
  });
  it('sends versionId only for include and keeps the inherit row revision (never resets to 0)', () => {
    expect(assignmentBody({ agentId: 'a', mode: 'include', versionId: 'v1', baseRevision: 2 })).toEqual({ mode: 'include', versionId: 'v1', expectedRevision: 2 });
    expect(assignmentBody({ agentId: 'a', mode: 'inherit', versionId: 'v1', baseRevision: 5 })).toEqual({ mode: 'inherit', expectedRevision: 5 });
    expect(assignmentBody({ agentId: 'a', mode: 'exclude', versionId: 'v1', baseRevision: 1 })).toEqual({ mode: 'exclude', expectedRevision: 1 });
  });
  it('detects unsaved changes and summarises inherit/include/exclude', () => {
    expect(isDirty(initialDraft(skill, 'a', row('a', 'inherit', null, 3)), row('a', 'inherit', null, 3))).toBe(false);
    expect(isDirty({ agentId: 'a', mode: 'include', versionId: 'v3', baseRevision: 1 }, row('a', 'include', 'v1', 1))).toBe(true);
    expect(memberSummary(skill, undefined).label).toBe('继承共享 · 版本 2');
    expect(memberSummary({ ...skill, shared: { ...shared, enabled: 0 } }, undefined).label).toBe('继承 · 未生效');
    expect(memberSummary(skill, row('a', 'include', 'v1', 1)).label).toBe('专属 · 版本 1');
    expect(memberSummary({ ...skill, archived: 1 }, row('a', 'include', 'v1', 1)).detail).toContain('已归档');
    expect(memberSummary(skill, row('a', 'exclude', null, 1)).label).toBe('已排除');
  });
  it('keeps each member\'s draft separate when switching and ignores stale responses', () => {
    let s: AssignmentState = assignmentReducer(emptyAssignments, { type: 'open', agentId: 'a', skill, current: undefined });
    s = assignmentReducer(s, { type: 'change', agentId: 'a', mode: 'include', versionId: 'v3' });
    s = assignmentReducer(s, { type: 'open', agentId: 'b', skill, current: row('b', 'exclude', null, 1) });
    expect(s.open).toBe('b'); expect(s.drafts.a).toMatchObject({ mode: 'include', versionId: 'v3' }); expect(s.drafts.b.mode).toBe('exclude');
    s = assignmentReducer(s, { type: 'saveStart', agentId: 'a', requestId: 1 });
    s = assignmentReducer(s, { type: 'saveStart', agentId: 'a', requestId: 2 });
    const stale = assignmentReducer(s, { type: 'saveDone', agentId: 'a', requestId: 1, assignment: row('a', 'include', 'v3', 1) });
    expect(stale).toBe(s);
    s = assignmentReducer(s, { type: 'saveDone', agentId: 'a', requestId: 2, assignment: row('a', 'include', 'v3', 1) });
    expect(s.drafts.a).toBeUndefined(); expect(s.status.a).toEqual({ kind: 'saved' }); expect(s.saved.a.revision).toBe(1); expect(s.open).toBe('b');
  });
  it('keeps the draft on conflict and only rebases on explicit reload', () => {
    let s = assignmentReducer(emptyAssignments, { type: 'open', agentId: 'a', skill, current: row('a', 'inherit', null, 2) });
    s = assignmentReducer(s, { type: 'change', agentId: 'a', mode: 'exclude' });
    s = assignmentReducer(s, { type: 'saveStart', agentId: 'a', requestId: 1 });
    s = assignmentReducer(s, { type: 'saveFailed', agentId: 'a', requestId: 1, message: 'Configuration changed (current revision 3); reload before saving.', conflict: true });
    expect(s.drafts.a).toMatchObject({ mode: 'exclude', baseRevision: 2 }); expect(s.status.a).toMatchObject({ kind: 'error', conflict: true });
    s = assignmentReducer(s, { type: 'reload', agentId: 'a', skill, current: row('a', 'include', 'v1', 3) });
    expect(s.drafts.a).toEqual({ agentId: 'a', mode: 'include', versionId: 'v1', baseRevision: 3 }); expect(s.status.a).toBeUndefined();
  });
  it('prefers the newer of a saved result and the refreshed list', () => {
    expect(newer(row('a', 'include', 'v1', 2), row('a', 'inherit', null, 3))?.mode).toBe('inherit');
    expect(newer(row('a', 'include', 'v1', 2), undefined)?.mode).toBe('include');
  });
});

describe('SkillDetail rendering', () => {
  const data = { workspace: { id: 'w', version: 1 }, roles: [{ id: 'a', name: 'a', displayName: '一个非常非常长的成员名称用于检查换行', version: 1 }, { id: 'b', name: 'b', displayName: '', version: 1 }], leadConfiguration: { runtime: 'dsh' } } as unknown as UiWorkspaceDetail;
  const full = { id: 's', workspaceId: 'w', name: 'Skill', description: 'desc', archived: 0, revision: 1, createdAt: '2026-01-01', shared, assignments: [row('a', 'include', 'v1', 2)],
    versions: versions.map(v => ({ ...v, skillId: 's', instructions: `# Body ${v.version}`, sourceDirectory: '/x', digest: `d${v.version}`, resources: [], requirements: { resources: false, scripts: false, runtimes: [] }, createdAt: '2026-01-01' })) };
  it('collapses the document by default, drops SCOPE/VERSION chips and lists member modes', () => {
    const html = renderToStaticMarkup(<SkillDetail skill={full} data={data} csrf="c" onChanged={async () => {}} />);
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('展开正文'); expect(html).toContain('<div id="skill-body-s" hidden=""></div>'); expect(html).not.toContain('class="md"');
    expect(html).not.toContain('SCOPE'); expect(html).not.toContain('VERSION:');
    expect(html).toContain('专属 · 版本 1'); expect(html).toContain('继承共享 · 版本 2'); expect(html).toContain('一个非常非常长的成员名称用于检查换行');
  });
  it('explains empty members and keeps unshare available for archived skills', () => {
    const html = renderToStaticMarkup(<SkillDetail skill={{ ...full, archived: 1 }} data={{ ...data, roles: [] } as UiWorkspaceDetail} csrf="c" onChanged={async () => {}} />);
    expect(html).toContain('工作区暂无成员'); expect(html).toContain('撤销默认共享'); expect(html).not.toContain('归档此 Skill');
  });
});
