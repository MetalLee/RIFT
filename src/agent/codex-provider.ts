import { observeNativeRun } from '../task/run-progress.js';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SessionId } from '@deepseek-ai/dsh-session';
import { NO_START_CAPABILITIES, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { randomUUID } from 'node:crypto';
import { invariant, type ActivationBridge, type ActivationHandle, type DevelopmentResult } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import { NativeCodexRuntime, type NativeCodexOptions } from './native-codex.js';
import { codexHome, nativeSession, sessionCallbacks } from './native-sessions.js';
import { REPOSITORY_PERMISSION_VERSION } from './repository-access.js';

export const name = 'rift-codex-provider';
export const inject = ['subagents','subprocess'];
export interface Config { providerName: string; model: string; permissionMode?: 'never'; env?: Record<string,string> }
export const Config: z<Config> = z.object({providerName:z.string().min(1),model:z.string().min(1),permissionMode:z.const('never').default('never'),env:z.dict(z.string()).default({})});

/** Registered backend with an explicit Host-only persistent task entry point.
 * The RIFT coordinator owns slots, leases and disposal for this entry point.
 * Generic DSH callers get isolated one-shot executions, never a task session. */
export class PersistentCodexProvider implements SubagentProvider {
  readonly riftPersistentCodex = true;
  readonly capabilities = NO_START_CAPABILITIES;
  readonly inheritsParentContext = false;
  readonly name: string;
  constructor(readonly config: Config, private readonly spawn: (spec:SubprocessSpawnSpec)=>SubprocessHandle, private readonly modelProvider?:NativeCodexOptions['modelProvider']) { this.name=config.providerName; }
  private runtime(mode: NativeCodexOptions['mode']) { return new NativeCodexRuntime({spawn:this.spawn,env:this.config.env,mode,modelProvider:this.modelProvider}); }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const childId=SessionId(`rift-codex-${randomUUID()}`);
    invariant(request.prompt.every(block=>block.type==='text'),'START_NOT_PUBLISHED','Codex task input must be text.');
    const handle=await this.runtime('develop').start({workspaceId:'dsh',agentId:'dsh',turnId:childId,cwd:request.cwd,model:this.config.model,instructions:'Execute the supplied task. Do not delegate.',messages:[{role:'user',content:request.prompt.map(block=>block.type==='text'?block.text:'').join('\n')}],tools:[],signal:request.signal});
    return {id:childId,dispose:handle.dispose,result:handle.result.then(result=>({stopReason:result.stopReason==='completed'?'completed' as const:result.stopReason==='cancelled'?'aborted' as const:'error' as const,output:[{type:'text' as const,text:result.text}]}),error=>({stopReason:'error' as const,output:[{type:'text' as const,text:String(error)}]}))};
  }

  async startTask(store:RiftStore,input:Parameters<ActivationBridge['start']>[0]):Promise<ActivationHandle> {
    const {run,task}=input;
    const reserved=store.run(run.id);
    invariant(reserved.taskId===task.id && reserved.roleId===input.role.id && ['preparing','running'].includes(reserved.status) && JSON.stringify(reserved.providerSnapshot)===JSON.stringify(run.providerSnapshot),'UNAUTHORIZED','Task session must use its current reserved Run and immutable provider snapshot.');
    invariant(run.providerSnapshot.binding?.providerName===this.name,'PROVIDER_UNAVAILABLE','Task must use its reserved provider instance.');
    invariant(!run.providerSnapshot.binding.model || run.providerSnapshot.binding.model===this.config.model,'PROVIDER_INSTANCE_MODEL_CONFLICT','Task model differs from its configured Codex provider.');
    invariant(store.get('SELECT id FROM execution_leases WHERE owner_type=? AND owner_id=? AND released_at IS NULL','run',run.id),'UNAUTHORIZED','Persistent task requires its active RIFT lease.');
    const reasoningEffort=run.providerSnapshot.binding.reasoningEffort ?? undefined;
    const mode=run.purpose==='review'?'review':task.kind==='analysis'?'analysis':'develop';
    const workspaceId=store.workflow(task.workflowId).workspaceId;
    const runtime=this.runtime(mode);
    const repositoryAccess=mode==='develop'||input.repositoryAccess?.sandboxMode==='unrestricted'?input.repositoryAccess:undefined;
    const start=async(scopeId:string,executionId:string,prompt:string)=>{
      const session=nativeSession(store,{workspaceId,scope:'task',scopeId,agentId:run.roleId,cwd:input.cwd,runtimeHome:codexHome({...process.env,...this.config.env}),configuration:{provider:this.name,model:this.config.model,reasoningEffort,mode,permissionVersion:REPOSITORY_PERMISSION_VERSION,repositoryAccess,role:run.providerSnapshot.role.prompt,skills:run.providerSnapshot.skillInstructions??'',bindingRevision:run.providerSnapshot.binding?.configRevision,tools:(input.tools??[]).map(({name,description,inputSchema})=>({name,description,inputSchema}))}});
      return runtime.start({onEvent:observeNativeRun(input.onProgress,input.onEvent),workspaceId,agentId:run.roleId,turnId:executionId,cwd:input.cwd,...repositoryAccess?{repositoryAccess}:{},model:this.config.model,reasoningEffort,session:sessionCallbacks(store,session,executionId,input.cwd,input.onAccepted),instructions:`You are executing a registered RIFT ${mode} task. Do not delegate. The new task envelope is authoritative: use its runId, cwd, source and candidate commits, acceptance criteria and result schema. Old paths and old acceptance claims in session history are not current evidence. Reinspect the current filesystem before acting. Never automatically repeat an interrupted command. ${mode==='review'?'Review this exact candidate read-only.':mode==='analysis'?(task.analysisItems?.length?'Analyze only the supplied text; do not access files.':'Analyze the assigned repository checkout read-only. Do not edit files or Git metadata, commit, push, or create a PR.'):'Follow developmentProtocol: edit files and use local git add/commit when needed. Push or create/update a PR only when explicitly requested by the user. Return the real implementation result and commit references; the Host still verifies source and runs checks/review after cleanup. A commit is not acceptance. Do not wait for those later gates inside this Run; report unavailable local tests honestly.'}\n${run.providerSnapshot.role.prompt}\n${run.providerSnapshot.skillInstructions??''}`,messages:[{role:'user',content:prompt}],tools:input.tools??[],signal:input.signal});
    };
    if (!task.analysisItems?.length) {
      const handle=await start(task.id,run.id,input.prompt);
      return {childId:`rift-native-${run.id}`,dispose:handle.dispose,result:handle.result.then(result=>({stopReason:result.stopReason,text:result.text}))};
    }
    // Each analysis item has its own durable memory, reused on task repair.
    // Execute sequentially within the already reserved business slot.
    let active: Awaited<ReturnType<typeof start>>|undefined;
    let stopped=false;
    const result=(async()=>{
      const items:{id:string;text:string}[]=[];
      for(const item of task.analysisItems!) {
        invariant(!stopped,'ABORTED_BEFORE_START','Analysis batch stopped.');
        input.signal.throwIfAborted();
        active=await start(`${task.id}:item:${item.id}`,`${run.id}:item:${item.id}`,JSON.stringify({taskId:task.id,runId:run.id,taskEnvelope:input.prompt,instructions:task.instructions,item}));
        if (stopped) { await active.dispose(); throw new Error('Analysis batch stopped during startup.'); }
        try { const output=await active.result; invariant(output.stopReason==='completed','ANALYSIS_FAILED','Analysis item did not complete.'); items.push({id:item.id,text:output.text}); }
        finally { await active.dispose(); active=undefined; }
      }
      const output:DevelopmentResult={schemaVersion:1,taskId:task.id,runId:run.id,outcome:'completed',summary:JSON.stringify({items}),changedPaths:[],checksClaimed:[],blockingReasons:[]};
      return {stopReason:'completed',text:JSON.stringify(output)};
    })();
    void result.catch(()=>{});
    return {childId:`rift-native-${run.id}`,result,dispose:async()=>{stopped=true;await active?.dispose();await result.catch(()=>{});}};
  }
}

export function isPersistentCodexProvider(provider:SubagentProvider):provider is PersistentCodexProvider {
  return 'riftPersistentCodex' in provider && provider.riftPersistentCodex===true && 'startTask' in provider && typeof provider.startTask==='function';
}

export function apply(ctx:Context,config:Config):void {
  invariant(config.permissionMode===undefined||config.permissionMode==='never','INVALID_CONFIG','Persistent Codex uses noninteractive execution.');
  invariant(['gpt-6.1-sol','gpt-6-astra'].includes(config.model),'INVALID_CONFIG','Select a supported Codex task model.');
  ctx.subagents.registerProvider(new PersistentCodexProvider(config,spec=>ctx.subprocess.spawn(spec)));
}
