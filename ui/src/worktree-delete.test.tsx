import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React, { type ReactElement } from 'react';
import type { WorktreeRemovalTarget } from '@rift/protocol';
import { WorktreeDeleteAction, WorktreeDeleteConfirmation } from './WorktreeDeleteAction';

// Exercise the deletion controls without the app-only Tailwind/Radix aliases.
vi.mock('./components/ui/button', () => ({
  Button: ({ variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => React.createElement('button', props),
}));

const target: WorktreeRemovalTarget = { kind: 'task', recordId: 'task:1', repositoryId: 'repo', path: 'D:\\RIFT\\工作目录 <exact>\\task', expectedVersion: 'opaque-version', state: 'available', canDelete: true, reason: null, error: null, canReconcile: false };
describe('Worktree deletion confirmation UI (server rendering)', () => {
  it('makes physical deletion, exact escaped path and preservation guarantees explicit, with a cancellation action', () => {
    const cancel = vi.fn(), remove = vi.fn();
    const element = WorktreeDeleteConfirmation({ target, busy: false, onCancel: cancel, onDelete: remove });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('删除 Worktree 磁盘目录？');
    expect(html).toContain('D:\\RIFT\\工作目录 &lt;exact&gt;\\task');
    expect(html).toContain('保留分支、提交、任务、运行、集成与审查记录');
    expect(html).toContain('dirty / untracked / ignored');
    expect(html).toContain('取消'); expect(html).toContain('确认删除磁盘目录');
    const buttons = (element.props.children as ReactElement<{ onClick?: () => void; children?: string }>[]).filter(child => child.props?.onClick);
    buttons.find(button => button.props.children === '取消')!.props.onClick!();
    expect(cancel).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
    buttons.find(button => button.props.children === '确认删除磁盘目录')!.props.onClick!();
    expect(remove).toHaveBeenCalledOnce();
  });
  it('disables confirmation and cancellation during deletion and reports busy state', () => {
    const html = renderToStaticMarkup(<WorktreeDeleteConfirmation target={target} busy onCancel={() => {}} onDelete={() => {}} />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('正在安全删除…');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it('disables unsafe directories with a visible reason and preserves retry/error evidence', () => {
    const html = renderToStaticMarkup(<WorktreeDeleteAction workspaceId="workspace" csrf="csrf" target={{ ...target, canDelete: false, state: 'unknown', reason: '执行清理未确认', error: 'Git timed out', canReconcile: true }} onChanged={() => {}} />);
    expect(html).toContain('删除 Worktree…'); expect(html).toContain('disabled=""');
    expect(html).toContain('执行清理未确认'); expect(html).toContain('上次删除未完成：Git timed out');
    expect(html).toContain('核对删除结果与清理证据');
    expect(html).not.toContain('确认删除磁盘目录'); // Requires a deliberate first click.
  });
});
