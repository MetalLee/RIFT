import { invariant, type Role, type RoleName, type ProviderBinding } from '../contracts/index.js';
import { RiftStore } from '../storage/database.js';
import { validateBinding } from './provider-bindings.js';
export interface RoleConfiguration { name:RoleName; kind:'dsh-lead'|'subagent'; providerBindingId?:string; prompt:string; revision:number }
export function configureRoles(store:RiftStore,workspaceId:string,bindings:ProviderBinding[],roles:RoleConfiguration[],registeredProviderNames:ReadonlySet<string>):Role[] {
  store.workspace(workspaceId);
  invariant(roles.length===4 && new Set(roles.map(role=>role.name)).size===4 && ['lead','developer-a','developer-b','reviewer'].every(name=>roles.some(role=>role.name===name)),'INVALID_ROLES','MVP requires exactly lead, developer-a, developer-b and reviewer.');
  for(const binding of bindings) validateBinding(binding,registeredProviderNames);
  for(const role of roles) {
    invariant(role.name==='lead' ? role.kind==='dsh-lead' && !role.providerBindingId : role.kind==='subagent' && Boolean(role.providerBindingId),'UNSUPPORTED_ROLE','MVP Lead must use DSH; child roles require registered provider bindings.');
    invariant(Number.isInteger(role.revision)&&role.revision>0,'INVALID_CONFIG','Role revisions must be positive integers.');
    if(role.providerBindingId) invariant(bindings.some(binding=>binding.id===role.providerBindingId),'BINDING_NOT_FOUND','Role binding must be included in this configuration.');
  }
  return store.transaction(()=> {
    invariant(!store.get('SELECT r.id FROM runs r JOIN roles role ON role.id=r.role_id WHERE role.workspace_id=? AND r.slot_released_at IS NULL LIMIT 1',workspaceId),'CONFIG_IN_USE','Cannot change role configuration while executions or unknown cleanup retain slots.');
    for(const binding of bindings) {
      const prior=store.get<ProviderBinding>('SELECT * FROM provider_bindings WHERE id=?',binding.id);
      if(prior)invariant(!store.get('SELECT r.id FROM runs r JOIN roles role ON role.id=r.role_id WHERE role.provider_binding_id=? AND r.slot_released_at IS NULL LIMIT 1',binding.id),'CONFIG_IN_USE','A shared provider binding is in use by another workspace or retained cleanup.');
      if(prior) invariant(binding.configRevision>prior.configRevision || JSON.stringify(prior)===JSON.stringify(binding),'STALE_CONFIG','A changed provider binding requires a higher revision.');
      store.exec('INSERT INTO provider_bindings(id,provider_name,package_version,config_revision,capabilities,credential_refs) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_name=excluded.provider_name,package_version=excluded.package_version,config_revision=excluded.config_revision,capabilities=excluded.capabilities,credential_refs=excluded.credential_refs',binding.id,binding.providerName,binding.packageVersion,binding.configRevision,JSON.stringify(binding.capabilities),JSON.stringify(binding.credentialRefs));
    }
    for(const role of roles) {
      const prior=store.get<Role>('SELECT * FROM roles WHERE workspace_id=? AND name=?',workspaceId,role.name);
      if(prior) invariant(role.revision>prior.revision || (role.revision===prior.revision&&role.kind===prior.kind&&role.prompt===prior.prompt&&(role.providerBindingId??null)===prior.providerBindingId),'STALE_CONFIG','A changed role requires a higher revision.');
      store.exec('INSERT INTO roles(id,workspace_id,name,kind,provider_binding_id,prompt,revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET kind=excluded.kind,provider_binding_id=excluded.provider_binding_id,prompt=excluded.prompt,revision=excluded.revision',`${workspaceId}:${role.name}`,workspaceId,role.name,role.kind,role.providerBindingId??null,role.prompt,role.revision);
    }
    return store.all<Role>('SELECT * FROM roles WHERE workspace_id=? ORDER BY name',workspaceId);
  });
}
