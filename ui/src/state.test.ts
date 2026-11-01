import { describe, expect, it, vi } from 'vitest';
import { LatestRequest, parseRoute, readDraft, routeHref, saveDraft, taskHref } from './state';

describe('workspace isolation', () => {
  it('aborts the previous request and rejects a response that ignored cancellation', async () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
    requests.cancel();
    expect(second.current()).toBe(false);
  });
  it('keeps drafts separate even when names/IDs contain routing punctuation', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    try {
      saveDraft('one/two', '第一份草稿');
      saveDraft('one%2Ftwo', '另一份草稿');
      expect(readDraft('one/two')).toBe('第一份草稿');
      expect(readDraft('one%2Ftwo')).toBe('另一份草稿');
      expect(readDraft('new-workspace')).toBe('');
    } finally { vi.unstubAllGlobals(); }
  });
  it('preserves encoded IDs and safely falls back from malformed routes', () => {
    expect(parseRoute(routeHref('团队/a#b', 'tasks'))).toEqual({ workspaceId: '团队/a#b', page: 'tasks' });
    expect(parseRoute('#/workspace/%zz/tasks').workspaceId).toBe('');
    expect(parseRoute('#/workspace/ws/unknown')).toEqual({ workspaceId: 'ws', page: 'chat' });
  });
  it('reports storage failure without throwing or losing the active in-memory edit', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } });
    try { expect(readDraft('ws')).toBe(''); expect(saveDraft('ws', 'draft')).toBe(false); } finally { vi.unstubAllGlobals(); }
  });
});

it('preserves validated settings tabs independently of task deep links', () => {
  expect(parseRoute('#/workspace/w/settings?tab=connections')).toEqual({ workspaceId: 'w', page: 'settings', settingsTab: 'connections' });
  expect(parseRoute('#/workspace/w/settings?tab=invalid')).toEqual({ workspaceId: 'w', page: 'settings' });
  expect(parseRoute('#/workspace/w/tasks?task=one%2Ftwo&tab=session')).toEqual({ workspaceId: 'w', page: 'tasks', taskId: 'one/two' });
});

it('keeps task links limited to the existing task contract and ignores workflow parameters', () => {
  expect(taskHref('团队/a', 'task/b')).toBe('#/workspace/%E5%9B%A2%E9%98%9F%2Fa/tasks?task=task%2Fb');
  expect(parseRoute(taskHref('团队/a', 'task/b'))).toEqual({ workspaceId: '团队/a', page: 'tasks', taskId: 'task/b' });
  expect(parseRoute('#/workspace/w/tasks?workflow=wf')).toEqual({ workspaceId: 'w', page: 'tasks' });
  expect(parseRoute('#/workspace/w/tasks?task=one&workflow=wf')).toEqual({ workspaceId: 'w', page: 'tasks', taskId: 'one' });
  expect(parseRoute('#/workspace/w/settings?tab=session&workflow=wf')).toEqual({ workspaceId: 'w', page: 'settings', settingsTab: 'session' });
});
