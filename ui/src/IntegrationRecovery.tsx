import { Button } from './components/ui/button';
import { useState } from 'react';
import type { UiIntegration } from '../../src/api/ui-contracts';
import { errorText, mutate } from './api';
export function IntegrationRecovery({ workspaceId, integration, csrf, onChanged }: { workspaceId: string; integration: UiIntegration; csrf: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (!['cleanup_unknown','publishing'].includes(integration.status)) return null;
  return <div className="run-recovery"><p>核对实际 Git 发布结果前，相关执行必须已确认清理。无法证明结果时会继续阻止集成。</p><Button variant="secondary" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await mutate(`/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(integration.id)}/reconcile`, csrf, { expectedVersion: integration.version }); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>{busy ? '正在核对 Git 证据…' : '核对集成与发布状态'}</Button>{error && <p className="form-error" role="alert">{error}</p>}</div>;
}
