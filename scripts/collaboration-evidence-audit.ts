/** Independently audit a completed real probe's fixed commits and ledger evidence. */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const source=JSON.parse(await readFile('docs/evidence/collaboration-real-astra-probe.json','utf8'));
if(source.status!=='pass')throw Error('Requires a completed real probe.');
const db=new DatabaseSync(path.join(source.temporary,'host','rift.db'),{readOnly:true});
const exec=promisify(execFile),repository=path.join(source.temporary,'repository');
const git=async(...args:string[])=>(await exec('git',['-C',repository,...args],{windowsHide:true})).stdout.trim();
const integrations=db.prepare('SELECT * FROM integrations ORDER BY rowid').all() as any[];
const records=[];
for(const integration of integrations){
  const candidate=JSON.parse(integration.candidate),run=db.prepare('SELECT * FROM runs WHERE id=?').get(integration.review_run_id) as any,review=JSON.parse(run.result);
  const checks=candidate.checks as {id:string;candidateHead:string;exitCode:number}[];
  if(review.reviewedCommit!==candidate.candidateHead||!checks.length||checks.some(check=>check.candidateHead!==candidate.candidateHead||check.exitCode!==0)||run.cleanup_status!=='confirmed')throw Error('Candidate/check/review identity or cleanup mismatch.');
  records.push({taskId:integration.task_id,status:integration.status,candidateHead:candidate.candidateHead,reviewedCommit:review.reviewedCommit,verdict:review.verdict,checks:checks.map(({id,candidateHead,exitCode})=>({id,candidateHead,exitCode})),reviewCleanup:run.cleanup_status});
}
const workflow=db.prepare('SELECT * FROM workflows').get() as any,finalHead=await git('rev-parse',workflow.integration_ref);
if(finalHead!==source.acceptedCommit||workflow.status!=='completed')throw Error('Final accepted ref mismatch.');
const ageSource=await git('show',`${finalHead}:age.mjs`),labelSource=await git('show',`${finalHead}:label.mjs`);
const {classifyAge}=await import(`data:text/javascript,${encodeURIComponent(ageSource)}`),{label}=await import(`data:text/javascript,${encodeURIComponent(labelSource)}`);
for(const age of [0,1,17])if(classifyAge(age)!=='minor')throw Error('Minor boundary failed');
for(const age of [18,19,20,21,99])if(classifyAge(age)!=='adult')throw Error('Adult boundary failed');
for(const age of [-1,1.5,'18',null]){let rejected=false;try{classifyAge(age);}catch(error){rejected=error instanceof RangeError;}if(!rejected)throw Error('Invalid input accepted');}
if(label!=='RIFT stable')throw Error('Sibling change lost');
if(await git('diff',workflow.base_commit,finalHead,'--','test.mjs','README.md'))throw Error('Unassigned files changed');
if(await git('status','--porcelain'))throw Error('Original checkout changed');
const runs=db.prepare('SELECT id,task_id,purpose,status,cleanup_status,slot_released_at FROM runs').all() as any[];
if(runs.some(run=>run.cleanup_status!=='confirmed'||!run.slot_released_at)||db.prepare('SELECT id FROM execution_leases WHERE released_at IS NULL').get())throw Error('Execution cleanup incomplete');
const report={date:new Date().toISOString(),status:'pass',mode:'read-only SQLite plus exact git object semantic verification, after real model probe closed',acceptedCommit:finalHead,records,runs,checks:{exactCandidateReview:true,checksBoundToCommit:true,fullAgeBoundary:true,independentLabelPreserved:true,unassignedFilesUnchanged:true,originalCheckoutClean:true,allCleanupConfirmed:true}};
db.close();await writeFile('docs/evidence/collaboration-exact-commit-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
