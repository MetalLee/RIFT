import { Button } from './components/ui/button';
import { useState } from 'react';
import type { UiRun } from '../../src/api/ui-contracts';
import { errorText, mutate } from './api';
export function RunRecovery({ workspaceId, run, csrf, onChanged }: { workspaceId: string; run: UiRun; csrf: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (run.slotReleasedAt || !['unknown','failed'].includes(run.cleanupStatus)) return null;
  return <div className="run-recovery"><p>未确认的清理仍占用资源。Host 只会在持有退出证明时释放，不提供强制绕过。</p><Button variant="secondary" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await mutate(`/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(run.id)}/reconcile`, csrf, { expectedVersion: run.version }); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>{busy ? '正在核对…' : '核对执行退出证据'}</Button>{error && <p className="form-error" role="alert">{error}</p>}</div>;
}
