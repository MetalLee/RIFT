import type { UiTask } from '@rift/protocol';
/** Stable topological order. Missing/cyclic evidence remains visible at the end instead of being discarded. */
export function dependencyOrder(tasks: UiTask[]): UiTask[] {
  const byId = new Map(tasks.map(task => [task.id, task])); const remaining = new Map<string, number>(); const dependents = new Map<string, string[]>();
  for (const task of tasks) { const dependencies = [...new Set(task.dependsOn)].filter(id => byId.has(id)); remaining.set(task.id, dependencies.length); for (const dependency of dependencies) dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]); }
  const queue = tasks.filter(task => remaining.get(task.id) === 0); const result: UiTask[] = [];
  for (let index = 0; index < queue.length; index++) { const task = queue[index]; result.push(task); for (const id of dependents.get(task.id) ?? []) { remaining.set(id, remaining.get(id)! - 1); if (remaining.get(id) === 0) queue.push(byId.get(id)!); } }
  const seen = new Set(result.map(task => task.id)); return [...result, ...tasks.filter(task => !seen.has(task.id))];
}
