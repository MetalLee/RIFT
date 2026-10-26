import type { AgentTurn } from './contracts.js';
import type { RiftStore } from '../storage/database.js';
import { now } from '../storage/database.js';
import { redact } from '../api/security.js';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown,limit=200):string|null=>typeof value==='string'?redact(value,limit):null;
/** One synchronous SQLite snapshot; it contains references and bounded evidence, never logs or diffs. */
export function captureTriggerContext(store:RiftStore,turn:AgentTurn):unknown {
  return store.transaction(()=>{
    const trigger=turn.triggerId?store.get<{workflowId:string;payload:unknown}>('SELECT workflow_id,payload FROM turn_triggers WHERE id=? AND workspace_id=?',turn.triggerId,turn.workspaceId):undefined;
    const workflowId=trigger?.workflowId??turn.configuration.messageTrigger?.workflowId;
    if(!workflowId)return null;
    const workflow=store.get<{id:string;status:string;version:number;planRevision:number}>('SELECT id,status,version,plan_revision FROM workflows WHERE id=? AND workspace_id=?',workflowId,turn.workspaceId);
    if(!workflow)return null;
    const taskIds=new Set<string>();let visited=0;
    const collect=(value:unknown,depth=0):void=>{if(++visited>80||depth>5)return;if(Array.isArray(value)){for(const child of value.slice(0,16))collect(child,depth+1);return;}const record=object(value);if(typeof record.taskId==='string')taskIds.add(record.taskId);if(typeof record.runId==='string'){const run=store.get<{taskId:string}>('SELECT r.task_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND t.workflow_id=?',record.runId,workflowId);if(run)taskIds.add(run.taskId);}for(const key of ['events','refs','tasks'])if(record[key])collect(record[key],depth+1);};
    collect(trigger?.payload);if(turn.configuration.messageTrigger?.taskId)taskIds.add(turn.configuration.messageTrigger.taskId);
    const available=store.all<{id:string}>('SELECT id FROM tasks WHERE workflow_id=? ORDER BY rowid DESC',workflowId);
    const selected=(taskIds.size?available.filter(task=>taskIds.has(task.id)):available).slice(0,8);
    const tasks=selected.map(({id})=>{
      const task=store.task(id);
      const integrations=store.all<{id:string;status:string;sourceHead:string;candidateHead:string|null;checkIds:string[];candidate:unknown;reviewRunId:string|null}>('SELECT id,status,source_head,candidate_head,check_ids,candidate,review_run_id FROM integrations WHERE task_id=? ORDER BY rowid DESC LIMIT 2',id).map(integration=>{
        const candidate=object(integration.candidate),checks=Array.isArray(candidate.checks)?candidate.checks.slice(0,20).map(value=>{const check=object(value);return{id:text(check.id),candidateHead:text(check.candidateHead),exitCode:typeof check.exitCode==='number'?check.exitCode:null};}):[];
        const run=integration.reviewRunId?store.get<{result:unknown;status:string;cleanupStatus:string}>('SELECT result,status,cleanup_status FROM runs WHERE id=? AND task_id=?',integration.reviewRunId,id):undefined;
        const review=object(run?.result);
        return{id:integration.id,status:integration.status,sourceHead:integration.sourceHead,candidateHead:integration.candidateHead,checkIds:integration.checkIds.slice(0,20),checks,checkEvidenceUnavailable:!Array.isArray(candidate.checks),review:run?{runId:integration.reviewRunId,status:run.status,cleanupStatus:run.cleanupStatus,verdict:text(review.verdict),reviewedCommit:text(review.reviewedCommit),findings:Array.isArray(review.findings)?review.findings.slice(0,5).map(value=>{const finding=object(value);return{severity:text(finding.severity,40),file:text(finding.file,200),line:typeof finding.line==='number'?finding.line:null,reason:text(finding.reason,400)};}):[]}:null};
      });
      return{id:task.id,title:redact(task.title,300),status:task.status,version:task.version,attempt:task.attempt,acceptedCommit:task.acceptedCommit,sourceHead:task.sourceHead,blockingReason:text(task.blockingReason,600),runs:store.all('SELECT id,purpose,status,cleanup_status,task_attempt FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 3',id),integrations};
    });
    return{capturedAt:now(),authority:'quoted-ledger-facts',workflow,tasks,omittedTasks:Math.max(0,(taskIds.size?taskIds.size:available.length)-tasks.length)};
  });
}
