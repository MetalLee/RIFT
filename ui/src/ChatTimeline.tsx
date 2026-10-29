import type { AgentTurn, ChatMessage, CoordinationReceipt, MessageChunk, RunStreamMessage, UiWorkspaceDetail } from '@rift/protocol';
import { buildConversationTimeline, messageAuthor, messageSender } from './chat-timeline';
import { MessageBody } from './MessageBody';
import { Button } from './components/ui/button';
import { time } from './App';
import { taskHref } from './state';
export function ChatTimeline({messages,turns,chunks,receipts,runMessages,data,stale,onStop}:{messages:ChatMessage[];turns:AgentTurn[];chunks:MessageChunk[];receipts?:CoordinationReceipt[];runMessages?:RunStreamMessage[];data:UiWorkspaceDetail;stale:boolean;onStop:(turn:AgentTurn)=>void}) {
  const {items,looseTurns}=buildConversationTimeline(messages,turns,chunks,receipts,runMessages);
  const name=(id:string|null|undefined)=>{const role=data.roles.find(role=>role.id===id);return role?.displayName??role?.name??'历史成员';};
  // Workflow/coordination receipts remain in task/activity views, never in chat.
  const controls=(turn:AgentTurn)=>['queued','running','stopping'].includes(turn.status)
    ? <div className="turn-state" key={turn.id}><Button variant="ghost" className="text-button" disabled={turn.status==='stopping'} onClick={()=>onStop(turn)}>停止这次回复</Button></div> : null;
  return <section className="message-list" aria-label="对话消息">{items.map(item=>{
    const message=item.message,sender=messageSender(message),author=sender==='user'?'你':name(messageAuthor(message));
    const recipient=message.recipientAgentId && (sender==='user' || message.recipientAgentId!==messageAuthor(message)) ? name(message.recipientAgentId) : undefined;
    const recipientRole=data.roles.find(role=>role.id===message.recipientAgentId);
    const alreadyMentioned=[recipient,recipientRole?.name].filter(Boolean).some(label=>{
      const prefix='@'+label,content=message.content.trimStart();
      return content.startsWith(prefix) && (content.length===prefix.length || /\s/.test(content[prefix.length]!));
    });
    return <article className={`message ${sender==='user'?'user':'assistant'}`} key={message.id}>
      <div className="message-heading"><span className="message-avatar">{sender==='user'?'我':author.slice(0,1)}</span><strong>{author}</strong><time>{time(message.createdAt)}</time></div>
      <div className="message-body"><div className="message-bubble"><MessageBody text={message.content} mention={alreadyMentioned?undefined:recipient}/>
      {item.taskIds.length>0&&<div className="message-task-tags">{item.taskIds.map(taskId=><a className="chip task-tag" key={taskId} href={taskHref(data.workspace.id,taskId)}>{data.tasks.find(task=>task.id===taskId)?.title??'查看关联任务'}<span aria-hidden="true"> ↗</span></a>)}</div>}
      </div>
      {item.turns.flatMap(turn=>turn.configuration?.request?.contextRefs??[]).filter(ref=>ref.type!=='task').map(ref=><span className="chip" key={`${ref.type}:${ref.id}`}>{ref.type==='repository'?'参考仓库':'参考工作目录'} · {ref.id}</span>)}
      {item.turns.map(controls)}</div>
    </article>;
  })}{looseTurns.map(controls)}</section>;
}
