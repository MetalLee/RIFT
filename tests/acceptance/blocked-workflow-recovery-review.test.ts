import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { ProjectService } from '../../src/project/index.js';
import { TaskCoordinator } from '../../src/task/coordinator.js';
import { LocalGitService } from '../../src/git/integration.js';
import { gitOk } from '../../src/git/process.js';
import type { ActivationBridge, ActivationResult, Candidate } from '../../src/contracts/index.js';
import { ChatService } from '../../src/chat/service.js';
import { CollaborationService } from '../../src/chat/collaboration.js';
import { seedWorkspace } from './fixtures.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';

type Started=Parameters<ActivationBridge['start']>[0]&{finish:(result:ActivationResult)=>void};

describe('Independent blocked Workflow recovery review',()=>{
  it.each(['failed','interrupted'] as const)('retries a never-started delivery using its execution connection but never replays an %s execution',async terminal=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-blocked-review-')),store=new RiftStore();
    const {workspace,roles}=seedWorkspace(store,'message-recovery'),sender=roles.find(role=>role.purpose==='lead')!,recipient=roles.find(role=>role.purpose==='developer')!;
    const calls:{input:RuntimeTurnInput;finish:(value:RuntimeTurnResult)=>void}[]=[];
    let collaboration!:CollaborationService;
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'default'}),validateConnection(connection){expect(['execution-model','explicit-model']).toContain(connection.model);},runtime:()=>({async start(input){let finish!:(value:RuntimeTurnResult)=>void;const result=new Promise<RuntimeTurnResult>(resolve=>{finish=resolve;});calls.push({input,finish});return{result,async dispose(){finish({text:'',stopReason:'cancelled'});}};}}),tools:()=>[],onTurnSettled:turn=>collaboration.settleTurn(turn)});
    collaboration=new CollaborationService(store,{} as TaskCoordinator,{enqueueMessage:(...args)=>chat.enqueueMessage(...args),validateDiscussion:(...args)=>{chat.validateAgentConnection(...args);}});
    try{
      const conversation=chat.createConversation(workspace.id,'Recover original delivery');
      store.exec("INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at,kind,sender_type,sender_agent_id,origin,visibility) VALUES('original-message',?,?,?,'assistant','Please inspect this question.','completed','2026-10-26T00:00:00Z','discussion','agent',?,'model','public')",workspace.id,conversation.id,recipient.id,sender.id);
      store.exec("INSERT INTO agent_inbox(id,message_id,workspace_id,conversation_id,recipient_agent_id,scope,status,error,created_at) VALUES('original-inbox','original-message',?,?,?,'discussion','failed','Configure a discussion connection for this member.','2026-10-26T00:00:00Z')",workspace.id,conversation.id,recipient.id);
      expect(chat.page(workspace.id,conversation.id).messages[0]).toMatchObject({deliveryStatus:'failed',deliveryReason:'Configure a discussion connection for this member.'});
      expect(()=>collaboration.retryDelivery(workspace.id,'original-message')).toThrow();expect(calls).toHaveLength(0);
      store.exec("UPDATE provider_bindings SET runtime='codex',model='execution-model' WHERE id=?",recipient.providerBindingId!);
      expect(chat.validateAgentConnection(workspace.id,recipient.id)).toEqual({runtime:'codex',model:'execution-model'});
      store.exec('UPDATE roles SET chat_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'explicit-model'}),recipient.id);
      expect(chat.validateAgentConnection(workspace.id,recipient.id).model).toBe('explicit-model');store.exec('UPDATE roles SET chat_connection=NULL WHERE id=?',recipient.id);
      const receipt=collaboration.retryDelivery(workspace.id,'original-message');expect(receipt).toEqual({messageId:'original-message',inboxId:'original-inbox',state:'pending'});
      expect(collaboration.retryDelivery(workspace.id,'original-message')).toEqual(receipt);
      await vi.waitFor(()=>expect(calls).toHaveLength(1));const turnId=calls[0]!.input.turnId;
      expect(chat.turn(workspace.id,turnId).configuration.connection.model).toBe('execution-model');
      expect(collaboration.retryDelivery(workspace.id,'original-message').inboxId).toBe('original-inbox');
      if(terminal==='failed'){
        calls[0]!.finish({text:'The model failed after receiving the message.',stopReason:'failed'});
        await vi.waitFor(()=>expect(chat.turn(workspace.id,turnId).status).toBe('failed'));
      }else{
        store.exec("UPDATE agent_inbox SET status='interrupted',error='Runtime acceptance unknown' WHERE id='original-inbox'");
      }
      expect(()=>collaboration.retryDelivery(workspace.id,'original-message')).toThrow(/already have reached an execution/);
      expect(calls).toHaveLength(1);expect(store.all("SELECT id FROM agent_turns WHERE message_id='original-message'")).toHaveLength(1);
      expect(store.all("SELECT id FROM agent_inbox WHERE message_id='original-message'")).toHaveLength(1);
      expect(store.all("SELECT id FROM messages WHERE id='original-message'")).toHaveLength(1);
      if(terminal==='interrupted')expect(store.all('SELECT id FROM execution_leases WHERE owner_id=? AND released_at IS NULL',turnId)).toHaveLength(1);
    }finally{await chat.close();collaboration.close();store.close();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-blocked-review-'))throw new Error('Unsafe cleanup path');await rm(home,{recursive:true,force:true});}
  });

  it('preserves a blocked uncommitted attempt and accepts only a fresh completed attempt after Host collection, checks and independent review',async()=>{
    const folder=await mkdtemp(path.join(tmpdir(),'rift-blocked-review-')),repo=path.join(folder,'repository');
    await mkdir(repo);await gitOk(repo,['init','-q','-b','main']);await gitOk(repo,['config','core.autocrlf','false']);
    await writeFile(path.join(repo,'README.md'),'baseline\n');await gitOk(repo,['add','.']);await gitOk(repo,['-c','user.name=Review','-c','user.email=review@example.invalid','commit','-qm','baseline']);
    const base=await gitOk(repo,['rev-parse','HEAD']),store=new RiftStore(path.join(folder,'ledger.db'));
    const projects=new ProjectService(store,new Set(['controlled']));
    projects.createWorkspace({id:'blocked-review',name:'Independent recovery',rootPath:repo,repositoryPath:repo,commonGitDir:path.join(repo,'.git'),baseRef:'main'});
    projects.configureRoles('blocked-review',[{id:'controlled',providerName:'controlled',packageVersion:'test',configRevision:1,capabilities:{},credentialRefs:[]}],[{name:'lead',kind:'dsh-lead',prompt:'Lead',revision:1},{name:'developer',purpose:'developer',kind:'subagent',providerBindingId:'controlled',prompt:'Develop',revision:1},{name:'reviewer',purpose:'reviewer',kind:'subagent',providerBindingId:'controlled',prompt:'Review independently',revision:1}]);
    const starts:Started[]=[];
    const bridge:ActivationBridge={async start(input){let finish!:(result:ActivationResult)=>void;const result=new Promise<ActivationResult>(resolve=>{finish=resolve;});starts.push({...input,finish});return{childId:`controlled-${input.run.id}`,result,async dispose(){finish({stopReason:'cancelled',text:''});}};}};
    const git=new LocalGitService({managedRoot:path.join(folder,'managed'),commands:[{id:'content-check',executable:process.execPath,args:['-e',"const fs=require('node:fs'); if(fs.readFileSync('README.md','utf8')!=='implemented\\n'||fs.readFileSync('new.txt','utf8')!=='preserved untracked content\\n') process.exit(1)"]}]}),collect=vi.spyOn(git,'collectSource');
    const coordinator=new TaskCoordinator({store,bridge,git});
    const wait=async(predicate:()=>boolean)=>vi.waitFor(()=>expect(predicate()).toBe(true),{timeout:15000,interval:20});
    const finish=(execution:Started,outcome:'completed'|'blocked')=>execution.finish({stopReason:'completed',text:JSON.stringify({schemaVersion:1,taskId:execution.task.id,runId:execution.run.id,outcome,summary:outcome==='blocked'?'Implementation exists but developer could not write Git metadata.':'Developer has inspected and completed the new attempt; Host acceptance remains pending.',changedPaths:['README.md','new.txt'],checksClaimed:[],blockingReasons:outcome==='blocked'?['Sandbox denied Git metadata write; no acceptance claimed.']:[]})});
    try{
      const workflow=coordinator.createWorkflow({workspaceId:'blocked-review',goal:'Recover without bypassing acceptance',baseCommit:base,integrationRef:'refs/heads/rift/blocked-review'});
      const [task]=coordinator.submitPlan({workflowId:workflow.id,expectedRevision:0,tasks:[{id:'recover-change',kind:'change',title:'Recover implementation',instructions:'Implement the requested content. Host collects source after completed development.',expectedPaths:['README.md','new.txt']}]});
      coordinator.dispatch({taskId:task!.id,expectedVersion:task!.version,idempotencyKey:'first'});await wait(()=>starts.length===1);const first=starts[0]!;
      const initialPrompt=JSON.parse(first.prompt);
      expect(initialPrompt.developmentProtocol).toMatchObject({stage:'development-before-host-source-collection',instructions:expect.stringContaining('Local git add/commit is permitted')});
      expect(initialPrompt.developmentProtocol.instructions).toContain('not that the Task is accepted');
      await writeFile(path.join(first.cwd,'README.md'),'implemented\n');await writeFile(path.join(first.cwd,'new.txt'),'preserved untracked content\n');finish(first,'blocked');
      await wait(()=>store.task(task!.id).status==='blocked'&&store.run(first.run.id).cleanupStatus==='confirmed');
      expect(collect).not.toHaveBeenCalled();expect(store.task(task!.id)).toMatchObject({sourceHead:null,acceptedCommit:null});
      expect(await gitOk(first.cwd,['rev-parse','HEAD'])).toBe(base);expect(await gitOk(first.cwd,['status','--short'])).toContain('?? new.txt');
      expect(()=>coordinator.finish({workflowId:workflow.id,summary:'Cannot accept existing files'})).toThrow();
      const originalResult=store.run(first.run.id).result;
      const retry=coordinator.retry({taskId:task!.id,expectedVersion:store.task(task!.id).version,reason:'Reinspect preserved implementation under the correct Host collection contract'});
      coordinator.dispatch({taskId:task!.id,expectedVersion:retry.version,idempotencyKey:'repair'});await wait(()=>starts.length===2);const repair=starts[1]!;
      expect(repair.cwd).not.toBe(first.cwd);expect(await readFile(path.join(repair.cwd,'README.md'),'utf8')).toBe('baseline\n');
      await expect(readFile(path.join(repair.cwd,'new.txt'))).rejects.toMatchObject({code:'ENOENT'});
      expect(repair.prompt).toContain('Sandbox denied Git metadata write');
      const recoveryPrompt=JSON.parse(repair.prompt);
      expect(recoveryPrompt.previousAttemptWorktrees).toEqual([expect.objectContaining({attempt:1,path:first.cwd,baseCommit:base})]);
      expect(recoveryPrompt.previousAttemptPolicy).toContain('Never edit or commit the old checkout');
      expect(recoveryPrompt.retryContext.reason).toBe('Reinspect preserved implementation under the correct Host collection contract');
      // Explicit controlled developer recovery copies reviewed content into its
      // own new checkout. No ledger status or old Run result is rewritten.
      for(const file of ['README.md','new.txt'])await writeFile(path.join(repair.cwd,file),await readFile(path.join(first.cwd,file)));
      finish(repair,'completed');await wait(()=>starts.some(start=>start.run.purpose==='review'));
      const review=starts.find(start=>start.run.purpose==='review')!,candidate=(JSON.parse(review.prompt) as {candidate:Candidate}).candidate;
      expect(collect).toHaveBeenCalledOnce();expect(store.run(repair.run.id).cleanupStatus).toBe('confirmed');
      expect(store.task(task!.id).acceptedCommit).toBeNull();expect(candidate.checks).toEqual([expect.objectContaining({commandId:'content-check',exitCode:0,candidateHead:candidate.candidateHead})]);
      expect(await gitOk(repo,['rev-parse',workflow.integrationRef])).toBe(base);
      expect(()=>coordinator.finish({workflowId:workflow.id,summary:'Not yet reviewed'})).toThrow();
      review.finish({stopReason:'completed',text:JSON.stringify({schemaVersion:1,taskId:task!.id,runId:review.run.id,verdict:'approve',reviewedCommit:candidate.candidateHead,findings:[]})});
      await wait(()=>store.task(task!.id).status==='succeeded');
      expect(store.run(first.run.id).result).toEqual(originalResult);expect(await readFile(path.join(first.cwd,'new.txt'),'utf8')).toBe('preserved untracked content\n');
      expect(await gitOk(first.cwd,['rev-parse','HEAD'])).toBe(base);expect(await gitOk(repo,['rev-parse','main'])).toBe(base);
      expect(await gitOk(repo,['show',`${workflow.integrationRef}:new.txt`])).toBe('preserved untracked content');
      expect(coordinator.finish({workflowId:workflow.id,summary:'New attempt passed Host checks and independent review'}).status).toBe('completed');
    }finally{await coordinator.shutdown();store.close();if(path.dirname(folder)!==path.resolve(tmpdir())||!path.basename(folder).startsWith('rift-blocked-review-'))throw new Error('Unsafe test cleanup path');await rm(folder,{recursive:true,force:true});}
  },25000);
});
