import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { useEffect, useRef, useState } from 'react';
import { api, errorText, request, type ApiConnectionCreate } from './api';
import { randomId } from './browser-platform';
import { Copy, Icon, Notice, Pill, time } from './App';
import { useMutation } from './useMutation';
import { LatestRequest } from './state';

export interface ApiConnection {
  id: string; name: string; protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; endpoint: string; model: string;
  provider: string; revision: number; parentId: string | null; createdAt: string; verifiedAt: string | null;
  verificationStatus: 'not-verified' | 'passed' | 'failed'; verificationError: string | null; available: boolean;
}
export function ConnectionCatalogue({ csrf, onChanged }: { csrf: string; onChanged: () => void }) {
  const [connections, setConnections] = useState<ApiConnection[]>([]); const [error, setError] = useState(''); const [editing, setEditing] = useState<ApiConnection | 'new' | null>(null); const [busy, setBusy] = useState<string | null>(null); const latest = useRef(new LatestRequest()); const write = useMutation(csrf);
  const saveKey = useRef(randomId()); const [saved, setSaved] = useState(false);
  const [configuration, setConfiguration] = useState<{ available: boolean; reason: string | null } | null>(null);
  async function load() { const token = latest.current.begin(); try { const result = await request<{ savedConnections: ApiConnection[]; configuration: {available:boolean;reason:string|null} }>('/connections', { signal: token.signal }); if (token.current()) { setConnections(result.savedConnections ?? []); setConfiguration(result.configuration); } } catch (e) { if (token.current()) setError(errorText(e)); } }
  useEffect(() => { void load(); return () => latest.current.cancel(); }, []);
  const initial = editing && editing !== 'new' ? editing : null;
  return <Card asChild><section className="card settings-card connection-catalogue"><div className="section-heading"><div><span className="eyebrow">MODEL API CONNECTIONS</span><h2>模型 API 连接</h2></div><Button variant="secondary" className="secondary" disabled={!configuration?.available || !!busy} onClick={() => { saveKey.current=randomId(); setEditing('new'); setError(''); setSaved(false); }}><Icon name="plus" size={16} />添加连接</Button></div><p>填写 API 端点、模型和密钥即可保存连接，无需设置环境变量。已保存的密钥不会在页面显示。</p><Button variant="ghost" className="text-button" disabled={!!busy} onClick={() => void load()}>刷新连接目录</Button>
    {saved && <p role="status" className="muted">连接已保存，密钥输入已清空。可发送验证请求，或在 Agent 设置中选择新连接。</p>}{error && <p className="form-error" role="alert">{error}</p>}{configuration && !configuration.available && <Notice>当前 Host 暂不能配置或验证 API 连接：{configuration.reason || '模型服务尚未启用'}</Notice>}
    {editing && <form key={initial?.id ?? 'new'} className="api-connection-form" onChange={() => { saveKey.current=randomId(); setSaved(false); }} onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy('save'); setError(''); setSaved(false);
      const element=e.currentTarget,form=new FormData(element),apiKey=String(form.get('apiKey')??'');
      try {
        await api.createConnection({name:String(form.get('name')).trim(),protocol:String(form.get('protocol')) as ApiConnectionCreate['protocol'],endpoint:String(form.get('endpoint')).trim(),model:String(form.get('model')).trim(),apiKey,...(initial?{parentId:initial.id}:{})},csrf,saveKey.current);
        const field=element.elements.namedItem('apiKey'); if(field instanceof HTMLInputElement)field.value='';
        form.delete('apiKey'); setEditing(null); setSaved(true); saveKey.current=randomId(); await load(); onChanged();
      } catch (error) { const message=errorText(error);setError(apiKey?message.split(apiKey).join('[已隐藏密钥]'):message); }
      finally { setBusy(null); }
    }}><h3>{initial ? `为 ${initial.name} 保存新版本` : '新建 API 连接'}</h3><fieldset className="form-grid m-0 min-w-0 border-0 p-0" disabled={!!busy}><label>连接名称<Input name="name" required maxLength={120} defaultValue={initial?.name ?? ''} /></label><label>API 协议<NativeSelect name="protocol" defaultValue={initial?.protocol ?? 'openai-responses'}><NativeSelectOption value="openai-responses">OpenAI Responses</NativeSelectOption><NativeSelectOption value="openai-completions">OpenAI Chat Completions</NativeSelectOption><NativeSelectOption value="anthropic-messages">Anthropic Messages</NativeSelectOption></NativeSelect></label><label className="full-width">API 端点<Input name="endpoint" type="url" required defaultValue={initial?.endpoint ?? ''} placeholder="https://…" /></label><label>模型标识<Input name="model" required maxLength={160} defaultValue={initial?.model ?? ''} /></label><label>API 密钥<Input name="apiKey" type="password" required maxLength={16384} defaultValue="" placeholder={initial ? '请重新输入密钥以保存新版本' : '输入 API 密钥'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} /></label></fieldset><Notice>每次保存都会生成新的连接版本。现有 Agent 和运行快照继续使用原连接；保存后请在对应 Agent 设置里明确选择新版本。</Notice><div className="form-actions"><Button variant="secondary" type="button" className="secondary" disabled={!!busy} onClick={() => setEditing(null)}>取消</Button><Button variant="default" className="primary" disabled={!!busy}>{busy === 'save' ? '正在保存…' : '保存新连接版本'}</Button></div></form>}
    {!connections.length && !editing && <p className="muted">尚未保存自定义 API 连接。也可以使用 Host 已登记的连接。</p>}
    <div className="saved-connections">{connections.map(connection => <article className="saved-connection" key={connection.id}><div className="saved-connection-title"><h3>{connection.name}</h3><Pill>{connection.verificationStatus === 'passed' ? '验证通过' : connection.verificationStatus === 'failed' ? '验证失败' : '尚未验证'}</Pill></div><p>{connection.protocol} · {connection.model} · 版本 {connection.revision}</p><Copy value={connection.endpoint} />{connection.verifiedAt && <p className="muted">验证时间：{time(connection.verifiedAt)}</p>}{!connection.available && <p className="muted">此连接当前未在 Host 加载，暂不能发送验证请求。</p>}{connection.verificationError && <p className="form-error">{connection.verificationError}</p>}<div className="connection-actions"><Button variant="ghost" className="text-button" disabled={!!busy || !configuration?.available} onClick={() => {saveKey.current=randomId();setEditing(connection);setError('');setSaved(false);}}>编辑为新版本</Button><Button variant="secondary" className="secondary" disabled={!!busy || !connection.available || !configuration?.available} onClick={async () => { setBusy(connection.id); setError(''); try { const result = await write<{ connection: ApiConnection; passed: boolean; error?: string }>(`/connections/${encodeURIComponent(connection.id)}/verify`, {}); if (!result.passed) setError(result.error ?? '连接验证未通过，请查看连接记录。'); await load(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); } }}>{busy === connection.id ? '正在调用模型验证…' : '发送真实模型验证请求'}</Button></div></article>)}</div>
  </section></Card>;
}
