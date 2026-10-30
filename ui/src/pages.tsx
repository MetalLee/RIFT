import { taskSelection } from './task-selection';
import { DetailLayout } from './DetailLayout';
import { Avatar, AvatarFallback } from './components/ui/avatar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Progress } from './components/ui/progress';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Card } from './components/ui/card';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { useEffect, useRef, useState } from 'react';
import type { UiPresence, UiTask, UiWorkspaceDetail } from '@rift/protocol';
import { Copy, Empty, Field, Heading, Icon, Notice, Pill, time } from './App';
import { LatestRequest, routeHref, taskHref } from './state';
import { AgentEditor, LeadEditor } from './Configuration';
import { errorText, mutate, request } from './api';
import { ReplanEditor, TaskRetry } from './TaskActions';
import { ActivityTurn } from './ActivityTurn';
import { ConnectionCatalogue } from './ConnectionCatalogue';
import { TaskEvidence } from './TaskEvidence';
import { TaskDiagnostics, taskIssueSummary } from './TaskDiagnostics';
import { WorkspaceControls } from './WorkspaceControls';
import { RunRecovery } from './RunRecovery';
import { IntegrationRecovery } from './IntegrationRecovery';
import { dependencyOrder } from './task-order';
import { AgentModels, modelLines } from './AgentModels';

const statusLabels: Record<string, string> = { pending: '待规划', ready: '就绪', running: '执行中', validating: '检查中', integrating: '集成中', succeeded: '已通过', blocked: '已阻塞', failed: '失败', cancelled: '已取消', preparing: '准备中', cancelling: '正在停止', interrupted: '已中断', confirmed: '已确认', unknown: '未知', created: '已创建', planning: '规划中', paused: '已暂停', completed: '已完成', queued: '排队中', started: '已开始' };
const status = (value: string) => statusLabels[value] ?? value;
const purpose = (value?: string) => value === 'lead' ? '主 Agent / 协调' : value === 'reviewer' ? '审查' : value === 'developer' ? '开发' : value ?? '未声明';
const presenceLabels: Record<UiPresence['state'], string> = { disabled: '已停用', unavailable: '不可用', running: '工作中', stopping: '正在停止', cleanup_unknown: '清理需确认', queued: '排队中', idle: '空闲', unknown: '状态未知' };
const reasons: Record<string, string> = {
  'No live execution evidence; runtime availability and idleness are not verified.': '没有当前执行证据，运行时可用性与空闲状态尚未确认。',
  'An execution still owns an unreleased lease; cleanup requires confirmation.': '执行仍占用未释放的资源，清理状态需要确认。',
  'The ledger records cancellation in progress.': '记录显示正在停止执行；资源将在清理确认后释放。',
  'The ledger records an active Turn or Run.': '记录显示存在活动的对话 Turn 或任务 Run。',
  'This role is disabled.': '这个成员已停用。',
  'A durable queued message or operation references this role.': '已有保存的消息或任务操作正在等待这个成员。',
  'The configured provider is not registered in this Host.': '配置的运行连接未在当前 Host 中登记。',
  'Lead lifecycle is not persisted. An attached session alone does not prove activity or idleness.': '旧式 Workflow 主 Agent 会话没有完整生命周期记录，无法仅据会话判断空闲或活动。',
};
const explain = (reason: string) => {
  const idle = /^Last recorded discussion (\w+); cleanup is confirmed and no execution lease remains\. Runtime authentication is separate\.$/.exec(reason);
  return idle ? `最近一次对话${({ completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' } as Record<string,string>)[idle[1]] ?? idle[1]}，清理已确认且没有剩余执行占用。运行连接认证单独验证。` : reasons[reason] ?? reason;
};
function Presence({ presence, stale }: { presence?: UiPresence; stale: boolean }) { return <Pill active={!stale && presence?.state === 'running'}>{stale ? '状态未同步' : presence ? presenceLabels[presence.state] : '状态未知'}</Pill>; }

export function Agents({ data, stale, csrf, onSaved }: { data: UiWorkspaceDetail; stale: boolean; csrf: string; onSaved: () => void }) {
    const [search,setSearch]=useState('');
    const [filter,setFilter]=useState('all');
    const [editing,setEditing]=useState<string|null>(null);
    const editorTrigger = useRef<HTMLButtonElement | null>(null);
    const [expandedRole,setExpandedRole]=useState<string|null>(null);
    const [actionError,setActionError]=useState('');
    const activeCount=data.presence.filter(p=>['running','stopping','queued'].includes(p.state)).length;
    const roles=data.roles.filter(r=>{
      const presence=data.presence.find(p=>p.roleId===r.id);
      return `${r.displayName} ${r.name} ${r.prompt}`.toLowerCase().includes(search.toLowerCase()) && (filter==='all'||(filter==='active'?['running','stopping','queued'].includes(presence?.state??''):presence?.state==='idle'));
    });
    return <><Heading eyebrow="AGENTS" title="智能代理" english="AGENTS" subtitle="管理当前工作区中的协作 Agent 团队与执行职责。各代理按职责链协同，在本地宿主环境中响应。" />
      <Dialog open={editing!==null} onOpenChange={open=>{if(!open)setEditing(null);}}><DialogContent className="agent-dialog" onCloseAutoFocus={event => { event.preventDefault(); editorTrigger.current?.focus(); }}><DialogHeader><DialogTitle>{editing==='new'?'添加 Agent':'配置智能代理'}</DialogTitle><DialogDescription>设置成员职责、对话连接和执行方式，新的配置用于下一次执行。</DialogDescription></DialogHeader>{editing&&<AgentEditor key={editing} data={data} agentId={editing==='new'?undefined:editing} csrf={csrf} onClose={()=>setEditing(null)} onSaved={onSaved}/>}</DialogContent></Dialog>
      {actionError&&<Notice role="status">{actionError}</Notice>}
      <div className="toolbar"><Tabs value={filter} onValueChange={setFilter}><TabsList><TabsTrigger value="all">全部 <span className="tab-count">{data.roles.length}</span></TabsTrigger><TabsTrigger value="active">活跃中 <span className="tab-count">{activeCount}</span></TabsTrigger><TabsTrigger value="idle">待命中 <span className="tab-count">{data.presence.filter(p=>p.state==='idle').length}</span></TabsTrigger></TabsList></Tabs><div className="toolbar-actions"><label className="search-field"><Icon name="search" size={16}/><Input type="search" aria-label="搜索 Agent" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索代理名称、职责…"/></label><Button variant="secondary" asChild><a href={routeHref(data.workspace.id,'settings')}><Icon name="settings"/>编排策略</a></Button>{data.capabilities.agentConfiguration.available&&<Button onClick={e=>{editorTrigger.current=e.currentTarget;setEditing('new');}}><Icon name="plus"/>添加 Agent</Button>}</div></div>
      <div className="agent-list">{roles.map(role=>{const presence=data.presence.find(p=>p.roleId===role.id);const binding=data.bindings.find(b=>b.id===role.providerBindingId);return <Card className="card agent-card" key={role.id}>
        <Avatar className={`agent-avatar ${role.kind==='dsh-lead'?'lead-avatar':''}`}><AvatarFallback>{(role.displayName||role.name).slice(0,1)}</AvatarFallback></Avatar>
        <div className="agent-description"><div className="agent-title"><h2>{role.displayName||role.name}{role.kind==='dsh-lead'&&<span> (主 Agent)</span>}</h2><code>@{role.name}</code><Presence presence={presence} stale={stale}/></div><p title={role.prompt}>{role.prompt||'尚未设置职责说明。'}</p></div>
        <AgentModels lines={modelLines(role,binding,data.leadConfiguration)} />
        <div className="agent-controls">{data.capabilities.agentConfiguration.available&&<Button variant="secondary" size="sm" onClick={e=>{editorTrigger.current=e.currentTarget;setEditing(role.id);}}>配置</Button>}<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`更多操作：${role.displayName||role.name}`}><Icon name="more"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>setExpandedRole(expandedRole===role.id?null:role.id)}>连接与执行详情</DropdownMenuItem><DropdownMenuItem asChild><a href={routeHref(data.workspace.id,'activity')}>查看运行状态</a></DropdownMenuItem><DropdownMenuItem asChild><a href={routeHref(data.workspace.id,'skills')}>配置专属 Skill</a></DropdownMenuItem>{role.kind!=='dsh-lead'&&data.capabilities.agentConfiguration.available&&<DropdownMenuItem onSelect={()=>{setActionError('');void mutate(`/workspaces/${encodeURIComponent(data.workspace.id)}/agents/${encodeURIComponent(role.id)}`,csrf,{expectedVersion:role.version,enabled:role.enabled===0},'PATCH').then(onSaved,e=>setActionError(errorText(e)));}}>{role.enabled===0?'启用成员':'停用成员'}</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div>
        <div className="agent-more" hidden={expandedRole!==role.id}><div><p><strong>系统职责：</strong>{purpose(role.purpose)}</p><p><strong>对话模型：</strong>{(l=>`${l.model} · ${l.source}`)(modelLines(role,binding,data.leadConfiguration)[0])}</p><p><strong>代码执行：</strong>{(l=>`${l.model} · ${l.source}`)(modelLines(role,binding,data.leadConfiguration)[1])}</p><p>{presence?explain(presence.reason):'当前没有活动记录。'}</p><p className="preserve-lines">{role.prompt}</p></div></div>
      </Card>;})}{!roles.length&&<Empty icon="agents" title="没有匹配的成员">试试其他名称，或切换成员状态筛选。</Empty>}</div>
      <div className="page-note"><Icon name="shield" size={25}/><div><h3>明确的职责与执行边界</h3><p>成员配置在下一次执行时生效；当前任务保留原有配置快照。</p></div><Button variant="ghost" asChild><a href={routeHref(data.workspace.id,'activity')}><Icon name="pulse"/>运行记录</a></Button></div>
    </>;
  }

export function Skills() { return <><Heading eyebrow="KNOWLEDGE & PRACTICE" title="技能扩展 (Skills)" subtitle="工作区的共享技能与成员专属指令，将在这里统一管理。" /><div className="skill-layout"><Card asChild><div className="card skill-empty"><Empty icon="skill" title="Skill 管理尚未开放">当前无法导入、分配或执行 Skill。Agent 的职责提示词仍可在成员页面查看。</Empty></div></Card><Card asChild><aside className="card skill-guide"><span className="eyebrow">A SHARED FOUNDATION</span><h2>让好的方法<br />可以复用。</h2><div className="guide-item"><span>01</span><div><h3>工作区共享</h3><p>为团队整理一致的工作规范。</p></div></div><div className="guide-item"><span>02</span><div><h3>成员专属</h3><p>为不同职责保留适合的指令。</p></div></div><div className="guide-item"><span>03</span><div><h3>明确的版本</h3><p>让每次执行所用的规则有据可查。</p></div></div><p className="muted">以上为计划能力，当前尚未启用。</p></aside></Card></div></>; }

export function Repositories({ data }: { data: UiWorkspaceDetail }) {
  return <><Heading eyebrow="REPOSITORIES & WORKTREES" title="代码库与工作区" english="Repositories & Worktrees" subtitle="查看关联仓库、任务工作目录与候选集成现场。" /><Notice>当前每个工作区关联一个仓库。此处展示已记录的目录；创建、接管与归档 worktree 尚未开放。</Notice>
    <div className="repository-list">{data.repositories.map(repo => <Card key={repo.id} asChild><article className="card repository-card" ><header className="repository-header"><div className="repository-name"><span className="repo-icon"><Icon name="branch" size={24} /></span><div><h2>{repo.canonicalPath.split(/[\\/]/).filter(Boolean).at(-1)}</h2><code>{repo.canonicalPath}</code></div></div><span className="chip">基线 · {repo.baseRef}</span></header><div className="repository-body"><div className="section-heading"><h3>工作目录</h3><span className="muted">{data.worktrees.length} 条 worktree 记录</span></div>{!data.worktrees.length ? <Empty icon="branch" title="暂无任务工作目录">任务执行后，Host 记录的工作目录会显示在这里。</Empty> : data.worktrees.filter(w => data.repositories.length === 1 || data.tasks.find(t => t.id === w.taskId)?.repositoryId === repo.id).map(w => { const task = data.tasks.find(t => t.id === w.taskId); const writer = data.runs.find(r => r.id === w.writerRunId); return <div className="worktree-row" key={w.id}><div className="worktree-top"><h3>{w.branch || w.kind}</h3><Pill>{w.status ? status(w.status) : '目录状态未知'}</Pill></div><Copy value={w.path} /><dl className="compact-fields"><Field name="用途">{w.kind === 'task' ? '任务目录' : w.kind === 'review' ? '审查目录' : '候选目录'}</Field><Field name="关联任务">{task?.title ?? w.taskId}</Field><Field name="记录中的写入 Run">{writer?.id ?? w.writerRunId ?? '无写入 Run 记录'}</Field><Field name="基线提交"><code>{w.baseCommit}</code></Field><Field name="清理状态">{writer ? status(writer.cleanupStatus) : '未提供'}</Field></dl></div>; })}
    {data.integrations.filter(i => (data.repositories.length === 1 || data.tasks.find(t => t.id === i.taskId)?.repositoryId === repo.id) && i.candidatePath && !data.worktrees.some(w => w.path === i.candidatePath)).map(i => <div className="worktree-row" key={i.id}><div className="worktree-top"><h3>候选集成现场</h3><Pill>{status(i.status)}</Pill></div><Copy value={i.candidatePath!} /><dl className="compact-fields"><Field name="关联任务">{data.tasks.find(t => t.id === i.taskId)?.title ?? i.taskId}</Field><Field name="候选提交"><code>{i.candidateHead ?? '尚未记录'}</code></Field><Field name="检查记录">{i.checkIds.length} 条</Field></dl>{i.error && <p className="form-error">{i.error}</p>}</div>)}</div></article></Card>)}</div></>;
}

export function Tasks({ data, csrf, onChanged, taskId }: { data: UiWorkspaceDetail; csrf: string; onChanged: () => void; taskId?: string }) {
  const [filter, setFilter] = useState('all');
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [workflow, setWorkflow] = useState('all');
  const [repository, setRepository] = useState('all');
  const [member, setMember] = useState('all');
  const [order, setOrder] = useState('record');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const useServerPages = data.capabilities.pagination.available && order === 'record';
  const [taskPage, setTaskPage] = useState(0);
  const [cursors, setCursors] = useState([0]);
  const [remotePage, setRemotePage] = useState<{ key: string; after: number; tasks: UiTask[]; nextAfter: number | null; totalCount: number } | null>(null);
  const [pageError, setPageError] = useState(''); const taskRequests = useRef(new LatestRequest());
  useEffect(() => { setTaskPage(0); setCursors([0]); }, [filter, workflow, repository, member, order]);
  const serverKey = JSON.stringify([filter, workflow, repository, member, order]); const after = cursors[taskPage] ?? 0;
  useEffect(() => {
    if (!useServerPages) return;
    const token = taskRequests.current.begin(); const query = new URLSearchParams({ after: String(after), limit: '30' });
    if (filter !== 'all') query.set('status', filter === 'active' ? 'running,ready,validating,integrating' : filter === 'attention' ? 'failed,blocked,cancelled' : filter);
    if (workflow !== 'all') query.set('workflowId', workflow); if (repository !== 'all') query.set('repositoryId', repository); if (member !== 'all') query.set('roleId', member);
    request<{ tasks: UiTask[]; nextAfter: number | null; totalCount: number }>(`/workspaces/${encodeURIComponent(data.workspace.id)}/tasks?${query}`, { signal: token.signal }).then(value => { if (token.current()) { setRemotePage({ ...value, key: serverKey, after }); setPageError(''); } }, e => { if (token.current()) setPageError(errorText(e)); });
    return () => taskRequests.current.cancel();
  }, [data.workspace.id, data.snapshotCursor, useServerPages, serverKey, after]);
  const [selection, setSelection] = useState<string | null>(taskId ?? null);
  const [linkedTask, setLinkedTask] = useState<UiTask | null>(null);
  useEffect(() => {
    if (taskId) setSelection(taskId);
    setLinkedTask(null);
    if (!taskId) return;
    const local = data.tasks.find(task => task.id === taskId);
    if (local) { setLinkedTask(local); return; }
    const controller = new AbortController();
    request<UiTask>(`/workspaces/${encodeURIComponent(data.workspace.id)}/tasks/${encodeURIComponent(taskId)}`,{signal:controller.signal}).then(value => { if (!controller.signal.aborted && value.id === taskId) setLinkedTask(value); }, error => { if (!controller.signal.aborted) setPageError(errorText(error)); });
    return () => controller.abort();
  },[taskId,data.workspace.id,data.snapshotCursor]);
  const subset = (order === 'dependency' ? dependencyOrder(data.tasks) : data.tasks).filter(t => (workflow === 'all' || t.workflowId === workflow) && (repository === 'all' || t.repositoryId === repository) && (member === 'all' || t.roleId === member));
  const filtered = subset.filter(t => filter === 'all' || (filter === 'active' ? ['running', 'ready', 'validating', 'integrating'].includes(t.status) : filter === 'attention' ? ['failed', 'blocked', 'cancelled'].includes(t.status) : t.status === filter));
  const currentPage = useServerPages ? taskPage : Math.min(taskPage, Math.max(0, Math.ceil(filtered.length / 30) - 1));
  const matchingRemote = remotePage?.key === serverKey && remotePage.after === after ? remotePage : null;
  const listed = useServerPages ? matchingRemote?.tasks ?? [] : filtered.slice(currentPage * 30, (currentPage + 1) * 30);
  const linked = taskId ? data.tasks.find(t => t.id === taskId) ?? (linkedTask?.id === taskId ? linkedTask : null) : null;
  const { task, outsidePage } = taskSelection(listed, linked, taskId ?? selection);
  const totalMatching = useServerPages ? matchingRemote?.totalCount ?? 0 : filtered.length;
  const remoteLoading = useServerPages && !matchingRemote && !pageError && !linked;
  const passed = subset.filter(t => t.status === 'succeeded').length;
  const selectedWorkflow = data.workflows.find(w => w.id === workflow);
  async function workflowAction(action: string) { if (!selectedWorkflow || actionBusy) return; setActionBusy(true); setActionError(''); try { await mutate(`/workspaces/${encodeURIComponent(data.workspace.id)}/workflows/${encodeURIComponent(selectedWorkflow.id)}/${action}`, csrf, action === 'cancel' ? {} : { expectedVersion: selectedWorkflow.version }); setConfirmCancel(false); onChanged(); } catch(e) { setActionError(errorText(e)); } finally { setActionBusy(false); } }
  return <><Heading eyebrow="TASKS & ACCEPTANCE" title={selectedWorkflow?.goal || "任务队列"} subtitle="跟踪工作流的执行、依赖与验收，让每一步协作有据可查。" action={<Card className="card task-progress"><div><span>流水线进度</span><strong>{passed} / {subset.length} 项已通过</strong></div><Progress value={subset.length ? passed/subset.length*100 : 0} aria-label="已通过的任务比例"/><span>{subset.length ? Math.round(passed/subset.length*100) : 0}% 已通过验收</span></Card>} /><div className="toolbar"><div className="filter-tabs" aria-label="任务状态筛选">{[['all', '全部'], ['active', '进行中'], ['attention', '需关注'], ['succeeded', '已通过']].map(([value, label]) => <Button variant="ghost" key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</Button>)}</div><Button variant="secondary" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(value=>!value)}><Icon name="settings" size={16}/>筛选</Button><label className="workflow-select"><span className="sr-only">工作流</span><NativeSelect value={workflow} onChange={e => { setWorkflow(e.target.value); setConfirmCancel(false); }}><NativeSelectOption value="all">全部工作流</NativeSelectOption>{data.workflows.map(w => <NativeSelectOption key={w.id} value={w.id}>{w.goal}</NativeSelectOption>)}</NativeSelect></label></div>
    <div className="task-extra-filters" hidden={!filtersOpen}><label>顺序<NativeSelect value={order} onChange={e => setOrder(e.target.value)}><NativeSelectOption value="record">记录顺序</NativeSelectOption><NativeSelectOption value="dependency">依赖优先</NativeSelectOption></NativeSelect></label><label>仓库<NativeSelect value={repository} onChange={e => setRepository(e.target.value)}><NativeSelectOption value="all">全部仓库</NativeSelectOption>{data.repositories.map(r => <NativeSelectOption key={r.id} value={r.id}>{r.canonicalPath.split(/[\\/]/).filter(Boolean).at(-1)}</NativeSelectOption>)}</NativeSelect></label><label>成员<NativeSelect value={member} onChange={e => setMember(e.target.value)}><NativeSelectOption value="all">全部成员</NativeSelectOption>{data.roles.map(r => <NativeSelectOption key={r.id} value={r.id}>{r.displayName || r.name}</NativeSelectOption>)}</NativeSelect></label></div>
    {selectedWorkflow && <div className="workflow-context"><Pill>{status(selectedWorkflow.status)}</Pill><p>{selectedWorkflow.goal}</p><span className="muted">计划修订 {selectedWorkflow.planRevision}</span></div>}
    {actionError && <Notice role="status">{actionError}</Notice>}
    {selectedWorkflow && <ReplanEditor key={selectedWorkflow.id} data={data} workflowId={selectedWorkflow.id} csrf={csrf} onChanged={onChanged} />}
    {pageError && <Notice role="status">{pageError}</Notice>}
    {(totalMatching > 30 || currentPage > 0) && <div className="pagination"><Button variant="secondary" className="secondary" disabled={currentPage === 0} onClick={() => setTaskPage(currentPage - 1)}>上一页</Button><span>第 {currentPage + 1} 页 · 共 {totalMatching} 项匹配任务</span><Button variant="secondary" className="secondary" disabled={useServerPages ? matchingRemote?.nextAfter == null : (currentPage + 1) * 30 >= totalMatching} onClick={() => { if (useServerPages && matchingRemote?.nextAfter != null) setCursors(values => [...values.slice(0,currentPage + 1), matchingRemote.nextAfter!]); setTaskPage(currentPage + 1); }}>下一页</Button></div>}
    {selectedWorkflow && data.capabilities.workflowActions.available && !['completed','cancelled','failed'].includes(selectedWorkflow.status) && <div className="workflow-actions"><Button variant="secondary" className="secondary" disabled={actionBusy} onClick={() => void workflowAction(selectedWorkflow.status === 'paused' ? 'resume' : 'pause')}>{selectedWorkflow.status === 'paused' ? '恢复工作流' : '暂停工作流'}</Button><Button variant="ghost" className="text-button" disabled={actionBusy} onClick={() => setConfirmCancel(true)}>取消工作流…</Button>{confirmCancel && <div className="cancel-confirm"><p>这会取消此工作流中的任务，并请求停止实际执行。清理未确认前仍会占用资源。</p><Button variant="secondary" className="secondary" onClick={() => setConfirmCancel(false)}>保留工作流</Button><Button variant="default" className="primary" disabled={actionBusy} onClick={() => void workflowAction('cancel')}>确认取消此工作流</Button></div>}</div>}
    {remoteLoading ? <div className="loading" role="status">正在读取这一页任务…</div> : !task ? <Card asChild><div className="card"><Empty icon="tasks" title={data.tasks.length ? '这个筛选下没有任务' : '还没有执行任务'}>{data.tasks.length ? '切换筛选可查看其他任务。' : '工作流中的任务被记录后，将在这里呈现状态、依赖与验收依据。'}</Empty></div></Card> : <DetailLayout detailKey={taskId ?? ''} onBack={() => { location.hash = routeHref(data.workspace.id, 'tasks'); }} className="list-detail" list={<section className="task-list">{outsidePage && <section className="notice" aria-label="链接指定的任务"><div className="min-w-0"><p>链接指定的任务不在当前页的匹配结果中；下方列表仅显示当前筛选结果。</p><p className="[overflow-wrap:anywhere]"><code>{outsidePage.id}</code> · {outsidePage.title}</p><Button variant="ghost" onClick={() => { setSelection(null); location.hash = routeHref(data.workspace.id, 'tasks'); }}>清除链接选择</Button></div></section>}<section className="task-list" aria-label="任务列表">{!listed.length && <p>当前页没有匹配任务，请切换筛选。</p>}{listed.map(t => <Card key={t.id} asChild><Button variant="ghost" data-detail-select className={`card task-card ${task?.id === t.id ? 'is-selected' : ''}`}  onClick={() => { setSelection(t.id); location.hash = taskHref(data.workspace.id, t.id); }} aria-pressed={task?.id === t.id}><div className="task-meta"><code>{t.id}</code><Pill active={t.status === 'running'}>{status(t.status)}</Pill></div><h2>{t.title}</h2><p>{taskIssueSummary(t) || t.instructions}</p><div className="task-card-bottom"><span>{data.roles.find(r => r.id === t.roleId)?.displayName ?? '尚未指派'}</span><span>{t.dependsOn.length} 项依赖 · 尝试 {t.attempt}</span></div></Button></Card>)}</section></section>}><Card asChild><aside className="card detail-card" aria-label="任务详情"><div className="eyebrow">TASK DETAIL</div><h2>{task.title}</h2><Copy value={task.id} /><TaskDiagnostics task={task} /><p className="preserve-lines">{task.instructions}</p><section><h3>验收要求</h3>{task.acceptanceCriteria.length ? <ul className="criteria">{task.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="muted">未记录独立验收要求。</p>}</section><section><h3>任务依赖</h3>{task.dependsOn.length ? task.dependsOn.map(id => { const dep = data.tasks.find(t => t.id === id); return <div className="dependency" key={id}><span>{dep?.title ?? id}</span><span className="muted">{dep ? status(dep.status) : '记录不可用'}</span></div>; }) : <p className="muted">无前置任务。</p>}</section><section><h3>执行与验收记录</h3>{data.runs.filter(r => r.taskId === task.id).map(r => <div className="run-record" key={r.id}><div><strong>{r.purpose === 'review' ? '审查' : r.purpose === 'repair' ? '修复' : '开发'} Run</strong><Pill>{r.status === 'succeeded' ? '执行完成' : status(r.status)}</Pill></div><code>{r.id}</code><p>清理：{status(r.cleanupStatus)} · {r.slotReleasedAt ? '槽位已释放' : '未记录槽位释放'}</p><small>{time(r.createdAt)}</small>{r.stopReason && <p>{r.stopReason}</p>}<RunRecovery workspaceId={data.workspace.id} run={r} csrf={csrf} onChanged={onChanged} /></div>)}{!data.runs.some(r => r.taskId === task.id) && <p className="muted">尚无 Run 记录。</p>}{data.integrations.filter(i => i.taskId === task.id).map(i => <div className="run-record" key={i.id}><strong>集成 · {status(i.status)}</strong><p>{i.checkIds.length} 条检查记录 · 审查 Run {i.reviewRunId ?? '尚未记录'}</p><code>{i.candidateHead ?? '尚未记录候选提交'}</code>{i.error && <p className="form-error">{i.error}</p>}<IntegrationRecovery workspaceId={data.workspace.id} integration={i} csrf={csrf} onChanged={onChanged} /></div>)}</section><TaskEvidence key={`evidence:${task.id}`} workspaceId={data.workspace.id} taskId={task.id} revision={JSON.stringify([task.version, data.integrations.filter(i => i.taskId === task.id)])} /><section><h3>任务工作目录</h3>{data.worktrees.filter(w => w.taskId === task.id).map(w => <div className="run-record" key={w.id}><strong>{w.branch || w.kind}</strong><Copy value={w.path} /><p>状态：{w.status ?? '未知'}</p></div>)}{!data.worktrees.some(w => w.taskId === task.id) && <p className="muted">尚无已记录的工作目录。</p>}</section><TaskRetry key={`retry:${task.id}`} task={task} data={data} csrf={csrf} onChanged={onChanged} /><dl><Field name="已接受提交"><code>{task.acceptedCommit ?? '尚未接受'}</code></Field><Field name="预期修改路径">{task.expectedPaths.length ? task.expectedPaths.map(p => <code className="block" key={p}>{p}</code>) : '未指定'}</Field><Field name="任务版本">{task.version}</Field></dl></aside></Card></DetailLayout>}
  </>;
}

export function Activity({ data, stale, csrf, onChanged }: { data: UiWorkspaceDetail; stale: boolean; csrf: string; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const sorted = [...data.presence].sort((a, b) => { const rank = (p: UiPresence) => ['cleanup_unknown', 'unavailable'].includes(p.state) ? 0 : ['running', 'stopping', 'queued'].includes(p.state) ? 1 : 2; return rank(a) - rank(b); });
  const active = sorted.find(p => p.roleId === selected) ?? sorted[0];
  const role = data.roles.find(r => r.id === active?.roleId);
  const groupTitle = (presence: UiPresence) => ['cleanup_unknown','unavailable'].includes(presence.state) ? '需要关注' : ['running','stopping','queued'].includes(presence.state) ? '正在执行与等待' : '空闲、停用与未知状态';
  return <><Heading eyebrow="ACTIVITY & EVIDENCE" title="Agent 运行状态与集群投影" subtitle="查看成员活动、任务关联与执行现场，及时处理需要关注的状态。" action={<Button variant="secondary" onClick={onChanged}><Icon name="refresh"/>刷新状态</Button>} />{!active ? <Empty icon="pulse" title="暂无成员状态">工作区尚未返回活动投影。</Empty> : <DetailLayout className="list-detail" list={<section className="activity-list" aria-label="Agent 状态列表">{sorted.map((p, index) => { const r = data.roles.find(item => item.id === p.roleId); return <div className="activity-item" key={p.roleId}>{(index === 0 || groupTitle(sorted[index - 1]) !== groupTitle(p)) && <h3 className="activity-group-title">{groupTitle(p)}</h3>}<Card key={p.roleId} asChild><Button variant="ghost" data-detail-select className={`card activity-card ${active.roleId === p.roleId ? 'is-selected' : ''}`}  onClick={() => setSelected(p.roleId)} aria-pressed={active.roleId === p.roleId}><div className="activity-title"><span className="agent-avatar">{(r?.displayName || r?.name || '?').slice(0, 1).toUpperCase()}</span><div><h2>{r?.displayName || r?.name || p.roleId}</h2><span className="muted">{purpose(r?.purpose)}</span></div><Presence presence={p} stale={stale} /></div><p>{explain(p.reason)}</p><div className="muted">{p.taskIds.length} 项关联任务 · {p.runIds.length} 条关联 Run · {p.turnIds.length} 条对话 Turn</div></Button></Card></div>; })}</section>}><Card asChild><aside className="card detail-card"><span className="eyebrow">EXECUTION CONTEXT</span><h2>{role?.displayName || role?.name || active.roleId}</h2><Presence presence={active} stale={stale} /><p>{explain(active.reason)}</p><dl><Field name="角色标识"><code>{active.roleId}</code></Field><Field name="最近观测">{time(active.observedAt)}</Field><Field name="生命周期来源">{role?.kind === 'dsh-lead' ? '对话 Turn 已持久化；旧式 Workflow Lead 会话状态未知' : '已持久化的任务 Run 与调度记录'}</Field></dl><section><h3>关联对话</h3>{active.turnIds.length ? active.turnIds.map(id => <ActivityTurn key={id} workspaceId={data.workspace.id} turnId={id} observedAt={data.observedAt} csrf={csrf} onChanged={onChanged} />) : <p className="muted">没有占用资源的对话 Turn。</p>}</section><section><h3>关联执行</h3>{active.runIds.length ? active.runIds.map(id => { const run = data.runs.find(r => r.id === id); return <div className="run-record" key={id}><code>{id}</code><p>{run ? `${run.status === 'succeeded' ? '执行完成' : status(run.status)} · 清理 ${status(run.cleanupStatus)}` : '执行记录不可用'}</p>{run && <><p>{data.tasks.find(t => t.id === run.taskId)?.title ?? run.taskId}</p><RunRecovery workspaceId={data.workspace.id} run={run} csrf={csrf} onChanged={onChanged} /></>}</div>; }) : <p className="muted">没有关联的 Run 记录。此信息不等于成员空闲。</p>}</section>{data.hostCapacity && <section className="host-capacity"><div><span className="eyebrow">HOST CAPACITY</span><h2>本机共享执行容量</h2><p>{stale ? '上次观测的占用' : '记录中的资源占用'} · 所有工作区共用</p></div><dl><Field name="子执行总占用">{data.hostCapacity.occupied.total} / {data.hostCapacity.limits.total}</Field><Field name="开发 / 分析">{data.hostCapacity.occupied.developers} / {data.hostCapacity.limits.developers}</Field><Field name="串行审查">{data.hostCapacity.occupied.reviewers} / {data.hostCapacity.limits.reviewers}</Field><Field name="主 Agent 对话（独立）">{data.hostCapacity.occupied.lead} / {data.hostCapacity.limits.lead}</Field></dl></section>}</aside></Card></DetailLayout>}</>;
}

export function Settings({ data, onLogout, csrf, onSaved, tab = 'lead' }: { tab?: string; data: UiWorkspaceDetail; onLogout: () => Promise<void>; csrf: string; onSaved: () => void }) {
    const [busy,setBusy]=useState(false);
    const titles: Record<string, string> = {lead: '主 Agent 配置', connections: 'API 连接', workspace: '工作区设置', session: '浏览器会话'};
    const setTab = (value: string) => { location.hash = `${routeHref(data.workspace.id, 'settings')}?tab=${value}`; };
    return <><Heading eyebrow="SETTINGS" title={titles[tab]} subtitle="主协调者负责分解宏观目标、调度技能扩展及管理多 Agent 协作工作流。设定其底层推理引擎与连接方式。"/>
      <Tabs value={tab} onValueChange={setTab} className="settings-tabs"><TabsList><TabsTrigger value="lead">主 Agent</TabsTrigger><TabsTrigger value="connections">API 连接</TabsTrigger><TabsTrigger value="workspace">工作区</TabsTrigger><TabsTrigger value="session">浏览器会话</TabsTrigger></TabsList>
        <TabsContent value="lead"><div className="settings-intro"><span>执行模型与对话模型</span><span className="muted">分别配置协调执行与对话辅助输出的模型</span></div>{data.capabilities.agentConfiguration.available?<LeadEditor data={data} csrf={csrf} onSaved={onSaved}/>:<Notice>当前连接配置只读：{data.leadConfiguration.model}</Notice>}
          <div className="metric-cards"><Card className="card metric-card"><span>配置来源</span><strong>{data.leadConfiguration.source==='workspace'?'工作区独立配置':'继承本机配置'}</strong></Card><Card className="card metric-card"><span>协作成员</span><strong>{data.roles.filter(r=>r.enabled!==0).length}<small> 位已启用</small></strong></Card><Card className="card metric-card"><span>关联代码库</span><strong>{data.repositories.length}<small> 个仓库</small></strong></Card></div>
          <div className="page-note"><Icon name="shield" size={24}/><div><h3>生效规则说明与快照提醒</h3><p>更改执行连接默认作用于下一次执行任务。当前正在推进的执行会话将完整保留启动时的参数快照。</p></div></div>
        </TabsContent>
        <TabsContent value="connections"><ConnectionCatalogue csrf={csrf} onChanged={onSaved}/></TabsContent>
        <TabsContent value="workspace"><Card className="card settings-card"><div className="section-heading"><h2>工作区信息</h2><span className="eyebrow">WORKSPACE</span></div><dl><Field name="名称">{data.workspace.name}</Field><Field name="标识"><Copy value={data.workspace.id}/></Field><Field name="工作区目录"><Copy value={data.workspace.rootPath}/></Field><Field name="仓库"><Copy value={data.workspace.repositoryPath||'尚未关联'}/></Field></dl><WorkspaceControls data={data} csrf={csrf} onChanged={onSaved}/></Card></TabsContent>
        <TabsContent value="session"><Card className="card settings-card"><h2>浏览器会话</h2><p>当前浏览器通过同源会话访问本机 Host。退出后，需要从终端重新打开浏览器入口。</p><Button variant="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{await onLogout();}finally{setBusy(false);}}}>{busy?'正在退出…':'退出浏览器会话'}</Button></Card></TabsContent>
      </Tabs>
    </>;
  }
