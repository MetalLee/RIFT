import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {RiftHostService} from '../../src/api/host-service.js';
import {startLocalApi} from '../../src/api/local-api.js';
import type {ChatMessage,ChatPage,CoordinationReceipt} from '../../src/chat/contracts.js';
import {seedWorkspace} from './fixtures.js';

async function fixture(){
 const home=await mkdtemp(path.join(tmpdir(),'rift-timeline-receipts-'));
 const host=new RiftHostService({subagents:{list:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'test',leadModel:'test',checks:[]});
 const {workspace,roles}=seedWorkspace(host.store);
 const conversation=host.chat.createConversation(workspace.id,'Receipts');
 const workflow=host.coordinator.createWorkflow({workspaceId:workspace.id,goal:'Receipt projection',repositoryFree:true,baseCommit:'',integrationRef:''});
 // Keep the workflow planning: real projection runs without starting any model execution.
 host.store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES(?,?,?,?,'chat','now')",workflow.id,workspace.id,conversation.id,roles.find(r=>r.purpose==='lead')!.id);
 const api=await startLocalApi(host,host.config),origin=`http://127.0.0.1:${api.port}`;
 const source={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
 const session=await fetch(`${origin}/ui-api/v1/session/connect`,{method:'POST',headers:source,body:'{}'});
 expect(session.status).toBe(200);
 const headers={...source,Cookie:session.headers.get('set-cookie')!.split(';')[0]!};
 const request=(query:Record<string,string>={},wid=workspace.id,cid=conversation.id)=>fetch(`${origin}/ui-api/v1/workspaces/${wid}/conversations/${cid}/messages?${new URLSearchParams({view:'timeline',...query})}`,{headers});
 const page=async(query:Record<string,string>={})=>{const response=await request(query);expect(response.status).toBe(200);const result=await response.json() as ChatPage;expect(Array.isArray(result.receipts)).toBe(true);return result as ChatPage&{receipts:CoordinationReceipt[]};};
 const emit=async(type:string,payload:Record<string,unknown>={},refs:{taskId?:string;runId?:string;requestId?:string}={})=>{
  host.store.event(workflow.id,type,payload,refs);
  const {seq}=host.store.require<{seq:number}>('SELECT MAX(event_seq) seq FROM task_events');
  await host.orchestration.pump();
  expect(host.orchestration.lastError).toBeNull();
  const message=host.store.require<ChatMessage>('SELECT * FROM messages WHERE dedupe_key=?',`event:${seq}:${conversation.id}`);
  return {seq,message};
 };
 return {host,workspace,workflow,conversation,page,request,emit,close:async()=>{await api.close();await host.close();await rm(home,{recursive:true,force:true});}};
}

describe('real timeline HTTP receipt projection',()=>{
 it('pages and refreshes only matching receipts, preserving routine types and complete public decision/error reasons',async()=>{
  const f=await fixture();try{
   const store=f.host.store,dev=store.require<{id:string}>("SELECT id FROM roles WHERE workspace_id=? AND purpose='developer' LIMIT 1",f.workspace.id);
   store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES('task',?,?,'analysis','Audit','Audit','[]','[]','running',1)",f.workflow.id,dev.id);
   store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at,slot_released_at,cleanup_status) VALUES('run','task',?,'develop',1,'completed','{}','later','now','now','confirmed')",dev.id);
   store.exec("INSERT INTO operations(id,kind,dedupe_key,entity_id,phase,payload,created_at) VALUES('request','dispatch','dispatch-task','task','completed','{}','now')");
   const routine=await f.emit('source.collected',{candidateHead:'a'.repeat(40),privatePayload:'PRIVATE_PAYLOAD'},{taskId:'task',runId:'run',requestId:'request'});
   const reason='具体决策依据。'.repeat(45);
   const decision=await f.emit('integration.accepted',{reason});
   const error=await f.emit('dispatch.blocked',{error:'Check failed: token=private-credential'});
   // Receipt timestamps and insertion order differ from visible message order.
   for(const [event,at] of [[routine,'2026-01-01'],[error,'2026-01-02'],[decision,'2026-01-03']] as const)
    f.host.store.exec('UPDATE messages SET created_at=? WHERE id=?',at,event.message.id);
   f.host.store.exec("UPDATE coordination_outbox SET status='pending'");await f.host.orchestration.pump();
   expect(f.host.store.all('SELECT id FROM coordination_receipts')).toHaveLength(3);
   expect(f.host.store.all("SELECT id FROM messages WHERE kind='receipt'")).toHaveLength(3);
   const latest=await f.page({limit:'2'});
   expect(latest.messages.map(m=>m.id)).toEqual([error.message.id,decision.message.id]);
   expect(latest.receipts.map(r=>r.eventSeq)).toEqual([decision.seq,error.seq]);
   expect(latest.receipts.find(r=>r.eventSeq===decision.seq)?.payload.reason).toBe(reason);
   expect(latest.receipts.find(r=>r.eventSeq===error.seq)?.payload.reason).toBe('Check failed: token=[REDACTED]');
   const older=await f.page({limit:'2',before:latest.nextBefore!});
   expect(older.messages.map(m=>m.id)).toEqual([routine.message.id]);
   expect(older.nextBefore).toBeNull();
   expect(older.receipts).toMatchObject([{workspaceId:f.workspace.id,conversationId:f.conversation.id,workflowId:f.workflow.id,eventSeq:routine.seq,
    payload:{eventSeq:routine.seq,workflowId:f.workflow.id,type:'source.collected',taskId:'task',runId:'run',requestId:'request'}}]);
   const refreshed=await f.page({limit:'1',refresh:JSON.stringify([`message:${routine.message.id}`,`message:${routine.message.id}`,`message:${decision.message.id}`])});
   expect(refreshed.messages.map(m=>m.id)).toEqual([decision.message.id]);
   expect(refreshed.refreshedMessages?.map(m=>m.id).sort()).toEqual([routine.message.id,decision.message.id].sort());
   expect(refreshed.receipts.map(r=>r.eventSeq)).toEqual([routine.seq,decision.seq]);
   expect(JSON.stringify([latest,older,refreshed])).not.toMatch(/PRIVATE_PAYLOAD|private-credential|candidateHead|taskTitle|cleanupStatus/);
   for(const column of ['task_id','run_id','request_id']){
    const value=store.require<Record<string,string>>(`SELECT ${column} AS value FROM messages WHERE id=?`,routine.message.id).value;
    store.exec(`UPDATE messages SET ${column}=NULL WHERE id=?`,routine.message.id);
    expect((await f.page()).receipts.some(r=>r.eventSeq===routine.seq)).toBe(false);
    store.exec(`UPDATE messages SET ${column}=? WHERE id=?`,value,routine.message.id);
   }
   store.exec('UPDATE messages SET dedupe_key=? WHERE id=?',`event:0${routine.seq}:${f.conversation.id}`,routine.message.id);
   expect((await f.page()).receipts.some(r=>r.eventSeq===routine.seq)).toBe(false);
  }finally{await f.close();}
 });

 it('defaults safely for absent, unknown or malformed receipts without guessing from message wording',async()=>{
  const f=await fixture();try{
   const missing=await f.emit('source.collected');
   f.host.store.exec('DELETE FROM coordination_receipts WHERE event_seq=?',missing.seq);
   const unknown=await f.emit('task.blocked',{reason:'Unknown future event'});
   // Simulate a future ledger type and stale/malformed receipt metadata.
   f.host.store.exec("UPDATE task_events SET type='future.unknown' WHERE event_seq=?",unknown.seq);
   f.host.store.exec("UPDATE coordination_receipts SET payload='not-json' WHERE event_seq=?",unknown.seq);
   const bounded=await f.emit('coordination.blocked',{reason:'x'.repeat(5000),internal:{authorization:'PRIVATE_INTERNAL'}});
   const page=await f.page();
   expect(page.messages).toHaveLength(3);
   expect(page.receipts.map(r=>r.eventSeq)).toEqual([unknown.seq,bounded.seq]);
   expect(page.receipts[0].payload).toEqual({eventSeq:unknown.seq,workflowId:f.workflow.id,type:'future.unknown',taskId:null,runId:null,requestId:null});
   expect(page.receipts[1].payload.reason).toBe('x'.repeat(1500)+'\n[TRUNCATED]');
   expect(JSON.stringify(page)).not.toContain('PRIVATE_INTERNAL');
  }finally{await f.close();}
 });

 it('rejects cross-workspace/conversation reads and excludes mismatched receipt/event identities',async()=>{
  const f=await fixture();try{
   const own=await f.emit('source.collected');
   const other=f.host.chat.createConversation(f.workspace.id,'Other room');
   const {workspace:foreign}=seedWorkspace(f.host.store,'foreign-workspace');
   expect((await f.request({},foreign.id,f.conversation.id)).status).toBe(404);
   const foreignPage=await f.request({refresh:JSON.stringify([`message:${own.message.id}`])},foreign.id,
    f.host.chat.createConversation(foreign.id,'Foreign').id);
   expect(foreignPage.status).toBe(200);expect(await foreignPage.json()).toMatchObject({messages:[],refreshedMessages:[],receipts:[]});
   const otherPage=await f.request({refresh:JSON.stringify([`message:${own.message.id}`])},f.workspace.id,other.id);
   expect(await otherPage.json()).toMatchObject({messages:[],refreshedMessages:[],receipts:[]});
   const cursor=(await f.page({limit:'1'}));
   // Produce a cursor then reject using it in another conversation.
   await f.emit('cleanup.confirmed');
   const before=(await f.page({limit:'1'})).nextBefore!;
   expect((await f.request({before},f.workspace.id,other.id)).status).toBe(400);
   expect(cursor.receipts).toHaveLength(1);
   const store=f.host.store;
   for(const [column,value,restore] of [['workspace_id',foreign.id,f.workspace.id],['conversation_id',other.id,f.conversation.id]] as const){
    store.exec(`UPDATE coordination_receipts SET ${column}=? WHERE event_seq=?`,value,own.seq);
    expect((await f.page()).receipts.some(r=>r.eventSeq===own.seq)).toBe(false);
    store.exec(`UPDATE coordination_receipts SET ${column}=? WHERE event_seq=?`,restore,own.seq);
   }
   const foreignWorkflow=f.host.coordinator.createWorkflow({workspaceId:foreign.id,goal:'Other',repositoryFree:true,baseCommit:'',integrationRef:''});
   store.exec('UPDATE task_events SET workflow_id=? WHERE event_seq=?',foreignWorkflow.id,own.seq);
   expect((await f.page()).receipts.some(r=>r.eventSeq===own.seq)).toBe(false);
   store.exec('UPDATE coordination_receipts SET workflow_id=? WHERE event_seq=?',foreignWorkflow.id,own.seq);
   expect((await f.page()).receipts.some(r=>r.eventSeq===own.seq)).toBe(false);
  }finally{await f.close();}
 });

 it('uses indexed bounded receipt lookups across a long stored history and duplicate refresh IDs',async()=>{
  const f=await fixture();try{
   f.host.store.transaction(()=>{for(let i=0;i<300;i++)f.host.store.event(f.workflow.id,'source.collected');});
   for(let i=0;i<7;i++)await f.host.orchestration.pump();
   expect(f.host.store.all('SELECT id FROM coordination_receipts')).toHaveLength(300);
   const old=f.host.store.require<{id:string}>('SELECT id FROM messages ORDER BY rowid LIMIT 1');
   const spy=vi.spyOn(f.host.store,'all');
   const page=await f.page({limit:'7',refresh:JSON.stringify(Array(100).fill(`message:${old.id}`))});
   expect(page.messages).toHaveLength(7);expect(page.refreshedMessages).toHaveLength(1);expect(page.receipts).toHaveLength(8);
   expect(JSON.stringify(page).length).toBeLessThan(20000);
   const [sql,...params]=spy.mock.calls.find(([sql])=>sql.includes('JOIN coordination_receipts r'))!;
   spy.mockRestore();
   const plan=f.host.store.all<{detail:string}>(`EXPLAIN QUERY PLAN ${sql}`,...params).map(r=>r.detail).join('\n');
   expect(plan).toMatch(/SEARCH r USING INDEX .*\(event_seq=\? AND conversation_id=\?\)/);
   expect(plan).not.toMatch(/SCAN [mre]\b/);
   const older=await f.page({limit:'7',before:page.nextBefore!});
   expect(older.receipts).toHaveLength(7);
   expect(new Set([...page.messages,...older.messages].map(m=>m.id)).size).toBe(14);
  }finally{await f.close();}
 });
});
