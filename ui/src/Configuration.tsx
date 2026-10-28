import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { Input } from './components/ui/input';
import { Card } from './components/ui/card';
import { Textarea } from './components/ui/textarea';
import { Button } from './components/ui/button';
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group';
import { Icon } from './components/Icon';
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

export function AgentEditor({ data, agentId, csrf, onClose, onSaved }: { data: UiWorkspaceDetail; agentId?: string; csrf: string; onClose: () => void; onSaved: () => void }) {
  const [agent] = useState(() => data.roles.find(r => r.id === agentId));
  const write = useMutation(csrf);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); if (busy) return; setBusy(true); setError(''); const form = new FormData(e.currentTarget); const execution = connectionFromForm(form, 'execution'); const common = { displayName: String(form.get('displayName')).trim(), prompt: String(form.get('prompt')), ...(agent?.kind === 'dsh-lead' ? {} : { chatConnection: connectionFromForm(form) }), ...(execution && !sameConnection(execution, data.bindings.find(binding => binding.id === agent?.providerBindingId)?.executionConnection) ? { executionConnection: execution } : {}) };
    try { await write(`/workspaces/${encodeURIComponent(data.workspace.id)}/agents${agent ? `/${encodeURIComponent(agent.id)}` : ''}`, agent ? { ...common, expectedVersion: agent.version } : { ...common, purpose: String(form.get('purpose')), ...(form.get('binding') ? { providerBindingId: String(form.get('binding')) } : {}) }, agent ? 'PATCH' : 'POST'); onSaved(); onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Card asChild><form className="card configuration-form" onSubmit={submit}><h2>{agent ? `配置 ${agent.displayName || agent.name}` : '添加一个新成员'}</h2><div className="form-grid"><label>显示名称<Input name="displayName" required maxLength={120} defaultValue={agent?.displayName ?? ''} /></label>{!agent && <label>系统职责<NativeSelect name="purpose" defaultValue="developer"><NativeSelectOption value="developer">开发与分析</NativeSelectOption><NativeSelectOption value="reviewer">审查</NativeSelectOption></NativeSelect></label>}<label className="full-width">职责与指令<Textarea name="prompt" rows={5} maxLength={16000} defaultValue={agent?.prompt ?? ''} /></label></div>{agent?.kind === 'dsh-lead' ? <Notice>主 Agent 的运行连接请在系统设置中配置，确保工作区使用单一明确的配置来源。</Notice> : <><ConnectionFields purpose="execution" initial={data.bindings.find(binding => binding.id === agent?.providerBindingId)?.executionConnection} optional preserveExisting={!!agent} /><ConnectionFields initial={agent?.chatConnection} optional /></>}<Notice>执行连接与对话连接分别配置。只有实际可用的执行能力才能承担代码任务，成员名称不授予能力。</Notice>{error && <p className="form-error" role="alert">{error} 输入已保留，请检查最新配置后重试。</p>}<div className="form-actions"><Button variant="secondary" type="button" className="secondary" disabled={busy} onClick={onClose}>取消</Button><Button variant="default" className="primary" disabled={busy}>{busy ? '正在保存…' : '保存成员'}</Button></div></form></Card>;
}

export function LeadEditor({ data, csrf, onSaved }: { data: UiWorkspaceDetail; csrf: string; onSaved: () => void }) {
  const current: ChatConnection = data.workspace.leadConnection ?? { runtime: data.leadConfiguration.runtime, provider: data.leadConfiguration.provider, model: data.leadConfiguration.model };
  const [mode, setMode] = useState<'dsh' | 'codex'>(current.runtime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [expectedVersion, setExpectedVersion] = useState(data.workspace.version);
  const [reset, setReset] = useState(0);
  const write = useMutation(csrf);
  return <form className="lead-form" onChange={() => setSaved(false)} onSubmit={async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await write<{ version: number }>(`/workspaces/${encodeURIComponent(data.workspace.id)}`, { expectedVersion, leadConnection: connectionFromForm(new FormData(event.currentTarget)) }, 'PATCH');
      setExpectedVersion(result.version); setSaved(true); onSaved();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }}>
    <RadioGroup className="execution-modes" value={mode} onValueChange={value => { setMode(value as 'dsh' | 'codex'); setSaved(false); }} aria-label="执行连接模式" disabled={busy}>
      <label className="execution-mode" htmlFor="lead-api-mode"><div className="execution-mode-heading"><Icon name="network" size={22}/><span><strong>模型 API 直连</strong><small>Model API</small></span><RadioGroupItem value="dsh" id="lead-api-mode"/></div><p>通过已登记的模型端点进行推理与工具调用，为主协调者提供规划、分析与上下文处理能力。</p><span>使用本机登记的 API 连接</span></label>
      <label className="execution-mode" htmlFor="lead-host-mode"><div className="execution-mode-heading"><Icon name="terminal" size={22}/><span><strong>本地宿主运行时</strong><small>Host Runtime · Codex</small></span><RadioGroupItem value="codex" id="lead-host-mode"/></div><p>通过本机 Codex 原生运行时执行对话。认证状态、可用模型和工具能力由当前 Host 提供。</p><span>使用本机运行连接与模型目录</span></label>
    </RadioGroup>
    <Card className="card lead-parameters"><h2>2. 模型与端点参数</h2><p>主协调者使用此连接作为下一次执行的推理入口。</p>
      <fieldset disabled={busy}><ConnectionFields key={`${mode}:${reset}`} initial={current.runtime === mode ? current : null} runtimeFilter={mode}/></fieldset>
      {error && <p className="form-error" role="alert">{error} 输入已保留。</p>}
      {saved && <p role="status" className="accent-text">配置已保存，将在下一次执行时生效。</p>}
      <div className="form-actions"><Button variant="secondary" type="button" disabled={busy} onClick={() => { setMode(current.runtime); setExpectedVersion(data.workspace.version); setReset(value => value + 1); setError(''); setSaved(false); }}>重新载入配置</Button><Button disabled={busy}>{busy ? '正在保存…' : '保存下一次执行配置'}</Button></div>
    </Card>
  </form>;
}
