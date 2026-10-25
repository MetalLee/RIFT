/** Real installed Workflow/PTC/subagent services; controlled provider, zero models. */
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { RiftStore } from '../src/storage/database.js';
import { ProjectService } from '../src/project/index.js';
import { TaskCoordinator } from '../src/task/coordinator.js';
import { LocalGitService } from '../src/git/integration.js';
import { DshActivationBridge } from '../src/task/activation-bridge.js';
const command=promisify(execFile),root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const temporary=await mkdtemp(path.join(root,'e1-workflow-service-'));
process.env.DSH_HOME=path.join(temporary,'dsh');initializeProfileFromDefault('probe','sdk-minimal',process.env.DSH_HOME);
const patch=path.join(temporary,'workflow.patch.yml');
await writeFile(patch,`- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n- insert:\n    - name: '@deepseek-ai/dsh-subagent'\n      config:\n        maxActiveSubagents: 3\n        maxDepth: 1\n    - name: '@deepseek-ai/dsh-ptc-runtime-node'\n    - name: '@deepseek-ai/dsh-workflow-ptc'\n      config:\n        provider: controlled-analysis\n        maxConcurrentAgents: 1\n        maxTotalAgents: 32\n`);
const report:Record<string,unknown>={date:new Date().toISOString(),mode:'real DSH Workflow/PTC/subagent service; controlled child provider; zero model calls; not native Codex/Claude evidence',evidenceDirectory:temporary};
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('probe'),profile:'probe',patchFiles:[patch],args:[]});
let store:RiftStore|undefined,coordinator:TaskCoordinator|undefined,lead:AgentHandle|undefined;
try {
  const repo=path.join(temporary,'中文 repo');await mkdir(repo);await command('git',['init','--initial-branch=main',repo]);await command('git',['-C',repo,'config','user.name','RIFT probe']);await command('git',['-C',repo,'config','user.email','probe@example.invalid']);await writeFile(path.join(repo,'README.md'),'baseline\n');await command('git',['-C',repo,'add','.']);await command('git',['-C',repo,'commit','-m','baseline']);
  const git=new LocalGitService({managedRoot:path.join(temporary,'managed'),commands:[]}),inspected=await git.inspectRepository(repo,'main');
  store=new RiftStore(path.join(temporary,'rift.db'));const project=new ProjectService(store,new Set(['controlled-analysis']));
  project.createWorkspace({id:'probe',name:'probe',rootPath:temporary,repositoryPath:repo,commonGitDir:inspected.commonGitDir,baseRef:'main'});
  project.configureRoles('probe',[{id:'controlled',providerName:'controlled-analysis',packageVersion:'controlled-only',configRevision:1,capabilities:{},credentialRefs:[]}],[{name:'captain',purpose:'lead',kind:'dsh-lead',prompt:'Plan',revision:1},{name:'analyst',purpose:'developer',kind:'subagent',providerBindingId:'controlled',prompt:'Analyze',revision:1},{name:'auditor',purpose:'reviewer',kind:'subagent',providerBindingId:'controlled',prompt:'Review',revision:1}]);
  const calls:{cwd:string;prompt:string;disposed:boolean;childTools:string[];guardDenied:boolean}[]=[];let active=0,peak=0;
  ctx.tools.register({name:'rift_probe_write',description:'Must be hidden and denied for batch descendants.',parameters:{type:'object',properties:{}},output:{schema:{},render:()=>[]},async execute(){throw new Error('Guard failed: sentinel body ran');}});
  ctx.subagents.registerProvider({name:'controlled-analysis',inheritsParentContext:false,capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},async start(request){
    const child=await ctx.agents.create({sessionId:SessionId(`controlled-scope-${randomUUID()}`),parentAgent:request.parent,meta:{cwd:request.cwd,parentSession:request.parent.id,origin:'subagent'}});
    const childTools=ctx.tools.schemas(child.agent).map(tool=>tool.name);const denied=await ctx.tools.execute({callId:`guard-${randomUUID()}` as ToolCallId,name:'rift_probe_write',arguments:{},agent:child.agent,signal:request.signal});await child.dispose();
    const prompt=request.prompt.filter(block=>block.type==='text').map(block=>block.text).join('\n'),call={cwd:request.cwd,prompt,disposed:false,childTools,guardDenied:Boolean(denied.isError)};calls.push(call);active++;peak=Math.max(peak,active);
    let resolve!:(value:any)=>void;const result=new Promise<any>(yes=>resolve=yes);const finish=()=>resolve({stopReason:request.signal.aborted?'aborted':prompt.includes('FAIL-ITEM')?'error':'completed',output:[{type:'text',text:'controlled analysis result'}]});
    request.signal.addEventListener('abort',finish,{once:true});if(!prompt.includes('WAIT-ITEM'))setTimeout(finish,20);
    return {id:SessionId(`controlled-${randomUUID()}`),result,async dispose(){if(!call.disposed){call.disposed=true;active--;request.signal.removeEventListener('abort',finish);finish();}}};
  }});
  lead=await ctx.agents.create({sessionId:SessionId(`probe-lead-${randomUUID()}`),meta:{cwd:repo},setup:scope=>{scope.tools.restrict({allow:[]});}});
  coordinator=new TaskCoordinator({store,git,bridge:new DshActivationBridge(ctx,()=>lead?.agent,store),runTimeoutMs:30_000});
  const workflow=coordinator.createWorkflow({id:'workflow',workspaceId:'probe',goal:'Workflow reuse probe',baseCommit:inspected.baseCommit,integrationRef:'refs/heads/rift/probe'});
  coordinator.submitPlan({workflowId:workflow.id,expectedRevision:0,tasks:[{id:'batch',kind:'analysis',title:'Batch',instructions:'Supplied text only',expectedPaths:[],analysisItems:[{id:'one',prompt:'First analysis'},{id:'two',prompt:'Second analysis'}]},{id:'failed',kind:'analysis',title:'Failure',instructions:'Supplied text',expectedPaths:[],analysisItems:[{id:'bad',prompt:'FAIL-ITEM'}]},{id:'cancelled',kind:'analysis',title:'Cancel',instructions:'Supplied text',expectedPaths:[],analysisItems:[{id:'waiting',prompt:'WAIT-ITEM'},{id:'never',prompt:'Never start'}]}]});
  const waitFor=async(predicate:()=>boolean)=>{const deadline=Date.now()+25_000;while(!predicate()){if(Date.now()>deadline)throw new Error('Probe wait expired');await new Promise(resolve=>setTimeout(resolve,30));}};
  for(const id of ['batch','failed']){coordinator.dispatch({taskId:id,idempotencyKey:id,expectedVersion:store.task(id).version});await waitFor(()=>['succeeded','blocked'].includes(store!.task(id).status));}
  coordinator.dispatch({taskId:'cancelled',idempotencyKey:'cancelled',expectedVersion:store.task('cancelled').version});await waitFor(()=>calls.some(call=>call.prompt.includes('WAIT-ITEM')));await coordinator.cancelTask('cancelled');await waitFor(()=>coordinator!.status(workflow.id).slots.total===0);
  const runs=store.all<{taskId:string;status:string;cleanupStatus:string;dshRunId:string;result:unknown}>('SELECT * FROM runs');
  report.result={batch:store.task('batch').status,failed:store.task('failed').status,cancelled:store.task('cancelled').status,peakConcurrentChildren:peak,calls,runs,workflowEvents:store.events(workflow.id).filter(event=>event.type==='analysis.workflow_started')};
  if(store.task('batch').status!=='succeeded'||store.task('failed').status!=='blocked'||store.task('cancelled').status!=='cancelled'||peak!==1||calls.length!==4||calls.some(call=>!call.disposed||!call.guardDenied||call.childTools.length!==0||call.cwd===repo)||runs.some(run=>run.cleanupStatus!=='confirmed'))throw new Error('Workflow service assertion failed');
  report.status='pass';
}catch(error){report.status='fail';report.error=String(error);process.exitCode=1;}
finally{await coordinator?.shutdown();await lead?.dispose();store?.close();await shutdown.shutdown(Number(process.exitCode??0));await writeFile(path.join(root,'e1-workflow-service-probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
