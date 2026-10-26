/** Real SQLite + HTTP/SSE + built React UI; controlled runtime, no model calls. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { RiftHostService } from '../src/api/host-service.js';
import { startLocalApi } from '../src/api/local-api.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../src/agent/runtime-types.js';
import { publicError } from '../src/api/security.js';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RIFT_PLAYWRIGHT_MODULE??'C:/Users/李祉延/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const home=await mkdtemp(path.join(root,'collaboration-browser-'));
const evidence=path.resolve('docs/evidence/collaboration-ui');await mkdir(evidence,{recursive:true});
const report:Record<string,any>={date:new Date().toISOString(),mode:'real SQLite, loopback HTTP/SSE and built React UI in headless Edge; controlled runtime',home,environment:{platform:process.platform,node:process.version},checks:{}};
const until=async(test:()=>boolean,timeout=15000)=>{const deadline=Date.now()+timeout;while(!test()){if(Date.now()>deadline)throw Error('Condition timed out');await new Promise(r=>setTimeout(r,10));}};
const calls:{input:RuntimeTurnInput;finish:(r:RuntimeTurnResult)=>void}[]=[];
const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as never,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[]});
host.registerChatRuntime('codex',{async start(input){let finish!:(r:RuntimeTurnResult)=>void;const result=new Promise<RuntimeTurnResult>(resolve=>finish=resolve);calls.push({input,finish});return{result,async dispose(){}};}},['browser-model']);
let api:Awaited<ReturnType<typeof startLocalApi>>|undefined,browser:any;
try{
  await host.initialize();
  const workspace=await host.handleBrowser('POST','/ui-api/v1/workspaces',{name:'协作验收工作区',leadConnection:{runtime:'codex',model:'browser-model'}},'browser-workspace') as {id:string};
  const member=await host.handleBrowser('POST',`/ui-api/v1/workspaces/${workspace.id}/agents`,{displayName:'分析成员',name:'analyst',purpose:'developer',prompt:'Analyze the supplied text',chatConnection:{runtime:'codex',model:'browser-model'}},'browser-member') as {id:string};
  const conversation=host.chat.createConversation(workspace.id,'对话与任务协作');
  api=await startLocalApi(host,{home,port:0,uiDist:path.resolve('dist/ui')});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  const browserErrors:string[]=[];page.on('pageerror',(e:Error)=>browserErrors.push(e.message));
  const url=`http://127.0.0.1:${api.port}/#/workspace/${workspace.id}/chat`;
  await page.goto(url);await page.locator('textarea').waitFor();
  // Timestamp the DOM update in the browser. Locator retry intervals are not
  // UI latency and must not inflate this measurement.
  await page.evaluate(()=>{const state=(window as any).__probe={watchers:[] as any[],times:{} as Record<string,number>};new MutationObserver(()=>{for(const watch of state.watchers)if(!state.times[watch.key]&&[...document.querySelectorAll(watch.selector)].some((node:any)=>node.innerText.includes(watch.text)))state.times[watch.key]=Date.now();}).observe(document.body,{subtree:true,childList:true,characterData:true});});
  const receipts:number[]=[],terminal:number[]=[];
  for(let i=0;i<20;i++){
    const content=`普通咨询样本 ${i+1}：请简要解释这个词。`,reply=`咨询回答 ${i+1}：这是一次普通对话。`;
    await page.evaluate(({i,content,reply}:any)=>(window as any).__probe.watchers.push({key:`receipt-${i}`,text:content,selector:'.message.user'},{key:`terminal-${i}`,text:reply,selector:'.message.assistant'}),{i,content,reply});
    const sent=host.chat.send(workspace.id,conversation.id,{clientMessageId:`latency-${i}`,content});
    const committed=Date.now();
    await page.getByText(content,{exact:true}).waitFor();receipts.push(await page.evaluate((i:number)=>(window as any).__probe.times[`receipt-${i}`],i)-committed);
    await until(()=>calls.some(c=>c.input.turnId===sent.turn.id));
    if(i===0)await page.getByRole('link',{name:'Agent 1 运行 · 0 待定'}).waitFor({timeout:2000});
    if(i===0)await page.locator('.status-link').filter({hasText:'Agent 1 运行'}).waitFor({timeout:5000});
    calls.find(c=>c.input.turnId===sent.turn.id)!.finish({text:reply,stopReason:'completed'});
    await until(()=>host.chat.turn(workspace.id,sent.turn.id).status==='completed');
    const settled=Date.parse(host.chat.turn(workspace.id,sent.turn.id).endedAt!);
    await page.locator('.message.assistant').filter({hasText:reply}).waitFor();terminal.push(await page.evaluate((i:number)=>(window as any).__probe.times[`terminal-${i}`],i)-settled);
    if(i===0){await page.getByRole('link',{name:'Agent 0 运行 · 0 待定'}).waitFor({timeout:2000});report.checks.headerLifecycleFresh=true;}
    if(await page.getByText(reply,{exact:true}).count()!==1)throw Error('Final reply duplicated');
  }
  const stats=(values:number[])=>({samples:values.length,p95Ms:[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1],minMs:Math.min(...values),maxMs:Math.max(...values),values});
  report.performance={receiptToVisible:stats(receipts),settledToFinalVisible:stats(terminal),excludes:'External inference, task duration and runtime cleanup time'};
  report.checks.healthySseP95=report.performance.receiptToVisible.p95Ms<=1000&&report.performance.settledToFinalVisible.p95Ms<=1000;
  report.checks.consultationDidNotCreateWorkflow=!host.store.get('SELECT id FROM workflows WHERE workspace_id=?',workspace.id);
  const initial=host.chat.send(workspace.id,conversation.id,{clientMessageId:'delegate',content:'请分析这段需求，并将任务交给分析成员。'}).turn;
  await until(()=>calls.some(c=>c.input.turnId===initial.id));const lead=calls.find(c=>c.input.turnId===initial.id)!;
  const invoke=(name:string,args:unknown)=>lead.input.tools.find(t=>t.name===name)!.execute(args,lead.input.signal);
  const workflow=await invoke('rift_workflow_start',{mode:'analysis',goal:'分析需求'}) as {id:string};
  const delegation=await invoke('rift_delegate',{recipientAgentId:member.id,expectedPlanRevision:0,taskDraft:{id:'browser-analysis',kind:'analysis',title:'检查需求边界',instructions:'比较 alpha 和 beta 的需求边界',expectedPaths:[]},message:'请检查需求边界，完成后给出结论。',idempotencyKey:'browser-delegate'}) as {taskId:string;requestId:string};
  report.checks.defaultMode=!!host.orchestration.owner(workflow.id)&&!lead.input.tools.some(t=>t.name==='rift_wait');
  await invoke('rift_yield',{summary:'分析任务已交给成员。',taskIds:[delegation.taskId],requestIds:[delegation.requestId]});
  lead.finish({text:'分析任务已登记，结果会更新在这里。',stopReason:'completed'});
  await until(()=>host.chat.turn(workspace.id,initial.id).status==='completed');
  await page.locator('a.task-tag').filter({hasText:'检查需求边界'}).first().waitFor();
  const tag=page.locator('a.task-tag').filter({hasText:'检查需求边界'}).first();
  report.checks.tagAttached=await tag.locator('xpath=ancestor::article').count()===1;
  report.checks.composerEnabled=await page.locator('textarea').isEnabled();
  report.checks.firstReplyWhileMemberRunning=host.store.task(delegation.taskId).status==='running';
  await tag.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'desktop-chat.png')});
  await tag.click();await page.getByLabel('任务详情',{exact:true}).getByText('检查需求边界',{exact:true}).waitFor();
  report.checks.taskTagDeepLink=page.url().includes('?task=browser-analysis');
  await page.goto(url);await page.locator('a.task-tag').first().waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.locator('a.task-tag').last().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'mobile-chat.png')});
  report.checks.mobileNoOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
  report.checks.noDiagnosticNoise=!/阶段开始|最后有效进展|\bfailed\b/.test(await page.locator('.message-list').innerText());
  await page.setViewportSize({width:1280,height:900});
  // Disconnect the actual SSE stream, then append > 100 rows and interleave a
  // different workspace. Reconnect and page through all retained chat history.
  await context.setOffline(true);api.server.closeAllConnections();
  const foreign=await host.handleBrowser('POST','/ui-api/v1/workspaces',{name:'其他工作区',leadConnection:{runtime:'codex',model:'browser-model'}},'foreign-workspace') as {id:string};
  const append=(prefix:string,count:number)=>host.store.transaction(()=>{for(let i=0;i<count;i++){
    host.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at,sender_type,origin,visibility) VALUES(?,?,?,'user',?,'completed',?,'user','user','public')",`${prefix}-${i}`,workspace.id,conversation.id,`${prefix} ${i}`,new Date().toISOString());
    host.store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,occurred_at) VALUES(?,'probe.foreign',?,?)",foreign.id,`${prefix}-${i}`,new Date().toISOString());
  }});
  append('离线历史',205);await context.setOffline(false);
  await page.getByText('离线历史 204',{exact:true}).waitFor({timeout:20000});
  while(await page.getByRole('button',{name:'读取更早消息',exact:true}).count()){await page.getByRole('button',{name:'读取更早消息',exact:true}).click();await page.getByRole('button',{name:'正在读取…',exact:true}).waitFor({state:'hidden'});}
  report.checks.backlogAndHistory=(await page.locator('.message.user').filter({hasText:/离线历史 \d+/}).count())===205;
  report.checks.historyNoDuplicates=await page.getByText('离线历史 0',{exact:true}).count()===1;
  await context.setOffline(true);api.server.closeAllConnections();
  host.store.transaction(()=>{for(let i=0;i<10020;i++)host.store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,occurred_at) VALUES(?,'probe.retention',?,?)",foreign.id,`retention-${i}`,new Date().toISOString());});
  append('窗口恢复',1);await context.setOffline(false);
  await page.getByText('窗口恢复 0',{exact:true}).waitFor({timeout:20000});
  report.checks.retentionSnapshot=await page.getByText('离线历史 0',{exact:true}).count()===1;
  await page.reload();await page.getByText('窗口恢复 0',{exact:true}).waitFor();
  report.checks.refreshNoDuplicate=await page.getByText('窗口恢复 0',{exact:true}).count()===1;
  // Recreate both EventSources with their actual requests aborted. Confirm
  // network failures, then append just after a successful periodic chat poll.
  let blockedSseAttempts=0,failedSseRequests=0;
  const pollingResponses:number[]=[];
  page.on('requestfailed',(request:any)=>{if(/\/events\?/.test(request.url()))failedSseRequests++;});
  page.on('response',(response:any)=>{if(/\/conversations\/[^/]+\/messages$/.test(response.url())&&response.status()===200)pollingResponses.push(Date.now());});
  await page.route(/\/events\?/,async(route:any)=>{blockedSseAttempts++;await route.abort();});
  const fallbackReloadAt=Date.now();await page.reload();
  await page.getByText('窗口恢复 0',{exact:true}).waitFor();
  await until(()=>blockedSseAttempts>=2&&failedSseRequests>=2,10000);
  await until(()=>pollingResponses.some(timestamp=>timestamp>fallbackReloadAt+1200),10000);
  const priorPoll=pollingResponses.at(-1)!,fallbackStart=Date.now();append('轮询降级',1);
  await page.getByText('轮询降级 0',{exact:true}).waitFor({timeout:25000});
  report.performance.pollingFallback={samples:1,visibleMs:Date.now()-fallbackStart,healthySseTargetApplied:false,configuredChatPollingMs:1800,blockedSseAttempts,failedSseRequests,appendedAfterPollMs:fallbackStart-priorPoll,pollingResponseTimes:pollingResponses};
  report.checks.pollingFallback=true;report.browserErrors=browserErrors;report.checks.noBrowserErrors=browserErrors.length===0;
  report.status=Object.values(report.checks).every(Boolean)?'pass':'fail';
}catch(error){report.status='fail';report.error=publicError(error);}
finally{await browser?.close();await api?.close();await host.close();await writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status!=='pass')process.exitCode=1;}
