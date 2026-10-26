import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import type { UiWorkspaceDetail, UiWorkspaceSummary } from '../../src/api/ui-contracts.js';
import type { AgentTurn, ChatPage, Conversation } from '../../src/chat/contracts.js';
import { startLocalApi } from '../../src/api/local-api.js';

const waitUntil = async (predicate: () => boolean) => { for (let i=0;i<100;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); } throw new Error('Timed out'); };

describe('U1–U5 browser domain routes', () => {
  it('executes registered repository-free text analysis without Git context or filesystem tools', async () => {
    const home=await mkdtemp(path.join(tmpdir(),'rift-text-analysis-'));
    const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[]});
    const calls:RuntimeTurnInput[]=[];
    host.registerChatRuntime('codex',{async start(input){calls.push(input);return{result:Promise.resolve({text:'The supplied text has two independent concerns.',stopReason:'completed' as const}),async dispose(){}};}},['text-test']);
    const prepare=vi.spyOn(host.git,'prepareTask');
    try{
      const workspace=await host.handleBrowser('POST','/ui-api/v1/workspaces',{name:'纯文本'},'text-ws') as {id:string};
      const agent=await host.handleBrowser('POST',`/ui-api/v1/workspaces/${workspace.id}/agents`,{displayName:'分析员',name:'analyst',purpose:'developer',prompt:'Analyze supplied text.',chatConnection:{runtime:'codex',model:'text-test'}},'text-agent') as {id:string};
      const workflow=await host.handle('POST','/v1/workflows',{workspaceId:workspace.id,goal:'Analyze supplied prose',mode:'analysis',startLead:false},'text-workflow') as {id:string};
      await host.handle('POST',`/v1/workflows/${workflow.id}/plan`,{expectedRevision:0,tasks:[{id:'text-only-task',kind:'analysis',title:'Read prose',instructions:'Compare alpha and beta.',expectedPaths:[],roleName:'analyst'}]},'text-plan');
      await expect(host.handle('POST',`/v1/workflows/${workflow.id}/plan`,{expectedRevision:1,tasks:[{kind:'change',title:'Forbidden',instructions:'Write a file',expectedPaths:['file.txt']}]},'forbidden-change')).rejects.toMatchObject({code:'REPOSITORY_REQUIRED'});
      host.coordinator.dispatch({taskId:'text-only-task',expectedVersion:0,idempotencyKey:'text-dispatch'});
      await waitUntil(()=>host.store.task('text-only-task').status==='succeeded');
      expect(prepare).not.toHaveBeenCalled(); expect(calls).toHaveLength(1); expect(calls[0]!.tools.map(tool=>tool.name)).toEqual(['rift_send_message']); expect(calls[0]!.agentId).toBe(agent.id);
      expect(host.store.all('SELECT * FROM worktrees')).toEqual([]); expect(host.store.all('SELECT * FROM workflow_repositories')).toEqual([]);
      expect(host.store.task('text-only-task')).toMatchObject({repositoryId:null,acceptedCommit:null});
      expect(host.coordinator.finish({workflowId:workflow.id,summary:'Text analysis verified.'}).status).toBe('completed');
    }finally{await host.close();await rm(home,{recursive:true,force:true});}
  });
  it('creates three-member workspaces, fixes versioned connection/Skill snapshots and routes explicit recipients without a model call', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-ui-domain-'));
    const host = new RiftHostService({ subagents: { list: () => [] }, llm: { listProviders: () => [] } } as unknown as Context, { home, port: 0, leadProvider: 'test', leadModel: 'test', checks: [] });
    const calls: { input: RuntimeTurnInput; finish: (value: RuntimeTurnResult) => void }[] = [];
    host.registerChatRuntime('codex', { async start(input) { let finish!: (value: RuntimeTurnResult) => void; const result = new Promise<RuntimeTurnResult>(resolve => { finish = resolve; }); calls.push({ input, finish }); return { result, async dispose() {} }; } }, ['verified-test-model']);
    try {
      await host.initialize();
      const create = (name: string) => host.handleBrowser('POST', '/ui-api/v1/workspaces', { name, leadConnection: { runtime: 'codex', model: 'verified-test-model' } }, name) as Promise<UiWorkspaceSummary>;
      const a = await create('空工作区'), b = await create('另一个');
      expect(a.repositoryPath).toBe('');
      const detail = await host.handleBrowser('GET', `/ui-api/v1/workspaces/${a.id}`, {}) as UiWorkspaceDetail;
      expect(detail.roles.map(role => role.purpose).sort()).toEqual(['developer', 'lead', 'reviewer']); expect(detail.conversations).toHaveLength(1);
      expect(detail.leadConfiguration).toMatchObject({ source: 'workspace', runtime: 'codex' });
      await expect(host.handleBrowser('PATCH', `/ui-api/v1/workspaces/${a.id}`, { expectedVersion: a.version - 1, name: 'stale' }, 'stale')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(host.handleBrowser('PATCH', `/ui-api/v1/workspaces/${a.id}`, { expectedVersion: a.version, leadConnection: { runtime: 'codex', model: 'unverified' } }, 'unverified')).rejects.toMatchObject({ code: 'MODEL_UNVERIFIED' });
      const skillDir = path.join(home, 'skill'); await mkdir(skillDir); await writeFile(path.join(skillDir, 'SKILL.md'), 'Always explain the acceptance evidence.');
      const preview = await host.handleBrowser('POST', `/ui-api/v1/workspaces/${a.id}/skills/preview`, { directory: skillDir, name: '验收方法' }, 'preview') as { previewId: string };
      const saved = await host.handleBrowser('POST', `/ui-api/v1/workspaces/${a.id}/skills/import`, { previewId: preview.previewId }, 'import') as { skill: {id:string}; version: {id:string} };
      await host.handleBrowser('PUT', `/ui-api/v1/workspaces/${a.id}/skills/${saved.skill.id}/shared`, { versionId: saved.version.id, expectedRevision: 0, enabled: true }, 'share');
      const conversation = detail.conversations[0]!;
      const messageRoute = `/ui-api/v1/workspaces/${a.id}/conversations/${conversation.id}/messages`;
      const body = { clientMessageId: 'first-message', content: '讨论计划' };
      const result = await host.handleBrowser('POST', messageRoute, body, 'message') as { turn: AgentTurn };
      await waitUntil(() => calls.length === 1);
      expect(calls[0]!.input.instructions).toContain('Always explain the acceptance evidence.');
      expect(calls[0]!.input.tools.map(tool => tool.name)).toContain('rift_workflow_start');
      expect(calls[0]!.input.cwd).toBe(path.join(home, 'chat-staging', result.turn.id));
      await expect(calls[0]!.input.tools.find(tool => tool.name === 'rift_workflow_start')!.execute({ goal: 'Code without repo' }, new AbortController().signal)).rejects.toMatchObject({ code: 'REPOSITORY_REQUIRED' });
      await expect(host.handle('POST', `/v1/workspaces/${a.id}/archive`, {}, 'archive-busy')).rejects.toMatchObject({ code: 'WORKSPACE_ACTIVE' });
      await host.handleBrowser('POST', messageRoute, body, 'same-client-different-http-key');
      expect(calls).toHaveLength(1);
      const bLead = host.store.require<{id:string}>("SELECT id FROM roles WHERE workspace_id=? AND purpose='lead'", b.id);
      await expect(host.handleBrowser('POST', messageRoute, { clientMessageId: 'foreign', content: 'wrong recipient', recipientAgentId: bLead.id }, 'foreign')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      calls[0]!.finish({ text: '这是可恢复的回复。', stopReason: 'completed' });
      await waitUntil(() => host.chat.turn(a.id, result.turn.id).status === 'completed');
      const page = await host.handleBrowser('GET', `${messageRoute}?limit=1`, {}) as ChatPage;
      expect(page.messages).toHaveLength(1); expect(page.nextBefore).not.toBeNull();
      expect(page.messages[0]!.content).toBe('这是可恢复的回复。');
      expect(host.store.get('SELECT owner_id FROM skill_execution_snapshots WHERE owner_type=? AND owner_id=?', 'turn', result.turn.id)).toBeTruthy();
      expect(host.store.get('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL', result.turn.id)).toBeUndefined();
      await expect(calls[0]!.input.tools.find(tool => tool.name === 'rift_status')!.execute({}, new AbortController().signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('uses dist/ui as the default static output in source execution without uiDist configuration', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-ui-default-'));
    const relativeName = `browser-default-${Date.now()}.js`, directory = path.resolve('dist/ui/assets'), file = path.join(directory, relativeName);
    await mkdir(directory, { recursive: true }); await writeFile(file, 'export const defaultPathWorks=true;');
    const api = await startLocalApi({ handle: async () => ({}), handleBrowser: async () => ({}) }, { home, port: 0 });
    try { const response = await fetch(`http://127.0.0.1:${api.port}/assets/${relativeName}`); expect(response.status).toBe(200); expect(await response.text()).toContain('defaultPathWorks'); }
    finally { await api.close(); await rm(file); await rm(home, { recursive: true, force: true }); }
  });
});
