import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UiWorkspaceDetail } from '@rift/protocol';
import { RepositoryManager } from './RepositoryManager';

const data = {
  workspace: { id: 'workspace', version: 1 }, observedAt: 'now',
  repositories: [{ id: 'repo', canonicalPath: '/repo', baseRef: 'main' }],
  worktrees: [{ id: 'task-tree', taskId: 'task', status: 'active' }],
  tasks: [{ id: 'task', repositoryId: 'repo' }],
  managedWorktrees: [], runs: [], integrations: [],
} as unknown as UiWorkspaceDetail;

describe('repository inventory initial rendering', () => {
  it('does not claim zero or render unverified task rows before the repository API loads', () => {
    const html = renderToStaticMarkup(<RepositoryManager data={data} csrf="fixture" onChanged={() => {}} />);
    expect(html).toContain('正在核对工作目录…');
    expect(html).not.toContain('0 个当前工作目录');
    expect(html).not.toContain('暂无当前工作目录');
    expect(html).not.toContain('worktree-row');
  });
  it('can report a known zero with no repositories, ignoring stale detached workspace records', () => {
    const html = renderToStaticMarkup(<RepositoryManager data={{ ...data, repositories: [] }} csrf="fixture" onChanged={() => {}} />);
    expect(html).toContain('0 个当前工作目录');
    expect(html).toContain('为代码任务关联一个仓库');
  });
});
