import { subscribeWorkspaceEvents } from './workspace-stream';
import { copyText } from './browser-platform';
import { AppChrome } from './components/AppChrome';
import { WorkspaceDirectory } from './WorkspaceDirectory';
import { Icon } from './components/Icon';
export { Icon } from './components/Icon';
import { Badge } from './components/ui/badge';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UiSession, UiWorkspaceDetail, UiWorkspaceList } from '@rift/protocol';
import { api, ApiError, consumeBootstrap, errorText } from './api';
import { LatestRequest, parseRoute, readDraft, routeHref, saveDraft, type Page } from './state';
import { Agents, Activity, Repositories, Settings, Skills, Tasks } from './pages';
import { ChatScreen } from './ChatScreen';
import { SkillLibrary } from './SkillLibrary';
import { RepositoryManager } from './RepositoryManager';

export function Heading({ eyebrow, title, subtitle, action, english }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode; english?: string }) {
  return <header className="page-heading"><div className="heading-copy">{eyebrow === 'WORKSPACE DIRECTORY' ? <div className="eyebrow accent-text">WORKSPACE DIRECTORY <span className="eyebrow-context">/ 系统工作区矩阵</span></div> : <nav aria-label="当前位置" className="breadcrumbs"><span>RIFT</span><span>/</span><span>{eyebrow === 'SETTINGS' ? '系统设置' : '工作台'}</span><span>/</span><span>{title}</span></nav>}<h1 className="sr-only">{title}{english ? ` · ${english}` : ''}</h1><p className="sr-only">{subtitle}</p></div>{action && <div className="heading-actions">{action}</div>}</header>;
}
export function Notice({ children, role = 'note' }: { children: ReactNode; role?: 'note' | 'status' }) { return <Alert role={role} className="notice"><Icon name="help" size={17}/><AlertDescription>{children}</AlertDescription></Alert>; }
export function Empty({ icon = 'grid', title, children }: { icon?: string; title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={28} /></span><h2>{title}</h2><p>{children}</p></div>;
}
export function Pill({ children, active = false }: { children: ReactNode; active?: boolean }) { return <Badge variant="secondary" className={`pill${active ? ' accent' : ''}`}><span className="dot" />{children}</Badge>; }
export function Field({ name, children }: { name: string; children: ReactNode }) { return <div className="field"><dt>{name}</dt><dd>{children ?? '未提供'}</dd></div>; }
export function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setCopied(false); setFailed(false); }, [value]);
  return <div className="copy-field"><code tabIndex={0}>{value}</code><Button variant="ghost" className="text-button" onClick={async () => { setFailed(false); try { await copyText(value); setCopied(true); } catch { setCopied(false); setFailed(true); } }} aria-label={`复制 ${value}`}>{copied ? '已复制' : '复制'}</Button><span role="status" className="copy-status">{failed ? '复制失败，请手动选择文本。' : copied ? '已复制到剪贴板。' : ''}</span></div>;
}
export function time(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }

export function App({ initialSession }: { initialSession: Promise<UiSession> }) {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [session, setSession] = useState<UiSession | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [list, setList] = useState<UiWorkspaceList | null>(null);
  const [detail, setDetail] = useState<UiWorkspaceDetail | null>(null);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [newChatRequest, setNewChatRequest] = useState(0);
  const [clock, setClock] = useState(Date.now());

  const requests = useRef(new LatestRequest());
  const listRequests = useRef(new LatestRequest());
  const authRequests = useRef(new LatestRequest());
  useEffect(() => { const change = () => {
    const code = consumeBootstrap(window.location, window.history);
    if (code !== null) {
      const token = authRequests.current.begin(); requests.current.cancel(); listRequests.current.cancel(); setSession(null); setSessionError(''); setList(null); setDetail(null); setError(''); setListError('');
      api.session(code).then(value => { if (token.current()) setSession(value); }, e => { if (token.current()) setSessionError(errorText(e)); });
    }
    setRoute(parseRoute(location.hash));
  }; addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => { const interval = setInterval(() => setClock(Date.now()), 5000); const visibility = () => { setClock(Date.now()); if (!document.hidden) setRefresh(n => n + 1); }; document.addEventListener('visibilitychange', visibility); return () => { clearInterval(interval); document.removeEventListener('visibilitychange', visibility); }; }, []);
  useEffect(() => { const token = authRequests.current.begin(); initialSession.then(value => { if (token.current()) setSession(value); }, e => { if (token.current()) setSessionError(errorText(e)); }); return () => authRequests.current.cancel(); }, [initialSession]);
  const fail = (e: unknown) => { if (e instanceof ApiError && e.status === 401) { setSession(null); setSessionError(errorText(e)); setDetail(null); setList(null); } };
  useEffect(() => {
    if (!session) return;
    const load = async () => { const token = listRequests.current.begin(); try { const value = await api.workspaces(token.signal); if (token.current()) { setList(value); setListError(''); } } catch (e) { if (token.current()) { setListError(errorText(e)); fail(e); } } };
    void load(); const interval = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { clearInterval(interval); listRequests.current.cancel(); };
  }, [session, refresh]);
  useEffect(() => {
    if (!session || !route.workspaceId) { setDetail(null); return; }
    setError('');
    const load = async () => { const token = requests.current.begin(); try { const value = await api.detail(route.workspaceId, token.signal); if (token.current() && value.workspace.id === route.workspaceId) { setDetail(previous => previous?.workspace.id === value.workspace.id && previous.snapshotCursor > value.snapshotCursor ? previous : value); setError(''); } } catch (e) { if (token.current()) { setError(errorText(e)); fail(e); } } };
    void load(); const interval = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { clearInterval(interval); requests.current.cancel(); };
  }, [session, route.workspaceId, refresh]);
  useEffect(() => {
    if (!session || detail?.workspace.id !== route.workspaceId || !detail?.capabilities.events.available) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = subscribeWorkspaceEvents(route.workspaceId, detail.snapshotCursor, {
      changed: event => {
        if(route.page==='chat') { try { const type=JSON.parse(event.data).type as string; if(type.startsWith('message.')||type==='turn.activity'||type==='turn.chunk'||type==='turn.message'||type==='run.message'||type==='run.progress')return; } catch { /* Unknown payload still requests a snapshot. */ } }
        if (!timer) timer = setTimeout(() => { timer = undefined; setRefresh(n => n + 1); }, 200); },
      snapshot: async signal => { const value = await api.detail(route.workspaceId, signal); if (!signal.aborted && value.workspace.id === route.workspaceId) setDetail(previous => previous?.workspace.id === value.workspace.id && previous.snapshotCursor > value.snapshotCursor ? previous : value); return value.snapshotCursor; },
      error: message => { if (message) setError(message); else setError(''); },
      expired: () => fail(new ApiError(401, '浏览器会话已过期。')),
    });
    return () => { close(); if (timer) clearTimeout(timer); };
  }, [session, route.workspaceId, route.page, detail?.workspace.id, detail?.capabilities.events.available]);
  // Never expose the previous workspace while the new request is still loading.
  const current = detail?.workspace.id === route.workspaceId ? detail : null;
  const stale = !!error || !!current && (clock - Date.parse(current.observedAt) > 35000 || document.hidden);
  const actualPage = !route.workspaceId ? 'workspaces' : route.page;
  const navigate = (id: string, page: Page) => { location.hash = routeHref(id, page); };
  const retry = () => {
    if (!session) {
      const token = authRequests.current.begin(); setSessionError('');
      api.session(null).then(value => { if (token.current()) setSession(value); }, e => { if (token.current()) setSessionError(errorText(e)); });
    } else setRefresh(n => n + 1);
  };
  const newChat = () => { setNewChatRequest(n => n + 1); navigate(route.workspaceId, 'chat'); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && route.workspaceId) { event.preventDefault(); setNewChatRequest(n=>n+1); location.hash=routeHref(route.workspaceId,'chat'); } }; addEventListener('keydown',key); return ()=>removeEventListener('keydown',key); },[route.workspaceId]);
  return <AppChrome workspaceId={route.workspaceId} page={actualPage} list={list} current={current} connected={!!session} stale={stale} syncingError={!!error || !!listError} onNewChat={newChat}>
    <main id="main" tabIndex={-1} className={`main-content page-${actualPage}${actualPage === 'chat' ? ' chat-main' : ''}`}>
      {!session ? <div className="auth-card"><div className="eyebrow">LOCAL CONNECTION</div><h1>{sessionError ? '暂时无法连接 RIFT' : '正在连接 RIFT'}</h1><p role="status">{sessionError || '正在自动连接并确认浏览器会话…'}</p>{sessionError && <><Notice>请确认 RIFT 服务已启动、当前网络可以访问该地址，然后重新连接。</Notice><Button onClick={retry}>重新连接</Button></>}</div> : <>
        {(error || listError) && <div className="error-banner" role="status"><div><strong>数据尚未同步</strong><p>{error || listError}</p>{current && <small>以下为 {time(current.observedAt)} 的记录。</small>}</div><Button variant="secondary" className="secondary" onClick={retry}>重新同步</Button></div>}
        {actualPage === 'workspaces' ? <WorkspaceDirectory selectedId={route.workspaceId} list={list} csrf={session.csrfToken} onCreate={id => { retry(); navigate(id, 'chat'); }} onAuthError={fail} /> : !current ? error ? <Empty title="暂时无法读取这个工作区">请重试同步，或从左侧选择其他工作区。</Empty> : <div className="loading" role="status">正在读取工作区记录<span className="loading-dots">…</span></div> : <>
          {actualPage === 'chat' && (current.capabilities.chat.available ? <ChatScreen onNewConversationHandled={()=>setNewChatRequest(0)} newConversationRequest={newChatRequest} key={route.workspaceId} data={current} csrf={session.csrfToken} onAuthError={fail} /> : <Chat key={route.workspaceId} data={current} />)}
          {stale && !error && <Notice>记录超过同步窗口，正在等待最新状态。以下内容仅代表上次观测。</Notice>}
          {actualPage === 'agents' && <Agents key={route.workspaceId} data={current} stale={stale} csrf={session.csrfToken} onSaved={retry} />}
          {actualPage === 'skills' && (current.capabilities.skills.available ? <SkillLibrary key={route.workspaceId} data={current} csrf={session.csrfToken} /> : <Skills />)}
          {actualPage === 'repositories' && (current.capabilities.multipleRepositories.available ? <RepositoryManager key={route.workspaceId} data={current} csrf={session.csrfToken} onChanged={retry} /> : <Repositories data={current} />)}
          {actualPage === 'tasks' && <Tasks key={route.workspaceId} taskId={route.taskId} data={current} csrf={session.csrfToken} onChanged={retry} />}
          {actualPage === 'activity' && <Activity key={route.workspaceId} data={current} stale={stale} csrf={session.csrfToken} onChanged={retry} />}
          {actualPage === 'settings' && <Settings tab={route.settingsTab} key={route.workspaceId} data={current} csrf={session.csrfToken} onSaved={retry} onLogout={async () => { try { await api.logout(session.csrfToken); setSession(null); setList(null); setDetail(null); setSessionError('浏览器会话已退出。可以重新连接 RIFT。'); } catch (e) { setError(errorText(e)); fail(e); } }} />}
          {actualPage !== 'chat' && <footer className="data-footer"><span>记录同步于 {time(current.observedAt)}</span><Button variant="ghost" className="text-button" onClick={retry}>刷新记录</Button></footer>}
        </>}
      </>}
    </main></AppChrome>;
}

function Chat({ data }: { data: UiWorkspaceDetail }) {
  const [draft, setDraft] = useState(() => readDraft(data.workspace.id));
  const [saved, setSaved] = useState(true);
  const lead = data.roles.find(r => r.kind === 'dsh-lead');
  return <div className="chat-page"><div className="chat-intro"><span className="eyebrow">{data.workspace.name} / CONVERSATION</span><div className="chat-monogram"><Icon name="skill" size={36} /></div><h1>从一个想法开始。</h1><p>在这里整理目标、记录问题，<br className="desktop-break" />为与 Agent 的下一次协作做好准备。</p></div>
    <div className="chat-availability"><span className="small-rule" /><span>对话连接尚未开放</span><span className="small-rule" /></div>
    <p className="chat-description">当前可查看真实的成员配置、任务和工作目录。聊天消息还不能发送；下方内容仅作为你的草稿保留。</p>
    <div className="chat-suggestions"><a href={routeHref(data.workspace.id, 'agents')}><Icon name="agents" /><div><strong>认识工作区成员</strong><span>查看职责与运行连接</span></div><Icon name="arrow" size={16} /></a><a href={routeHref(data.workspace.id, 'tasks')}><Icon name="tasks" /><div><strong>查看执行进展</strong><span>任务、依赖与验收记录</span></div><Icon name="arrow" size={16} /></a></div>
    <div className="composer"><div className="composer-context"><span className="chip"><Icon name="agents" size={15} />默认主 Agent · {lead?.name ?? '未配置'}</span><span className="chip"><Icon name="branch" size={15} />{data.workspace.baseRef}</span></div><label className="sr-only" htmlFor="chat-draft">{data.workspace.name} 的对话草稿</label><Textarea id="chat-draft" value={draft} onChange={e => { setDraft(e.target.value); setSaved(saveDraft(data.workspace.id, e.target.value)); }} placeholder="写下你的目标或问题…" aria-describedby="chat-unavailable" /><div className="composer-bottom"><span>{saved ? '草稿保留在当前标签页 · 尚未发送' : '浏览器无法保存草稿，请勿关闭此页'}</span><Button variant="default" className="send-button" disabled aria-label="发送不可用：对话连接尚未开放" aria-describedby="chat-unavailable"><Icon name="up" /></Button></div></div><p id="chat-unavailable" className="composer-help">消息发送与 @ 定向对话尚未支持。回车仅换行，不会提交。</p>
  </div>;
}
