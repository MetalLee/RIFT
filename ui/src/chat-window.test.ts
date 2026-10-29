import {buildConversationTimeline} from './chat-timeline';
import {describe,it,expect} from 'vitest';
import type {ChatPage,ChatMessage} from '@rift/protocol';
import {needsTimelineBridge,mergeChatHistory} from './chat-state';
import {applyMessageEvent} from './stream-state';
import type {WorkspaceEvent} from '@rift/protocol';
const message=(n:number):ChatMessage=>({id:'m'+n,workspaceId:'ws',conversationId:'c',role:'assistant',senderType:'agent',senderAgentId:'dev',clientMessageId:null,recipientAgentId:null,content:'text '+n,status:'completed',version:0,createdAt:String(n)});
const page=(start:number,end:number):ChatPage=>({conversation:{id:'c',workspaceId:'ws',title:'Room',version:0,createdAt:'now'},timeline:true,messages:Array.from({length:end-start},(_,i)=>message(start+i)),turns:[],chunks:[],nextBefore:start?String(start):null,snapshotCursor:1});
describe('lazy live chat window',()=>{
 it('detects a multi-page recovery gap and bridges only unseen arrivals before the old window',()=>{
  const old=page(30,60),next=page(130,160);expect(needsTimelineBridge(old,next)).toBe(true);expect(needsTimelineBridge(old,page(40,70))).toBe(false);
  let merged=mergeChatHistory(old,next),cursor=Number(next.nextBefore);let requests=0;
  while(cursor){const older=page(Math.max(0,cursor-30),cursor);requests++;merged=mergeChatHistory(older,merged);if(older.messages.some(m=>old.messages.some(o=>o.id===m.id)))break;cursor=Number(older.nextBefore);}
  expect(requests).toBe(3);expect(new Set(merged.messages.map(m=>m.id)).size).toBe(130);
  for(let i=30;i<160;i++)expect(merged.messages.some(m=>m.id==='m'+i)).toBe(true);
 });
 it('applies Run deltas to the same normalized timeline identity and requests snapshots for gaps',()=>{
  const current=page(0,3);
  const event={workspaceId:'ws',entityVersion:0,occurredAt:'now',seq:2,type:'run.message',entityId:'run',payload:{conversationId:'c',message:{seq:1,runId:'run',messageId:'s',workspaceId:'ws',conversationId:'c',roleId:'dev',taskId:'task',status:'streaming',kind:'commentary',version:0,createdAt:'now',updatedAt:'now'},offset:0,delta:'检查',replace:false}} as WorkspaceEvent;
  const next=applyMessageEvent(current,event)!;expect(next.messages.at(-1)).toMatchObject({id:'run-stream:run:s',content:'检查',senderAgentId:'dev',status:'streaming'});
  expect(applyMessageEvent(next,event)).toBe(next);
  expect(applyMessageEvent(current,{...event,payload:{...event.payload,offset:9}})).toBeUndefined();
  expect(applyMessageEvent(current,{...event,payload:{...event.payload,conversationId:'other'}})).toBe(current);
 });
 it('lets refreshed same-version terminal state replace retained streaming state',()=>{
  const old=page(0,1);old.messages[0]!.status='streaming';
  const refreshed=page(0,1);refreshed.messages[0]!.status='interrupted';
  expect(mergeChatHistory(old,refreshed).messages[0]?.status).toBe('interrupted');
 });
});

describe('timeline Run result SSE presentation',()=>{
 const raw=JSON.stringify({schemaVersion:1,taskId:'task',runId:'run',verdict:'approve',reviewedCommit:'cc195cf050b5d0af7b3f42e6e1dcbbf8f0c0f1aa',findings:[]},null,2);
 const event=(seq:number,offset:number,delta:string,status='streaming',replace=false):WorkspaceEvent=>({workspaceId:'ws',entityVersion:0,occurredAt:'now',seq,type:'run.message',entityId:'run',payload:{conversationId:'c',message:{seq:1,runId:'run',messageId:'review',workspaceId:'ws',conversationId:'c',roleId:'reviewer',taskId:'task',status,kind:'final',version:seq,createdAt:'now',updatedAt:'now'},offset,delta,replace}} as WorkspaceEvent);
 const visible=(p:ChatPage)=>buildConversationTimeline(p.messages,p.turns,[],[],p.runMessages).items.at(-1)!.message.content;
 it('formats completion and replay without changing raw offsets, including hydration mid-stream',()=>{
  let p=applyMessageEvent(page(0,0),event(2,0,raw.slice(0,30)))!;
  p=JSON.parse(JSON.stringify(p)); // snapshot/reload representation
  p=applyMessageEvent(p,event(3,30,raw.slice(30),'completed'))!;
  expect(visible(p)).toContain('审查通过');expect(visible(p)).not.toContain('schemaVersion');
  expect(p.messages[0]!.content).toBe(raw);
  expect(applyMessageEvent(p,event(3,30,raw.slice(30),'completed'))).toBe(p);
  const refreshed=JSON.parse(JSON.stringify(p)) as ChatPage;
  p=applyMessageEvent(refreshed,event(4,raw.length,'','completed'))!;
  expect(visible(p)).toContain('审查通过'); // raw offset, not formatted string length
  expect(applyMessageEvent(p,event(5,raw.length+1,'x','completed'))).toBeUndefined();
  const blocked=raw.replace('approve','blocked');
  p=applyMessageEvent(p,event(6,0,blocked,'completed',true))!;expect(visible(p)).toContain('审查受阻');
 });
 it('formats developer results too and never treats commentary or mismatched identity as a verdict',()=>{
  const dev=JSON.stringify({schemaVersion:1,taskId:'task',runId:'run',summary:'实现完成'});
  expect(visible(applyMessageEvent(page(0,0),event(2,0,dev,'completed',true))!)).toBe('实现完成');
  const e=event(2,0,raw,'completed',true);(e.payload.message as {kind:string}).kind='commentary';
  expect(visible(applyMessageEvent(page(0,0),e)!)).toBe(raw);
  const wrong=raw.replace('"task"','"foreign"');expect(visible(applyMessageEvent(page(0,0),event(2,0,wrong,'completed',true))!)).toBe(wrong);
 });
});
