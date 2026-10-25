import { WorkspaceTopology } from './components/WorkspaceTopology';
import { useRef, useState, type FormEvent } from 'react';
import type { UiWorkspaceList } from '../../src/api/ui-contracts';
import { api, errorText } from './api';
import { routeHref } from './state';
import { Empty, Heading, Pill } from './App';
import { Icon } from './components/Icon';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './components/ui/sheet';

export function WorkspaceDirectory({ list, selectedId, csrf, onCreate, onAuthError }: {
  list: UiWorkspaceList | null; selectedId: string; csrf: string;
  onCreate: (id: string) => void; onAuthError: (error: unknown) => void;
}) {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idempotency = useRef<{body: string; key: string} | null>(null);
  const matches = list?.workspaces.filter(w=>`${w.name} ${w.repositoryPath}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(busy)return;
    const form = new FormData(event.currentTarget);
    const repositoryPath = String(form.get('repositoryPath') ?? '').trim();
    const value = {name:String(form.get('name')).trim(), ...(repositoryPath?{repositoryPath,baseRef:String(form.get('baseRef')??'').trim()||'HEAD'}:{})};
    const body = JSON.stringify(value);
    if(idempotency.current?.body!==body) idempotency.current={body,key:crypto.randomUUID()};
    setBusy(true);setError('');
    try { const workspace=await api.createWorkspace(value,csrf,idempotency.current!.key);setCreating(false);onCreate(workspace.id); }
    catch(e){setError(errorText(e));onAuthError(e);}finally{setBusy(false);}
  }
  return <>
    <Heading eyebrow="WORKSPACE DIRECTORY" title="工作区管理与切换" subtitle="工作区是多代理协同与代码知识库隔离的独立容器。连接工作目录，保持每个项目的上下文与协作边界。" action={
      <Sheet open={creating} onOpenChange={open=>{if(!busy)setCreating(open);}}><SheetTrigger asChild><Button className="primary" disabled={!list?.capabilities.workspaceCreate.available}><Icon name="plus"/>创建新工作区</Button></SheetTrigger>
        <SheetContent className="workspace-drawer"><SheetHeader><span className="eyebrow accent-text">NEW RUNTIME ENVIRONMENT</span><SheetTitle>创建新工作区</SheetTitle><SheetDescription>先为团队创建一个空间，代码仓库也可以稍后关联。</SheetDescription></SheetHeader>
          <form onSubmit={submit} className="dialog-form"><label>工作区名称<Input name="name" required maxLength={120} placeholder="例如：RIFT 界面组" disabled={busy}/></label><label>本机仓库路径 <span className="muted">（可选）</span><Input name="repositoryPath" placeholder="现有 Git 仓库的绝对路径" disabled={busy}/></label><label>基线分支或引用 <span className="muted">（可选）</span><Input name="baseRef" placeholder="留空使用 HEAD" disabled={busy}/></label>{error&&<p role="alert" className="form-error">{error}</p>}<div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setCreating(false)}>取消</Button><Button disabled={busy}>{busy?'正在创建…':'创建并进入'}</Button></div></form>
        </SheetContent>
      </Sheet>
    }/>
    <div className="workspace-layout"><section className="workspace-list" aria-label="工作区列表"><div className="section-heading"><span>可切换工作区 <span className="muted">({list?.workspaces.length??0})</span></span><label className="compact-search"><Icon name="search" size={15}/><Input type="search" aria-label="搜索工作区" placeholder="搜索工作区" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
      {!list?<div className="loading">正在读取工作区…</div>:!matches.length?<Card className="card"><Empty title={list.workspaces.length?'没有匹配的工作区':'建立你的第一个工作区'}>{list.workspaces.length?'试试其他名称或路径关键词。':'点击“创建新工作区”，开始与 Agent 协作。'}</Empty></Card>:matches.map(w=><Card className={`card workspace-card ${selectedId===w.id?'is-selected':''}`} key={w.id}>
        <div className="workspace-card-heading"><div><h2>{w.name}</h2><Pill active={w.id===selectedId||!!w.activeWorkflowId}>{w.id===selectedId?'当前活动':w.activeWorkflowId?'后台执行':w.status==='active'?'就绪待命':'已归档'}</Pill></div><Button variant="secondary" size="sm" disabled={w.id===selectedId} asChild><a aria-disabled={w.id===selectedId} href={routeHref(w.id,'chat')}>{w.id===selectedId?'使用中':'切换至此'}</a></Button></div>
        <code className="workspace-path">{w.repositoryPath||'尚未关联代码仓库'}</code>
        <div className="workspace-metrics"><div><span>协作工作流</span><strong>{w.workflowCount}<small> 个</small></strong></div><div><span>任务记录</span><strong>{w.taskCount}<small> 项</small></strong></div><div><span>当前状态</span><strong className="metric-text">{w.activeWorkflowId?'工作流执行中':w.status==='active'?'可开始协作':'已归档'}</strong></div></div>
        <div className="workspace-card-bottom"><span><Icon name="network" size={16}/>主代理：{w.leadConnection?.model??'继承本机配置'}</span><code title={w.id}>#{w.id.slice(-7).toUpperCase()}</code></div>
      </Card>)}
    </section><aside className="workspace-guide">
      <Card className="card topology-card"><div className="section-heading"><h3>工作区资源拓扑</h3><Icon name="network" size={17}/></div><WorkspaceTopology/><dl className="topology-facts"><div><dt>本地宿主连接</dt><dd><span className="dot accent-dot"/>会话已连接</dd></div><div><dt>工作区上下文</dt><dd>独立记录与草稿</dd></div></dl></Card>
      <Card className="card principle-card"><div className="workspace-photo"><img src="/assets/workspace-studio-stitch.jpg" alt="窗边整洁的工作室与书桌"/><div><span>WORKSPACE DESIGN PRINCIPLE</span><h3>上下文的洁净是精准思维的前提</h3></div></div><p>每个项目拥有独立的协作空间。切换工作区时，对话与草稿分别保留，后台任务继续运行。</p></Card>
    </aside></div>
  </>;
}
