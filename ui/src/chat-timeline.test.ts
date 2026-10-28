import { describe,expect,it } from 'vitest';
import { buildChatTimeline,buildConversationTimeline,messageAuthor,messageSender } from './chat-timeline';
import { taskHref,parseRoute } from './state';
import type { AgentTurn,ChatMessage,MessageChunk,StreamMessage } from '@rift/protocol';
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
    expect(result.items).toHaveLength(2);expect(result.items.find(item=>item.message.id==='delegation')!.taskIds).toEqual(['task-a']);expect(result.items.find(item=>item.message.id==='delegation')!.updates[0]?.content).toBe('Checking');expect(result.items.find(item=>item.message.id==='other')!.updates).toEqual([]);
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
  it('keeps interleaved turns in generation order before and after their final snapshots',()=>{
    const stream=(id:string,time:string,kind:StreamMessage['kind']='reasoning_summary'):StreamMessage=>({seq:Number(id),turnId:'turn',messageId:id,kind,text:`text-${id}`,status:'completed',version:0,createdAt:time,updatedAt:time});
    const first=message('input',{createdAt:'2026-01-01T00:00:00Z'});
    const second=message('second',{createdAt:'2026-01-01T00:00:02Z'});
    const live={...turn,activities:[],streamMessages:[stream('1','2026-01-01T00:00:01Z'),stream('2','2026-01-01T00:00:03Z','commentary')]};
    const ongoing=buildConversationTimeline([first,second],[live],[]).items;
    expect(ongoing.map(row=>row.message.content)).toEqual(['input','text-1','second','text-2']);
    const final=message('final',{role:'assistant',senderType:'agent',senderAgentId:'lead',recipientAgentId:null,sourceTurnId:'turn',createdAt:'2026-01-01T00:00:05Z',content:'Done'});
    const settled=buildConversationTimeline([first,second,final],[{...live,status:'completed'}],[]).items;
    expect(settled.map(row=>row.message.content)).toEqual(['input','text-1','second','text-2','Done']);
    expect(settled[1]!.message.id).toBe(ongoing[1]!.message.id);
  });

  it('reconciles the final reply in place and retains an abandoned attempt',()=>{
    const start='2026-01-01T00:00:01Z',later='2026-01-01T00:00:02Z';
    const streamed=(id:string,status:StreamMessage['status']):StreamMessage=>({seq:1,turnId:'turn',messageId:id,kind:'final',text:id,status,version:0,createdAt:start,updatedAt:start});
    const live={...turn,activities:[],streamMessages:[streamed('abandoned','interrupted'),streamed('answer','completed')]};
    const input=message('input',{createdAt:'2026-01-01T00:00:00Z'}),next=message('next',{createdAt:later});
    const ongoing=buildConversationTimeline([input,next],[live],[]).items;
    const final=message('final',{role:'assistant',senderType:'agent',senderAgentId:'lead',recipientAgentId:null,sourceTurnId:'turn',content:'answer',createdAt:'2026-01-01T00:00:03Z'});
    const settled=buildConversationTimeline([input,next,final],[{...live,status:'completed'}],[]).items;
    expect(settled.map(row=>[row.message.id,row.message.content])).toEqual(ongoing.map(row=>[row.message.id,row.message.content]));
    expect(settled[1]!.message.status).toBe('interrupted');
  });

});

it('deduplicates versioned messages and decision receipts by identity, independent of replay order',()=>{
  const input=message('input',{createdAt:'2026-01-01T00:00:00Z',taskId:'task-a'});
  const old=message('notice',{senderType:'system',role:'system',kind:'receipt',version:0,content:'old',taskId:'task-a',dedupeKey:'event:7:c',createdAt:'2026-01-01T00:00:02Z'});
  const current={...old,version:1,content:'需要用户决定是否继续'};
  const decision={id:'decision',workspaceId:'ws',conversationId:'c',workflowId:'wf',eventSeq:7,payload:{eventSeq:7,type:'coordination.blocked',reason:'COORDINATION_AUTOMATIC_BUDGET',workflowId:'wf',taskId:'task-a'},createdAt:current.createdAt};
  const routine={...decision,id:'routine',eventSeq:6,payload:{eventSeq:6,type:'source.collected',workflowId:'wf',taskId:'task-a'},createdAt:'2026-01-01T00:00:01Z'};
  const one=buildChatTimeline([input,old,current],[],[],[decision,routine,decision]);
  const replay=buildChatTimeline([current,input,old],[],[],[routine,decision]);
  expect(replay).toEqual(one);
  const updates=one.items[0]!.updates;
  expect(updates).toHaveLength(2);
  expect(updates[0]).toMatchObject({type:'source.collected',collapsible:true});
  expect(updates[1]).toMatchObject({type:'coordination.blocked',content:'需要用户决定是否继续',collapsible:false});
});
