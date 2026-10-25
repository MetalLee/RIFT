import { invariant, type Role, type RoleName, type RolePurpose, type ProviderBinding } from '../contracts/index.js';
import { RiftStore } from '../storage/database.js';
import { validateBinding, validateInstanceModels } from './provider-bindings.js';
export interface RoleConfiguration { name:RoleName; purpose?:RolePurpose; kind:'dsh-lead'|'subagent'; providerBindingId?:string; prompt:string; revision:number }
export function rolePurpose(role:Pick<RoleConfiguration,'name'|'purpose'>):RolePurpose|undefined { return role.purpose ?? (role.name==='lead'?'lead':role.name==='reviewer'?'reviewer':/^developer-[ab]$/.test(role.name)?'developer':undefined); }
export function configureRoles(store:RiftStore,workspaceId:string,bindings:ProviderBinding[],roles:RoleConfiguration[],registeredProviderNames:ReadonlySet<string>):Role[] {
  store.workspace(workspaceId);
  invariant(roles.length>=3 && roles.length<=130 && new Set(roles.map(role=>role.name)).size===roles.length,'INVALID_ROLES','Configure up to 130 unique roles including one Lead, a developer and a reviewer.');
  invariant(roles.every(role=>typeof role.name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(role.name)&&['lead','developer','reviewer'].includes(rolePurpose(role)??'')),'INVALID_ROLES','Roles need valid unique names and an explicit purpose; legacy default names retain their purpose.');
  invariant(roles.filter(role=>rolePurpose(role)==='lead').length===1&&roles.some(role=>rolePurpose(role)==='developer')&&roles.some(role=>rolePurpose(role)==='reviewer'),'INVALID_ROLES','Exactly one Lead and at least one developer and reviewer are required.');
  invariant(new Set(bindings.map(binding=>binding.id)).size===bindings.length,'INVALID_CONFIG','Provider binding IDs must be unique.');
  for(const binding of bindings) validateBinding(binding,registeredProviderNames);
  for(const role of roles) {
    invariant(rolePurpose(role)==='lead' ? role.kind==='dsh-lead' && !role.providerBindingId : role.kind==='subagent' && Boolean(role.providerBindingId),'UNSUPPORTED_ROLE','Lead must use DSH; child roles require registered provider bindings.');
    invariant(Number.isInteger(role.revision)&&role.revision>0,'INVALID_CONFIG','Role revisions must be positive integers.');
    if(role.providerBindingId) invariant(bindings.some(binding=>binding.id===role.providerBindingId),'BINDING_NOT_FOUND','Role binding must be included in this configuration.');
  }
  return store.transaction(()=> {
    invariant(!store.get('SELECT id FROM execution_leases WHERE workspace_id=? AND released_at IS NULL LIMIT 1',workspaceId),'CONFIG_IN_USE','Cannot change role configuration while executions or unknown cleanup retain slots.');
    for(const prior of store.all<Role>('SELECT * FROM roles WHERE workspace_id=? AND enabled=1',workspaceId)) {
      const replacement=roles.find(role=>role.name===prior.name);
      if(replacement&&rolePurpose(replacement)===rolePurpose(prior))continue;
      invariant(!store.get("SELECT id FROM agent_turns WHERE agent_id=? AND status='queued' LIMIT 1",prior.id),'CONFIG_IN_USE','A queued discussion still needs this role.');
      invariant(!store.get("SELECT id FROM tasks WHERE role_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1",prior.id)&&!store.get("SELECT id FROM operations WHERE phase='queued' AND json_extract(payload,'$.roleId')=? LIMIT 1",prior.id),'CONFIG_IN_USE','An unfinished task or queued request still needs this role and purpose.');
    }
    const incomingIds=new Set(bindings.map(binding=>binding.id));
    validateInstanceModels([...store.all<ProviderBinding>('SELECT * FROM provider_bindings').filter(binding=>!incomingIds.has(binding.id)),...bindings]);
    for(const binding of bindings) {
      const prior=store.get<ProviderBinding>('SELECT * FROM provider_bindings WHERE id=?',binding.id);
      if(prior)invariant(!store.get('SELECT r.id FROM runs r JOIN roles role ON role.id=r.role_id WHERE role.provider_binding_id=? AND r.slot_released_at IS NULL LIMIT 1',binding.id),'CONFIG_IN_USE','A shared provider binding is in use by another workspace or retained cleanup.');
      const canonical=(value:ProviderBinding)=>JSON.stringify({providerName:value.providerName,packageVersion:value.packageVersion,capabilities:Object.fromEntries(Object.entries(value.capabilities).sort()),credentialRefs:value.credentialRefs,runtime:value.runtime??null,model:value.model??null,spawn:value.spawn??null});
      if(prior) invariant(binding.configRevision>prior.configRevision || (binding.configRevision===prior.configRevision&&canonical(prior)===canonical(binding)),'STALE_CONFIG','A changed provider binding requires a higher revision.');
      store.exec('INSERT INTO provider_bindings(id,provider_name,package_version,config_revision,capabilities,credential_refs,runtime,model,spawn) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_name=excluded.provider_name,package_version=excluded.package_version,config_revision=excluded.config_revision,capabilities=excluded.capabilities,credential_refs=excluded.credential_refs,runtime=excluded.runtime,model=excluded.model,spawn=excluded.spawn',binding.id,binding.providerName,binding.packageVersion,binding.configRevision,JSON.stringify(binding.capabilities),JSON.stringify(binding.credentialRefs),binding.runtime??null,binding.model??null,binding.spawn?JSON.stringify(binding.spawn):null);
    }
    store.exec('UPDATE roles SET enabled=0 WHERE workspace_id=?',workspaceId);
    for(const role of roles) {
      const prior=store.get<Role>('SELECT * FROM roles WHERE workspace_id=? AND name=?',workspaceId,role.name);
      if(prior) invariant(role.revision>prior.revision || (role.revision===prior.revision&&role.kind===prior.kind&&rolePurpose(role)===rolePurpose(prior)&&role.prompt===prior.prompt&&(role.providerBindingId??null)===prior.providerBindingId),'STALE_CONFIG','A changed role requires a higher revision.');
      store.exec('INSERT INTO roles(id,workspace_id,name,kind,purpose,provider_binding_id,prompt,revision,enabled) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(workspace_id,name) DO UPDATE SET kind=excluded.kind,purpose=excluded.purpose,provider_binding_id=excluded.provider_binding_id,prompt=excluded.prompt,revision=excluded.revision,version=roles.version+1,enabled=1',`${workspaceId}:${role.name}`,workspaceId,role.name,role.kind,rolePurpose(role)!,role.providerBindingId??null,role.prompt,role.revision);
    }
    return store.all<Role>('SELECT * FROM roles WHERE workspace_id=? AND enabled=1 ORDER BY name',workspaceId);
  });
}
