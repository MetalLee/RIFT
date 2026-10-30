import { isNearChatBottom, scrollChatToLatest, restoreChatAnchor } from './chat-scroll';
import { applyMessageEvent } from './stream-state';
import type { WorkspaceEvent, AgentTurn, ChatMessage, ChatPage, Conversation, ContextRef, UiWorkspaceDetail } from '@rift/protocol';
import { ChatTimeline } from './ChatTimeline';
import { subscribeWorkspaceEvents } from './workspace-stream';
import { randomId } from './browser-platform';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { Textarea } from './components/ui/textarea';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, errorText, isDefinitiveRejection, mutate, request } from './api';
import { Empty, Icon, Notice, Pill, time } from './App';
import { LatestRequest, readDraft, saveDraft } from './state';
import { loadPending, mergeChatHistory, needsTimelineBridge, persistPending, shouldSendOnKey, type ChatHistory, type PendingMessage } from './chat-state';
import { useMutation } from './useMutation';
import { MessageBody } from './MessageBody';
import { createPortal } from 'react-dom';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';

const segment = encodeURIComponent;
const turnLabel: Record<AgentTurn['status'], string> = { queued: '排队中', running: '正在回复', stopping: '正在停止', completed: '回复完成', failed: '回复失败', cancelled: '已停止', interrupted: '执行中断' };
function displayName(role: UiWorkspaceDetail['roles'][number]) { return (role as typeof role & { displayName?: string }).displayName ?? role.name; }
export function ChatScreen({ data, csrf, onAuthError, newConversationRequest = 0, onNewConversationHandled }: { data: UiWorkspaceDetail; csrf: string; onAuthError: (e: unknown) => void; newConversationRequest?: number; onNewConversationHandled: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>(data.conversations);
  const [menuSlot, setMenuSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setMenuSlot(document.getElementById('conversation-menu-slot')); }, []);
  const creating = useRef(false);
  const [focusConversation, setFocusConversation] = useState('');
  const handledRequest = useRef(0);
  useEffect(() => { if (newConversationRequest && handledRequest.current !== newConversationRequest) { handledRequest.current = newConversationRequest; void create(); onNewConversationHandled(); } if (!newConversationRequest) handledRequest.current = 0; }, [newConversationRequest]);
  const selectionKey = `rift:conversation:${encodeURIComponent(data.workspace.id)}`;
  const [selected, setSelected] = useState(() => { let saved = ''; try { saved = sessionStorage.getItem(selectionKey) ?? ''; } catch { /* Storage is optional. */ } return data.conversations.some(c => c.id === saved) ? saved : data.conversations[0]?.id ?? ''; });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/workspaces/${segment(data.workspace.id)}`;
  const mutation = useMutation(csrf);
  function selectConversation(id: string) { setSelected(id); try { sessionStorage.setItem(selectionKey, id); } catch { /* Keep the in-memory selection. */ } }
  useEffect(() => {
    setConversations(items => {
      const merged = new Map(items.map(item => [item.id, item]));
      for (const incoming of data.conversations) {
        const existing = merged.get(incoming.id);
        if (!existing || existing.version < incoming.version) merged.set(incoming.id, incoming);
      }
      return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    });
    setSelected(value => value || data.conversations[0]?.id || '');
  }, [data.conversations]);
  async function create() { if (creating.current) return; creating.current = true; setBusy(true); setError(''); try { const c = await mutation<Conversation>(`${base}/conversations`, {}); setConversations(items => [c, ...items.filter(item => item.id !== c.id)]); selectConversation(c.id); setFocusConversation(c.id); } catch (e) { setError(errorText(e)); onAuthError(e); } finally { creating.current = false; setBusy(false); } }
  const updateConversation = useCallback((conversation: Conversation) => setConversations(items => items.map(item => item.id === conversation.id && item.version <= conversation.version ? conversation : item)), []);
  const title = conversations.find(c => c.id === selected)?.title ?? '新对话';
  return <div className="chat-page live-chat">{menuSlot && createPortal(<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="conversation-menu-trigger" aria-label={`切换对话：${title}`} title={title}><span className="topbar-title">{title}</span><Icon name="down" size={14}/></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="conversation-menu">{conversations.map(c=><DropdownMenuItem key={c.id} onSelect={()=>selectConversation(c.id)}><span>{c.title}</span>{selected===c.id&&<Icon name="check" size={16}/>}</DropdownMenuItem>)}<DropdownMenuSeparator/><DropdownMenuItem disabled={busy} onSelect={()=>void create()}><Icon name="plus"/>{busy ? '正在创建…' : '新对话'}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>,menuSlot)}
    {error && <Notice role="status">{error}</Notice>}
    {selected ? <ConversationView focusOnMount={focusConversation === selected} key={selected} conversationId={selected} data={data} csrf={csrf} onAuthError={onAuthError} onConversation={updateConversation} /> : <Empty icon="chat" title="开始一段新的对话">创建对话后，默认由主 Agent 接收。也可以选择一个已配置连接的成员。<Button disabled={busy} onClick={()=>void create()}>新建对话</Button></Empty>}
  </div>;
}

function ConversationView({ conversationId, data, csrf, onAuthError, onConversation, focusOnMount }: { focusOnMount: boolean; conversationId: string; data: UiWorkspaceDetail; csrf: string; onAuthError: (e: unknown) => void; onConversation: (conversation: Conversation) => void }) {
  useEffect(() => { if (focusOnMount) composer.current?.focus(); }, []);
  const recipientTrigger = useRef<HTMLButtonElement>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<ChatPage | null>(null);
  useEffect(() => { if (page) onConversation(page.conversation); }, [page?.conversation.id, page?.conversation.version, onConversation]);
  const [earlier, setEarlier] = useState<ChatHistory>({ messages: [], turns: [], chunks: [] });
  const [earlierCursor, setEarlierCursor] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState(() => readDraft(data.workspace.id, conversationId));
  const [recipient, setRecipient] = useState(() => { try { return sessionStorage.getItem(`rift:recipient:${data.workspace.id}:${conversationId}`) || data.roles.find(r => r.kind === 'dsh-lead')?.id || ''; } catch { return data.roles.find(r => r.kind === 'dsh-lead')?.id || ''; } });
  const [error, setError] = useState(''); const [sending, setSending] = useState(false); const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [actionError, setActionError] = useState(''); const [eventError, setEventError] = useState(''); const [observedAt, setObservedAt] = useState(0); const [clock, setClock] = useState(Date.now());
  const lastSnapshot = useRef<ChatPage|undefined>(undefined); const retainedActive = useRef<string[]>([]); const gapQueue = useRef(new Map<string,{cursor:string;known:Set<string>}>()); const fillingGap = useRef(false); const historyAbort = useRef(new AbortController());
  const historyGeneration = useRef(0); const syncInFlight = useRef<symbol|null>(null); const loadingHistory = useRef(false); const historyAnchor = useRef<{height:number;top:number}|null>(null);
  const [saved, setSaved] = useState(true); const [mentions, setMentions] = useState(false); const [newContent, setNewContent] = useState(false);
  const contextKey = `rift:context:${encodeURIComponent(data.workspace.id)}:${encodeURIComponent(conversationId)}`;
  const [contextOpen, setContextOpen] = useState(false);
  const [contextRefs, setContextRefs] = useState<ContextRef[]>(() => { try { const value = JSON.parse(sessionStorage.getItem(contextKey) ?? '[]'); return Array.isArray(value) ? value.filter(item => item && ['task','repository','worktree'].includes(item.type) && typeof item.id === 'string').slice(0,20) : []; } catch { return []; } });
  const contexts = [...data.repositories.map(r => ({ type: 'repository' as const, id: r.id, name: `仓库 · ${r.canonicalPath}` })), ...data.tasks.map(t => ({ type: 'task' as const, id: t.id, name: `任务 · ${t.title}` })), ...data.worktrees.map(w => ({ type: 'worktree' as const, id: w.id, name: `Worktree · ${w.path}` })), ...(data.managedWorktrees ?? []).filter(w => w.status === 'active').map(w => ({ type: 'worktree' as const, id: w.id, name: `Worktree · ${w.path}` }))];
  const invalidContext = contextRefs.some(ref => !contexts.some(c => c.id === ref.id && c.type === ref.type));
  function selectContext(ref: ContextRef, checked: boolean) { setContextRefs(current => { const next = checked ? [...current, ref].slice(0,20) : current.filter(item => item.type !== ref.type || item.id !== ref.id); try { sessionStorage.setItem(contextKey, JSON.stringify(next)); } catch { /* Keep current edits in memory. */ } return next; }); }
  const latest = useRef(new LatestRequest()); const alive = useRef(true); const bottom = useRef<HTMLDivElement>(null); const scrollArea = useRef<HTMLDivElement>(null); const transcript = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null); const nearBottom = useRef(true);
  const pending = useRef<PendingMessage | null>(loadPending(data.workspace.id, conversationId));
  const base = `/workspaces/${segment(data.workspace.id)}/conversations/${segment(conversationId)}/messages`;
  const pageUrl = `${base}?view=timeline&limit=30`;
  const snapshotUrl=()=>`${pageUrl}&refresh=${segment(JSON.stringify(retainedActive.current))}`;
  async function fillGaps(){
    if(fillingGap.current)return;fillingGap.current=true;
    try{
      for(const [key,gap] of gapQueue.current){
        while(alive.current){
          const older=await request<ChatPage>(`${pageUrl}&before=${segment(gap.cursor)}`,{signal:historyAbort.current.signal});
          if(!alive.current)return;
          setPage(previous=>previous?{...previous,...mergeChatHistory(older,previous)}:previous);
          if(!older.nextBefore||older.messages.some(message=>gap.known.has(message.id))){gapQueue.current.delete(key);break;}
          gap.cursor=older.nextBefore;
        }
      }
    }catch(e){if(alive.current){setEventError('遗漏消息同步暂未完成；将继续重试。');onAuthError(e);}}
    finally{fillingGap.current=false;}
  }
  function acceptSnapshot(result:ChatPage){
    if(needsTimelineBridge(lastSnapshot.current,result))gapQueue.current.set(result.nextBefore!,{cursor:result.nextBefore!,known:new Set(lastSnapshot.current!.messages.map(message=>message.id))});
    lastSnapshot.current=result;
    const current={...result,...mergeChatHistory({messages:[],turns:[],chunks:[]},result)};
    setPage(previous=>{
      if(previous&&previous.snapshotCursor>result.snapshotCursor)return previous;
      return previous?{...current,...mergeChatHistory(previous,current)}:current;
    });
    setEarlierCursor(current=>current===undefined?result.nextBefore:current);
    setObservedAt(Date.now());setError('');void fillGaps();
  }
  async function sync() {
    if(syncInFlight.current)return;
    const requestId=Symbol();syncInFlight.current=requestId;const token=latest.current.begin();
    try{const result=await request<ChatPage>(snapshotUrl(),{signal:token.signal});if(token.current()&&alive.current&&result.conversation.id===conversationId&&result.conversation.workspaceId===data.workspace.id)acceptSnapshot(result);}
    catch(e){if(token.current()&&alive.current){setError(errorText(e));onAuthError(e);}}
    finally{if(syncInFlight.current===requestId)syncInFlight.current=null;}
  }
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 5000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!data.capabilities.events.available) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = subscribeWorkspaceEvents(data.workspace.id, data.snapshotCursor, {
      changed: event => {
        try {
          const update = JSON.parse(event.data) as WorkspaceEvent;
          if(update.type==='run.progress')return;
          if (update.type === 'turn.message' || update.type === 'turn.activity' || update.type === 'run.message') {
            setPage(previous => {const next=previous&&applyMessageEvent(previous, update);if(!next&&!timer)timer=setTimeout(()=>{timer=undefined;void sync();},200);return next??previous;});
            setObservedAt(Date.now());return;
          }
        } catch { /* A snapshot below repairs malformed or missing-base events. */ }
        if (!timer) timer = setTimeout(() => { timer = undefined; void sync(); }, 500);
      },
      snapshot: async signal => {
        const generation = ++historyGeneration.current;
        latest.current.cancel();
        const first = await request<ChatPage>(snapshotUrl(), { signal });
        if (!signal.aborted && generation === historyGeneration.current) acceptSnapshot(first);
        return first.snapshotCursor;
      },
      error: setEventError,
      expired: () => onAuthError(new ApiError(401, '浏览器会话已过期。')),
    });
    return () => { close(); if (timer) clearTimeout(timer); };
  }, [base, data.capabilities.events.available]);
  useEffect(() => {
    alive.current=true;historyAbort.current=new AbortController();void sync();
    const interval=setInterval(()=>{if(!document.hidden)void sync();},data.capabilities.events.available?15000:3000);
    const visibility=()=>{if(!document.hidden)void sync();};document.addEventListener('visibilitychange',visibility);
    return()=>{alive.current=false;historyAbort.current.abort();latest.current.cancel();syncInFlight.current=null;clearInterval(interval);document.removeEventListener('visibilitychange',visibility);};
  },[base,data.capabilities.events.available]);
  const contentRevision = `${page?.messages.map(message=>message.id+':'+message.version+':'+message.status).join(',')}`;
  const jumpToLatest=()=>{nearBottom.current=true;if(scrollArea.current)scrollChatToLatest(scrollArea.current);setNewContent(false);};
  useLayoutEffect(()=>{
    if(!page||!scrollArea.current)return;
    if(nearBottom.current)jumpToLatest();else setNewContent(true);
  },[contentRevision]);
  useLayoutEffect(()=>{
    if(historyAnchor.current&&scrollArea.current){restoreChatAnchor(scrollArea.current,historyAnchor.current.height,historyAnchor.current.top);historyAnchor.current=null;}
  },[earlier]);
  useEffect(()=>{
    if(!scrollArea.current||!transcript.current)return;
    const resize=new ResizeObserver(()=>{if(nearBottom.current&&scrollArea.current)scrollChatToLatest(scrollArea.current);});
    resize.observe(scrollArea.current);resize.observe(transcript.current);return()=>resize.disconnect();
  },[]);
  function chooseRecipient(id: string) { setRecipient(id); setMentions(false); setDraft(current => { const next = current.endsWith('@') ? current.slice(0,-1) : current; saveDraft(data.workspace.id, next, conversationId); return next; }); try { sessionStorage.setItem(`rift:recipient:${data.workspace.id}:${conversationId}`, id); } catch { /* Session storage is optional. */ } composer.current?.focus(); }
  const chosen = data.roles.find(r => r.id === recipient);
  const connectionMissing = chosen?.kind !== 'dsh-lead' && !chosen?.chatConnection && !data.bindings.find(binding=>binding.id===chosen?.providerBindingId)?.executionConnection;
  const disabledReason = !chosen ? '所选成员已失效，请明确选择接收者。' : chosen.enabled === 0 ? '所选成员已停用，请选择其他接收者。' : connectionMissing ? '所选成员尚未配置对话连接。' : invalidContext ? '所选上下文已失效，请在上下文选择器中移除或重新选择。' : data.workspace.status !== 'active' ? '已归档工作区不能接收新消息。' : '';
  async function send() {
    const text = draft.trim(); if (sending || !text || disabledReason) return;
    if (!pending.current || pending.current.text !== text || pending.current.recipient !== recipient || JSON.stringify(pending.current.contextRefs ?? []) !== JSON.stringify(contextRefs)) pending.current = { text, recipient, clientMessageId: randomId(), key: randomId(), contextRefs, mentions: chosen ? [{ agentId: chosen.id, label: displayName(chosen) }] : [] };
    const submission = pending.current; persistPending(data.workspace.id, conversationId, submission); setSending(true); setActionError('');
    try {
      const result = await mutate<{ message: ChatMessage; turn: AgentTurn }>(base, csrf, { content: submission.text, recipientAgentId: submission.recipient, clientMessageId: submission.clientMessageId, contextRefs: submission.contextRefs ?? [], mentions: submission.mentions ?? [] }, 'POST', submission.key);
      if (!alive.current) return;
      if (result.message.conversationId !== conversationId || result.message.workspaceId !== data.workspace.id) throw new Error('返回的消息不属于当前对话，请重新同步。');
      setDraft(''); saveDraft(data.workspace.id, '', conversationId); pending.current = null; persistPending(data.workspace.id, conversationId, null); nearBottom.current = true; await sync();
    } catch (e) { if (alive.current) { if (isDefinitiveRejection(e) && pending.current) { pending.current = { ...pending.current, key: randomId() }; persistPending(data.workspace.id, conversationId, pending.current); } setActionError(`${errorText(e)} 草稿已保留；再次发送同一内容会复用消息标识。`); onAuthError(e); } } finally { if (alive.current) setSending(false); }
  }
  async function loadEarlier(){
    const cursor=earlierCursor===undefined?page?.nextBefore:earlierCursor;
    if(!cursor||loadingHistory.current||!scrollArea.current)return;
    loadingHistory.current=true;setLoadingEarlier(true);nearBottom.current=false;
    const generation=historyGeneration.current;
    try{
      const result=await request<ChatPage>(`${pageUrl}&before=${segment(cursor)}`);
      if(!alive.current||generation!==historyGeneration.current||!scrollArea.current)return;
      historyAnchor.current={height:scrollArea.current.scrollHeight,top:scrollArea.current.scrollTop};
      setEarlier(items=>mergeChatHistory(result,items));setEarlierCursor(result.nextBefore);
    }catch(e){if(alive.current){setActionError(errorText(e));onAuthError(e);}}
    finally{loadingHistory.current=false;if(alive.current)setLoadingEarlier(false);}
  }
  function onTranscriptScroll(){
    const element=scrollArea.current;if(!element)return;
    nearBottom.current=isNearChatBottom(element);
    if(nearBottom.current)setNewContent(false);
    else if(element.scrollTop<120)void loadEarlier();
  }
  const history = mergeChatHistory(earlier, page ?? { messages: [], turns: [], chunks: [] }); const { messages } = history;
  retainedActive.current=[...messages.filter(message=>message.status==='streaming').map(message=>message.id.startsWith('stream:')||message.id.startsWith('run-stream:')?message.id:'message:'+message.id),...history.turns.filter(turn=>['queued','running','stopping'].includes(turn.status)).flatMap(turn=>['turn-status:'+turn.id,...turn.messageId?['message:'+turn.messageId]:[]])].slice(0,100);
  const stale = !!error || !!eventError || clock - observedAt > 15000;
  return <><div className="chat-transcript-scroll" ref={scrollArea} onScroll={onTranscriptScroll} tabIndex={0} aria-label="聊天记录"><div className="chat-transcript" ref={transcript}><span className="sr-only" role="status" aria-live="polite">{history.turns.length ? `最新回复状态：${turnLabel[history.turns[history.turns.length - 1].status]}` : '对话记录已载入'}</span><div className="chat-scope sr-only"><span className="eyebrow">{data.workspace.name}</span><span className="muted">单一接收者 · 历史由 Host 保存</span></div>{(error || actionError || eventError) && <div className="error-banner" role="status"><p>{actionError || error || eventError}</p><Button variant="secondary" className="secondary" onClick={() => void sync()}>重新同步</Button></div>}
    {(earlierCursor === undefined ? page?.nextBefore : earlierCursor) && <Button variant="secondary" className="secondary history-button" onClick={() => void loadEarlier()} disabled={loadingEarlier}>{loadingEarlier ? '正在读取…' : '读取更早消息'}</Button>}
    {!page ? <div className="loading">正在读取对话记录…</div> : !messages.length && !page.runMessages?.length ? <div className="live-chat-welcome"><span className="chat-monogram"><Icon name="skill" size={32} /></span><h1>今天，想一起完成什么？</h1><p>默认与主 Agent 讨论目标，使用 @ 选择其他成员。<br />代码执行会进入独立的任务流程。</p></div> : <ChatTimeline messages={messages} turns={history.turns} chunks={history.chunks} receipts={history.receipts} runMessages={page.runMessages} data={data} stale={stale} onStop={async turn => { try { await mutate(`/workspaces/${segment(data.workspace.id)}/turns/${segment(turn.id)}/stop`,csrf,{}); if(alive.current)await sync(); } catch(error) { if(alive.current){setError(errorText(error));onAuthError(error);} } }} />}
    <div ref={bottom} className="chat-bottom-anchor" /></div></div>
    {newContent && <Button variant="secondary" className="new-content secondary" onClick={jumpToLatest}>有新消息 · 跳至底部</Button>}
    <div className="composer-dock"><div className="composer-context"><Button variant="ghost" ref={recipientTrigger} className="chip recipient-button" aria-expanded={mentions} onClick={() => setMentions(v => !v)}>@ {chosen ? displayName(chosen) : '选择接收者'} <Icon name="chevron" size={14} /></Button><Button variant="ghost" ref={contextTrigger} className="chip recipient-button" aria-expanded={contextOpen} onClick={() => setContextOpen(value => !value)}><Icon name="branch" size={15} />上下文 · {contextRefs.length}</Button></div>{contextOpen && <fieldset className="context-picker" onKeyDown={e => { if(e.key === 'Escape') { e.stopPropagation(); setContextOpen(false); contextTrigger.current?.focus(); } }}><legend>当前工作区的任务与代码上下文（最多 20 项）</legend>{contexts.map(ref => { const checked = contextRefs.some(item => item.id === ref.id && item.type === ref.type); return <label key={`${ref.type}:${ref.id}`}><Checkbox  checked={checked} disabled={!checked && contextRefs.length >= 20} onCheckedChange={checked => selectContext({ type: ref.type, id: ref.id }, checked === true)} /><span>{ref.name}</span></label>; })}{!contexts.length && <p>还没有可引用的任务、仓库或工作目录。</p>}{contextRefs.filter(ref => !contexts.some(c => c.id === ref.id && c.type === ref.type)).map(ref => <Button variant="ghost" className="text-button" key={`${ref.type}:${ref.id}`} onClick={() => selectContext(ref, false)}>移除失效上下文 · {ref.id}</Button>)}</fieldset>}{mentions && <div className="mention-menu" onKeyDown={e => { if(e.key === 'Escape') { e.stopPropagation(); setMentions(false); recipientTrigger.current?.focus(); } }} aria-label="选择消息接收者">{data.roles.map(r => <Button variant="ghost" key={r.id} aria-pressed={recipient === r.id} className={recipient === r.id ? 'selected' : ''} onClick={() => chooseRecipient(r.id)} disabled={r.enabled === 0}><span>{displayName(r)}</span><span>{r.enabled === 0 ? '已停用' : r.kind === 'dsh-lead' ? '主 Agent' : '子 Agent'}</span></Button>)}</div>}<div className="composer live-composer"><label className="sr-only" htmlFor="live-draft">消息内容</label><Textarea id="live-draft" ref={composer} value={draft} maxLength={32000} disabled={sending} placeholder="输入消息，或用 @ 选择接收者…" onChange={e => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; setDraft(e.target.value); setSaved(saveDraft(data.workspace.id, e.target.value, conversationId)); if (e.target.value.endsWith('@') && !(e.nativeEvent as InputEvent).isComposing) setMentions(true); }} onKeyDown={e => { if (e.key === 'Escape') setMentions(false); if (shouldSendOnKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) { e.preventDefault(); void send(); } }} /><div className="composer-bottom"><span>{saved ? 'Ctrl / ⌘ + Enter 发送 · Enter 换行' : '浏览器无法保存草稿，请勿关闭此页'}</span><Button variant="default" className="send-button" aria-label={sending ? '正在发送' : '发送消息'} disabled={sending || !draft.trim() || !!disabledReason} onClick={() => void send()}><Icon name="up" /></Button></div></div><p className="composer-help">{disabledReason || '停止回复不会取消已登记的任务。每条消息仅投递给当前选定的成员。'}</p></div>
  </>;
}
