import React from 'react';
import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {buildConversationTimeline} from './chat-timeline';
import {ChatTimeline} from './ChatTimeline';
import {applyMessageEvent} from './stream-state';
import type {ChatMessage,ChatPage,RunStreamMessage} from '@rift/protocol';
import type {UiWorkspaceDetail} from '@rift/protocol';
import type {WorkspaceEvent} from '@rift/protocol';
const data={workspace:{id:'ws'},roles:[{id:'dev',name:'frontend-developer',displayName:'前端开发'},{id:'lead',name:'lead'}],tasks:[{id:'task',title:'前端审计'}]} as UiWorkspaceDetail;
const run={seq:1,runId:'run',messageId:'m',taskId:'task',roleId:'dev',workspaceId:'ws',conversationId:'conversation',kind:'commentary',text:'正在检查前端入口。',status:'streaming',version:0,createdAt:'2026-10-28T00:00:02Z',updatedAt:'2026-10-28T00:00:02Z'} satisfies RunStreamMessage;
const lead={id:'lead-message',workspaceId:'ws',conversationId:'conversation',role:'assistant',senderType:'agent',senderAgentId:'lead',content:'请开始检查。',status:'completed',version:0,createdAt:'2026-10-28T00:00:01Z',clientMessageId:null,recipientAgentId:null} as ChatMessage;
describe('shared conversation run output',()=>{
 it('interleaves Lead and child messages with their own identity, without progress cards',()=>{
  const timeline=buildConversationTimeline([lead],[],[],[],[run]);
  expect(timeline.items.map(i=>i.message.senderAgentId)).toEqual(['lead','dev']);
  const html=renderToStaticMarkup(<ChatTimeline messages={[lead]} turns={[]} chunks={[]} runMessages={[run]} data={data} stale={false} onStop={()=>{}}/>);
  for(const text of ['前端开发','正在检查前端入口。','正在输出…'])expect(html).toContain(text);
  expect(html).not.toContain('run-progress-card');expect(html).not.toContain('子 agent 执行进度');
 });
 it('keeps public child progress as its own conversation message',()=>{
  const message={...lead,id:'progress',senderAgentId:'dev',kind:'progress',content:'正在核对调用关系。'} as ChatMessage;
  const timeline=buildConversationTimeline([message],[],[]);
  expect(timeline.items).toHaveLength(1);expect(timeline.items[0]!.message.senderAgentId).toBe('dev');expect(timeline.loose).toEqual([]);
  const html=renderToStaticMarkup(<ChatTimeline messages={[message]} turns={[]} chunks={[]} data={data} stale={false} onStop={()=>{}}/>);
  expect(html).not.toContain('执行进展');expect(html).toContain('正在核对调用关系。');
 });
 it('applies replay deltas once, rejects gaps and foreign ownership, and preserves partial output',()=>{
  const page={conversation:{id:'conversation',workspaceId:'ws',title:'Room',version:0,createdAt:'now'},messages:[lead],turns:[],chunks:[],runMessages:[run],snapshotCursor:1,nextBefore:null} satisfies ChatPage;
  const event={seq:2,type:'run.message',entityId:'run',payload:{conversationId:'conversation',message:{...run,text:undefined,version:1,status:'interrupted'},offset:run.text.length,delta:'连接中断前的内容。',replace:false}} as unknown as WorkspaceEvent;
  const next=applyMessageEvent(page,event)!;
  expect(next.runMessages![0]!.text).toBe(run.text+'连接中断前的内容。');expect(next.runMessages![0]!.status).toBe('interrupted');
  expect(applyMessageEvent(next,event)).toBe(next);
  expect(applyMessageEvent(page,{...event,payload:{...event.payload,offset:999}})).toBeUndefined();
  expect(applyMessageEvent(page,{...event,payload:{...event.payload,conversationId:'foreign'}})).toBe(page);
  expect(applyMessageEvent(page,{...event,payload:{...event.payload,message:{...run,workspaceId:'foreign'}}})).toBeUndefined();
  const html=renderToStaticMarkup(<ChatTimeline messages={[lead]} turns={[]} chunks={[]} runMessages={next.runMessages} data={data} stale={false} onStop={()=>{}}/>);
  expect(html).toContain('连接中断前的内容。');expect(html).toContain('未完成回复');
 });
 it('renders structured task summaries without changing the stored final result',()=>{
  const final={...run,kind:'final',status:'completed',text:JSON.stringify({schemaVersion:1,runId:'run',summary:'审计已完成。'})} as RunStreamMessage;
  expect(buildConversationTimeline([],[],[],[],[final]).items[0]?.message.content).toBe('审计已完成。');
 });
});
