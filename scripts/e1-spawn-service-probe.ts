/** Actual DSH spawn/Agent scope inspection, stopped before the first model turn. */
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initializeProfileFromDefault,runProfile} from '@deepseek-ai/dsh/profile-boot';
import {loadLayeredEnv} from '@deepseek-ai/dsh-app-boot';
import {SessionId} from '@deepseek-ai/dsh-session';
import type {AgentHandle} from '@deepseek-ai/dsh-agent';
import type {ActivationBridge} from '../src/contracts/index.js';
import {RiftStore} from '../src/storage/database.js';
import {TaskCoordinator} from '../src/task/coordinator.js';
import {DshActivationBridge} from '../src/task/activation-bridge.js';
import {installLeadTools} from '../src/tools/rift-tools.js';

const evidence=path.resolve('docs/evidence'),runtime=path.resolve('.runtime-evidence');await mkdir(evidence,{recursive:true});await mkdir(runtime,{recursive:true});
const temporary=await mkdtemp(path.join(runtime,'e1-spawn-service-'));
process.env.DSH_HOME=path.join(temporary,'dsh');initializeProfileFromDefault('probe','sdk-minimal',process.env.DSH_HOME);
const patch=path.join(temporary,'spawn.patch.yml');await writeFile(patch,`- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n- insert:\n    - name: '@deepseek-ai/dsh-subagent'\n      config:\n        maxActiveSubagents: 1\n        maxDepth: 1\n    - name: '@deepseek-ai/dsh-subagent-spawn-in-process'\n`);
const report:Record<string,unknown>={date:new Date().toISOString(),node:process.version,dsh:'0.2.1-rc.3',mode:'actual official in-process spawn and Agent creation; publication deliberately rejected by agent/created sentinel before prompt acceptance; zero model calls; not native model execution evidence',evidenceDirectory:temporary};
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('probe'),profile:'probe',patchFiles:[patch],args:[]});
const store=new RiftStore();let lead:AgentHandle|undefined,coordinator:TaskCoordinator|undefined,modelRequests=0,unexpectedModelRequests=0;
const snapshots:{id:string;tools:string[];cwd:string|undefined;provider:string|undefined;model:string|undefined}[]=[],disposed:string[]=[];
// Never call next(): an unexpected stream is counted and stopped before any
// adapter/network dispatch, in addition to the earlier publication sentinel.
const removeLlmGuard=ctx.on('llm/stream',()=>{modelRequests++;unexpectedModelRequests++;throw new Error('UNEXPECTED_MODEL_CALL_BLOCKED');});
const removeDisposed=ctx.on('agent/disposed',({agent})=>{disposed.push(agent.id);});
let removeCreated:(()=>void)|undefined;
try {
  const unsupported=async()=>{throw new Error('This scope probe must not execute business or Git operations.');};
  coordinator=new TaskCoordinator({store,bridge:{start:unsupported},git:{prepareTask:unsupported,collectSource:unsupported,prepareCandidate:unsupported,publishCandidate:unsupported}});
  lead=await ctx.agents.create({sessionId:SessionId(`scope-lead-${randomUUID()}`),meta:{cwd:temporary},setup:(scope,agent)=>installLeadTools(scope,agent,'scope-probe',coordinator!)});
  const parent=lead.agent,globalTools=ctx.tools.schemas().map(tool=>tool.name),leadTools=ctx.tools.schemas(parent).map(tool=>tool.name);
  removeCreated=ctx.on('agent/created',({agent})=>{
    if(agent.session.header.parentSession!==parent.id)return undefined;
    snapshots.push({id:agent.id,tools:ctx.tools.schemas(agent).map(tool=>tool.name),cwd:agent.session.header.cwd,provider:agent.options.provider,model:agent.options.model});
    throw new Error('RIFT_SPAWN_SCOPE_CAPTURED_BEFORE_MODEL');
  });
  const binding={id:'spawn-binding',providerName:'spawn',runtime:'dsh' as const,packageVersion:'0.2.1-rc.3',configRevision:1,capabilities:{...ctx.subagents.getProvider('spawn')!.capabilities},credentialRefs:[],spawn:{provider:'deepseek-official',model:'deepseek-flash'}};
  const bridge=new DshActivationBridge(ctx,()=>parent);
  const failures:string[]=[];
  // Repeated rejection under maxActiveSubagents=1 verifies failed creation
  // actually releases its official reservation rather than leaking capacity.
  for(let attempt=0;attempt<2;attempt++){
    // Business fields are a controlled fixture; this probe verifies the actual
    // official spawn boundary and does not claim to execute a ledger task.
    const input={run:{id:`run-${attempt}`,providerSnapshot:{binding}},task:{id:`task-${attempt}`,title:'Scope inspection'},cwd:temporary,prompt:'This prompt must never be accepted; stop during creation.',signal:new AbortController().signal} as unknown as Parameters<ActivationBridge['start']>[0];
    try {const handle=await bridge.start(input);await handle.dispose();throw new Error('Unexpected activation publication.');}catch(error){failures.push(String(error));}
  }
  await ctx.subagents.drainDescendants([parent]);
  const remainingBeforeLeadDispose=ctx.agents.list().map(agent=>agent.id);
  await lead.dispose();lead=undefined;
  const remainingAfterLeadDispose=ctx.agents.list().map(agent=>agent.id);
  const shell=process.platform==='win32'?'pwsh':'bash';
  report.scope={globalTools,leadTools,children:snapshots,shellTool:shell,leadCannotUseShell:!leadTools.includes(shell),childrenHaveDevelopmentTools:snapshots.every(snapshot=>snapshot.tools.includes(shell)&&snapshot.tools.includes('read_image')&&snapshot.tools.includes('working_directory')),childrenCannotSeeLeadTools:snapshots.every(snapshot=>snapshot.tools.every(name=>!name.startsWith('rift_')))};
  report.lifecycle={failures,disposed,remainingBeforeLeadDispose,remainingAfterLeadDispose,repeatedStartsAtCapacityOne:snapshots.length===2};
  report.modelRequests=modelRequests;report.unexpectedModelRequestsBlocked=unexpectedModelRequests;
  if(snapshots.length!==2||failures.some(error=>!error.includes('RIFT_SPAWN_SCOPE_CAPTURED_BEFORE_MODEL'))||modelRequests!==0||snapshots.some(snapshot=>snapshot.cwd!==temporary||!snapshot.tools.includes(shell)||snapshot.tools.some(name=>name.startsWith('rift_'))||!disposed.includes(snapshot.id))||remainingBeforeLeadDispose.length!==1||remainingBeforeLeadDispose[0]!==parent.id||remainingAfterLeadDispose.length!==0||leadTools.includes(shell))throw new Error('Official spawn scope assertion failed.');
  report.status='pass';
}catch(error){report.status='fail';report.error=String(error);process.exitCode=1;}
finally{removeCreated?.();await coordinator?.shutdown();await lead?.dispose();store.close();removeDisposed();removeLlmGuard();await shutdown.shutdown(Number(process.exitCode??0));await writeFile(path.join(evidence,'e1-spawn-service.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
