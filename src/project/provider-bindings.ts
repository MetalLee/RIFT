import { invariant, type ProviderBinding } from '../contracts/index.js';
const allowed=new Set(['id','providerName','packageVersion','configRevision','capabilities','credentialRefs']);
export function validateBinding(input:ProviderBinding,registeredProviderNames:ReadonlySet<string>):void {
  invariant(Object.keys(input).every(key=>allowed.has(key)),'INVALID_CONFIG','Provider bindings only accept references and declared metadata; credentials belong to the host.');
  invariant(registeredProviderNames.has(input.providerName),'PROVIDER_NOT_REGISTERED',`Provider ${input.providerName} is not registered in this host.`);
  invariant(input.id && input.packageVersion && Number.isInteger(input.configRevision) && input.configRevision>0,'INVALID_CONFIG','Binding requires an ID, package version and positive revision.');
  invariant(Array.isArray(input.credentialRefs) && input.credentialRefs.every(ref=>/^(env|keychain|dsh):[A-Za-z0-9_.\/-]+$/.test(ref)||/^native:(claude|codex)$/.test(ref)),'INVALID_CREDENTIAL_REFERENCE','Credentials must use env:, keychain:, dsh: or native runtime references, never literal secrets.');
  invariant(Object.values(input.capabilities).every(value=>typeof value==='boolean'),'INVALID_CONFIG','Provider capabilities must be boolean values.');
}
