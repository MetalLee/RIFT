import type { UiWorkspaceDetail, WorkspaceWorktree, WorktreeRemovalTarget } from '@rift/protocol';

/** Historical/absent entries are still inspectable without claiming a live directory. */
export function isCurrentRemoval(state: string): boolean {
  return !['deleted', 'missing', 'unavailable'].includes(state);
}
export function isCurrentWorktree(status?: string, removalState?: string): boolean {
  return !['archived', 'detached', 'creation_failed'].includes(status ?? '') && (removalState === undefined || isCurrentRemoval(removalState));
}

/** Use the same inventory and predicates for the metric and the visible rows. */
export function repositoryWorktreeList(data: UiWorkspaceDetail, repositoryId: string, trees: WorkspaceWorktree[], removals: WorktreeRemovalTarget[], showHistory = false) {
  const taskIds = new Set(data.tasks.filter(task => task.repositoryId === repositoryId || !task.repositoryId && data.repositories.length === 1).map(task => task.id));
  const allTaskTrees = data.worktrees.filter(tree => taskIds.has(tree.taskId));
  const allCandidateTrees = removals.filter(target => target.kind === 'candidate' || target.kind === 'review');
  const currentTree = (kind: 'user' | 'task', tree: { id: string; status?: string }) => isCurrentWorktree(tree.status, removals.find(item => item.kind === kind && item.recordId === tree.id)?.state);
  const currentTrees = trees.filter(tree => currentTree('user', tree));
  const currentTaskTrees = allTaskTrees.filter(tree => currentTree('task', tree));
  const currentCandidateTrees = allCandidateTrees.filter(target => isCurrentRemoval(target.state));
  const currentCount = currentTrees.length + currentTaskTrees.length + currentCandidateTrees.length;
  return {
    visibleTrees: showHistory ? trees : currentTrees,
    taskTrees: showHistory ? allTaskTrees : currentTaskTrees,
    candidateTrees: showHistory ? allCandidateTrees : currentCandidateTrees,
    currentCount,
    historyCount: trees.length + allTaskTrees.length + allCandidateTrees.length - currentCount,
  };
}
