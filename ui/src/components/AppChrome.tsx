import { useState, type ReactNode } from 'react';
import type { UiWorkspaceDetail, UiWorkspaceList } from '@rift/protocol';
import { routeHref, type Page } from '../state';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from './ui/sheet';

const navigation: {page: Page; name: string; icon: string}[] = [
  {page:'chat',name:'对话',icon:'chat'}, {page:'agents',name:'智能代理',icon:'agents'},
  {page:'skills',name:'技能扩展',icon:'skill'}, {page:'repositories',name:'代码库与工作区',icon:'branch'},
  {page:'tasks',name:'任务队列',icon:'tasks'}, {page:'settings',name:'系统设置',icon:'settings'},
];

export function AppChrome({ workspaceId, page, list, current, connected, stale, syncingError, onNewChat, children }: {
  workspaceId: string; page: Page; list: UiWorkspaceList | null; current: UiWorkspaceDetail | null;
  connected: boolean; stale: boolean; syncingError: boolean; onNewChat: () => void; children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = list?.workspaces.find(w=>w.id===workspaceId);
  const running = current?.presence.filter(p=>p.state==='running' || p.state==='stopping').length ?? 0;
  const attention = current?.presence.filter(p=>['queued','cleanup_unknown','unavailable'].includes(p.state)).length ?? 0;
  const link = (target: Page) => routeHref(workspaceId, target);
  const side = <>
    <DropdownMenu onOpenChange={open=>{if(!open)setSearch('');}}>
      <DropdownMenuTrigger asChild><Button variant="ghost" className="workspace-switch" aria-label="切换工作区"><span className="dot accent-dot" /><span>{selected?.name ?? 'RIFT 工作区'}</span><Icon name="switch" size={16}/></Button></DropdownMenuTrigger>
      <DropdownMenuContent className="workspace-menu" side="bottom" align="start">
        <div className="workspace-menu-search"><Icon name="search" size={16}/><Input aria-label="搜索工作区" placeholder="搜索工作区…" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key!=='Escape')e.stopPropagation();}}/></div>
        <div className="workspace-menu-list">{list?.workspaces.filter(w=>w.name.toLowerCase().includes(search.toLowerCase())).map(w=><DropdownMenuItem key={w.id} asChild><a href={routeHref(w.id,'chat')} onClick={()=>setMobileOpen(false)}><Icon name="folder"/><span>{w.name}</span>{w.id===workspaceId&&<Icon name="check" size={15}/>}</a></DropdownMenuItem>)}{list && !list.workspaces.some(w=>w.name.toLowerCase().includes(search.toLowerCase()))&&<p className="menu-empty">没有匹配的工作区</p>}</div>
        <DropdownMenuSeparator/><DropdownMenuItem asChild><a href={link('workspaces')} onClick={()=>setMobileOpen(false)}><Icon name="grid"/>管理与创建工作区</a></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Button variant="secondary" className="new-chat" disabled={!workspaceId} onClick={()=>{setMobileOpen(false);onNewChat();}}><Icon name="compose"/><span>新建对话</span><kbd>⌘K</kbd></Button>
    <nav aria-label="工作区导航">{navigation.map(item=><Button variant="ghost" asChild key={item.page}><a href={link(item.page)} className={`nav-link ${page===item.page?'active':''}`} aria-current={page===item.page?'page':undefined} onClick={()=>setMobileOpen(false)}><Icon name={item.icon}/><span>{item.name}</span></a></Button>)}</nav>
    <div className="host-status"><span className={`dot ${connected?'accent-dot':''}`}/><span>{connected ? (syncingError ? '会话已连接 · 数据未同步' : '本地宿主已连接') : '等待本地宿主连接'}</span><code>v0.1.0</code></div>
  </>;
  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={e=>{e.preventDefault();document.getElementById('main')?.focus();}}>跳至主要内容</a>
    <aside className="sidebar" aria-label="主导航">{side}</aside>
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}><SheetContent side="left" className="mobile-navigation"><SheetTitle className="sr-only">工作区导航</SheetTitle><SheetDescription className="sr-only">切换工作区或打开工作区页面。</SheetDescription><div className="mobile-sidebar">{side}</div></SheetContent></Sheet>
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><Button variant="ghost" size="icon" className="mobile-menu" aria-label="展开导航" onClick={()=>setMobileOpen(true)}><Icon name="menu"/></Button>{page==='chat'&&<span id="conversation-menu-slot"/>}</div>
      <div className="topbar-actions"><Button variant="ghost" asChild><a className="status-link" href={link('activity')}><span className="dot accent-dot"/><span>{current?`${stale ? '上次观测 · ' : ''}Agent ${running} 运行 · ${attention} 待定`:'Agent 状态'}</span><Icon name="down" size={13}/></a></Button>
      </div></header>{children}</div>
  </div>;
}
