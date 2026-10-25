import { expect, it } from 'vitest';
import type { UiTask } from '../../src/api/ui-contracts';
import { dependencyOrder } from './task-order';
it('orders prerequisites first without mutating server snapshots or losing unresolved evidence', () => {
  const task = (id: string, dependsOn: string[] = []) => ({ id, dependsOn } as UiTask);
  const input = [task('end', ['middle']), task('middle', ['start']), task('start'), task('outside', ['missing'])];
  expect(dependencyOrder(input).map(t => t.id)).toEqual(['start', 'outside', 'middle', 'end']);
  expect(input.map(t => t.id)).toEqual(['end', 'middle', 'start', 'outside']);
  expect(dependencyOrder([task('a', ['b']), task('b', ['a'])]).map(t => t.id)).toEqual(['a', 'b']);
});
