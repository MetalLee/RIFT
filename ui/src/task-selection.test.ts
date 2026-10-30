import { expect, it } from 'vitest';
import type { UiTask } from '@rift/protocol';
import { taskSelection } from './task-selection';
const task = (id: string) => ({ id }) as UiTask;
it('does not insert linked tasks into filtered results or pagination', () => {
  const linked = task('succeeded-other-workflow-other-repository');
  for (const listed of [[task('running')], [task('page-2')], []]) {
    const before = [...listed];
    expect(taskSelection(listed, linked, linked.id)).toEqual({ task: linked, outsidePage: linked });
    expect(listed).toEqual(before);
  }
});
it('uses the matching page record and does not duplicate a legitimate link', () => {
  const current = task('linked');
  expect(taskSelection([current], task('linked'), 'linked')).toEqual({ task: current, outsidePage: null });
});
it('returns to an existing selection or the first matching task without a link', () => {
  const first = task('first'), selected = task('selected');
  expect(taskSelection([first, selected], null, 'selected').task).toBe(selected);
  expect(taskSelection([first], null, 'missing').task).toBe(first);
  expect(taskSelection([], null, null).task).toBeUndefined();
});
