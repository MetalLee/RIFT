import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyMessageEvent } from './stream-state';
import { ChatTimeline } from './ChatTimeline';
import { buildChatTimeline, buildConversationTimeline } from './chat-timeline';
import { mergeChatHistory } from './chat-state';
import type { AgentTurn, ChatMessage, ChatPage, StreamMessage } from '../../src/chat/contracts';
import type { WorkspaceEvent } from '../../src/events/workspace-events';
import type { UiWorkspaceDetail } from '../../src/api/ui-contracts';

const user:ChatMessage={id:'user',workspaceId:'ws',conversationId:'conversation',clientMessageId:'client',recipientAgentId:'lead',role:'user',content:'Inspect',status:'completed',version:0,createdAt:'2026-10-27T12:00:00Z'};
const turn={id:'turn',messageId:'user',workspaceId:'ws',conversationId:'conversation',agentId:'lead',status:'running',version:0,phase:'generating',createdAt:user.createdAt,configuration:{},streamMessages:[]} as unknown as AgentTurn;
const initial:ChatPage={conversation:{id:'conversation',workspaceId:'ws',title:'Test',version:0,createdAt:user.createdAt},messages:[user],turns:[turn],chunks:[],nextBefore:null,snapshotCursor:10};
function messageEvent(seq:number,offset:number,delta:string,version=seq,extra:Partial<StreamMessage>={}):WorkspaceEvent {
  return {seq,workspaceId:'ws',type:'turn.message',entityId:'turn',entityVersion:0,occurredAt:user.createdAt,payload:{conversationId:'conversation',turnVersion:seq,message:{seq:1,turnId:'turn',messageId:'pre',kind:'commentary',status:'streaming',version,createdAt:user.createdAt,updatedAt:user.createdAt,...extra},offset,delta,replace:false}};
}

describe('chat stream projection and rendering',()=>{
  it('applies Chinese/English deltas once and recovers a missing prefix through a snapshot',()=>{
    const one=messageEvent(11,0,'我先检查 API。');
    const page=applyMessageEvent(initial,one)!;
    expect(page.turns[0]!.streamMessages![0]!.text).toBe('我先检查 API。');
    expect(applyMessageEvent(page,one)).toBe(page);
    expect(applyMessageEvent(initial,messageEvent(12,20,'missing'))).toBeUndefined();
    const two=messageEvent(12,'我先检查 API。'.length,' Checking progress.');
    const continued=applyMessageEvent(page,two)!;
    expect(continued.turns[0]!.streamMessages![0]!.text).toBe('我先检查 API。 Checking progress.');
    expect(mergeChatHistory(initial,continued).turns[0]!.streamMessages).toEqual(continued.turns[0]!.streamMessages);
    expect(applyMessageEvent(continued,messageEvent(13,0,'foreign',13,{turnId:'foreign'}))?.turns[0]?.streamMessages?.at(-1)?.turnId).not.toBe('foreign');
  });

  it('renders interim text as a peer assistant message without execution logs',()=>{
    let page=applyMessageEvent(initial,messageEvent(11,0,'我先检查代码。',0,{status:'completed'}))!;
    const activity={seq:1,turnId:'turn',type:'tool.started',phase:'tool',toolName:'exec_command',toolCallId:'call',summary:'开始调用 exec_command',payload:{},createdAt:user.createdAt};
    page=applyMessageEvent(page,{seq:12,workspaceId:'ws',type:'turn.activity',entityId:'turn',entityVersion:0,occurredAt:user.createdAt,payload:{turnVersion:12,activity}})!;
    expect(page.turns[0]!.currentToolName).toBe('exec_command');
    const data={workspace:{id:'ws'},roles:[{id:'lead',displayName:'主 Agent'}],tasks:[]} as unknown as UiWorkspaceDetail;
    const html=renderToStaticMarkup(<ChatTimeline messages={page.messages} turns={page.turns} chunks={[]} data={data} stale={false} onStop={()=>{}}/>);
    expect(html).toContain('我先检查代码。');
    expect(html.match(/<article/g)).toHaveLength(2);
    for(const text of ['进展说明','执行活动','exec_command','工具执行中','message-draft'])expect(html).not.toContain(text);
    const final={...user,id:'final',role:'assistant',senderType:'agent',senderAgentId:'lead',recipientAgentId:null,sourceTurnId:'turn',content:'检查完成。'} as ChatMessage;
    const streamedAnswer={seq:2,turnId:'turn',messageId:'answer',kind:'final',text:final.content,status:'completed',version:0,createdAt:user.createdAt,updatedAt:user.createdAt} as StreamMessage;
    const settled={...page.turns[0]!,status:'completed',streamMessages:[...page.turns[0]!.streamMessages!,streamedAnswer]} as AgentTurn;
    const timeline=buildChatTimeline([...page.messages,final],[settled],[]);
    expect(timeline.items.flatMap(item=>item.drafts).map(message=>message.text)).toEqual(['我先检查代码。']);
    const finalHtml=renderToStaticMarkup(<ChatTimeline messages={[...page.messages,final]} turns={[settled]} chunks={[]} data={data} stale={false} onStop={()=>{}}/>);
    expect(finalHtml.indexOf('我先检查代码。')).toBeLessThan(finalHtml.indexOf('检查完成。'));
    expect(finalHtml.split('检查完成。')).toHaveLength(2);
  });

  it.each(['reasoning','reasoning_summary'] as const)('renders %s directly as conversation text in both languages',kind=>{
    const data={workspace:{id:'ws'},roles:[{id:'lead',displayName:'主 Agent'}],tasks:[]} as unknown as UiWorkspaceDetail;
    for (const text of ['需要比较两处调用的结果。','The two call results need to be compared.']) {
      const page=applyMessageEvent(initial,messageEvent(11,0,text,11,{kind}))!;
      const html=renderToStaticMarkup(<ChatTimeline messages={page.messages} turns={page.turns} chunks={[]} data={data} stale={false} onStop={()=>{}}/>);
      expect(html).toContain(text);
      expect(html.match(/<article/g)).toHaveLength(2);
      expect(html).not.toContain('<details');
      expect(html).not.toContain('阶段输出');
      const rows=buildConversationTimeline(page.messages,page.turns,[]).items;
      expect(rows.map(row=>row.message.senderType??row.message.role)).toEqual(['user','agent']);
      expect(rows[1]!.message.senderAgentId).toBe('lead');
      expect(rows[0]!.turns).toHaveLength(0);
      expect(rows[1]!.turns).toHaveLength(1);
    }
  });

  it('retains interrupted messages and accepts authoritative replacement text',()=>{
    const page=applyMessageEvent(initial,messageEvent(11,0,'Partial output.'))!;
    const event=messageEvent(12,0,'Reconciled.',12,{status:'interrupted'});event.payload.replace=true;
    const interrupted=applyMessageEvent(page,event)!;
    expect(interrupted.turns[0]!.streamMessages![0]).toMatchObject({text:'Reconciled.',status:'interrupted'});
  });
});


it('records a late tool fact without regressing a settled phase or inventing a newer version',()=>{
  const page={...initial,turns:[{...turn,status:'cancelled',phase:'settled',version:20} as AgentTurn]};
  const activity={seq:2,turnId:'turn',type:'tool.completed',phase:'cleanup',toolName:'exec_command',toolCallId:'call',summary:'Tool returned late',payload:{},createdAt:user.createdAt};
  const updated=applyMessageEvent(page,{seq:30,workspaceId:'ws',type:'turn.activity',entityId:'turn',entityVersion:0,occurredAt:user.createdAt,payload:{turnVersion:20,updatesPhase:0,activity}})!;
  expect(updated.turns[0]).toMatchObject({status:'cancelled',phase:'settled',version:20});
  expect(updated.turns[0]!.activities).toHaveLength(1);
});
