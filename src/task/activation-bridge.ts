import { observeDshRun } from './run-progress.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-subagent';
import type { ActivationBridge, ActivationHandle } from '../contracts/index.js';
import { RiftError } from '../contracts/index.js';
import type { RiftStore } from '../storage/database.js';
import { startAnalysisBatch } from './analysis-reuse.js';
import { isPersistentCodexProvider } from '../agent/codex-provider.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { redact } from '../api/security.js';
import { createRepositoryShell } from '../agent/repository-shell.js';
import { createRepositoryReadTools } from '../agent/repository-read.js';
import { workspaceRepositoryAccess } from '../agent/repository-access.js';

/** Routes registered execution through DSH or the persistent Codex backend.
 * The coordinator remains the owner of business leases and returned handles. */
export class DshActivationBridge implements ActivationBridge {
  constructor(private readonly ctx: Context, private readonly parentForTask: (taskId: string) => Agent | undefined, private readonly store?:RiftStore) {}

  async start(input: Parameters<ActivationBridge['start']>[0]): Promise<ActivationHandle> {
    if (input.signal.aborted) throw new RiftError('ABORTED_BEFORE_START', 'Cancelled before calling the provider.');
    const parent = this.parentForTask(input.task.id);
    if (!parent || this.ctx.agents.get(parent.id) !== parent) {
      throw new RiftError('LIVE_LEAD_REQUIRED', 'The workflow needs its current live DSH Lead before dispatch.');
    }
    const binding = input.run.providerSnapshot.binding;
    const provider=binding && this.ctx.subagents.getProvider(binding.providerName);
    if (!binding || !provider) {
      throw new RiftError('PROVIDER_UNAVAILABLE', 'The exact configured provider instance is not registered.');
    }
    if (isPersistentCodexProvider(provider)) {
      if (!this.store) throw new RiftError('START_NOT_PUBLISHED','Persistent Codex requires the RIFT ledger.');
      return provider.startTask(this.store,input);
    }
    if(binding.runtime!=='dsh')throw new RiftError('FILESYSTEM_ISOLATION_UNAVAILABLE','Select a scoped DSH execution binding or the persistent RIFT Codex backend; this external provider has no verified workspace isolation.');
    const spawn=binding.spawn;
    if(spawn && (binding.runtime!=='dsh' || !provider.capabilities.agentOptions || (spawn.agentPreset&&!provider.capabilities.agentPreset)))throw new RiftError('START_NOT_PUBLISHED','Configured DSH spawn options are not supported by the exact registered provider.');
    const agentOptions:AgentOptions|undefined=spawn?{provider:spawn.provider,model:spawn.model,...spawn.reasoningEffort?{reasoningEffort:ReasoningEffortId(spawn.reasoningEffort)}:{},...spawn.maxTokens?{maxTokens:spawn.maxTokens}:{}}:undefined;
    if(input.task.analysisItems != null)return startAnalysisBatch(this.ctx,this.store,parent,input,agentOptions);
    const restrictInherited=binding.runtime==='dsh';
    const readOnly=input.task.kind==='analysis'||input.run.purpose==='review';
    const repositoryAccess=restrictInherited&&readOnly&&this.store?await workspaceRepositoryAccess(this.store,this.store.workflow(input.task.workflowId).workspaceId):input.repositoryAccess;
    const needsRepositoryShell=restrictInherited&&(!readOnly||repositoryAccess?.sandboxMode==='unrestricted')&&!!(repositoryAccess?.repositoryPaths.length||repositoryAccess?.workspaceDirectory);
    if(restrictInherited&&!provider.prepareContinuable)throw new RiftError('START_NOT_PUBLISHED','This DSH provider cannot install the owned repository execution scope before startup.');
    const shell=needsRepositoryShell?await createRepositoryShell(this.ctx.subprocess,{...input,repositoryAccess}):undefined;
    if(restrictInherited&&readOnly&&(input.tools??[]).some(tool=>!['rift_send_message','rift_skill_resource',...(input.run.purpose==='review'?['rift_read_evidence']:[])].includes(tool.name)))throw new RiftError('START_NOT_PUBLISHED','Formal review and analysis accept only scoped collaboration and file reading tools.');
    const scopedTools=[...(input.tools??[]),...(restrictInherited&&readOnly&&repositoryAccess?createRepositoryReadTools(input.cwd):[]),...(shell?[shell.tool]:[])];
    // The manager supports a reserved identity for local DSH children. Install
    // only into that exact child's scope before its first prompt is released.
    const childId=provider.prepareContinuable&&(restrictInherited||scopedTools.length)?SessionId(`rift-run-${input.run.id}`):undefined;
    let child:Agent|undefined;
    const removeTools=childId?this.ctx.on('agent/created',({agent})=>{
      if(agent.id!==childId)return;
      child=agent;
      observeDshRun(agent,input.onProgress,input.onEvent);
      if(restrictInherited)agent.ctx.tools.restrict({allow:[]});
      for(const tool of scopedTools)agent.ctx.tools.register({name:tool.name,description:tool.description,parameters:tool.inputSchema as ToolDefinition['parameters'],output:{schema:{},render:(_args,value)=>[{type:'text',text:redact(JSON.stringify(value))}]},execute:async(args,execution)=>{if(execution.agent!==agent||this.ctx.agents.get(agent.id)!==agent)throw new RiftError('UNAUTHORIZED','Only this live Run may use its scoped tools.');input.signal.throwIfAborted();execution.signal.throwIfAborted();input.onProgress?.({phase:'tool',toolName:tool.name});try{const result=await tool.execute(args,execution.signal);input.onProgress?.({phase:'tool_done',toolName:tool.name});return result;}catch(error){input.onProgress?.({phase:'tool_failed',toolName:tool.name});throw error;}}});
      return undefined;
    }):undefined;
    let activation:Awaited<ReturnType<Context['subagents']['startActivation']>>;
    try{activation = await this.ctx.subagents.startActivation({
      provider: binding.providerName,
      ...(childId?{childId}:{}),
      label: `${input.task.title} (${input.run.id})`,
      request: { parent, cwd: input.cwd, prompt: [{ type: 'text', text: input.prompt }],...agentOptions?{agentOptions}:{},...spawn?.agentPreset?{agentPreset:spawn.agentPreset}:{} },
      signal: input.signal,
      delivery: 'caller',
    });}catch(error){await shell?.dispose();throw error;}finally{removeTools?.();}
    return {
      childId: activation.childId,
      result: activation.result.then(result => {
        // Local DSH activations omit the committed turn failure from their
        // result. Read only the owned child's terminal event, never its prompt.
        const terminal=child?.session?.snapshotEvents().filter(event=>event.type==='turn/end').at(-1);
        const reason=terminal?.type==='turn/end'?terminal.data.reason:undefined;
        const diagnostic=result.diagnostic??(reason?.kind==='error'?reason.error.message:undefined);
        return {stopReason:result.stopReason,text:result.output.filter(block=>block.type==='text').map(block=>block.text).join('\n'),...(diagnostic?{diagnostic:redact(diagnostic,4096)}:{})};
      }),
      dispose: async () => { try { await shell?.dispose(); } finally { await activation.dispose(); } },
    };
  }
}
