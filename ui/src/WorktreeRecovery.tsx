import { Button } from './components/ui/button';
import { useState } from 'react';
import type { WorkspaceWorktree } from '../../src/project/repositories';
import { errorText, mutate } from './api';
import { Copy } from './App';
export function WorktreeRecovery({ workspaceId, tree, csrf, onChanged }: { workspaceId: string; tree: WorkspaceWorktree; csrf: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (!['creating','creation_unknown','moving','move_unknown'].includes(tree.status)) return null;
  return <div className="run-recovery"><p>创建或移动的结果尚未确认。Host 将核对 Git 退出证明和实际目录，不会强制删除未知文件。</p>{tree.pendingPath && <><p>待确认目标目录</p><Copy value={tree.pendingPath} /></>}<Button variant="secondary" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await mutate(`/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(tree.id)}/reconcile`, csrf, { expectedVersion: tree.version }); onChanged(); } catch(e) { setError(errorText(e)); } finally { setBusy(false); } }}>{busy ? '正在核对目录与退出证据…' : '重新核对目录状态'}</Button>{error && <p className="form-error" role="alert">{error}</p>}</div>;
}
