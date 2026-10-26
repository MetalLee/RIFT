import { describe,expect,it } from 'vitest';
import { buildChatTimeline,messageAuthor,messageSender } from './chat-timeline';
import { taskHref,parseRoute } from './state';
import type { AgentTurn,ChatMessage,MessageChunk } from '../../src/chat/contracts';
const message=(id:string,extra:Partial<ChatMessage>={}):ChatMessage=>({id,workspaceId:'ws',conversationId:'c',clientMessageId:null,recipientAgentId:'lead',role:'user',senderType:'user',content:id,status:'completed',version:0,createdAt:'2026-01-01',...extra});
const turn={id:'turn',messageId:'input',agentId:'lead',status:'running',createdAt:'2026-01-01',activities:[{payload:{taskId:'task-a'}}]} as unknown as AgentTurn;
describe('conversation author and attached work',()=>{
  it('uses sender identity separately from @recipient and roundtrips a specific task deep link',()=>{
    const value=message('delegation',{role:'assistant',senderType:'agent',senderAgentId:'lead',recipientAgentId:'developer',taskId:'a/b#c'});
    expect(messageSender(value)).toBe('agent');expect(messageAuthor(value)).toBe('lead');
    expect(parseRoute(taskHref('团队/ws','a/b#c'))).toEqual({workspaceId:'团队/ws',page:'tasks',taskId:'a/b#c'});
  });
  it('places progress and the task tag under the matching delegation, not an unrelated newer message',()=>{
    const delegated=message('delegation',{role:'assistant',senderType:'agent',senderAgentId:'lead',recipientAgentId:'developer',taskId:'task-a'});
    const result=buildChatTimeline([delegated,message('other'),message('progress',{senderType:'agent',role:'assistant',senderAgentId:'developer',kind:'progress',taskId:'task-a',content:'Checking'})],[],[]);
    expect(result.items).toHaveLength(2);expect(result.items[0]!.taskIds).toEqual(['task-a']);expect(result.items[0]!.updates[0]?.content).toBe('Checking');expect(result.items[1]!.updates).toEqual([]);
  });
  it('merges draft chunks by monotonic seq and replaces the draft with its final sourceTurnId message',()=>{
    const chunks=[{seq:2,turnId:'turn',text:'world'},{seq:1,turnId:'turn',text:'hello '},{seq:1,turnId:'turn',text:'hello '}] as MessageChunk[];
    const draft=buildChatTimeline([message('input')],[turn],chunks);expect(draft.items[0]!.drafts[0]?.text).toBe('hello world');
    const final=message('final',{role:'assistant',senderType:'agent',senderAgentId:'lead',recipientAgentId:null,sourceTurnId:'turn',content:'hello world'});
    const settled=buildChatTimeline([message('input'),final],[{...turn,status:'completed'}],chunks);
    expect(settled.items.flatMap(item=>item.drafts)).toEqual([]);expect(settled.items[1]!.taskIds).toEqual(['task-a']);
  });
  it('retains cancelled drafts as unfinished records rather than completed messages',()=>{
    const result=buildChatTimeline([message('input')],[{...turn,status:'cancelled'}],[{seq:1,turnId:'turn',text:'partial'} as MessageChunk]);
    expect(result.items[0]!.drafts[0]?.turn.status).toBe('cancelled');expect(result.items).toHaveLength(1);
  });
});
