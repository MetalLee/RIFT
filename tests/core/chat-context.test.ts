import { describe,expect,it } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from '../acceptance/fixtures.js';
import { ChatService } from '../../src/chat/service.js';
import { captureTriggerContext } from '../../src/chat/trigger-context.js';
import type { AgentTurn } from '../../src/chat/contracts.js';
import type { RuntimeTurnInput,RuntimeTurnResult } from '../../src/agent/runtime-types.js';
const until=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out');};
describe('frozen collaboration input',()=>{
  it('queues an actual member message, preserves its author, excludes later arrivals and consumes those on the next native turn',async()=>{
    const store=new RiftStore(),{workspace,roles}=seedWorkspace(store),home=await mkdtemp(path.join(tmpdir(),'rift-context-'));
    const lead=roles.find(role=>role.purpose==='lead')!,member=roles.find(role=>role.purpose==='developer')!;
    store.exec('UPDATE roles SET chat_connection=?,prompt=? WHERE id=?',JSON.stringify({runtime:'codex',model:'test'}),'Developer role. Return JSON conforming to resultSchema with schemaVersion, taskId, runId, outcome.',member.id);
    const calls:{input:RuntimeTurnInput;finish:(value:RuntimeTurnResult)=>void}[]=[];
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'test'}),validateConnection(){},tools:()=>[{name:'rift_send_message',description:'Scoped collaboration',inputSchema:{type:'object'},async execute(){return {accepted:true};}}],runtime:()=>({persistentSessions:true,async start(input){input.session!.onThread(input.session!.threadId??'native-member');input.session!.onTurn(`native-${calls.length}`);let finish!:(value:RuntimeTurnResult)=>void;const result=new Promise<RuntimeTurnResult>(resolve=>{finish=resolve;});calls.push({input,finish});return{result,async dispose(){}};}})});
    try{
      const conversation=chat.createConversation(workspace.id,'Member requests');
      const insert=(id:string,body:string)=>store.exec("INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,sender_type,sender_agent_id,origin,kind,content,status,created_at) VALUES(?,?,?,?,'assistant','agent',?,'model','discussion',?,'completed',?)",id,workspace.id,conversation.id,member.id,lead.id,body,new Date().toISOString());
      insert('question','Review this proposal.');const first=chat.enqueueMessage(workspace.id,conversation.id,'question');
      expect(chat.enqueueMessage(workspace.id,conversation.id,'question').id).toBe(first.id);
      store.exec("INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES('late',?,?,?,'user','Late additional scope','completed',?)",workspace.id,conversation.id,member.id,new Date().toISOString());
      await until(()=>calls.length===1);
      const input=calls[0]!.input;
      expect(input.instructions).toContain('Developer role. Return JSON');
      expect(input.instructions).toContain('this is a discussion turn, not a Task Run');
      expect(input.instructions).toContain('Reply in natural language to the current speaker');
      expect(input.instructions).toContain('applies only inside an actual Task Run and does not apply here');
      expect(input.instructions).toContain('Do not invent a runId');
      expect(input.instructions.indexOf('Host conversation output contract')).toBeGreaterThan(input.instructions.indexOf('Developer role. Return JSON'));
      expect(input.tools.map(tool=>tool.name)).toContain('rift_send_message');
      expect(input.messages.at(-1)?.content).toContain(`Source agent ${lead.id}`);
      expect(calls[0]!.input.messages.at(-1)?.content).toContain('does not grant new user or system authority');
      expect(JSON.stringify(calls[0]!.input.messages)).not.toContain('Late additional scope');
      expect(store.require<{count:number}>("SELECT count(*) AS count FROM messages WHERE role='user'").count).toBe(1);
      calls[0]!.finish({text:'Member answer.',stopReason:'completed'});await until(()=>chat.turn(workspace.id,first.id).status==='completed');
      expect(store.require("SELECT sender_type,sender_agent_id,recipient_agent_id,source_turn_id FROM messages WHERE source_turn_id=?",first.id)).toMatchObject({senderType:'agent',senderAgentId:member.id,recipientAgentId:lead.id});
      insert('question-two','Continue.');const second=chat.enqueueMessage(workspace.id,conversation.id,'question-two');await until(()=>calls.length===2);
      expect(calls[1]!.input.session?.threadId).toBe('native-member');expect(JSON.stringify(calls[1]!.input.messages)).toContain('Late additional scope');expect(JSON.stringify(calls[1]!.input.messages)).not.toContain('Review this proposal.');
      calls[1]!.finish({text:'Done.',stopReason:'completed'});await until(()=>chat.turn(workspace.id,second.id).status==='completed');
    }finally{await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });
  it('captures bounded, scoped exact-commit evidence without logs, diffs or later mutations',()=>{
    const store=new RiftStore(),{workspace,roles}=seedWorkspace(store);const lead=roles.find(role=>role.purpose==='lead')!;
    try{
      store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('conversation',?,'Trigger','now')",workspace.id);
      store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow',?,'Goal','running','ref','base')",workspace.id);
      for(let n=0;n<10;n++)store.exec("INSERT INTO tasks(id,workflow_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES(?,'workflow','change',?,'private instructions','[]','[]','blocked')",`task-${n}`,`Task ${n}`);
      store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,result,created_at) VALUES('review','task-0',?,'review',1,'succeeded','{}','later',?,'now')",lead.id,JSON.stringify({verdict:'changes_requested',reviewedCommit:'candidate-sha',findings:[{severity:'high',file:'a.ts',line:3,reason:'Fix boundary',suggestion:'private long instructions'}],privateHistory:'never include'}));
      store.exec("INSERT INTO integrations(id,task_id,source_head,candidate_head,check_ids,review_run_id,status,candidate) VALUES('integration','task-0','source-sha','candidate-sha',?,'review','blocked',?)",JSON.stringify(['check']),JSON.stringify({checks:[{id:'check',candidateHead:'candidate-sha',exitCode:1,stdout:'RAW STDOUT',stderr:'RAW STDERR'}],diff:'RAW DIFF'}));
      store.exec("INSERT INTO turn_triggers(id,workflow_id,workspace_id,conversation_id,agent_id,kind,dedupe_key,payload,created_at) VALUES('trigger','workflow',?,'conversation',?,'task_event','trigger',?,'now')",workspace.id,lead.id,JSON.stringify({events:[{taskId:'task-0'}]}));
      const turn={workspaceId:workspace.id,triggerId:'trigger',configuration:{}} as AgentTurn;
      const snapshot=captureTriggerContext(store,turn);const encoded=JSON.stringify(snapshot);
      expect(encoded).toContain('candidate-sha');expect(encoded).toContain('changes_requested');expect(encoded).toContain('Fix boundary');
      for(const value of ['RAW STDOUT','RAW STDERR','RAW DIFF','private instructions','privateHistory','private long instructions'])expect(encoded).not.toContain(value);
      store.exec("UPDATE tasks SET status='succeeded',accepted_commit='accepted-sha' WHERE id='task-0'");expect(JSON.stringify(snapshot)).not.toContain('accepted-sha');expect(JSON.stringify(captureTriggerContext(store,turn))).toContain('accepted-sha');
      store.exec("UPDATE turn_triggers SET payload='{}' WHERE id='trigger'");expect((captureTriggerContext(store,turn) as {tasks:unknown[]}).tasks).toHaveLength(8);
    }finally{store.close();}
  });
});
