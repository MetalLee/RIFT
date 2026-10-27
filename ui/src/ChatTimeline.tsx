import { TurnDetails, turnPhaseLabel } from './TurnDetails';
import type { TimelineItem } from './chat-timeline';
import type { AgentTurn, ChatMessage, CoordinationReceipt, MessageChunk } from '../../src/chat/contracts';
import type { UiWorkspaceDetail } from '../../src/api/ui-contracts';
import { buildChatTimeline, messageAuthor, messageSender, type TimelineUpdate } from './chat-timeline';
import { receiptLabel } from './CoordinationReceipt';
import { MessageBody } from './MessageBody';
import { Button } from './components/ui/button';
import { Pill, time } from './App';
import { taskHref } from './state';
const labels:Record<AgentTurn['status'],string>={queued:'排队中',running:'正在回复',stopping:'正在停止',completed:'回复完成',failed:'回复失败',cancelled:'已停止',interrupted:'执行中断'};
export function ChatTimeline({messages,turns,chunks,receipts,data,stale,onStop}:{messages:ChatMessage[];turns:AgentTurn[];chunks:MessageChunk[];receipts?:CoordinationReceipt[];data:UiWorkspaceDetail;stale:boolean;onStop:(turn:AgentTurn)=>void}) {
  const {items,loose,looseTurns}=buildChatTimeline(messages,turns,chunks,receipts);
  const name=(id:string|null|undefined)=>{const role=data.roles.find(role=>role.id===id);return role?.displayName??role?.name??'历史成员';};
  const updates=(values:TimelineUpdate[])=>values.length>0 && <details className="chat-progress"><summary>协作进展 · {values.length}</summary><ul>{values.map(value=><li key={value.id}>{value.senderAgentId ? `${name(value.senderAgentId)}：` : '系统：'}{value.type?receiptLabel(value.type):value.content}</li>)}</ul></details>;
  const controls=(turn:AgentTurn)=>{
    const active=['queued','running','stopping'].includes(turn.status);
    return <div className="turn-state" key={turn.id}>{active && <><Pill active={!stale&&turn.status==='running'}>{stale?'上次状态：':''}{turnPhaseLabel(turn)}</Pill><Button variant="ghost" className="text-button" disabled={turn.status==='stopping'} onClick={()=>onStop(turn)}>停止这次回复</Button></>}{turn.cleanupStatus==='unknown'&&<span className="muted">清理待确认，执行资源已保留。</span>}{!active&&turn.status!=='completed'&&<span className="muted">{labels[turn.status]} · 本轮未完成</span>}<TurnDetails turn={turn} view="chat"/>{turn.error&&<details className="chat-progress"><summary>查看原因</summary><p>{turn.error}</p></details>}</div>;
  };
  const stream = (item: TimelineItem) => item.drafts.map(({turn,text,messageId,kind,status}) => {
    const label = status === 'interrupted' ? '未完成输出' : kind === 'commentary' ? '进展说明' : kind === 'reasoning_summary' ? '思考摘要' : kind === 'final' ? '回答' : '阶段输出';
    const body = <><div className="message-heading"><strong>{name(turn.agentId)}</strong><span>{label}</span></div><MessageBody text={text}/></>;
    return kind === 'reasoning_summary' ? <details className="message-draft" key={`${turn.id}:${messageId??'draft'}`}><summary>{label}</summary>{body}</details> : <div className="message-draft" key={`${turn.id}:${messageId??'draft'}`}>{body}</div>;
  });
  return <section className="message-list" aria-label="对话消息">{items.map(item=>{
    const message=item.message,sender=messageSender(message),author=sender==='user'?'你':name(messageAuthor(message));
    return <article className={`message ${sender==='user'?'user':'assistant'}`} key={message.id}>
      <div className="message-heading"><span className="message-avatar">{sender==='user'?'我':author.slice(0,1)}</span><strong>{author}</strong>{message.recipientAgentId&&<span className="message-recipient">@{name(message.recipientAgentId)}</span>}<time>{time(message.createdAt)}</time></div>
      {sender==='agent'&&stream(item)}
      <MessageBody text={message.content}/>
      {message.deliveryStatus && <small className="muted">{message.deliveryStatus==='pending'?(message.deliveryScope==='task'?'等待下一次任务输入':'等待成员处理'):message.deliveryStatus==='delivered'?'已投递，等待处理':message.deliveryStatus==='consumed'?(message.deliveryScope==='task'?'已纳入任务输入':'已处理'):message.deliveryStatus==='interrupted'?'投递执行中断，等待核查':'投递未完成'}</small>}
      {message.deliveryReason && ['failed','interrupted'].includes(message.deliveryStatus??'') && <details className="chat-progress"><summary>查看投递原因</summary><p>{message.deliveryReason}</p></details>}
      {sender==='agent'&&message.status!=='completed'&&<small className="muted">未完成回复</small>}
      {item.taskIds.length>0&&<div className="message-task-tags">{item.taskIds.map(taskId=><a className="chip task-tag" key={taskId} href={taskHref(data.workspace.id,taskId)}>{data.tasks.find(task=>task.id===taskId)?.title??'查看关联任务'}<span aria-hidden="true"> ↗</span></a>)}</div>}
      {item.turns.flatMap(turn=>turn.configuration?.request?.contextRefs??[]).filter(ref=>ref.type!=='task').map(ref=><span className="chip" key={`${ref.type}:${ref.id}`}>{ref.type==='repository'?'参考仓库':'参考工作目录'} · {ref.id}</span>)}
      {updates(item.updates)}{item.turns.map(controls)}
      {sender!=='agent'&&stream(item)}
    </article>;
  })}{updates(loose)}{looseTurns.map(controls)}</section>;
}
