import { expect, it } from 'vitest';
import type { UiTask } from '@rift/protocol';
import { taskSelection } from './task-selection';
const task = (id: string) => ({ id }) as UiTask;
it('does not insert linked tasks into filtered results or pagination', () => {
  const linked = task('succeeded-other-workflow-other-repository');
  for (const listed of [[task('running')], [task('page-2')], []]) {
    const before = [...listed];
    expect(taskSelection(listed, linked, null, linked.id)).toEqual({ task: linked, outsidePage: linked });
    expect(listed).toEqual(before);
  }
});
it('uses the matching page record and does not duplicate a legitimate link', () => {
  const current = task('linked');
  expect(taskSelection([current], task('linked'), null, 'linked')).toEqual({ task: current, outsidePage: null });
});
it('returns to an existing selection or the first matching task without a link', () => {
  const first = task('first'), selected = task('selected');
  expect(taskSelection([first, selected], null, 'selected').task).toBe(selected);
  expect(taskSelection([first], null, 'missing').task).toBe(first);
  expect(taskSelection([], null, null).task).toBeUndefined();
});

it('never defaults to another task while an explicit route is unresolved or failed', () => {
  const first = task('first');
  expect(taskSelection([first], null, 'first', 'remote')).toEqual({ task: undefined, outsidePage: null });
  expect(taskSelection([first], task('old-target'), 'first', 'remote')).toEqual({ task: undefined, outsidePage: null });
});
it('retains only the correct linked data during a same-target refresh', () => {
  const linked = task('remote');
  expect(taskSelection([task('first')], linked, 'first', 'remote')).toEqual({ task: linked, outsidePage: linked });
  expect(taskSelection([], linked, null, 'new-target')).toEqual({ task: undefined, outsidePage: null });
});
it('ignores stale linked data after returning to the list', () => {
  const first = task('first');
  expect(taskSelection([first], task('remote'), 'remote').task).toBe(first);
});
