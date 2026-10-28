import type { AgentTurn, ChatMessage, CoordinationReceipt, MessageChunk, RunStreamMessage, UiWorkspaceDetail } from '@rift/protocol';
import { buildConversationTimeline, messageAuthor, messageSender, type TimelineUpdate } from './chat-timeline';
import { receiptLabel } from './CoordinationReceipt';
import { MessageBody } from './MessageBody';
import { Button } from './components/ui/button';
import { Pill, time } from './App';
import { taskHref } from './state';
const labels:Record<AgentTurn['status'],string>={queued:'排队中',running:'正在回复',stopping:'正在停止',completed:'回复完成',failed:'回复失败',cancelled:'已停止',interrupted:'执行中断'};
export function ChatTimeline({messages,turns,chunks,receipts,runMessages,data,stale,onStop}:{messages:ChatMessage[];turns:AgentTurn[];chunks:MessageChunk[];receipts?:CoordinationReceipt[];runMessages?:RunStreamMessage[];data:UiWorkspaceDetail;stale:boolean;onStop:(turn:AgentTurn)=>void}) {
  const {items,loose,looseTurns}=buildConversationTimeline(messages,turns,chunks,receipts,runMessages);
  const name=(id:string|null|undefined)=>{const role=data.roles.find(role=>role.id===id);return role?.displayName??role?.name??'历史成员';};
  const updates=(values:TimelineUpdate[])=>{
    const important=values.filter(value=>!value.collapsible || !value.taskId);
    const groups=new Map<string,TimelineUpdate[]>();
    for(const value of values)if(value.collapsible && value.taskId)groups.set(value.taskId,[...(groups.get(value.taskId)??[]),value]);
    const list=(entries:TimelineUpdate[]) => <ul>{entries.map(value=><li key={value.id}>{value.senderAgentId ? `${name(value.senderAgentId)}：` : '系统：'}{value.type&&<strong>{receiptLabel(value.type)} · </strong>}{value.content}{value.taskId&&<> · <a href={taskHref(data.workspace.id,value.taskId)}>{data.tasks.find(task=>task.id===value.taskId)?.title??value.taskId}</a></>}</li>)}</ul>;
    return <>{important.length>0&&<div className="chat-notices" aria-label="需要关注的协作事件">{list(important)}</div>}{[...groups].map(([taskId,routine])=><details className="chat-progress" key={taskId}><summary>例行协作进展 · {data.tasks.find(task=>task.id===taskId)?.title??taskId} · {routine.length}</summary>{list(routine)}</details>)}</>;
  };
  const controls=(turn:AgentTurn)=>{
    const active=['queued','running','stopping'].includes(turn.status);
    if (!active && turn.status === 'completed' && turn.cleanupStatus !== 'unknown' && !turn.error) return null;
    return <div className="turn-state" key={turn.id}>{active && <><Pill active={!stale&&turn.status==='running'}>{stale?'上次状态：':''}{labels[turn.status]}</Pill><Button variant="ghost" className="text-button" disabled={turn.status==='stopping'} onClick={()=>onStop(turn)}>停止这次回复</Button></>}{turn.cleanupStatus==='unknown'&&<span className="muted">清理待确认，执行资源已保留。</span>}{!active&&turn.status!=='completed'&&<span className="muted">{labels[turn.status]} · 本轮未完成</span>}{turn.error&&<p className="form-error preserve-lines">{turn.error}</p>}</div>;
  };
  return <section className="message-list" aria-label="对话消息">{items.map(item=>{
    const message=item.message,sender=messageSender(message),author=sender==='user'?'你':name(messageAuthor(message));
    return <article className={`message ${sender==='user'?'user':'assistant'}`} key={message.id}>
      <div className="message-heading"><span className="message-avatar">{sender==='user'?'我':author.slice(0,1)}</span><strong>{author}</strong>{message.recipientAgentId&&<span className="message-recipient">@{name(message.recipientAgentId)}</span>}<time>{time(message.createdAt)}</time></div>
      <MessageBody text={message.content}/>
      {message.deliveryStatus && <small className="muted">{message.deliveryStatus==='pending'?(message.deliveryScope==='task'?'等待下一次任务输入':'等待成员处理'):message.deliveryStatus==='delivered'?'已投递，等待处理':message.deliveryStatus==='consumed'?(message.deliveryScope==='task'?'已纳入任务输入':'已处理'):message.deliveryStatus==='interrupted'?'投递执行中断，等待核查':'投递未完成'}</small>}
      {message.deliveryReason && ['failed','interrupted'].includes(message.deliveryStatus??'') && <p className="form-error preserve-lines">{message.deliveryReason}</p>}
      {sender==='agent'&&message.status!=='completed'&&<small className="muted">{message.status==='streaming'?(stale?'连接待同步':'正在输出…'):'未完成回复'}</small>}
      {item.taskIds.length>0&&<div className="message-task-tags">{item.taskIds.map(taskId=><a className="chip task-tag" key={taskId} href={taskHref(data.workspace.id,taskId)}>{data.tasks.find(task=>task.id===taskId)?.title??'查看关联任务'}<span aria-hidden="true"> ↗</span></a>)}</div>}
      {item.turns.flatMap(turn=>turn.configuration?.request?.contextRefs??[]).filter(ref=>ref.type!=='task').map(ref=><span className="chip" key={`${ref.type}:${ref.id}`}>{ref.type==='repository'?'参考仓库':'参考工作目录'} · {ref.id}</span>)}
      {updates(item.updates)}{item.turns.map(controls)}
    </article>;
  })}{updates(loose)}{looseTurns.map(controls)}</section>;
}
