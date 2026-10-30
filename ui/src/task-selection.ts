import type { UiTask } from '@rift/protocol';

/** A linked object is detail context, never an extra matching result or page item. */
export function taskSelection(listed: UiTask[], linked: UiTask | null, selected: string | null, taskId?: string) {
  const target = taskId ? listed.find(t => t.id === taskId) ?? (linked?.id === taskId ? linked : undefined) : undefined;
  const task = taskId ? target : listed.find(t => t.id === selected) ?? listed[0];
  const outsidePage = taskId && target && !listed.some(t => t.id === taskId) ? target : null;
  return { task, outsidePage };
}
