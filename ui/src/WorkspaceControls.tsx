import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { useState } from 'react';
import type { UiWorkspaceDetail } from '@rift/protocol';
import { errorText } from './api';
import { useMutation } from './useMutation';
import { Notice } from './App';

export function WorkspaceControls({ data, csrf, onChanged }: { data: UiWorkspaceDetail; csrf: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false); const [archiving, setArchiving] = useState(false); const [expectedVersion, setExpectedVersion] = useState(data.workspace.version); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const write = useMutation(csrf);
  const base = `/workspaces/${encodeURIComponent(data.workspace.id)}`;
  if (data.workspace.status === 'archived') return <Notice>工作区已归档，保留历史记录供查阅。</Notice>;
  return <div className="workspace-settings-controls">{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><Button variant="secondary" onClick={() => { setExpectedVersion(data.workspace.version); setEditing(true); setArchiving(false); }}>重命名工作区</Button><Button variant="ghost" className="text-button" onClick={() => { setArchiving(true); setEditing(false); }}>归档工作区…</Button></div>{editing && <form className="inline-form" onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); const form = new FormData(e.currentTarget); try { await write(base, { name: String(form.get('workspaceName')).trim(), expectedVersion }, 'PATCH'); setEditing(false); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}><label>工作区名称<Input name="workspaceName" maxLength={120} defaultValue={data.workspace.name} required /></label><Button variant="secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>取消</Button><Button variant="default" className="primary" disabled={busy}>{busy ? '正在保存…' : '保存名称'}</Button></form>}{archiving && <div className="archive-workspace"><h3>归档「{data.workspace.name}」</h3><p>历史对话与任务记录将保留。活动工作流、排队对话或未确认的清理会阻止归档；任务工作目录也必须通过安全检查。</p>{data.worktrees.length > 0 && <details><summary>核对 {data.worktrees.length} 个任务工作目录</summary><ul>{data.worktrees.map(w => <li key={w.id}><code>{w.path}</code></li>)}</ul></details>}<div className="form-actions"><Button variant="secondary" className="secondary" disabled={busy} onClick={() => setArchiving(false)}>保留工作区</Button><Button variant="default" className="primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await write(`${base}/archive`, {}); setArchiving(false); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>{busy ? '正在检查并归档…' : '确认归档此工作区'}</Button></div></div>}</div>;
}
