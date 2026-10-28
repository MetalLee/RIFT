/** Historical/absent entries are still inspectable without claiming a live directory. */
export function isCurrentRemoval(state: string): boolean {
  return !['deleted', 'missing', 'unavailable'].includes(state);
}
export function isCurrentWorktree(status?: string, removalState?: string): boolean {
  return !['archived', 'detached', 'creation_failed'].includes(status ?? '') && (removalState === undefined || isCurrentRemoval(removalState));
}
