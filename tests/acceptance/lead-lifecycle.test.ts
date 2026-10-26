import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { RiftHostService } from '../../src/api/host-service.js';
import { seedWorkspace } from './fixtures.js';

vi.mock('../../src/agent/repository-shell.js',()=>({createRepositoryShell:vi.fn(async()=>({tool:{name:'exec_command',description:'Controlled repository shell',inputSchema:{},execute:vi.fn(async()=>({exitCode:0}))},dispose:vi.fn(async()=>{})}))}));

describe('independent Lead lifecycle management', () => {
  async function fixture(cancel = vi.fn(async () => undefined), createGate: Promise<void> = Promise.resolve()) {
    const home = await mkdtemp(path.join(tmpdir(), 'rift-lead-lifecycle-'));
    const handles: { agent: { id: string; followup: ReturnType<typeof vi.fn>; cancel: typeof cancel }; dispose: ReturnType<typeof vi.fn> }[] = [];
    const create = vi.fn(async () => {
      await createGate;
      const handle = { agent: { id: `lead-${handles.length}`, followup: vi.fn(), cancel }, dispose: vi.fn(async () => undefined) };
      handles.push(handle);
      return handle;
    });
    const ctx = { agents: { create }, subagents: { list: () => [] }, llm: { listProviders: () => [{ id: 'fake', name: 'Fake' }] } } as unknown as Context;
    const service = new RiftHostService(ctx, { home, port: 0, leadProvider: 'fake', leadModel: 'fake', checks: [] });
    const { workspace } = seedWorkspace(service.store);
    const workflow = service.coordinator.createWorkflow({ workspaceId: workspace.id, goal: 'lifecycle', integrationRef: 'refs/heads/rift/lifecycle', baseCommit: 'a'.repeat(40) });
    let closed = false;
    return { service, workflow, handles, create, close: async () => { if (!closed) { closed = true; await service.close(); } await rm(home, { recursive: true, force: true }); } };
  }

  it('serializes concurrent Lead attachment so one workflow has exactly one live parent', async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([f.service.startLead(f.workflow.id), f.service.startLead(f.workflow.id)]);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(new Set(results.map(result => result.leadSessionId)).size).toBe(1);
      expect(f.service.store.events(f.workflow.id).filter(event => event.type === 'lead.attached')).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('cancels durable workflow work even if cancelling the Lead throws', async () => {
    const f = await fixture(vi.fn(async () => { throw new Error('parent cancellation failed'); }));
    try {
      f.service.coordinator.submitPlan({ workflowId: f.workflow.id, expectedRevision: 0, tasks: [{ id: 'child', kind: 'analysis', title: 'Child', instructions: 'Inspect', expectedPaths: [] }] });
      await f.service.startLead(f.workflow.id);
      await expect(f.service.handle('POST', `/v1/workflows/${f.workflow.id}/cancel`, {}, 'cancel')).rejects.toMatchObject({ code: 'LEAD_CANCEL_FAILED' });
      expect(f.service.store.workflow(f.workflow.id).status).toBe('cancelled');
      expect(f.service.store.task('child').status).toBe('cancelled');
    } finally { await f.close(); }
  });

  it('attaches a live parent without requesting a model turn', async () => {
    const f = await fixture();
    try {
      const parent = await f.service.ensureLead(f.workflow.id);
      expect(parent.leadSessionId).toBe(f.handles[0]!.agent.id);
      expect(f.handles[0]!.agent.followup).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('rejects an unregistered Lead provider before creating an agent or requesting a turn', async () => {
    const f = await fixture();
    try {
      f.service.config.leadProvider = 'not-registered';
      await expect(f.service.startLead(f.workflow.id)).rejects.toMatchObject({ code: 'LEAD_PROVIDER_UNAVAILABLE' });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.handles).toHaveLength(0);
      expect(f.service.store.workflow(f.workflow.id).leadSessionId).toBeNull();
    } finally { await f.close(); }
  });

  it('disposes a parent that finishes creation after close begins', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(undefined, gate);
    try {
      const attached = expect(f.service.ensureLead(f.workflow.id)).rejects.toMatchObject({ code: 'HOST_CLOSING' });
      const closing = f.close();
      release();
      await Promise.all([attached, closing]);
      expect(f.handles).toHaveLength(1);
      expect(f.handles[0]!.dispose).toHaveBeenCalledTimes(1);
      expect(f.handles[0]!.agent.followup).not.toHaveBeenCalled();
    } finally { release(); await f.close(); }
  });
});
