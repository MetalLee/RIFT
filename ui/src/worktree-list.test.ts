import { describe, expect, it } from 'vitest';
import { isCurrentRemoval, isCurrentWorktree } from './worktree-list';

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
