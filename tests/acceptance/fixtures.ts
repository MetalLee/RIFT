import { RiftStore } from '../../src/storage/database.js';
import { createWorkspace } from '../../src/project/workspace.js';
import { configureRoles } from '../../src/project/agent-roles.js';
import type { ProviderBinding } from '../../src/contracts/index.js';

export function seedWorkspace(store: RiftStore, workspaceId = 'workspace-acceptance') {
  const workspace = createWorkspace(store, { id: workspaceId, name: workspaceId, rootPath: process.cwd(), repositoryPath: process.cwd(), commonGitDir: `${process.cwd()}/.git`, baseRef: 'HEAD' });
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
