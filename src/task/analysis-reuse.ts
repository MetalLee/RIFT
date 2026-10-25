import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkflowRun } from '@deepseek-ai/dsh-workflow';
import '@deepseek-ai/dsh-workflow';
import { invariant, RiftError, type ActivationBridge, type ActivationHandle, type DevelopmentResult } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';

/** Trusted, fixed script: prompts remain data. Awaiting every agent also awaits
 * its official Workflow disposal, so one business slot has at most one child. */
export const ANALYSIS_BATCH_SCRIPT = `
const results = [];
for (const item of args.items) {
  const text = await agent(args.context + "\\nAnalysis item " + item.id + ":\\n" + item.prompt, { label: item.id });
  results.push({ id: item.id, text });
}
return results;
`;

/** Reuses the installed DSH engine inside one already-reserved analysis Run.
 * This is an execution-local batch, not a second queue or recovery backend. */
export async function startAnalysisBatch(ctx:Context,store:RiftStore|undefined,lead:Agent,input:Parameters<ActivationBridge['start']>[0],agentOptions?:AgentOptions):Promise<ActivationHandle> {
  invariant(store,'START_NOT_PUBLISHED','Analysis batches require the durable RIFT task and run ledger.');
  const task=store.task(input.task.id), run=store.run(input.run.id), binding=run.providerSnapshot.binding;
  invariant(task.kind==='analysis' && run.taskId===task.id && run.purpose!=='review','START_NOT_PUBLISHED','Workflow reuse is only available inside a registered analysis task.');
  invariant(['preparing','running'].includes(run.status)&&run.slotReleasedAt===null&&task.status==='running','START_NOT_PUBLISHED','Analysis reuse requires an active reserved business Run.');
  invariant(run.roleId===input.role.id&&binding&&JSON.stringify(run.providerSnapshot)===JSON.stringify(input.run.providerSnapshot),'START_NOT_PUBLISHED','Analysis reuse must use the reserved immutable role binding.');
  invariant(task.analysisItems && task.analysisItems.length>=1&&task.analysisItems.length<=32&&new Set(task.analysisItems.map(item=>item.id)).size===task.analysisItems.length&&task.analysisItems.every(item=>typeof item.id==='string'&&item.id.length>0&&typeof item.prompt==='string'&&item.prompt.trim().length>0),'START_NOT_PUBLISHED','Analysis batch requires 1–32 unique nonempty items.');
  invariant(store.get('SELECT id FROM worktrees WHERE task_id=? AND attempt=? AND kind=? AND path=? AND writer_run_id=?',task.id,run.taskAttempt,'task',input.cwd,run.id),'START_NOT_PUBLISHED','Analysis batch cwd must be the worktree owned by its reserved Run.');
  invariant(!binding.spawn?.agentPreset,'START_NOT_PUBLISHED','DSH Workflow does not support a per-child agentPreset; use a DSH binding without one for analysis batches.');
  const engine=ctx.get('workflowEngine');
  invariant(engine,'START_NOT_PUBLISHED','The official DSH Workflow engine is not mounted in this profile.');
  const rootId=SessionId(`rift-analysis-${randomUUID()}`);
  const belongs=(agent:Agent|undefined):boolean=>{
    const seen=new Set<string>();
    while(agent&&!seen.has(agent.id)) { if(agent.id===rootId)return true;seen.add(agent.id);const parentId=agent.session.header.parentSession;agent=parentId?ctx.agents.get(parentId):undefined; }
    return false;
  };
  // Local DSH agents cannot use inherited tools to delegate or write. External
  // providers retain their own tool policies; their file changes still fail the
  // existing analysis collectSource gate in the isolated worktree.
  const removeGuard=ctx.tools.guard(execution=>belongs(execution.agent)?'RIFT batch analysis uses supplied text only; tool execution is disabled.':undefined);
  const removeListener=ctx.on('agent/created',({agent})=>{if(belongs(agent))agent.ctx.tools.restrict({allow:[]});return undefined;});
  let parent:AgentHandle|undefined, workflow:WorkflowRun|undefined;
  const dispose=async()=>{
    const errors:unknown[]=[];
    try {await workflow?.dispose();}catch(error){errors.push(error);}
    try {await parent?.dispose();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Analysis Workflow cleanup could not be confirmed.');
    removeListener();removeGuard();
  };
  try {
    input.signal.throwIfAborted();
    parent=await ctx.agents.create({sessionId:rootId,parentAgent:lead,meta:{cwd:input.cwd,parentSession:lead.id,origin:'subagent'},...(agentOptions?{agentOptions}:{}),signal:input.signal,setup:scope=>{scope.tools.restrict({allow:[]});}});
    input.signal.throwIfAborted();
    workflow=engine.start({parent:parent.agent,signal:input.signal,subagentProvider:binding.providerName,maxTotalAgents:task.analysisItems.length,meta:{name:'rift-analysis-batch',description:'Sequential analysis items in one durable RIFT Run.'},script:ANALYSIS_BATCH_SCRIPT,args:{context:`${run.providerSnapshot.role.prompt}\n${task.instructions}\nAnalyze only the supplied text. Do not edit files, invoke tools, or delegate. Return your analysis as text; the host records the task result.`,items:task.analysisItems}});
    store.event(task.workflowId,'analysis.workflow_started',{workflowRunId:workflow.id,parentSessionId:rootId,itemIds:task.analysisItems.map(item=>item.id),maxConcurrentChildren:1},{taskId:task.id,runId:run.id});
    const accepted=workflow;
    let cleanup:Promise<void>|undefined;
    return {childId:rootId,result:accepted.result.then(result=>{
      if(result.stopReason!=='completed')return {stopReason:result.stopReason,text:result.error??'DSH Workflow did not complete.',dshRunId:accepted.id};
      invariant(Array.isArray(result.value)&&result.value.length===task.analysisItems!.length,'INVALID_RESULT','DSH Workflow batch result has the wrong item count.');
      const items=result.value as {id:string;text:string|null}[];
      invariant(items.every((item,index)=>item?.id===task.analysisItems![index]!.id&&(typeof item.text==='string'||item.text===null)),'INVALID_RESULT','DSH Workflow batch result does not match its requested items.');
      const failed=items.filter(item=>item.text===null);
      const output:DevelopmentResult={schemaVersion:1,taskId:task.id,runId:run.id,outcome:failed.length?'blocked':'completed',summary:JSON.stringify({workflowRunId:accepted.id,items}),changedPaths:[],checksClaimed:[],blockingReasons:failed.map(item=>`Analysis item ${item.id} failed.`)};
      return {stopReason:'completed',text:JSON.stringify(output),dshRunId:accepted.id};
    }),dispose:()=>cleanup??=dispose()};
  }catch(error){
    await dispose();
    throw new RiftError('START_NOT_PUBLISHED',`Analysis Workflow was not published: ${(error as Error).message}`);
  }
}
