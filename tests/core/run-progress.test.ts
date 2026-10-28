import {describe,it,expect,vi} from 'vitest';
import {RiftStore} from '../../src/storage/database.js';
import {seedWorkspace} from '../acceptance/fixtures.js';
import {conversationRunProgress,recordRunProgress,observeDshRun,observeNativeRun} from '../../src/task/run-progress.js';
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
describe('task run progress',()=>{
 it('isolates conversations/workspaces and snapshots persisted progress without waking Lead',()=>{
  const f=fixture();try{
   recordRunProgress(f.store,'run',{phase:'thinking',step:true});
   recordRunProgress(f.store,'run',{phase:'tool',toolName:'rift_read_file'});
   recordRunProgress(f.store,'run',{phase:'tool_done',toolName:'rift_read_file'});
   expect(conversationRunProgress(f.store,f.workspace.id,'conversation')[0]).toMatchObject({runId:'run',toolCalls:1,modelSteps:1,phase:'tool_done',taskStatus:'running'});
   expect(conversationRunProgress(f.store,f.workspace.id,'another')).toEqual([]);
   expect(conversationRunProgress(f.store,'foreign','conversation')).toEqual([]);
   expect(f.store.all("SELECT * FROM task_events WHERE type='run.progress'")).toEqual([]);
   expect(f.store.all("SELECT * FROM workspace_events WHERE type='run.progress'")).toHaveLength(3);
  }finally{f.store.close();}
 });
 it('throttles token activity and ignores events after execution ends',()=>{
  const f=fixture();try{
   recordRunProgress(f.store,'run',{phase:'thinking'});
   for(let i=0;i<100;i++)recordRunProgress(f.store,'run',{phase:'thinking'});
   expect(f.store.all("SELECT * FROM workspace_events WHERE type='run.progress'")).toHaveLength(1);
   f.store.exec("UPDATE runs SET status='failed' WHERE id='run'");
   recordRunProgress(f.store,'run',{phase:'tool',toolName:'late'});
   expect(conversationRunProgress(f.store,f.workspace.id,'conversation')[0]).toMatchObject({status:'failed',toolCalls:0,phase:'thinking'});
  }finally{f.store.close();}
 });
 it('does not truncate active runs at thirty',()=>{
  const f=fixture();try{f.store.exec('UPDATE scheduler_limits SET developers=40,total=41 WHERE id=1');for(let i=0;i<35;i++)f.insert('run-'+i);expect(conversationRunProgress(f.store,f.workspace.id,'conversation')).toHaveLength(36);}finally{f.store.close();}
 });
 it('observes exact DSH child only and never forwards reasoning text',()=>{
  let listener:any;const emit=vi.fn(),agent={ctx:{on:(_name:string,fn:unknown)=>{listener=fn;}}} as any;
  observeDshRun(agent,emit);
  listener({agent:{},frame:{type:'start'}});expect(emit).not.toHaveBeenCalled();
  listener({agent,frame:{type:'start'}});
  listener({agent,frame:{type:'chunk',chunk:{type:'reasoning-delta',text:'PRIVATE_CONTENT'}}});
  listener({agent,frame:{type:'chunk',chunk:{type:'text-delta',text:'PUBLIC_CONTENT'}}});
  expect(emit.mock.calls.map(c=>c[0])).toEqual([{phase:'thinking',step:true},{phase:'thinking'},{phase:'generating'}]);
 });
 it('handles native/text-analysis events without storing text or arguments',()=>{
  const emit=vi.fn(),observe=observeNativeRun(emit);
  observe({type:'message.started',messageId:'m',kind:'reasoning_summary'});
  observe({type:'message.delta',messageId:'m',text:'PRIVATE_CONTENT'});
  observe({type:'tool.started',toolCallId:'c',toolName:'exec_command'});
  observe({type:'tool.failed',toolCallId:'c',toolName:'exec_command'});
  expect(emit.mock.calls.map(c=>c[0])).toEqual([{phase:'thinking'},{phase:'thinking'},{phase:'tool',toolName:'exec_command'},{phase:'tool_failed',toolName:'exec_command'}]);
 });
});
