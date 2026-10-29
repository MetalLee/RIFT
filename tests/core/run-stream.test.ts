import {describe,it,expect,vi,afterEach} from 'vitest';
import {RiftStore} from '../../src/storage/database.js';
import {seedWorkspace} from '../acceptance/fixtures.js';
import {RunChatStream,conversationRunMessages} from '../../src/task/run-stream.js';
import {observeDshRun,observeNativeRun} from '../../src/task/run-progress.js';
function fixture(){
 const store=new RiftStore(),{workspace,roles}=seedWorkspace(store),role=roles.find(r=>r.purpose==='developer')!;
 store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('conversation',?,'Test','now')",workspace.id);
 store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('wf',?,'Test','running','refs/heads/rift/test','base')",workspace.id);
 store.exec("INSERT INTO workflow_conversations(workflow_id,workspace_id,conversation_id,agent_id,mode,created_at) VALUES('wf',?,'conversation',?,'chat','now')",workspace.id,roles.find(r=>r.purpose==='lead')!.id);
 store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES('task','wf',?,'analysis','Audit','Audit','[]','[]','running',1)",role.id);
 const insert=(id:string)=>{
  const roleId=id==='run'?role.id:'role-'+id,taskId=id==='run'?'task':'task-'+id;
  if(id!=='run'){
   store.exec("INSERT INTO roles(id,workspace_id,name,purpose,kind,provider_binding_id,prompt,revision) SELECT ?,workspace_id,?,'developer','subagent',provider_binding_id,prompt,revision FROM roles WHERE id=?",roleId,roleId,role.id);
   store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES(?,'wf',?,'analysis','Audit','Audit','[]','[]','running',1)",taskId,roleId);
  }
  store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,'develop',1,'running','{}','later','now')",id,taskId,roleId);
 };

 insert('run');return{store,workspace,insert};
}

afterEach(()=>vi.useRealTimers());
describe('run conversation streaming',()=>{
 it('does not apply a whole-run text quota across independently completed messages',()=>{
  const f=fixture(),stream=new RunChatStream(f.store,'run');
  try{
   for(let i=0;i<4;i++){
    stream.accept({type:'message.started',messageId:'m'+i,kind:'commentary'});
    stream.accept({type:'message.completed',messageId:'m'+i,text:'文'.repeat(70000)});
   }
   stream.finish(false);
   const messages=conversationRunMessages(f.store,f.workspace.id,'conversation');
   expect(messages).toHaveLength(4);expect(messages.every(m=>m.text.length===70000&&m.status==='completed')).toBe(true);
  }finally{stream.finish(true);f.store.close();}
 });
 it('publishes before completion, redacts split credentials, survives interruption, and isolates conversations',async()=>{
  vi.useFakeTimers();const f=fixture();const stream=new RunChatStream(f.store,'run');
  try{
   stream.accept({type:'message.started',messageId:'m',kind:'commentary'});
   stream.accept({type:'message.delta',messageId:'m',text:'正在检查组件。'});
   await vi.advanceTimersByTimeAsync(45);
   expect(conversationRunMessages(f.store,f.workspace.id,'conversation')[0]).toMatchObject({text:'正在检查组件。',status:'streaming',runId:'run',taskId:'task'});
   stream.accept({type:'message.delta',messageId:'m',text:' api_key=super'});
   await vi.advanceTimersByTimeAsync(45);
   stream.accept({type:'message.delta',messageId:'m',text:'secretvalue end.'});
   stream.finish(true);
   const rows=conversationRunMessages(f.store,f.workspace.id,'conversation');
   expect(rows[0]?.status).toBe('interrupted');expect(rows[0]?.text).toContain('正在检查组件。');
   expect(JSON.stringify(f.store.all('SELECT * FROM workspace_events'))).not.toContain('supersecretvalue');
   expect(conversationRunMessages(f.store,'other','conversation')).toEqual([]);
   expect(conversationRunMessages(f.store,f.workspace.id,'other')).toEqual([]);
   expect(f.store.all('SELECT * FROM task_events')).toEqual([]);
   stream.accept({type:'message.delta',messageId:'m',text:'late'});
   expect(conversationRunMessages(f.store,f.workspace.id,'conversation')).toEqual(rows);
  }finally{stream.finish(true);f.store.close();}
 });
 it('never displays untranslated public summaries or private/unknown deltas',()=>{
  const f=fixture(),stream=new RunChatStream(f.store,'run'),observe=observeNativeRun(undefined,e=>stream.accept(e));
  try{
   observe({type:'message.delta',messageId:'unknown',text:'PRIVATE'});
   observe({type:'message.started',messageId:'r',kind:'reasoning'});
   observe({type:'message.delta',messageId:'r',text:'PRIVATE'});
   observe({type:'message.completed',messageId:'r',text:'PRIVATE'});
   observe({type:'message.started',messageId:'s',kind:'reasoning_summary'});
   observe({type:'message.delta',messageId:'s',text:'已核对入口，接下来验证测试。'});
   observe({type:'message.completed',messageId:'s'});
   stream.finish(false);
   expect(conversationRunMessages(f.store,f.workspace.id,'conversation')).toHaveLength(0);
   expect(JSON.stringify(f.store.all('SELECT * FROM run_stream_messages'))).not.toContain('PRIVATE');
  }finally{stream.finish(true);f.store.close();}
 });
 it('maps exact DSH child attempts, end-only text and partial failures without duplicate deltas',()=>{
  let listener:any;const output:any[]=[];const agent={id:'child',ctx:{on:(_n:string,fn:any)=>{listener=fn;}}} as any;
  observeDshRun(agent,undefined,e=>output.push(e));
  const send=(frame:any)=>listener({agent,frame:{attemptId:'a',...frame}});
  listener({agent:{id:'other'},frame:{type:'start',attemptId:'a'}});
  send({type:'start'});
  send({type:'chunk',chunk:{type:'reasoning-delta',index:0,text:'PRIVATE'}});
  send({type:'chunk',chunk:{type:'text-delta',index:1,text:'检查'}});
  send({type:'chunk',chunk:{type:'block-end',index:1,block:{type:'text',text:'检查完成。'}}});
  send({type:'end',outcome:{kind:'abandoned'}});
  expect(output.filter(e=>e.type==='message.delta').map(e=>e.text).join('')).toBe('检查完成。');
  expect(output.at(-1)).toMatchObject({type:'message.completed',text:'检查完成。',interrupted:true});
  expect(JSON.stringify(output)).not.toContain('PRIVATE');
 });
 it('marks an unclosed stream interrupted after a host restart/terminal run',async()=>{
  vi.useFakeTimers();const f=fixture(),stream=new RunChatStream(f.store,'run');
  try{
   stream.accept({type:'message.started',messageId:'m',kind:'assistant'});
   stream.accept({type:'message.delta',messageId:'m',text:'已有进展。'});
   await vi.advanceTimersByTimeAsync(45);
   f.store.exec("UPDATE runs SET status='interrupted' WHERE id='run'");
   expect(conversationRunMessages(f.store,f.workspace.id,'conversation')[0]?.status).toBe('interrupted');
   stream.accept({type:'message.delta',messageId:'m',text:'late'});
   stream.finish(true);
   expect(conversationRunMessages(f.store,f.workspace.id,'conversation')[0]?.text).toBe('已有进展。');
  }finally{stream.finish(true);f.store.close();}
 });
});

it('publishes translated Run summary after normal Run completion without delaying the final message',async()=>{
 const f=fixture();let resolve!:(text:string)=>void;
 const stream=new RunChatStream(f.store,'run',()=>()=>new Promise(r=>{resolve=r;}));
 try{
  stream.accept({type:'message.started',messageId:'summary',kind:'reasoning_summary'});
  stream.accept({type:'message.completed',messageId:'summary',text:'English public summary'});
  stream.accept({type:'message.started',messageId:'answer',kind:'final'});
  stream.accept({type:'message.completed',messageId:'answer',text:'任务结果'});
  stream.finish(false);
  expect(conversationRunMessages(f.store,f.workspace.id,'conversation').map(m=>m.text)).toEqual(['任务结果']);
  await Promise.resolve();resolve('完整中文摘要');
  await vi.waitFor(()=>expect(conversationRunMessages(f.store,f.workspace.id,'conversation').map(m=>m.text)).toEqual(['任务结果','完整中文摘要']));
  expect(JSON.stringify(f.store.all('SELECT * FROM workspace_events'))).not.toContain('English public summary');
 }finally{f.store.close();}
});
