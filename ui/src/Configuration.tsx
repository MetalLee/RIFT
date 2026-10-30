import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { Input } from './components/ui/input';
import { Card } from './components/ui/card';
import { Textarea } from './components/ui/textarea';
import { Button } from './components/ui/button';
import { useEffect, useState, type FormEvent } from 'react';
import type { ChatConnection, UiWorkspaceDetail, ConnectionChoice } from '@rift/protocol';
import { errorText, mutate, request } from './api';
import { Notice } from './App';
import { useMutation } from './useMutation';
import type { ApiConnection } from './ConnectionCatalogue';

export function ConnectionFields({ initial, optional = false, runtimeFilter, purpose = 'chat', preserveExisting = false }: { initial?: ChatConnection | null; optional?: boolean; runtimeFilter?: 'dsh' | 'codex'; purpose?: 'chat' | 'execution'; preserveExisting?: boolean }) {
  const [choices, setChoices] = useState<ConnectionChoice[]>([]);
  const [savedConnections, setSavedConnections] = useState<ApiConnection[]>([]); const [model, setModel] = useState(initial?.model ?? '');
  const [error, setError] = useState('');
  const initialId = initial ? initial.runtime === 'dsh' ? `dsh:${initial.provider}` : initial.runtime : '';
  const [selected, setSelected] = useState(initialId);
  useEffect(() => { const controller = new AbortController(); request<{ connections: ConnectionChoice[]; savedConnections?: ApiConnection[] }>('/connections', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setChoices(result.connections); setSavedConnections(result.savedConnections ?? []); } }, e => { if (!controller.signal.aborted) setError(errorText(e)); }); return () => controller.abort(); }, []);
  const selectedChoice = choices.find(c => c.id === selected);
  const execution = purpose === 'execution';
  const field = (name: string) => execution ? `execution_${name}` : name;
  const saved = savedConnections.find(c => c.provider === selectedChoice?.provider);
  const models = selectedChoice?.models ?? [];
  return <fieldset className="connection-fields">
    <legend>{execution ? '任务执行连接' : '对话运行连接'}</legend>
    {error && <p className="form-error">{error}</p>}
    <label>API 或原生运行时<NativeSelect name={field('connectionId')} value={selected} onChange={e => {
      setSelected(e.target.value);
      const choice = choices.find(c => c.id === e.target.value);
      setModel(savedConnections.find(item => item.provider === choice?.provider)?.model ?? '');
    }} required={!optional}>
      <NativeSelectOption value="">{execution && preserveExisting ? '保留现有执行连接' : optional ? execution ? '暂不配置任务执行连接' : '暂不配置对话连接' : '选择 API 或原生运行时'}</NativeSelectOption>
      {initialId && !choices.some(c => c.id === initialId) && <NativeSelectOption value={initialId} disabled>{initialId} · 当前不可用</NativeSelectOption>}
      {choices.filter(c => !runtimeFilter || c.runtime === runtimeFilter).map(c => <NativeSelectOption value={c.id} key={c.id} disabled={!c.available || (execution && !c.executionAvailable)}>
        {c.runtime === 'dsh' ? `模型 API · ${savedConnections.find(item => item.provider === c.provider)?.name ?? c.provider}` : 'Codex 原生运行时'}{!c.available || (execution && !c.executionAvailable) ? '（不可用）' : ''}
      </NativeSelectOption>)}
    </NativeSelect></label>
    {selected && <>
      <label>模型标识{selectedChoice?.modelSelection === 'verified-only' ? <NativeSelect name={field('model')} required value={model} onChange={e => setModel(e.target.value)}>
        <NativeSelectOption value="">选择模型</NativeSelectOption>
        {model && !models.includes(model) && <NativeSelectOption value={model} disabled>{model} · 当前不可用</NativeSelectOption>}
        {models.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
      </NativeSelect> : <Input name={field('model')} required maxLength={160} readOnly={!!saved} value={model} onChange={e => setModel(e.target.value)} placeholder="输入此连接支持的模型标识" />}</label>
      <label>推理强度（可选）<Input key={selected} name={field('reasoningEffort')} maxLength={40} defaultValue={selected === initialId ? initial?.reasoningEffort ?? '' : ''} placeholder="留空使用运行时默认值" /></label>
    </>}
    <p>{execution ? '选择 API 或原生运行时，再配置模型。更改将在下一次任务执行时生效；运行中的任务保留原有参数。' : '登记信息不等于认证通过；配置会在下一次执行时固定到快照。正在运行的回复不会切换模型。'}</p>
    {selectedChoice && <p className="muted">工具通道：{selectedChoice.tools ? '支持' : '未验证'} · 认证：{saved?.verificationStatus === 'passed' ? '最近一次验证已通过' : saved?.verificationStatus === 'failed' ? '最近一次验证未通过' : '尚未验证'}</p>}
  </fieldset>;
}
export function connectionFromForm(form: FormData, purpose: 'chat' | 'execution' = 'chat'): ChatConnection | null {
  const field = (name: string) => purpose === 'execution' ? `execution_${name}` : name;
  const id = String(form.get(field('connectionId')) ?? ''); if (!id) return null;
  const runtime = id.startsWith('dsh:') ? 'dsh' : 'codex';
  const effort = String(form.get(field('reasoningEffort')) ?? '').trim();
  return { runtime, ...(runtime === 'dsh' ? { provider: id.slice(4) } : {}), model: String(form.get(field('model')) ?? '').trim(), ...(effort ? { reasoningEffort: effort } : {}) };
}

function sameConnection(a: ChatConnection, b?: ChatConnection | null): boolean {
  return !!b && a.runtime === b.runtime && a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '');
}

export function AgentEditor({ data, agentId, csrf, onClose, onSaved, embedded=false }: { embedded?:boolean; data: UiWorkspaceDetail; agentId?: string; csrf: string; onClose: () => void; onSaved: () => void }) {
  const [agent] = useState(() => data.roles.find(r => r.id === agentId));
  const currentExecution=agent?.purpose==='lead' ? data.workspace.leadConnection??{runtime:data.leadConfiguration.runtime,provider:data.leadConfiguration.provider,model:data.leadConfiguration.model} : data.bindings.find(binding=>binding.id===agent?.providerBindingId)?.executionConnection;
  const write = useMutation(csrf);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); if (busy) return; setBusy(true); setError(''); const form = new FormData(e.currentTarget); const execution = connectionFromForm(form, 'execution'); const common = { displayName: String(form.get('displayName')).trim(), prompt: String(form.get('prompt')), chatConnection: connectionFromForm(form), ...(execution && !sameConnection(execution, currentExecution) ? { executionConnection: execution, ...(agent?.purpose==='lead'?{expectedWorkspaceVersion:data.workspace.version}:{}) } : {}) };
    try { await write(`/workspaces/${encodeURIComponent(data.workspace.id)}/agents${agent ? `/${encodeURIComponent(agent.id)}` : ''}`, agent ? { ...common, expectedVersion: agent.version } : { ...common, purpose: String(form.get('purpose')), ...(form.get('binding') ? { providerBindingId: String(form.get('binding')) } : {}) }, agent ? 'PATCH' : 'POST'); onSaved(); if(!embedded)onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Card asChild><form className="card configuration-form" onSubmit={submit}>{embedded && <h2>成员职责与连接</h2>}<div className="form-grid"><label>显示名称<Input name="displayName" required maxLength={120} defaultValue={agent?.displayName ?? ''} /></label>{!agent && <label>系统职责<NativeSelect name="purpose" defaultValue="developer"><NativeSelectOption value="developer">开发与分析</NativeSelectOption><NativeSelectOption value="reviewer">审查</NativeSelectOption></NativeSelect></label>}<label className="full-width">职责与指令<Textarea name="prompt" rows={5} maxLength={16000} defaultValue={agent?.prompt ?? ''} /></label></div><ConnectionFields purpose="execution" initial={currentExecution} optional preserveExisting={!!agent} /><ConnectionFields initial={agent?.chatConnection} optional />{agent?.purpose==='lead'&&<Notice>主 Agent 的规划、工具调用使用执行模型；公开思考摘要翻译和对话标题使用对话模型。未指定对话模型时沿用执行连接。</Notice>}<Notice>执行连接与对话连接分别配置。只有实际可用的执行能力才能承担代码任务，成员名称不授予能力。</Notice>{error && <p className="form-error" role="alert">{error} 输入已保留，请检查最新配置后重试。</p>}<div className="form-actions">{!embedded&&<Button variant="secondary" type="button" className="secondary" disabled={busy} onClick={onClose}>取消</Button>}<Button variant="default" className="primary" disabled={busy}>{busy ? '正在保存…' : '保存成员'}</Button></div></form></Card>;
}

export function LeadEditor({ data, csrf, onSaved }: { data: UiWorkspaceDetail; csrf: string; onSaved: () => void }) {
  const lead=data.roles.find(role=>role.purpose==='lead');
  if(!lead)return <Notice>工作区尚未配置主 Agent。</Notice>;
  return <AgentEditor key={lead.id+':'+lead.version+':'+data.workspace.version} data={data} agentId={lead.id} csrf={csrf} onClose={()=>{}} onSaved={onSaved} embedded />;
}
