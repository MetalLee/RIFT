import { describe, expect, it } from 'vitest';
import type { UiWorkspaceDetail, WorkspaceWorktree, WorktreeRemovalTarget } from '@rift/protocol';
import { repositoryWorktreeList, isCurrentRemoval, isCurrentWorktree } from './worktree-list';

describe('current work directories versus retained history', () => {
  it.each(['deleted','missing','unavailable'])('does not display %s removal history as a current directory', state => {
    expect(isCurrentRemoval(state)).toBe(false);
    expect(isCurrentWorktree('active', state)).toBe(false);
  });
  it.each(['archived','detached','creation_failed'])('excludes %s worktree records', status => {
    expect(isCurrentWorktree(status)).toBe(false);
  });
  it.each(['available','deleting','unknown','failed'])('keeps %s deletion controls visible for actual or uncertain targets', state => {
    expect(isCurrentRemoval(state)).toBe(true);
    expect(isCurrentWorktree('active', state)).toBe(true);
  });
  it('keeps unfinished creation/movement and ordinary active directories visible', () => {
    for (const status of ['active','creating','creation_unknown','moving','move_unknown']) expect(isCurrentWorktree(status)).toBe(true);
  });
});

describe('repository list and metric share the same population', () => {
  const data = {
    repositories: [{ id: 'one' }, { id: 'two' }],
    tasks: [{ id: 't1', repositoryId: 'one' }, { id: 't2', repositoryId: 'two' }, { id: 'legacy' }],
    worktrees: [
      { id: 'task-active', taskId: 't1', status: 'active' },
      { id: 'task-missing', taskId: 't1', status: 'active' },
      { id: 'task-archived', taskId: 't1', status: 'archived' },
      { id: 'other', taskId: 't2', status: 'active' },
      { id: 'legacy', taskId: 'legacy', status: 'active' },
    ],
    // Deliberately stale: user records must come from the repository inventory instead.
    managedWorktrees: [],
  } as unknown as UiWorkspaceDetail;
  const trees = [
    { id: 'user-active', status: 'active' },
    { id: 'user-deleted', status: 'active' },
    { id: 'user-detached', status: 'detached' },
    { id: 'user-failed', status: 'creation_failed' },
  ] as WorkspaceWorktree[];
  const removals = [
    { kind: 'user', recordId: 'user-deleted', state: 'deleted' },
    { kind: 'task', recordId: 'task-missing', state: 'missing' },
    { kind: 'candidate', recordId: 'integration', state: 'available' },
    { kind: 'review', recordId: 'integration', state: 'available' },
    { kind: 'candidate', recordId: 'old', state: 'unavailable' },
    { kind: 'review', recordId: 'old', state: 'deleted' },
  ] as WorktreeRemovalTarget[];
  it('counts exactly the default user/task/candidate/review rows, not stale workspace totals', () => {
    const list = repositoryWorktreeList(data, 'one', trees, removals);
    expect(list.visibleTrees.map(t => t.id)).toEqual(['user-active']);
    expect(list.taskTrees.map(t => t.id)).toEqual(['task-active']);
    expect(list.candidateTrees.map(t => t.kind)).toEqual(['candidate', 'review']);
    expect(list.currentCount).toBe(4);
    expect(list.currentCount).toBe(list.visibleTrees.length + list.taskTrees.length + list.candidateTrees.length);
    expect(list.historyCount).toBe(7);
  });
  it('shows retained history without changing the current metric', () => {
    const list = repositoryWorktreeList(data, 'one', trees, removals, true);
    expect(list.currentCount).toBe(4);
    expect(list.visibleTrees.length + list.taskTrees.length + list.candidateTrees.length).toBe(11);
    expect(list.historyCount).toBe(7);
  });
  it('assigns legacy tasks only to a sole repository and does not double count across repositories', () => {
    expect(repositoryWorktreeList(data, 'two', [], []).taskTrees.map(t => t.id)).toEqual(['other']);
    expect(repositoryWorktreeList({ ...data, repositories: [data.repositories[0]!] }, 'one', [], removals).taskTrees.map(t => t.id)).toEqual(['task-active', 'legacy']);
  });
  it.each(['available', 'deleting', 'unknown', 'failed'])('retains %s targets and their recovery controls in the current population', state => {
    const list = repositoryWorktreeList(data, 'two', [], [{ kind: 'review', recordId: 'review', state } as WorktreeRemovalTarget]);
    expect(list.currentCount).toBe(2);
    expect(list.candidateTrees[0]?.state).toBe(state);
  });
});
