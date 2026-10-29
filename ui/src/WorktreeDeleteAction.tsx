import React, { useRef, useState } from 'react';
import type { WorktreeRemovalTarget } from '@rift/protocol';
import { Button } from './components/ui/button';
import { errorText } from './api';
import { useMutation } from './useMutation';

export function WorktreeDeleteConfirmation({ target, busy, onCancel, onDelete }: {
  target: WorktreeRemovalTarget; busy: boolean; onCancel: () => void; onDelete: () => void;
}) {
  return <div className="cancel-confirm" role="group" aria-label="确认删除 Worktree" aria-busy={busy}>
    <h4>删除 Worktree 磁盘目录？</h4><code>{target.path}</code>
    <p>仅删除以上 RIFT 受管目录。保留分支、提交、任务、运行、集成与审查记录；此操作不会删除主仓库或外部目录。</p>
    <p>确认后将删除目录内所有内容，包括未提交修改、未跟踪文件和忽略文件，且不会保存这些本地内容。Host 仍会检查归属、版本、执行清理和锁定状态。</p>
    <Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button>
    <Button variant="destructive" disabled={busy} onClick={onDelete}>{busy ? '正在安全删除…' : '确认删除磁盘目录'}</Button>
  </div>;
}

export function WorktreeDeleteAction({ workspaceId, target, csrf, onChanged }: {
  workspaceId: string; target: WorktreeRemovalTarget; csrf: string; onChanged: () => Promise<void> | void;
}) {
  const [confirmation, setConfirmation] = useState<WorktreeRemovalTarget | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false), write = useMutation(csrf);
  async function act(action: 'delete' | 'reconcile', snapshot: WorktreeRemovalTarget) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await write(`/workspaces/${encodeURIComponent(workspaceId)}/worktree-removals/${snapshot.kind}/${encodeURIComponent(snapshot.recordId)}/${action}`, {
        expectedVersion: snapshot.expectedVersion, ...(action === 'delete' ? { confirmDelete: true } : {}),
      });
      setConfirmation(null);
    } catch (e) { setError(errorText(e)); setConfirmation(null); }
    finally {
      // A rejected/uncertain request also advances the deletion receipt. Always
      // reload before allowing another confirmation with a new version token.
      try { await onChanged(); } finally { inFlight.current = false; setBusy(false); }
    }
  }
  return <div className="worktree-delete-action">
    <Button variant="ghost" disabled={busy || !target.canDelete} onClick={() => { setError(''); setConfirmation(target); }}>删除 Worktree…</Button>
    {target.reason && <p role="status">{target.reason}</p>}
    {target.error && <p className="form-error">上次删除未完成：{target.error}</p>}
    {target.canReconcile && <Button variant="secondary" disabled={busy} onClick={() => void act('reconcile', target)}>{busy ? '正在核对…' : '核对删除结果与清理证据'}</Button>}
    {confirmation && <WorktreeDeleteConfirmation target={confirmation} busy={busy} onCancel={() => setConfirmation(null)} onDelete={() => void act('delete', confirmation)} />}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
