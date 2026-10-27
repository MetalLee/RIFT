import { RiftStore } from '../../src/storage/database.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { configureRoles } from '../../src/project/agent-roles.js';
import type { ProviderBinding } from '../../src/contracts/index.js';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// A checkout may be a linked Git worktree: its .git is then a pointer file,
// while the shared metadata directory belongs to the original repository.
// Seed the same canonical identity the Host verifies, without weakening it.
const repositoryIdentity=new Map<string,{repositoryPath:string;commonGitDir:string}>();
function currentRepositoryIdentity(){
  const cwd=realpathSync(process.cwd());
  let identity=repositoryIdentity.get(cwd);
  if(!identity){
    const gitPath=(flag:string)=>realpathSync(execFileSync('git',['-C',cwd,'rev-parse','--path-format=absolute',flag],{encoding:'utf8',windowsHide:true,timeout:10000}).trim());
    identity={repositoryPath:gitPath('--show-toplevel'),commonGitDir:gitPath('--git-common-dir')};
    repositoryIdentity.set(cwd,identity);
  }
  return identity;
}

export function seedWorkspace(store: RiftStore, workspaceId = 'workspace-acceptance') {
  const identity=currentRepositoryIdentity();
  const workspace = createWorkspace(store, { id: workspaceId, name: workspaceId, rootPath: identity.repositoryPath, ...identity, baseRef: 'HEAD' });
  const bindings: ProviderBinding[] = [
    { id: `${workspaceId}-claude`, providerName: 'claude-code-dev', packageVersion: 'test-only', configRevision: 1, capabilities: {}, credentialRefs: ['env:ANTHROPIC_API_KEY'] },
    { id: `${workspaceId}-codex`, providerName: 'codex-review', packageVersion: 'test-only', configRevision: 1, capabilities: {}, credentialRefs: ['dsh:codex-auth'] },
  ];
  const roles = configureRoles(store, workspaceId, bindings, [
    { name: 'lead', kind: 'dsh-lead', prompt: 'Plan', revision: 1 },
    { name: 'developer-a', kind: 'subagent', providerBindingId: bindings[0]!.id, prompt: 'Develop A', revision: 1 },
    { name: 'developer-b', kind: 'subagent', providerBindingId: bindings[0]!.id, prompt: 'Develop B', revision: 1 },
    { name: 'reviewer', kind: 'subagent', providerBindingId: bindings[1]!.id, prompt: 'Review', revision: 1 },
  ], new Set(['claude-code-dev', 'codex-review']));
  return { workspace, roles, bindings };
}
