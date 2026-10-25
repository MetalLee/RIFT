import { invariant, type ProviderBinding } from '../contracts/index.js';
const allowed=new Set(['id','providerName','packageVersion','configRevision','capabilities','credentialRefs','runtime','model','spawn']);
export function validateBinding(input:ProviderBinding,registeredProviderNames:ReadonlySet<string>):void {
  invariant(Object.keys(input).every(key=>allowed.has(key)),'INVALID_CONFIG','Provider bindings only accept references and declared metadata; credentials belong to the host.');
  invariant(registeredProviderNames.has(input.providerName),'PROVIDER_NOT_REGISTERED',`Provider ${input.providerName} is not registered in this host.`);
  invariant(input.id && input.packageVersion && Number.isInteger(input.configRevision) && input.configRevision>0,'INVALID_CONFIG','Binding requires an ID, package version and positive revision.');
  invariant(Array.isArray(input.credentialRefs) && input.credentialRefs.every(ref=>/^(env|keychain|dsh):[A-Za-z0-9_.\/-]+$/.test(ref)||/^native:(claude|codex)$/.test(ref)),'INVALID_CREDENTIAL_REFERENCE','Credentials must use env:, keychain:, dsh: or native runtime references, never literal secrets.');
  invariant(Object.values(input.capabilities).every(value=>typeof value==='boolean'),'INVALID_CONFIG','Provider capabilities must be boolean values.');
  invariant(input.runtime == null || ['dsh','codex','claude'].includes(input.runtime),'INVALID_CONFIG','Unknown provider runtime.');
  invariant(input.model == null || (typeof input.model==='string' && input.model.trim().length>0),'INVALID_CONFIG','Model must be a nonempty identifier.');
  if(input.spawn) {
    invariant(input.runtime==='dsh','UNSUPPORTED_PROVIDER_OPTION','Only DSH bindings accept per-child spawn options; external models belong to separate registered instances.');
    invariant(Object.keys(input.spawn).every(key=>['provider','model','reasoningEffort','agentPreset','maxTokens'].includes(key)),'INVALID_CONFIG','Unknown DSH spawn option.');
    invariant([input.spawn.provider,input.spawn.model].every(value=>typeof value==='string'&&value.trim().length>0),'INVALID_CONFIG','DSH spawn requires an explicit provider and model.');
    invariant(input.spawn.reasoningEffort===undefined || (typeof input.spawn.reasoningEffort==='string'&&input.spawn.reasoningEffort.trim().length>0),'INVALID_CONFIG','Reasoning effort must be a nonempty identifier.');
    invariant(input.spawn.agentPreset===undefined || (typeof input.spawn.agentPreset==='string'&&input.spawn.agentPreset.trim().length>0),'INVALID_CONFIG','Agent preset must be a nonempty identifier.');
    invariant(input.spawn.maxTokens===undefined || (Number.isSafeInteger(input.spawn.maxTokens)&&input.spawn.maxTokens>0),'INVALID_CONFIG','maxTokens must be a positive safe integer.');
    invariant(input.capabilities.agentOptions===true,'UNSUPPORTED_PROVIDER_OPTION','DSH spawn requires the agentOptions capability.');
    invariant(!input.spawn.agentPreset || input.capabilities.agentPreset===true,'UNSUPPORTED_PROVIDER_OPTION','Selecting a preset requires the agentPreset capability.');
    invariant(!input.model || input.model===input.spawn.model,'INVALID_CONFIG','DSH model metadata must match the spawn model.');
  }
  invariant(input.runtime!=='dsh' || Boolean(input.spawn),'INVALID_CONFIG','DSH bindings require explicit spawn model options.');
}

/** External model selection is an instance configuration, never a request override. */
export function validateInstanceModels(bindings:ProviderBinding[]):void {
  const instances=new Map<string,ProviderBinding>();
  for(const binding of bindings) {
    const prior=instances.get(binding.providerName);
    invariant(!prior || !prior.runtime || !binding.runtime || prior.runtime===binding.runtime,'PROVIDER_INSTANCE_RUNTIME_CONFLICT','One provider instance cannot represent different runtimes.');
    invariant(binding.runtime==='dsh' || !prior || !prior.model || !binding.model || prior.model===binding.model,'PROVIDER_INSTANCE_MODEL_CONFLICT','External models must use distinct registered provider instances.');
    instances.set(binding.providerName,{...binding,runtime:binding.runtime??prior?.runtime,model:binding.model??prior?.model});
  }
}
