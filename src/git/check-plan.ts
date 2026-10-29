import type { CheckCommand, CheckPlan } from './types.js';

export function validateCheckPlan(commands: readonly CheckCommand[], plan?: CheckPlan): void {
  const invalid = () => { throw new Error('INVALID_CHECK_CONFIG: invalid check plan'); };
  if (plan && (!['dag', 'serial'].includes(plan.mode) || Object.keys(plan).some(key => !['mode', 'maxConcurrency', 'resourceSlots'].includes(key)) || !Number.isSafeInteger(plan.maxConcurrency ?? 2) || (plan.maxConcurrency ?? 2) < 1 || (plan.maxConcurrency ?? 2) > 64 || !Number.isSafeInteger(plan.resourceSlots ?? 2) || (plan.resourceSlots ?? 2) < 1 || (plan.resourceSlots ?? 2) > 64 || plan.mode === 'serial' && plan.maxConcurrency !== undefined && plan.maxConcurrency !== 1)) invalid();
  const byId = new Map(commands.map(command => [command.id, command]));
  for (const command of commands) {
    if (!plan && [command.dependsOn, command.mutexGroup, command.isolation, command.resourceSlots].some(value => value !== undefined)) invalid();
    if (command.dependsOn !== undefined && (!Array.isArray(command.dependsOn) || command.dependsOn.length > 64 || new Set(command.dependsOn).size !== command.dependsOn.length || command.dependsOn.some(id => typeof id !== 'string' || !byId.has(id)))) invalid();
    if (command.mutexGroup !== undefined && (typeof command.mutexGroup !== 'string' || !command.mutexGroup.trim() || command.mutexGroup.length > 160)) invalid();
    if (command.isolation !== undefined && !['snapshot', 'read_only'].includes(command.isolation)) invalid();
    if (plan?.mode === 'serial' && command.isolation === 'snapshot') invalid();
    if (command.resourceSlots !== undefined && (!Number.isSafeInteger(command.resourceSlots) || command.resourceSlots < 1 || command.resourceSlots > (plan?.resourceSlots ?? 2))) invalid();
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('INVALID_CHECK_CONFIG: dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const command of commands) visit(command.id);
}
