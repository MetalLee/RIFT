import { afterEach, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftHostService } from '../../src/api/host-service.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { configureRoles } from '../../src/project/agent-roles.js';
import { gitOk } from '../../src/git/process.js';
import { CandidateEvidenceError } from '../../src/git/evidence.js';
import type { Candidate, Run } from '../../src/contracts/index.js';
import type { TaskEvidence, CheckEvidence } from '@rift/protocol';
import type { RuntimeTool } from '../../src/agent/runtime-types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'rift-host-evidence-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo');await mkdir(repo);await gitOk(repo,['init','-b','main']);await gitOk(repo,['config','user.name','Test']);await gitOk(repo,['config','user.email','test@localhost']);
  await writeFile(path.join(repo,'base.txt'),'base');await gitOk(repo,['add','.']);await gitOk(repo,['commit','-m','base']);const base=await gitOk(repo,['rev-parse','HEAD']);
  const host=new RiftHostService({subagents:{list:()=>[]}} as unknown as Context,{home:path.join(root,'host'),port:0,leadProvider:'test',leadModel:'test',checks:[{id:'unit',executable:'rift-nonexistent-check',args:[]}]});cleanup.push(()=>host.close());
  const workspace=createWorkspace(host.store,{id:'own',name:'Own',rootPath:repo,repositoryPath:repo,commonGitDir:path.join(repo,'.git'),baseRef:'main'});
  configureRoles(host.store,workspace.id,[{id:'fake',providerName:'fake',packageVersion:'test',configRevision:1,capabilities:{},credentialRefs:[]}],[{name:'lead',kind:'dsh-lead',prompt:'Lead',revision:1},{name:'developer-a',kind:'subagent',providerBindingId:'fake',prompt:'Develop',revision:1},{name:'reviewer',purpose:'reviewer',kind:'subagent',providerBindingId:'fake',prompt:'Read only',revision:1}],new Set(['fake']));
  createWorkspace(host.store,{id:'foreign',name:'Foreign',rootPath:repo,repositoryPath:repo,commonGitDir:path.join(repo,'.git'),baseRef:'main'});
  const workflow=host.coordinator.createWorkflow({id:'workflow',workspaceId:'own',goal:'Evidence',integrationRef:'refs/heads/rift/evidence',baseCommit:base});
  host.coordinator.submitPlan({workflowId:workflow.id,expectedRevision:0,tasks:[{id:'task',kind:'change',title:'Task',instructions:'Task',acceptanceCriteria:['Do not guess checks from this prose.']}]});host.coordinator.pause(workflow.id);
  await writeFile(path.join(repo,'source.txt'),'source');await gitOk(repo,['add','.']);await gitOk(repo,['commit','-m','source']);const source=await gitOk(repo,['rev-parse','HEAD']);host.store.exec("UPDATE tasks SET source_head=?,status='blocked' WHERE id='task'",source);
  const task=host.store.task('task'),context={workspace,workflow,task};let candidate!:Candidate;
  try {await host.git.prepareCandidate({...context,sourceHead:source,integrationId:'integration'});} catch(error) {if(!(error instanceof CandidateEvidenceError))throw error;candidate=error.candidate;}
  host.store.exec("INSERT INTO integrations(id,task_id,source_head,candidate_head,expected_target_head,check_ids,candidate,status) VALUES('integration','task',?,?,?,?,?,'evidence_waiting')",source,candidate.candidateHead,candidate.expectedTargetHead,JSON.stringify(candidate.checkIds),JSON.stringify(candidate));
  const route='/ui-api/v1/workspaces/own/tasks/task/evidence';
  return {host,context,candidate,route};
}
it('exposes real Host logs through scoped HTTP and CLI; rejects uploads, wrong workspace/candidate and stale versions',async()=>{
  const f=await fixture(),{host,route,candidate}=f;
  const evidence=await host.handle('GET',route,{}) as TaskEvidence;
  expect(evidence.integrations[0]).toMatchObject({candidateHead:candidate.candidateHead,evidenceUnavailable:false,readiness:{status:'environment_unavailable',requiredCheckIds:['unit']}});
  const checkId=candidate.checkIds[0]!,query=`?integrationId=integration&checkId=${checkId}`;
  const log=await host.handle('GET',route+'/log'+query,{}) as CheckEvidence;expect(log.host?.executionSource).toBe('host');expect(log.exitCode).not.toBe(0);
  const cli=await host.workspaceCli.execute('own',{argv:['task','evidence-log','task'],input:{integrationId:'integration',checkId}});expect(cli).toEqual(log);
  await expect(host.handle('GET',route.replace('/own/','/foreign/'),{})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(host.handle('GET',route+'/log?integrationId=integration&checkId=..%2Fmanagement.token',{})).rejects.toThrow();
  const input={integrationId:'integration',candidateHead:candidate.candidateHead,expectedVersion:host.store.task('task').version,idempotencyKey:'repair'};
  await expect(host.handle('POST',route,{...input,executionSource:'host',stdout:'fabricated',exitCode:0},'upload')).rejects.toThrow();
  await expect(host.handle('POST',route,{...input,candidateHead:'f'.repeat(40)},'wrong-head')).rejects.toMatchObject({code:'CANDIDATE_EVIDENCE_MISMATCH'});
  await expect(host.handle('POST',route,{...input,expectedVersion:input.expectedVersion+1},'stale')).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(host.commands.execute({name:'task.retry-dispatch',workspaceId:'own',id:'task',input:{}})).rejects.toMatchObject({code:'EVIDENCE_NOT_READY'});
  (host.git as unknown as {commands:Map<string,{id:string;executable:string;args:string[]}>}).commands.set('unit',{id:'unit',executable:process.execPath,args:['-e','console.log("token=credential-is-redacted")']});
  const result=await host.handle('POST',route,input,'repair');expect(await host.handle('POST',route,input,'repair')).toEqual(result);
  expect(host.store.all('SELECT id FROM integrations')).toHaveLength(1);expect(host.store.all('SELECT id FROM runs')).toHaveLength(0);
  const ready=await host.handle('GET',route,{}) as TaskEvidence;expect(ready.integrations[0]?.readiness.status).toBe('ready');expect(ready.integrations[0]?.candidateHead).toBe(candidate.candidateHead);expect(JSON.stringify(ready)).not.toContain('credential-is-redacted');
});
it('gives the Reviewer a live, read-only task-bound evidence tool',async()=>{
  const {host,context,candidate}=await fixture(),role=host.store.require<{id:string}>("SELECT id FROM roles WHERE workspace_id='own' AND purpose='reviewer'");
  host.store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('review','task',?,'review',1,'running','{}','later','now')",role.id);
  const run=host.store.run('review'),tools=(host as unknown as {runEvidenceTools(run:Run):RuntimeTool[]}).runEvidenceTools(run),tool=tools[0]!;
  const signal=new AbortController().signal;
  expect((await tool.execute({},signal) as TaskEvidence).taskId).toBe(context.task.id);
  expect((await tool.execute({integrationId:'integration',checkId:candidate.checkIds[0]},signal) as CheckEvidence).host?.candidateHead).toBe(candidate.candidateHead);
  await expect(tool.execute({integrationId:'integration',checkId:candidate.checkIds[0],taskId:'foreign'},signal)).rejects.toThrow();
  await expect(tool.execute({integrationId:'integration',command:'echo fake'},signal)).rejects.toThrow();
  host.store.exec("UPDATE runs SET status='succeeded',cleanup_status='confirmed',slot_released_at='now' WHERE id='review'");
  await expect(tool.execute({},signal)).rejects.toMatchObject({code:'UNAUTHORIZED'});
});
