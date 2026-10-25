import { posix } from 'node:path';
import { invariant, type Task, type PlanTask } from '../contracts/index.js';
export function normalizeExpectedPaths(paths:string[]):string[] {
  return paths.map(path=>{ const normalized=path.replaceAll('\\','/').replace(/^\.\//,'').replace(/\/$/,''); invariant(normalized && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0'),'INVALID_PATH','Expected paths must stay inside the task checkout.'); return posix.normalize(normalized); });
}
export function pathsOverlap(left:readonly string[],right:readonly string[]):boolean {
  if(!left.length||!right.length) return true;
  return left.some(a=>right.some(b=> { const x=a.toLowerCase(),y=b.toLowerCase(); return x===y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || x.includes('*') || y.includes('*'); }));
}
export function validateDag(tasks:{id:string;dependsOn:string[]}[]):void {
  const byId=new Map(tasks.map(task=>[task.id,task.dependsOn]));
  invariant(byId.size===tasks.length,'DUPLICATE_TASK','Plan task IDs must be unique.');
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(taskId:string):void=>{ invariant(byId.has(taskId),'INVALID_DEPENDENCY',`Dependency ${taskId} is outside this workflow.`); invariant(!visiting.has(taskId),'DEPENDENCY_CYCLE','Plan contains a dependency cycle.'); if(visited.has(taskId)) return; visiting.add(taskId); for(const dependency of byId.get(taskId)??[]) visit(dependency); visiting.delete(taskId); visited.add(taskId); };
  for(const task of tasks) visit(task.id);
}
export function dependencyStatus(dependencies:Task[]):'ready'|'waiting'|'blocked' { if(dependencies.some(task=>['failed','cancelled','blocked'].includes(task.status))) return 'blocked'; return dependencies.every(task=>task.status==='succeeded'&&(task.kind==='analysis'||task.acceptedCommit))?'ready':'waiting'; }
export type { PlanTask };
