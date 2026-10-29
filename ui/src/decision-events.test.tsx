import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage, CoordinationReceipt, UiWorkspaceDetail } from '@rift/protocol';
import { ChatTimeline } from './ChatTimeline';
const data={workspace:{id:'ws'},roles:[],tasks:[{id:'task',title:'任务'}]} as unknown as UiWorkspaceDetail;
const input={id:'input',workspaceId:'ws',conversationId:'c',role:'user',content:'开始',createdAt:'2026-01-01',version:0,status:'completed',taskId:'task'} as ChatMessage;
it('hides only known routine events and leaves blockers, repair requests, unknown and decision events visible',()=>{
  const types=['source.collected','task.blocked','review.changes_requested','coordination.blocked','unknown.event','cleanup.failed'];
  const receipts=types.map((type,index)=>({id:`r${index}`,eventSeq:index,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:`2026-01-0${index+2}`,payload:{eventSeq:index,type,workflowId:'wf',taskId:'task',...(type==='coordination.blocked'?{reason:'需要用户确认，不得自动继续'}:{})}})) satisfies CoordinationReceipt[];
  const html=renderToStaticMarkup(<ChatTimeline messages={[input]} turns={[]} chunks={[]} receipts={receipts} data={data} stale={false} onStop={()=>{}}/>);
  const folded=html.match(/<details[^>]*>[\s\S]*?<\/details>/g)??[];
  expect(folded).toHaveLength(0);expect(html).not.toContain('例行协作进展');expect(html).not.toContain('系统：');
  for(const text of ['任务受阻','需要用户确认','清理失败']){expect(html).toContain(text);}
  expect(html).toContain('需要关注的协作事件');
});
it('does not collapse a routine event carrying a reason or erase a same-task later decision',()=>{
  const receipts=[1,2].map(eventSeq=>({id:`r${eventSeq}`,eventSeq,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:`2026-01-0${eventSeq+1}`,payload:{eventSeq,type:'source.collected',reason:`检查受阻 ${eventSeq}`,workflowId:'wf',taskId:'task'}}));
  const render=(values:CoordinationReceipt[])=>renderToStaticMarkup(<ChatTimeline messages={[input]} turns={[]} chunks={[]} receipts={values} data={data} stale={false} onStop={()=>{}}/>);
  expect(render(receipts)).toBe(render([...receipts].reverse()));expect(render(receipts)).not.toContain('<details');
  expect(render(receipts)).toContain('检查受阻 1');expect(render(receipts)).toContain('检查受阻 2');
});
it('hides routine progress for all tasks',()=>{
  const receipts=['task','other'].map((taskId,index)=>({id:`routine-${index}`,eventSeq:index,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:`2026-01-0${index+2}`,payload:{eventSeq:index,type:'source.collected',workflowId:'wf',taskId}}));
  const html=renderToStaticMarkup(<ChatTimeline messages={[input]} turns={[]} chunks={[]} receipts={receipts} data={data} stale={false} onStop={()=>{}}/>);
  expect(html).not.toContain('<details');expect(html).not.toContain('例行协作进展');expect(html).not.toContain('chat-notices');
});
it('shows the full structured public reason when the matching legacy message contains only a shortened summary',()=>{
  const reason='完整公开依据。'.repeat(60);
  const receipt={id:'full-reason',workspaceId:'ws',conversationId:'c',workflowId:'wf',eventSeq:9,createdAt:'2026-01-02',payload:{eventSeq:9,type:'source.collected',taskId:'task',workflowId:'wf',reason}};
  const notice={...input,id:'notice',role:'system',senderType:'system',kind:'receipt',dedupeKey:'event:9:c',content:'旧的简短摘要',createdAt:receipt.createdAt} as ChatMessage;
  const html=renderToStaticMarkup(<ChatTimeline messages={[input,notice]} turns={[]} chunks={[]} receipts={[receipt]} data={data} stale={false} onStop={()=>{}}/>);
  expect(html).toContain(reason);expect(html).toContain('旧的简短摘要');expect(html).not.toContain('<details');
  expect(html.match(/<li>/g)).toHaveLength(1);
});

it.each(['user','agent'] as const)('puts %s recipient at the beginning of the body, not the author heading',sender=>{
  const roles=[{id:'lead',displayName:'负责人'},{id:'dev',displayName:'开发者'}];
  const message={...input,senderType:sender,role:sender==='user'?'user':'assistant',senderAgentId:sender==='agent'?'lead':null,recipientAgentId:'dev',content:'请检查实现'} as ChatMessage;
  const html=renderToStaticMarkup(<ChatTimeline messages={[message]} turns={[]} chunks={[]} data={{...data,roles} as UiWorkspaceDetail} stale={false} onStop={()=>{}}/>);
  const heading=html.match(/<div class="message-heading">[\s\S]*?<\/div>/)?.[0];
  expect(heading).not.toContain('@');expect(html).toContain('class="message-mention"');
  expect(html.indexOf('@开发者')).toBeLessThan(html.indexOf('请检查实现'));
  expect(html).toContain('class="message-bubble"');expect(html).toContain('message-task-tags');
  expect(html).toContain(sender==='user'?'message user':'message assistant');
});
it('does not duplicate a recipient already written at the start of a message',()=>{
  const message={...input,recipientAgentId:'dev',content:'@开发者 请检查实现'};
  const html=renderToStaticMarkup(<ChatTimeline messages={[message]} turns={[]} chunks={[]} data={{...data,roles:[{id:'dev',displayName:'开发者'}]} as UiWorkspaceDetail} stale={false} onStop={()=>{}}/>);
  expect(html.match(/@开发者/g)).toHaveLength(1);
});
