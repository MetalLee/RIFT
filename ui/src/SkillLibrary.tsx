import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { Input } from './components/ui/input';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { UiWorkspaceDetail, CompiledSkills, SkillAssignment, LibrarySkill, SkillImportPreview as Preview } from '@rift/protocol';
import { assignmentBody, assignmentReducer, emptyAssignments, isDirty, memberSummary, newer, type AssignmentMode } from './skill-assignment';
import { ApiError, errorText, request } from './api';
import { Copy, Empty, Heading, Icon, Notice, Pill } from './App';
import { LatestRequest } from './state';
import { useMutation } from './useMutation';
import { MessageBody } from './MessageBody';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';

export function SkillLibrary({ data, csrf }: { data: UiWorkspaceDetail; csrf: string }) {
  const [skills, setSkills] = useState<LibrarySkill[]>([]); const [selected, setSelected] = useState(''); const [importing, setImporting] = useState(false);
  const [scope, setScope] = useState('shared');
  const [error, setError] = useState(''); const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const base = `/workspaces/${encodeURIComponent(data.workspace.id)}`; const latest = useRef(new LatestRequest());
  const mutation = useMutation(csrf);
  async function load() { const token = latest.current.begin(); try { const result = await request<{ skills: LibrarySkill[] }>(`${base}/skills`, { signal: token.signal }); if (token.current()) { setSkills(result.skills); setError(''); } } catch (e) { if (token.current()) setError(errorText(e)); } finally { if (token.current()) setLoading(false); } }
  useEffect(() => { void load(); return () => latest.current.cancel(); }, [base, data.snapshotCursor]);
  const visibleSkills = skills.filter(s => scope === 'all' || (scope === 'shared' ? !!s.shared?.enabled : s.assignments.some(a => a.mode === 'include')));
  const skill = visibleSkills.find(s => s.id === selected) ?? visibleSkills[0];
  return <><Heading eyebrow="KNOWLEDGE & PRACTICE" title="技能扩展 (Skills)" subtitle="配置供所有 Agent 继承的共享规则与专属指令包。通过指令注入实现认知约束，让技能与上下文持续协同。" action={<><Button variant="secondary" className="secondary" onClick={()=>void load()}><Icon name="refresh"/>刷新指令库</Button><Button variant="default" className="primary" onClick={() => { setImporting(true); setPreview(null); }}><Icon name="plus" />导入 Skill</Button></>} />
    {error && <div className="error-banner" role="alert"><p>{error}</p><Button variant="secondary" className="secondary" onClick={() => void load()}>刷新</Button></div>}
    {importing && <Card asChild><div className="card configuration-form"><h2>{preview ? '确认导入内容' : '从本机目录导入'}</h2>{!preview ? <form onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); const form = new FormData(e.currentTarget); const skillId = String(form.get('skillId') ?? ''); const existing = skills.find(s => s.id === skillId); try { setPreview(await mutation<Preview>(`${base}/skills/preview`, { directory: String(form.get('directory')).trim(), name: String(form.get('name')).trim() || undefined, description: String(form.get('description')).trim() || undefined, ...(existing ? { skillId, expectedRevision: existing.revision } : {}) })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}><div className="form-grid"><label className="full-width">保存为<NativeSelect name="skillId"><NativeSelectOption value="">新的 Skill</NativeSelectOption>{skills.filter(s => !s.archived).map(s => <NativeSelectOption value={s.id} key={s.id}>{s.name} · 新增版本</NativeSelectOption>)}</NativeSelect></label><label className="full-width">Skill 目录<Input name="directory" required placeholder="包含 SKILL.md 的本机绝对路径" /></label><label>名称（可选）<Input name="name" maxLength={120} placeholder="留空使用已有名称或目录名" /></label><label>说明（可选）<Input name="description" maxLength={2000} /></label></div><Notice>先预览再保存；不会执行包内脚本。目录不能包含符号链接、环境凭据文件或依赖目录。</Notice><div className="form-actions"><Button variant="secondary" type="button" className="secondary" onClick={() => setImporting(false)}>取消</Button><Button variant="default" className="primary" disabled={busy}>{busy ? '正在读取…' : '预览内容'}</Button></div></form> : <><div className="preview-summary"><h3>{preview.name}</h3><p>{preview.description}</p><Copy value={preview.sourceDirectory} /><p>{preview.resources.length} 个资源 · {preview.requirements.scripts ? '包含脚本，当前运行连接不支持加载' : preview.requirements.resources ? '包含资源，当前运行连接不支持加载' : '仅指令，可供受支持的连接加载'}</p></div><pre className="skill-document">{preview.instructions}</pre>{preview.resources.length > 0 && <ul className="resource-list">{preview.resources.map(r => <li key={r.path}><code>{r.path}</code><span>{r.bytes} bytes</span></li>)}</ul>}<Notice>保存的是此次预览的内容快照。当前引用成员：{preview.currentReferenceAgents.map(id => data.roles.find(r => r.id === id)?.displayName ?? id).join('、') || '无'}。新版本不会自动启用；已有执行仍使用原版本。</Notice><div className="form-actions"><Button variant="secondary" className="secondary" disabled={busy} onClick={() => setPreview(null)}>返回</Button><Button variant="default" className="primary" disabled={busy} onClick={async () => { setBusy(true); try { const result = await mutation<{ skill: LibrarySkill }>(`${base}/skills/import`, { previewId: preview.previewId }); setSelected(result.skill.id); setImporting(false); setPreview(null); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>{busy ? '正在保存…' : '保存不可变版本'}</Button></div></>}</div></Card>}
    <div className="skill-library-toolbar"><Tabs value={scope} onValueChange={setScope}><TabsList aria-label="Skill 作用域"><TabsTrigger value="shared">工作区共享库 <span className="tab-count">{skills.filter(s=>s.shared?.enabled).length}</span></TabsTrigger><TabsTrigger value="dedicated">Agent 专属配置 <span className="tab-count">{skills.filter(s=>s.assignments.some(a=>a.mode==='include')).length}</span></TabsTrigger><TabsTrigger value="all">全部</TabsTrigger></TabsList></Tabs></div>
    {loading ? <div className="loading">正在读取 Skill 库…</div> : !skills.length ? <SkillEmptyState title="为团队导入第一项 Skill">选择含 SKILL.md 的目录，预览后保存，再设置共享或成员专属版本。</SkillEmptyState> : !visibleSkills.length ? <SkillEmptyState title="此作用域暂无 Skill">切换到“全部”查看已导入的技能，或导入一项新技能。</SkillEmptyState> : <div className="skill-library-layout"><section className="skill-list" aria-label="Skill 列表">{visibleSkills.map(s => <Card key={s.id} asChild><Button variant="ghost" className={`card skill-list-item ${s.id === skill?.id ? 'is-selected' : ''}`}  onClick={() => setSelected(s.id)}><div className="skill-card-heading"><div><h2>{s.name}</h2><code>{s.id}</code></div><Pill active={!!s.shared?.enabled}>{s.archived ? '已归档' : s.shared?.enabled ? '默认共享' : '可供选择'}</Pill></div><p>{s.description || '尚未填写说明。'}</p><footer className="skill-card-footer"><span>{s.versions.length} 个版本</span><span>{s.shared?.enabled ? '全员默认共享' : `${s.assignments.filter(a=>a.mode==='include').length} 位成员专属`}</span></footer></Button></Card>)}</section>{skill && <SkillDetail key={skill.id} skill={skill} data={data} csrf={csrf} onChanged={load} />}</div>}
  </>;
}


function SkillEmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <Card asChild><div className="card skill-empty-state"><Empty icon="skill" title={title}>{children}</Empty></div></Card>;
}

const modeLabels: Record<AssignmentMode, { title: string; hint: string }> = {
  inherit: { title: '继承', hint: '跟随工作区共享；未共享时不加载' },
  include: { title: '专属', hint: '为此成员固定一个版本，不受共享变化影响' },
  exclude: { title: '排除', hint: '即使工作区共享也不加载' },
};
const versionLabel = (v: LibrarySkill['versions'][number]) => `版本 ${v.version} · ${new Date(v.createdAt).toLocaleDateString('zh-CN')}`;

export function SkillDetail({ skill, data, csrf, onChanged }: { skill: LibrarySkill; data: UiWorkspaceDetail; csrf: string; onChanged: () => Promise<void> }) {
  const base = `/workspaces/${encodeURIComponent(data.workspace.id)}`; const skillPath = `${base}/skills/${encodeURIComponent(skill.id)}`;
  const mutation = useMutation(csrf);
  const [viewVersionId, setViewVersionId] = useState(skill.shared?.enabled ? skill.shared.versionId : skill.versions[0]?.id ?? '');
  const [expanded, setExpanded] = useState(false);
  const version = skill.versions.find(v => v.id === viewVersionId) ?? skill.versions[0];
  const [savedShared, setSavedShared] = useState<LibrarySkill['shared']>(null);
  const shared = newer(savedShared, skill.shared) ?? null;
  const [sharedDraft, setSharedDraft] = useState<{ versionId: string; baseRevision: number } | null>(null);
  const [sharedBusy, setSharedBusy] = useState(false); const [sharedStatus, setSharedStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false); const [archiveError, setArchiveError] = useState('');
  const [state, dispatch] = useReducer(assignmentReducer, emptyAssignments);
  const requestSeq = useRef(0);
  const [effective, setEffective] = useState<{ agentId: string; value?: CompiledSkills; error?: string } | null>(null); const effectiveLatest = useRef(new LatestRequest());
  // Any configuration change makes a previously checked effective set stale.
  const effectiveScope = JSON.stringify([data.workspace.version, data.roles.map(r => [r.id, r.version]), skill.revision, skill.shared, skill.assignments, state.saved]);
  useEffect(() => { effectiveLatest.current.cancel(); setEffective(null); }, [effectiveScope]);
  useEffect(() => () => effectiveLatest.current.cancel(), []);
  const sharedVersionId = sharedDraft?.versionId ?? shared?.versionId ?? skill.versions[0]?.id ?? '';
  const sharedStale = !!sharedDraft && sharedDraft.baseRevision !== (shared?.revision ?? 0);
  const view = { versions: skill.versions, shared, archived: skill.archived };
  const currentOf = (agentId: string) => newer(state.saved[agentId], skill.assignments.find(a => a.agentId === agentId));

  async function saveShared(enabled: boolean) {
    if (sharedBusy) return;
    setSharedBusy(true); setSharedStatus(null);
    const body = enabled ? { versionId: sharedVersionId, enabled: true, expectedRevision: sharedDraft?.baseRevision ?? shared?.revision ?? 0 } : { versionId: shared!.versionId, enabled: false, expectedRevision: shared?.revision ?? 0 };
    try { setSavedShared(await mutation<NonNullable<LibrarySkill['shared']>>(`${skillPath}/shared`, body, 'PUT')); setSharedDraft(null); setSharedStatus({ ok: true, text: enabled ? '已设为默认共享。' : '已撤销默认共享。' }); await onChanged(); }
    catch (e) { setSharedStatus({ ok: false, text: errorText(e) }); } finally { setSharedBusy(false); }
  }
  async function saveAssignment(agentId: string) {
    const draft = state.drafts[agentId];
    if (!draft || state.status[agentId]?.kind === 'saving') return;
    const requestId = ++requestSeq.current; dispatch({ type: 'saveStart', agentId, requestId });
    try { const assignment = await mutation<SkillAssignment>(`${base}/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skill.id)}`, assignmentBody(draft), 'PUT'); dispatch({ type: 'saveDone', agentId, requestId, assignment }); setEffective(null); await onChanged(); }
    catch (e) { dispatch({ type: 'saveFailed', agentId, requestId, message: errorText(e), conflict: e instanceof ApiError && e.status === 409 }); }
  }
  async function checkEffective(agentId: string) {
    const role = data.roles.find(r => r.id === agentId); const runtime = role?.chatConnection?.runtime ?? (role?.kind === 'dsh-lead' ? data.leadConfiguration.runtime : 'dsh');
    const token = effectiveLatest.current.begin(); setEffective({ agentId });
    try { const value = await request<CompiledSkills>(`${base}/agents/${encodeURIComponent(agentId)}/skills/effective?runtime=${runtime}`, { signal: token.signal }); if (token.current()) setEffective({ agentId, value }); }
    catch (e) { if (token.current()) setEffective({ agentId, error: errorText(e) }); }
  }
  async function archive() {
    if (archiveBusy) return; setArchiveBusy(true); setArchiveError('');
    try { await mutation(`${skillPath}/archive`, { expectedRevision: skill.revision }, 'POST'); await onChanged(); } catch (e) { setArchiveError(errorText(e)); } finally { setArchiveBusy(false); }
  }

  return <Card asChild><article className="card skill-detail" aria-labelledby={`skill-title-${skill.id}`}>
    <header className="skill-detail-header"><div className="skill-detail-title"><h2 id={`skill-title-${skill.id}`}>{skill.name}</h2>{!!skill.archived && <Pill>已归档</Pill>}</div>{skill.description && <p>{skill.description}</p>}</header>

    <section className="skill-document-section" aria-label="Skill 正文">
      <div className="skill-file-header"><Icon name="file" size={20}/><code>SKILL.md</code><label className="skill-inline-select"><span>查看版本</span><NativeSelect value={version?.id ?? ''} onChange={e => setViewVersionId(e.target.value)}>{skill.versions.map(v => <NativeSelectOption key={v.id} value={v.id}>{versionLabel(v)}</NativeSelectOption>)}</NativeSelect></label></div>
      <div className="skill-document-toggle"><Button variant="secondary" className="secondary" aria-expanded={expanded} aria-controls={`skill-body-${skill.id}`} onClick={() => setExpanded(v => !v)}><Icon name="down" size={18}/>{expanded ? '收起正文' : '展开正文'}</Button><span className="muted">{(version?.instructions.length ?? 0).toLocaleString('zh-CN')} 字符 · {version?.resources.length ?? 0} 个资源</span><Copy value={version?.instructions ?? ''} /></div>
      <div id={`skill-body-${skill.id}`} hidden={!expanded}>{expanded && version && <><Tabs defaultValue="preview" className="skill-preview-tabs"><TabsList aria-label="Skill 阅读模式"><TabsTrigger value="preview">阅读预览</TabsTrigger><TabsTrigger value="source">Markdown 源码</TabsTrigger></TabsList><TabsContent value="preview" className="skill-preview"><MessageBody text={version.instructions}/></TabsContent><TabsContent value="source"><pre className="skill-document">{version.instructions}</pre></TabsContent></Tabs>
        <div className="skill-metadata"><Copy value={version.digest} /><p>来源：<code>{version.sourceDirectory}</code></p><p>{version.requirements.resources ? '需要资源加载能力' : '仅指令注入'}{version.requirements.scripts ? ' · 需要脚本能力' : ''}</p></div>{version.resources.length > 0 && <ul className="resource-list">{version.resources.map(r => <li key={r.path}><code>{r.path}</code><span>{r.bytes} bytes</span></li>)}</ul>}</>}</div>
    </section>

    <section className="skill-assignment" aria-labelledby={`skill-shared-${skill.id}`}><h3 id={`skill-shared-${skill.id}`}>工作区共享</h3>
      <p>{shared?.enabled ? `当前默认共享版本 ${skill.versions.find(v => v.id === shared.versionId)?.version ?? '未知'}，选择“继承”的成员会加载它。` : '当前未共享，选择“继承”的成员不会加载。'}</p>
      <div className="skill-inline-form"><label className="skill-inline-select"><span>共享版本</span><NativeSelect value={sharedVersionId} disabled={!!skill.archived || sharedBusy} onChange={e => setSharedDraft({ versionId: e.target.value, baseRevision: sharedDraft?.baseRevision ?? shared?.revision ?? 0 })}>{skill.versions.map(v => <NativeSelectOption key={v.id} value={v.id}>{versionLabel(v)}</NativeSelectOption>)}</NativeSelect></label>
        <Button variant="secondary" className="secondary" disabled={sharedBusy || !!skill.archived || !!shared?.enabled && sharedVersionId === shared.versionId} aria-busy={sharedBusy} onClick={() => void saveShared(true)}>{sharedBusy ? '正在保存…' : shared?.enabled ? '更新共享版本' : '设为默认共享'}</Button>
        {!!shared?.enabled && <Button variant="ghost" className="text-button" disabled={sharedBusy} onClick={() => void saveShared(false)}>撤销默认共享</Button>}</div>
      {sharedStale && <Notice>共享配置已在别处更新，你的版本选择基于旧配置，保存会被拒绝。<Button variant="ghost" className="text-button" onClick={() => { setSharedDraft(null); setSharedStatus(null); }}>放弃选择并载入最新</Button></Notice>}
      {sharedStatus && <p className={sharedStatus.ok ? 'skill-save-ok' : 'form-error'} role={sharedStatus.ok ? 'status' : 'alert'}>{sharedStatus.text}</p>}
    </section>

    <section className="skill-assignment" aria-labelledby={`skill-members-${skill.id}`}><h3 id={`skill-members-${skill.id}`}>成员分配</h3>
      <p>继承：跟随共享；专属：为该成员固定版本；排除：不加载。保存配置不代表执行时一定生效，可逐个检查最终生效集合。</p>
      {!data.roles.length ? <p className="muted">工作区暂无成员。</p> : <ul className="skill-member-list">{data.roles.map(role => {
        const current = currentOf(role.id); const summary = memberSummary(view, current); const draft = state.drafts[role.id]; const status = state.status[role.id];
        const open = state.open === role.id; const dirty = !!draft && isDirty(draft, current); const saving = status?.kind === 'saving';
        const stale = !!draft && draft.baseRevision !== (current?.revision ?? 0); const panelId = `skill-member-${skill.id}-${role.id}`; const name = role.displayName || role.name;
        return <li key={role.id} className={`skill-member${open ? ' is-open' : ''}`}>
          <div className="skill-member-row"><div className="skill-member-name"><strong>{name}</strong><span className={`skill-mode skill-mode-${summary.mode}`}>{summary.label}</span>{dirty && !open && <span className="skill-member-flag">有未保存修改</span>}{status?.kind === 'saved' && <span className="skill-save-ok" role="status">已保存</span>}</div>
            <Button variant="ghost" className="text-button" aria-expanded={open} aria-controls={panelId} aria-label={`${open ? '收起' : '编辑'} ${name} 的分配`} onClick={() => dispatch(open ? { type: 'close' } : { type: 'open', agentId: role.id, skill: view, current })}>{open ? '收起' : '编辑'}</Button></div>
          <p className="skill-member-detail">{summary.detail}</p>
          {open && draft && <div id={panelId} className="skill-member-editor"><fieldset disabled={saving}><legend className="sr-only">{name} 的生效方式</legend>
            {(['inherit', 'include', 'exclude'] as const).map(mode => <label key={mode} className="skill-mode-option"><input type="radio" name={`mode-${skill.id}-${role.id}`} value={mode} checked={draft.mode === mode} disabled={mode === 'include' && !!skill.archived && current?.mode !== 'include'} onChange={() => dispatch({ type: 'change', agentId: role.id, mode })}/><span><strong>{modeLabels[mode].title}</strong><small>{modeLabels[mode].hint}</small></span></label>)}
            {draft.mode === 'include' && <label className="skill-inline-select"><span>专属版本</span><NativeSelect value={draft.versionId} onChange={e => dispatch({ type: 'change', agentId: role.id, versionId: e.target.value })}>{skill.versions.map(v => <NativeSelectOption key={v.id} value={v.id}>{versionLabel(v)}</NativeSelectOption>)}</NativeSelect></label>}</fieldset>
            {draft.mode === 'include' && !!skill.archived && <p className="form-error">已归档的 Skill 不能保存为专属，请改为继承或排除。</p>}
            {stale && <Notice>此成员的分配已在别处更新，当前草稿基于旧配置，保存会被拒绝。<Button variant="ghost" className="text-button" onClick={() => dispatch({ type: 'reload', agentId: role.id, skill: view, current })}>放弃草稿并载入最新</Button></Notice>}
            {status?.kind === 'error' && <div className="form-error" role="alert"><p>{status.message}</p>{status.conflict && !stale && <Button variant="ghost" className="text-button" onClick={() => void onChanged()}>刷新最新配置</Button>}</div>}
            <div className="form-actions"><Button variant="default" className="primary" disabled={!dirty || saving || draft.mode === 'include' && (!!skill.archived || !draft.versionId)} aria-busy={saving} onClick={() => void saveAssignment(role.id)}>{saving ? '正在保存…' : '保存分配'}</Button><Button variant="ghost" className="text-button" disabled={saving} onClick={() => dispatch({ type: 'discard', agentId: role.id })}>{dirty ? '放弃修改' : '取消'}</Button><Button variant="ghost" className="text-button" disabled={effective?.agentId === role.id && !effective.value && !effective.error} onClick={() => void checkEffective(role.id)}>检查最终生效集合</Button></div>
            {effective?.agentId === role.id && <div className="effective-skills" aria-live="polite">{!effective.value && !effective.error ? <p>正在检查…</p> : effective.error ? <p className="form-error">无法生成生效集合：{effective.error}</p> : <><h4>最终生效 · {effective.value!.versions.length} 项</h4>{effective.value!.versions.map(v => <p key={v.skillId}>{v.name} / 版本 {v.version} / {v.source === 'shared' ? '共享继承' : '成员专属'}</p>)}{!effective.value!.versions.length && <p>当前没有生效的 Skill。</p>}</>}</div>}
          </div>}
        </li>; })}</ul>}
    </section>

    {!skill.archived && <section className="skill-assignment"><h3>归档 Skill</h3><p>历史版本和执行快照会保留。现有共享与分配引用不会自动清除，归档后仍可撤销共享或改为继承/排除。</p><Button variant="ghost" className="text-button" disabled={archiveBusy} aria-busy={archiveBusy} onClick={() => void archive()}>{archiveBusy ? '正在归档…' : '归档此 Skill'}</Button>{archiveError && <p className="form-error" role="alert">{archiveError}</p>}</section>}
  </article></Card>;
}
