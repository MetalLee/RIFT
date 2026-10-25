import { posix } from 'node:path';
import { invariant, type Task, type PlanTask } from '../contracts/index.js';
export interface SchedulerLimits { developers:number; total:number; maxTasks:number; maxReplans:number; agingMs:number }
export function schedulerLimits(input:Partial<SchedulerLimits>={}):SchedulerLimits {
  const limits={developers:2,total:(input.developers??2)+1,maxTasks:1000,maxReplans:100,agingMs:60_000,...input};
  for(const [field,min,max] of [['developers',1,128],['total',2,129],['maxTasks',1,10000],['maxReplans',0,1000],['agingMs',1,3600000]] as const)invariant(Number.isInteger(limits[field])&&limits[field]>=min&&limits[field]<=max,'INVALID_LIMITS',`${field} must be an integer between ${min} and ${max}.`);
  invariant(limits.total>limits.developers,'INVALID_LIMITS','Global total must reserve at least one slot beyond the developer budget for serial review.');
  return limits;
}
export function validatePriority(value:number):number {invariant(Number.isInteger(value)&&value>=-100&&value<=100,'INVALID_PRIORITY','Priority must be an integer between -100 and 100.');return value;}
/** Round-robin across workflows; aging prevents starvation inside each workflow. */
export function schedulingOrder<T extends {createdAt:string;priority:number;lastScheduled:number;sequence:number}>(entries:T[],agingMs:number,clock=Date.now()):T[] {
  const score=(entry:T)=>entry.priority+Math.floor(Math.max(0,clock-Date.parse(entry.createdAt))/agingMs);
  return entries.sort((a,b)=>a.lastScheduled-b.lastScheduled||score(b)-score(a)||a.sequence-b.sequence);
}
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
  const remaining=new Map<string,number>(),successors=new Map<string,string[]>(),ready:string[]=[];
  for(const task of tasks){
    invariant(new Set(task.dependsOn).size===task.dependsOn.length,'INVALID_DEPENDENCY','Task dependencies must be unique.');
    remaining.set(task.id,task.dependsOn.length);if(!task.dependsOn.length)ready.push(task.id);
    for(const dependency of task.dependsOn){invariant(byId.has(dependency),'INVALID_DEPENDENCY',`Dependency ${dependency} is outside this workflow.`);const children=successors.get(dependency)??[];children.push(task.id);successors.set(dependency,children);}
  }
  for(let index=0;index<ready.length;index++)for(const next of successors.get(ready[index]!)??[]){const count=remaining.get(next)!-1;remaining.set(next,count);if(count===0)ready.push(next);}
  invariant(ready.length===tasks.length,'DEPENDENCY_CYCLE','Plan contains a dependency cycle.');
}
export function dependencyStatus(dependencies:Task[]):'ready'|'waiting'|'blocked' { if(dependencies.some(task=>['failed','cancelled','blocked'].includes(task.status))) return 'blocked'; return dependencies.every(task=>task.status==='succeeded'&&(task.kind==='analysis'||task.acceptedCommit))?'ready':'waiting'; }
export type { PlanTask };
