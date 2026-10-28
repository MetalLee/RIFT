import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage, CoordinationReceipt, UiWorkspaceDetail } from '@rift/protocol';
import { ChatTimeline } from './ChatTimeline';
const data={workspace:{id:'ws'},roles:[],tasks:[{id:'task',title:'任务'}]} as unknown as UiWorkspaceDetail;
const input={id:'input',workspaceId:'ws',conversationId:'c',role:'user',content:'开始',createdAt:'2026-01-01',version:0,status:'completed',taskId:'task'} as ChatMessage;
it('collapses only known routine events and leaves blockers, repair requests, unknown and decision events visible',()=>{
  const types=['source.collected','task.blocked','review.changes_requested','coordination.blocked','unknown.event','cleanup.failed'];
  const receipts=types.map((type,index)=>({id:`r${index}`,eventSeq:index,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:`2026-01-0${index+2}`,payload:{eventSeq:index,type,workflowId:'wf',taskId:'task',...(type==='coordination.blocked'?{reason:'需要用户确认，不得自动继续'}:{})}})) satisfies CoordinationReceipt[];
  const html=renderToStaticMarkup(<ChatTimeline messages={[input]} turns={[]} chunks={[]} receipts={receipts} data={data} stale={false} onStop={()=>{}}/>);
  const folded=html.match(/<details[^>]*>[\s\S]*?<\/details>/g)??[];
  expect(folded).toHaveLength(1);expect(folded[0]).toContain('例行协作进展');
  for(const text of ['任务受阻','需要用户确认','清理失败']){expect(html).toContain(text);expect(folded[0]).not.toContain(text);}
  expect(html).toContain('需要关注的协作事件');
});
it('does not collapse a routine event carrying a reason or erase a same-task later decision',()=>{
  const receipts=[1,2].map(eventSeq=>({id:`r${eventSeq}`,eventSeq,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:`2026-01-0${eventSeq+1}`,payload:{eventSeq,type:'source.collected',reason:`检查受阻 ${eventSeq}`,workflowId:'wf',taskId:'task'}}));
  const render=(values:CoordinationReceipt[])=>renderToStaticMarkup(<ChatTimeline messages={[input]} turns={[]} chunks={[]} receipts={values} data={data} stale={false} onStop={()=>{}}/>);
  expect(render(receipts)).toBe(render([...receipts].reverse()));expect(render(receipts)).not.toContain('<details');
  expect(render(receipts)).toContain('检查受阻 1');expect(render(receipts)).toContain('检查受阻 2');
});
it('groups routine progress by task, never merging different tasks into one collapsed group',()=>{
  const receipts=['task','other'].map((taskId,index)=>({id:`routine-${index}`,eventSeq:index,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:`2026-01-0${index+2}`,payload:{eventSeq:index,type:'source.collected',workflowId:'wf',taskId}}));
  const html=renderToStaticMarkup(<ChatTimeline messages={[input]} turns={[]} chunks={[]} receipts={receipts} data={data} stale={false} onStop={()=>{}}/>);
  expect(html.match(/<details/g)).toHaveLength(2);expect(html).toContain('例行协作进展 · 任务');expect(html).toContain('例行协作进展 · other');
});
