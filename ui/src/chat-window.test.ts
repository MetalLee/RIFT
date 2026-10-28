import {describe,it,expect} from 'vitest';
import type {ChatPage,ChatMessage} from '../../src/chat/contracts';
import {needsTimelineBridge,mergeChatHistory} from './chat-state';
import {applyMessageEvent} from './stream-state';
import type {WorkspaceEvent} from '../../src/events/workspace-events';
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
