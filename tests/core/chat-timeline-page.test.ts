import {describe,it,expect} from 'vitest';
import {RiftStore} from '../../src/storage/database.js';
import {seedWorkspace} from '../acceptance/fixtures.js';
import {timelinePage} from '../../src/chat/timeline-page.js';
import type {Conversation} from '../../src/chat/contracts.js';
function fixture(){
 const store=new RiftStore(),{workspace,roles}=seedWorkspace(store),lead=roles.find(r=>r.purpose==='lead')!,dev=roles.find(r=>r.purpose==='developer')!;
 const c:Conversation={id:'c',workspaceId:workspace.id,title:'Room',version:0,createdAt:'2026-01-01T00:00:00Z'};
 store.exec('INSERT INTO conversations(id,workspace_id,title,created_at) VALUES(?,?,?,?)',c.id,c.workspaceId,c.title,c.createdAt);
 store.exec("INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES('user',?,'c',?,'user','Begin','completed',?)",workspace.id,lead.id,c.createdAt);
 store.exec("INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('turn',?,'c','user',?,'completed',?,?)",workspace.id,lead.id,JSON.stringify({agent:{id:lead.id,displayName:'lead',prompt:'PRIVATE_PROMPT'.repeat(1000),purpose:'lead'},connection:{runtime:'dsh',model:'test'},context:{messages:['PRIVATE_HISTORY'.repeat(1000)]}}),c.createdAt);
 store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('wf',?,'Test','running','ref','base')",workspace.id);
 store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES('wf',?,'c',?,'chat','now')",workspace.id,lead.id);
 store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES('task','wf',?,'analysis','Audit','Audit','[]','[]','running',1)",dev.id);
 store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES('run','task',?,'develop',1,'running','{}','later','now')",dev.id);
 const add=(n:number,sameTime=false)=>{
  const at=sameTime?'2026-01-02T00:00:00Z':new Date(Date.UTC(2026,0,2,0,0,n)).toISOString();
  if(n%2===0)store.exec("INSERT INTO turn_stream_messages(turn_id,message_id,kind,text,status,created_at,updated_at) VALUES('turn',?,'commentary',?,'completed',?,?)",'m'+n,'LEAD_'+n,at,at);
  else store.exec("INSERT INTO run_stream_messages(run_id,message_id,kind,text,status,created_at,updated_at) VALUES('run',?,'commentary',?,'completed',?,?)",'m'+n,'CHILD_'+n,at,at);
 };
 return{store,c,lead,add};
}
describe('bounded chronological chat pages',()=>{
 it('returns failed-turn controls even with no output, including retained turns outside the latest window',()=>{
  const f=fixture();try{
   f.store.exec("UPDATE agent_turns SET status='failed',error='Provider connection failed' WHERE id='turn'");
   expect(timelinePage(f.store,f.c).turns[0]).toMatchObject({id:'turn',status:'failed',error:'Provider connection failed'});
   for(let i=1;i<70;i+=2)f.add(i);
   const latest=timelinePage(f.store,f.c,undefined,30,['turn-status:turn','message:user']);
   expect(latest.messages.some(m=>m.id==='user')).toBe(false);
   expect(latest.turns[0]).toMatchObject({id:'turn',status:'failed',error:'Provider connection failed'});
   expect(latest.refreshedMessages?.some(m=>m.id==='user')).toBe(true);
  }finally{f.store.close();}
 });
 it('refreshes retained active messages outside the latest page without loading whole runs',()=>{
  const f=fixture();try{
   f.add(1);f.store.exec("UPDATE run_stream_messages SET status='streaming'");
   const original=timelinePage(f.store,f.c).messages.at(-1)!;
   for(let i=2;i<100;i++)f.add(i);
   f.store.exec("UPDATE runs SET status='failed' WHERE id='run'");
   const latest=timelinePage(f.store,f.c,undefined,30,[original.id]);
   expect(latest.messages).toHaveLength(30);expect(latest.messages.some(m=>m.id===original.id)).toBe(false);
   expect(latest.refreshedMessages).toHaveLength(1);expect(latest.refreshedMessages![0]).toMatchObject({id:original.id,status:'interrupted'});
   const foreign=timelinePage(f.store,{...f.c,id:'other'},undefined,30,[original.id]);expect(foreign.refreshedMessages).toEqual([]);
  }finally{f.store.close();}
 });
 it('loads only the newest 30 actual messages from a long turn/run, not their entire parents',()=>{
  const f=fixture();try{
   f.store.transaction(()=>{for(let i=0;i<1200;i++)f.add(i);});
   const page=timelinePage(f.store,f.c);
   expect(page.messages).toHaveLength(30);expect(page.messages[0]?.content).toBe('LEAD_1170');expect(page.messages.at(-1)?.content).toBe('CHILD_1199');
   expect(page.nextBefore).not.toBeNull();expect(page.runMessages).toEqual([]);expect(page.chunks).toEqual([]);
   expect(JSON.stringify(page)).not.toContain('PRIVATE_');expect(JSON.stringify(page).length).toBeLessThan(25000);
   const older=timelinePage(f.store,f.c,page.nextBefore!);
   expect(older.messages.at(-1)?.content).toBe('CHILD_1169');expect(new Set([...page.messages,...older.messages].map(m=>m.id)).size).toBe(60);
  }finally{f.store.close();}
 });
 it('walks all sources without gaps/duplicates even when timestamps tie and new messages arrive',()=>{
  const f=fixture();try{
   for(let i=0;i<65;i++)f.add(i,true);
   let page=timelinePage(f.store,f.c,undefined,7);const seen=page.messages.map(m=>m.id);
   f.add(9999);
   while(page.nextBefore){page=timelinePage(f.store,f.c,page.nextBefore,7);seen.push(...page.messages.map(m=>m.id));}
   expect(seen).toHaveLength(66);expect(new Set(seen).size).toBe(66);expect(seen.some(id=>id.includes('m9999'))).toBe(false);
   expect(()=>timelinePage(f.store,{...f.c,id:'other'},JSON.stringify({version:1,conversationId:'c',at:'now',key:'x'}))).toThrow(/cursor/i);
  }finally{f.store.close();}
 });
 it('deduplicates the canonical final answer and excludes private/title content',()=>{
  const f=fixture();try{
   f.add(0);
   f.store.exec("INSERT INTO turn_stream_messages(turn_id,message_id,kind,text,status,created_at,updated_at) VALUES('turn','final','final','Answer','completed','2026-01-03','2026-01-03')");
   f.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,sender_type,sender_agent_id,source_turn_id,content,status,created_at) VALUES('final-message',?,'c','assistant','agent',?,'turn','Answer','completed','2026-01-04')",f.c.workspaceId,f.lead.id);
   f.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,visibility,content,status,created_at) VALUES('private',?,'c','user','internal','PRIVATE','completed','2026-01-05')",f.c.workspaceId);
   const page=timelinePage(f.store,f.c);expect(page.messages.filter(m=>m.content==='Answer')).toHaveLength(1);expect(JSON.stringify(page)).not.toContain('PRIVATE');
  }finally{f.store.close();}
 });
 it('validates limits/cursors and maps terminal orphan streams to interrupted',()=>{
  const f=fixture();try{
   f.add(1);f.store.exec("UPDATE run_stream_messages SET status='streaming'");f.store.exec("UPDATE runs SET status='failed' WHERE id='run'");
   expect(timelinePage(f.store,f.c).messages.at(-1)?.status).toBe('interrupted');
   expect(()=>timelinePage(f.store,f.c,'broken')).toThrow(/cursor/i);expect(()=>timelinePage(f.store,f.c,undefined,0)).toThrow(/limit/i);
  }finally{f.store.close();}
 });
});
