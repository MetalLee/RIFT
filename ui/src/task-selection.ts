import type { UiTask } from '@rift/protocol';

/** A linked object is detail context, never an extra matching result or page item. */
export function taskSelection(listed: UiTask[], linked: UiTask | null, selected: string | null) {
  const task = listed.find(t => t.id === selected) ?? linked ?? listed[0];
  const outsidePage = linked && !listed.some(t => t.id === linked.id) ? linked : null;
  return { task, outsidePage };
}
