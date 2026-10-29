import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage, CoordinationReceipt, UiWorkspaceDetail } from '@rift/protocol';
import { ChatTimeline } from './ChatTimeline';
const data={workspace:{id:'ws'},roles:[],tasks:[{id:'task',title:'任务'}]} as unknown as UiWorkspaceDetail;
const input={id:'input',workspaceId:'ws',conversationId:'c',role:'user',content:'开始',createdAt:'2026-01-01',version:0,status:'completed',taskId:'task'} as ChatMessage;
it('hides all workflow/system receipts, including blockers and automatic turn limits',()=>{
 const types=['dispatch.queued','task.blocked','coordination.blocked','unknown.event','cleanup.failed'];
 const receipts=types.map((type,index)=>({id:'r'+index,eventSeq:index,workspaceId:'ws',conversationId:'c',workflowId:'wf',createdAt:'2026-01-02',payload:{eventSeq:index,type,taskId:'task',workflowId:'wf',reason:'成员自动对话达到本轮限制'}}));
 const notice={...input,id:'notice',role:'system',senderType:'system',kind:'receipt',content:'任务已入队，流程事件'} as ChatMessage;
 const html=renderToStaticMarkup(<ChatTimeline messages={[input,notice]} turns={[]} chunks={[]} receipts={receipts} data={data} stale={false} onStop={()=>{}}/>);
 for(const text of ['系统：','例行协作进展','任务已入队','成员自动对话达到本轮限制','流程事件','chat-notices'])expect(html).not.toContain(text);
 expect(html).toContain('开始');expect(html).toContain('task-tag');
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
