import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function serve(){ const server=await createServer({configFile:path.join(root,'ui/vite.config.ts'),root:path.join(root,'ui'),cacheDir:out+'vite-cache',server:{host:'127.0.0.1',port:5209,strictPort:true,fs:{allow:[root,'/data/projects/RIFT/node_modules','/data/projects/RIFT/packages/protocol']}}});await server.listen();return server; }
import * as f from './fixtures.mjs';
const require=createRequire(import.meta.url);
const playwrightPath=process.env.PLAYWRIGHT_PATH || '/data/projects/RIFT/.rift/workspaces/workspace-a6791aae-4934-4069-a7d9-870bf02d2539/workspace/playwright-tools/node_modules/playwright';
const {chromium}=require(playwrightPath);
const out=path.resolve(process.env.UI_EVIDENCE_DIR || '/data/projects/RIFT/.rift/workspaces/workspace-a6791aae-4934-4069-a7d9-870bf02d2539/workspace/playwright-tools/ui-fixes-c4d993cd')+'/', origin='http://127.0.0.1:5209';
await mkdir(out+'screens',{recursive:true});
const report={checkFilter:process.env.UI_CHECK_FILTER??null,startedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}),root,playwright:require(playwrightPath+'/package.json').version,mode:'isolated Vite; all API responses mocked; no real business writes',screens:[],checks:[],pageErrors:[],requests:[],unexpectedRequests:[]};
const checkFilter = process.env.UI_CHECK_FILTER ? new RegExp(process.env.UI_CHECK_FILTER) : null;
let state={empty:false,fail:'',delay:'',long:false,stale:false,unreferenced:false};let page,context,browser,server;
const savedConnections=[{id:'api-demo-1',name:'团队模型（模拟）',protocol:'openai-responses',endpoint:'https://example.invalid/v1',model:'audit-model',revision:1,available:true,verificationStatus:'unverified',verifiedAt:null,verification:null,verificationError:null}];
savedConnections.push({...savedConnections[0],id:'api-demo-2',name:'备用模型（模拟）'});
const removals=[{kind:'user',recordId:'tree-1',repositoryId:'repo-1',path:f.trees[0].path,state:'present',expectedVersion:1,canDelete:true,canReconcile:false,reason:null,error:null}];
// Per-request gates exercise real fetch/abort/route identity without timing guesses.
const taskReads = new Map();
function holdTask(id, status = 200) {
 let release; const gate = new Promise(resolve => { release = resolve; });
 const read = { status, gate, release, started: 0, finished: 0 };
 taskReads.set(id, read); return read;
}
function taskFixtures(){return [...f.tasks,...Array.from({length:31},(_,i)=>({...f.tasks[0],id:'page-task-'+i,workflowId:'workflow-2',repositoryId:'repo-2'}))];}
async function intercept(route){const r=route.request(),u=new URL(r.url()); if(!u.pathname.startsWith('/ui-api/')){if(u.origin!==origin){report.unexpectedRequests.push(r.url());return route.abort();}return route.continue();}
const p=u.pathname.replace('/ui-api/v1',''); report.requests.push({path:p,method:r.method(),mock:true}); let body,status=200;
const taskRead = /\/tasks\/[^/]+$/.test(p) ? taskReads.get(p.split('/').at(-1)) : null;
if (taskRead) {
 taskRead.started++; await taskRead.gate;
 await route.fulfill({status:taskRead.status,json:taskRead.status===200 ? {...f.tasks[2],id:p.split('/').at(-1),title:'外部深链任务'} : {error:{code:'PROVIDER_UNAVAILABLE',message:'mock task unavailable'}}});
 taskRead.finished++; return;
}
if(state.delay && p.endsWith(state.delay))await new Promise(r=>setTimeout(r,1800));
if(state.fail && (p===state.fail || p.endsWith(state.fail) || state.fail==='/session' && p==='/session/connect')){status=state.fail==='/session'?401:503;body={error:{code:'PROVIDER_UNAVAILABLE',message:'upstream connection refused (audit simulated)'}};}
else if(state.importCode && p.endsWith('/skills/preview')){status=400;body={error:{code:state.importCode,message:'/private/path Bearer test-secret'}};}
else if(r.method()!=='GET'){
 if(p.endsWith('/conversations')){body={...f.conversation,id:'conversation-'+(f.conversations.length+1),title:'新对话',version:0};f.conversations.unshift(body);}
 else if(p.endsWith('/verify')){await new Promise(r=>setTimeout(r,150));body={passed:false,error:'upstream timeout (audit simulated)',connection:savedConnections.find(c=>p.includes(c.id))};}
 else if(p.endsWith('/archive')){const skill=f.skills.find(s=>p.includes('/'+s.id+'/'));if(skill){skill.archived=1;skill.revision++;}body={ok:true};}
 else if(p.endsWith('/session/connect'))body={csrfToken:'audit-not-a-real-session',expiresAt:'2099-01-01T00:00:00Z'};
 else {status=409;body={error:{code:'VERSION_CONFLICT',message:'Version conflict: refresh and retry (audit simulated)'}};}
}else if(p==='/session')body={csrfToken:'audit-not-a-real-session',expiresAt:'2099-01-01T00:00:00Z'};
else if(p==='/workspaces')body={workspaces:state.empty?[]:f.workspaces,capabilities:f.capabilities,observedAt:f.now()};
else if(p==='/connections')body={configuration:{available:true,reason:null},connections:[{id:'dsh:anthropic',runtime:'dsh',provider:'anthropic',available:true,models:['Claude 3.7 Sonnet'],modelSelection:'free',tools:true},{id:'codex',runtime:'codex',available:true,models:['gpt-6.1-sol'],modelSelection:'verified-only',tools:true}],savedConnections,executionProviders:[]};
else if(p.endsWith('/tasks')){const all=taskFixtures();const filtered=all.filter(t=>(!u.searchParams.has('status')||u.searchParams.get('status').split(',').includes(t.status))&&['workflowId','repositoryId','roleId'].every(k=>!u.searchParams.has(k)||t[k]===u.searchParams.get(k)));const after=Number(u.searchParams.get('after')||0),end=after+30;body={tasks:filtered.slice(after,end),totalCount:filtered.length,nextAfter:end<filtered.length?end:null};}
else if(/\/tasks\/[^/]+$/.test(p)){body={...f.tasks[2],id:p.split('/').at(-1),title:'外部深链任务'};}
else if(p.endsWith('/messages')){const c=f.conversations.find(c=>c.id===p.split('/').at(-2))??f.conversation;body={conversation:c,messages:state.empty||c.id!==f.conversation.id?[]:f.messages,turns:[],chunks:[],nextBefore:null,snapshotCursor:1};}
else if(p.endsWith('/conversations'))body={conversations:state.empty?[]:f.conversations};
else if(p.endsWith('/skills'))body={skills:state.empty?[]:f.skills.map(s=>state.unreferenced?{...s,shared:null}:s)};
else if(p.endsWith('/worktrees'))body={worktrees:p.includes('repo-1')?f.trees:[],discovered:[],removals:p.includes('repo-1')?removals:[]};
else if(p.endsWith('/evidence'))body={taskId:p.split('/').at(-2),acceptedCommit:null,currentCandidate:null,integrations:[]};
else if(p==='/workspaces/wsp-001') {body=f.detail();body.hostCapacity={limits:{developers:3,reviewers:1,total:4,lead:1},occupied:{developers:1,reviewers:0,total:1,lead:0}};
 body.snapshotCursor=state.revision??1;
 if(state.large)body.tasks=taskFixtures();
 body.capabilities={...body.capabilities,pagination:{available:!!state.pagination}};
 body.workflows=[...body.workflows,{...body.workflows[0],id:'workflow-2',goal:'第二工作流'}];
 if(state.stale)body.observedAt='2026-01-01T00:00:00Z';
 if(state.empty)for(const k of ['tasks','roles','repositories','managedWorktrees','presence','workflows'])body[k]=[];
 if(state.long)body.roles=body.roles.map(r=>({...r,prompt:r.prompt.repeat(8),chatConnection:{...r.chatConnection,model:'long-audit-model-context-extended-version-20261030-'.repeat(3)}}));
}else {report.unexpectedRequests.push(p);status=404;body={error:{message:'Audit fixture route not implemented'}};}
await route.fulfill({status,json:body});}
async function go(name){await page.goto(`${origin}/?audit=${Date.now()}#/workspace/wsp-001/${name}`);await page.locator('.page-'+name.split('?')[0]).waitFor();await page.waitForTimeout(300);}
async function ready(){await page.waitForTimeout(180);await page.evaluate(()=>document.fonts.ready);}
async function snap(name){await ready();const file='screens/'+name+'.png';await page.screenshot({path:out+file,fullPage:true,animations:'disabled'});const measure=await page.evaluate(()=>{
 const cv=document.createElement('canvas');cv.width=cv.height=1;const ctx=cv.getContext('2d',{willReadFrequently:true});const rgba=v=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=v;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((n,i)=>i===3?n/255:n);};const mix=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[hidden],.sr-only');};const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};const label=e=>e.getAttribute('aria-label')||e.innerText?.trim().slice(0,100)||e.getAttribute('placeholder')||e.tagName;
 const controls=[...document.querySelectorAll('button,a,input,textarea,select,[role=checkbox],[role=tab],[role=radio]')].filter(visible).map(e=>({tag:e.tagName,slot:e.getAttribute('data-slot'),label:label(e),class:String(e.className),disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true',...box(e),pressed:e.getAttribute('aria-pressed'),selected:e.getAttribute('aria-selected'),checked:e.getAttribute('aria-checked')}));
 const contrasts=[];for(const e of [...document.querySelectorAll('main *,header *,aside *')].filter(visible)){if(![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||e.closest(':disabled,[aria-disabled=true]'))continue;let bg=[255,255,255],chain=[],x=e,excluded=false;while(x){chain.unshift(x);x=x.parentElement;}for(const a of chain){const s=getComputedStyle(a);if(Number(s.opacity)!==1||s.backgroundImage!=='none')excluded=true;bg=mix(rgba(s.backgroundColor),bg);}const s=getComputedStyle(e),fg=mix(rgba(s.color),bg),l1=lum(fg),l2=lum(bg),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);contrasts.push({text:e.textContent.trim().slice(0,90),class:String(e.className),foreground:fg,background:bg,ratio:Number(ratio.toFixed(2)),fontSize:s.fontSize,fontWeight:s.fontWeight,excluded,threshold:parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&parseInt(s.fontWeight)>=700)?3:4.5});}
 return {url:location.href,viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth,background:getComputedStyle(document.body).backgroundColor,sidebar:document.querySelector('.sidebar')?box(document.querySelector('.sidebar')):null,controls,contrasts,alerts:[...document.querySelectorAll('[role=alert]')].filter(visible).map(e=>e.innerText),statuses:[...document.querySelectorAll('[role=status]')].map(e=>e.innerText),headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>({tag:e.tagName,text:e.innerText,hidden:e.classList.contains('sr-only')}))};});report.screens.push({name,file,...measure});return measure;}
async function check(name,fn){if(checkFilter && !checkFilter.test(name))return;try{const data=await fn();report.checks.push({name,status:'passed',data});console.log('PASS',name);}catch(e){report.checks.push({name,status:'failed',error:e.stack});console.error('FAIL',name,e.message);await page?.screenshot({path:out+'screens/failed-'+name+'.png',fullPage:true}).catch(()=>{});}await writeFile(out+'measurements.json',JSON.stringify(report,null,2));}
const eq=assert.equal;
async function count(selector,n){await page.waitForFunction(({selector,n})=>document.querySelectorAll(selector).length===n,{selector,n});}
try{
server=await serve();browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'});report.browser=browser.version();context=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block'});await context.route('**/*',intercept);page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>report.pageErrors.push({url:page.url(),error:e.stack}));page.on('console',m=>{if(m.type()==='error') (report.consoleErrors??=[]).push(m.text());});
for(const width of [1280,768,390]){
 await page.setViewportSize({width,height:900});
 for(const name of ['workspaces','chat','agents','skills','repositories','tasks','activity','settings']) await check(`${name}-${width}`,async()=>{await go(name);await page.locator('.loading,.auth-card').waitFor({state:'hidden'});const m=await snap(`${name}-${width}`);eq(m.overflow,false);const low=m.contrasts.filter(c=>!c.excluded&&c.ratio<c.threshold&&c.text!=='/'&&!c.class.includes('rift-icon'));assert.deepEqual(low,[],'low contrast: '+JSON.stringify(low));return {overflow:m.overflow};});
 for(const [tab,label] of [['connections','API 连接'],['workspace','工作区'],['session','浏览器会话']]) await check(`settings-${tab}-${width}`,async()=>{await go('settings?tab='+tab);await page.getByRole('tab',{name:label,exact:true,selected:true}).waitFor();const m=await snap(`settings-${tab}-${width}`);eq(m.overflow,false);});
 if(width<1101) for(const [route,row] of [['skills','.skill-list-item'],['tasks','.task-card'],['activity','.activity-card']]) await check(`detail-${route}-${width}`,async()=>{await go(route);const item=page.locator(row).last();await item.scrollIntoViewIfNeeded();const before=await page.evaluate(()=>scrollY);await item.click();await page.locator('.detail-back').waitFor({state:'visible'});eq(await page.evaluate(()=>document.activeElement.className),'detail-pane');eq(await page.locator(row).first().isVisible(),false);assert.ok((await page.locator('.detail-back').boundingBox()).y>=56);await snap(`detail-${route}-${width}`);await page.getByRole('button',{name:'返回列表',exact:true}).click();await page.waitForFunction(e=>e===document.activeElement,await item.elementHandle());assert.ok(Math.abs((await page.evaluate(()=>scrollY))-before)<3);return {returnedScroll:before};});
}
await page.setViewportSize({width:1280,height:900});
await check('keyboard-entry',async()=>{await go('chat');await page.keyboard.press('Tab');eq(await page.evaluate(()=>document.activeElement.className),'skip-link');await snap('skip-link');await page.keyboard.press('Enter');eq(await page.evaluate(()=>document.activeElement.id),'main');await page.locator('#live-draft').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');const style=await page.locator('.composer').evaluate(e=>({outline:getComputedStyle(e).outlineWidth,color:getComputedStyle(e).outlineColor}));eq(style.outline,'2px');await snap('composer-focus');return style;});
await check('shortcuts',async()=>{for(const key of ['Control+k','Meta+k']){await go('agents');eq(await page.locator('.search-field kbd').count(),0);const before=f.conversations.length;await page.keyboard.press(key);await page.waitForFunction(()=>document.activeElement.id==='live-draft');eq(f.conversations.length,before+1);} });
await check('pickers-escape-selection',async()=>{await go('chat');await page.locator('.recipient-button').first().click();eq(await page.locator('.mention-menu [aria-pressed=true]').count(),1);await page.locator('.mention-menu button').nth(1).focus();await page.keyboard.press('Escape');await count('.mention-menu',0);eq(await page.locator('.recipient-button').first().evaluate(e=>e===document.activeElement),true);await page.locator('.recipient-button').nth(1).click();await page.locator('.context-picker button').first().focus();await page.keyboard.press('Escape');await count('.context-picker',0);eq(await page.locator('.recipient-button').nth(1).evaluate(e=>e===document.activeElement),true);});
await check('agent-dialog-focus',async()=>{await go('agents');for(const trigger of [page.getByRole('button',{name:'添加 Agent',exact:true}),page.getByRole('button',{name:'配置',exact:true}).nth(1)]){await trigger.click();await page.getByRole('dialog').waitFor();eq(await page.getByRole('dialog').locator('h2').count(),1);await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForTimeout(250);eq(await trigger.evaluate(e=>e===document.activeElement),true);}});
await check('skill-archive',async()=>{await go('skills');eq(await page.locator('.skill-list-item[aria-pressed=true]').count(),1);const writes=()=>report.requests.filter(r=>r.path.endsWith('/archive')).length;const before=writes();await page.getByRole('button',{name:'归档此 Skill',exact:true}).click();eq(writes(),before);eq(await page.getByRole('button',{name:'确认归档 Skill',exact:true}).isDisabled(),true);await snap('skill-referenced-confirm');await page.getByRole('button',{name:'取消归档',exact:true}).click();eq(writes(),before);state.unreferenced=true;await go('skills');await page.getByRole('tab',{name:'全部',exact:true}).click();await page.getByRole('button',{name:'归档此 Skill',exact:true}).click();await page.getByRole('button',{name:'确认归档 Skill',exact:true}).click();await page.getByText('已归档“工程协作与代码规范”。历史版本和执行快照仍可查看。',{exact:true}).waitFor();eq(writes(),before+1);await snap('skill-archived');state.unreferenced=false;f.skills[0].archived=0;});
await check('connection-recovery',async()=>{state.fail='/connections';await go('settings?tab=connections');await page.getByText(/目录读取失败/).waitFor();await snap('connection-load-error');state.fail='';await page.getByRole('button',{name:'刷新连接目录',exact:true}).click();await page.getByText(/目录读取失败/).waitFor({state:'hidden'});const rows=page.locator('.saved-connection');await rows.first().getByRole('button',{name:'验证实际对话与工具调用',exact:true}).click();await rows.first().locator('.form-error[role=status]').waitFor();eq(await rows.nth(1).locator('.form-error[role=status]').count(),0);await page.getByRole('button',{name:'刷新连接目录',exact:true}).click();await ready();await rows.first().locator('.form-error[role=status]').waitFor();await rows.nth(1).getByRole('button',{name:'验证实际对话与工具调用',exact:true}).click();await rows.nth(1).locator('.form-error[role=status]').waitFor();await page.getByRole('button',{name:'添加连接',exact:true}).waitFor({state:'visible'});eq(await rows.first().getByRole('button',{name:'验证实际对话与工具调用'}).getAttribute('aria-describedby'),'verification-api-demo-1');await snap('connection-verify-errors');await page.getByRole('button',{name:'添加连接',exact:true}).click();await page.locator('input[name=name]').fill('保留草稿');await page.locator('input[name=endpoint]').fill('https://example.invalid/v1');await page.locator('input[name=model]').fill('mock-model');await page.locator('input[name=apiKey]').fill('mock-secret-do-not-display');await page.getByRole('button',{name:'保存新连接版本',exact:true}).click();await page.getByText(/配置已更新/).waitFor();eq(await page.locator('input[name=name]').inputValue(),'保留草稿');eq(await page.locator('.api-connection-form').innerText().then(t=>t.includes('mock-secret-do-not-display')),false);await snap('connection-save-error');});
await check('deep-links-evidence',async()=>{await go('tasks?task=task-105');for(const id of ['task-106','task-105','task-106']){await page.locator('.task-card').filter({hasText:id}).click();await page.waitForFunction(id=>location.hash.endsWith('?task='+id),id);await count('.task-evidence',1);await page.getByRole('button',{name:'刷新证据',exact:true}).waitFor();}await snap('task-106-evidence');await page.reload();await page.locator('.task-card[aria-pressed=true]').filter({hasText:'task-106'}).waitFor();await page.goBack();await page.locator('.task-card[aria-pressed=true]').filter({hasText:'task-105'}).waitFor();await page.goForward();await page.locator('.task-card[aria-pressed=true]').filter({hasText:'task-106'}).waitFor();await go('settings');await page.getByRole('tab',{name:'API 连接',exact:true}).click();await page.getByRole('tab',{name:'浏览器会话',exact:true}).click();await page.reload();await page.getByRole('tab',{name:'浏览器会话',selected:true,exact:true}).waitFor();assert.match(await page.locator('h1').innerText(),/浏览器会话/);await page.goBack();await page.getByRole('tab',{name:'API 连接',selected:true,exact:true}).waitFor();await page.goForward();await page.getByRole('tab',{name:'浏览器会话',selected:true,exact:true}).waitFor();});
await check('notice-and-loading',async()=>{await go('settings');eq(await page.locator('.notice[role=alert]').count(),0);state.delay='/skills';await go('skills');await page.getByRole('status').filter({hasText:'正在读取 Skill 库'}).waitFor();await snap('skill-loading');state.delay='';});
await check('copy-rejection-and-fallback',async()=>{await go('settings?tab=workspace');await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))}}));const button=page.getByRole('button',{name:'复制 wsp-001',exact:true});await button.click();await button.locator('..').getByRole('status').filter({hasText:'复制失败'}).waitFor();await snap('copy-rejected');await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});document.execCommand=()=>false;});await button.click();await button.locator('..').getByRole('status').filter({hasText:'复制失败'}).waitFor();await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.resolve()}}));await button.click();await button.locator('..').getByRole('status').filter({hasText:'已复制到剪贴板'}).waitFor();});
await check('stale-and-sync',async()=>{state.stale=true;await go('agents');assert.match(await page.locator('.status-link').innerText(),/上次观测/);await snap('stale-observation');state.stale=false;state.fail='/workspaces/wsp-001';await page.getByRole('button',{name:'刷新记录',exact:true}).click();await page.getByText('数据尚未同步',{exact:true}).waitFor();assert.match(await page.locator('.host-status').innerText(),/会话已连接.*数据未同步/);await snap('sync-error');state.fail='';await page.getByRole('button',{name:'重新同步',exact:true}).click();await page.getByText('数据尚未同步',{exact:true}).waitFor({state:'hidden'});});
await check('model-details',async()=>{state.long=true;await go('agents');await page.getByRole('button',{name:'更多操作：界面实现',exact:true}).click();await page.getByRole('menuitem',{name:'连接与执行详情',exact:true}).click();assert.match(await page.locator('.agent-more:not([hidden])').innerText(),/对话模型：long-audit-model-context-extended-version-20261030-/);await snap('long-model-details');state.long=false;});
await check('mobile-targets',async()=>{await page.setViewportSize({width:390,height:900});for(const name of ['workspaces','chat','agents','skills','repositories','tasks','activity','settings']){await go(name);if(name==='chat')await page.locator('#live-draft').fill('可发送草稿');const m=await snap('targets-'+name);const targets=m.controls.filter(c=>!c.disabled&&(c.tag==='BUTTON'||c.slot==='button')&&!c.class.includes('checkbox'));assert.deepEqual(targets.filter(c=>c.width<43.9||c.height<43.9),[]);const hit=await page.locator('button:visible').evaluateAll(ns=>ns.filter(e=>!e.disabled&&e.getAttribute('role')!=='checkbox').filter(e=>{const r=e.getBoundingClientRect();if(r.top<56||r.bottom>innerHeight)return false;const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&!e.contains(hit);}).map(e=>e.textContent));assert.deepEqual(hit,[]);}await go('agents');await page.getByRole('button',{name:'添加 Agent',exact:true}).click();await snap('agent-dialog-390');await page.keyboard.press('Escape');});
await check('form-error-drafts',async()=>{await page.setViewportSize({width:1280,height:900});await go('skills');await page.getByRole('button',{name:'导入 Skill',exact:true}).click();await page.locator('input[name=directory]').fill('/mock/skill');await page.getByRole('button',{name:'预览内容',exact:true}).click();await page.getByText(/配置已更新/).waitFor();eq(await page.locator('input[name=directory]').inputValue(),'/mock/skill');await snap('skill-import-error');await go('chat');await page.locator('#live-draft').fill('失败后保留的草稿');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText(/草稿已保留/).waitFor();eq(await page.locator('#live-draft').inputValue(),'失败后保留的草稿');await snap('send-error');});
await check('session-recovery',async()=>{state.fail='/session';await go('settings');await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();await snap('session-expired');state.fail='';await page.getByRole('button',{name:'重新连接',exact:true}).click();await page.getByRole('tab',{name:'主 Agent',exact:true}).waitFor();});
await check('narrow-deep-link-keyboard',async()=>{await page.setViewportSize({width:390,height:900});await go('tasks?task=task-106');await page.locator('.detail-back').waitFor({state:'visible'});await page.getByRole('button',{name:'返回列表',exact:true}).click();eq(await page.locator('.task-card[aria-pressed=true]').evaluate(e=>e===document.activeElement),true);await page.keyboard.press('Enter');await page.locator('.detail-back').waitFor({state:'visible'});eq(await page.evaluate(()=>document.activeElement.className),'detail-pane');assert.ok((await page.locator('.detail-back').boundingBox()).y>=56);await snap('task-deep-link-390');});
await check('contrast-interaction-states',async()=>{await page.setViewportSize({width:390,height:900});for(const name of ['agents','settings']){await go(name);const tab=page.getByRole('tab').nth(1);await tab.hover();let m=await snap(name+'-tab-hover');assert.deepEqual(m.contrasts.filter(c=>!c.excluded&&c.ratio<c.threshold&&c.text!=='/'&&!c.class.includes('rift-icon')),[]);await tab.click();m=await snap(name+'-tab-selected');assert.deepEqual(m.contrasts.filter(c=>!c.excluded&&c.ratio<c.threshold&&c.text!=='/'&&!c.class.includes('rift-icon')),[]);} });
await check('repository-summary-wrap',async()=>{const measurements=[];for(const width of [390,767,768,1100,1101,1280]){await page.setViewportSize({width,height:900});await go('repositories');const rects=await page.locator('.metric-card strong').evaluateAll(nodes=>nodes.map((node,i)=>{const word=['已挂载','工作目录','资源占用'][i],text=[...node.childNodes].find(n=>n.nodeType===3&&n.textContent.includes(word)),range=document.createRange();const start=text.textContent.indexOf(word);range.setStart(text,start);range.setEnd(text,start+word.length);return {text:word,lines:range.getClientRects().length,font:getComputedStyle(node).fontSize};}));assert.ok(rects.every(r=>r.lines===1));measurements.push({width,rects});}return measurements;});
await check('landscape-and-reduced-motion',async()=>{await page.setViewportSize({width:844,height:390});await page.emulateMedia({reducedMotion:'reduce'});await go('chat');const m=await snap('chat-landscape');eq(m.overflow,false);});

for (const width of [390,768]) await check(`task-history-${width}`,async()=>{
  await page.setViewportSize({width,height:900});await go('tasks');
  const row=page.locator('.task-card').filter({hasText:'task-106'});
  await row.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);
  await row.click();await page.locator('.detail-open').waitFor();
  await page.goBack();await page.locator('.detail-open').waitFor({state:'hidden'});
  assert.ok(!page.url().includes('task='));eq(await row.evaluate(e=>e===document.activeElement),true);
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scroll)<3);
  await snap(`history-list-${width}`);
  await page.goForward();await page.locator('.detail-open').waitFor();
  assert.match(await page.locator('[aria-label="任务详情"]').innerText(),/task-106/);
  eq(await page.evaluate(()=>document.activeElement.className),'detail-pane');
  await page.getByRole('button',{name:'返回列表',exact:true}).click();
  await page.waitForFunction(()=>!location.hash.includes('task='));await row.waitFor({state:'visible'});
  await page.goBack();await page.locator('.detail-open').waitFor();
  await page.goForward();await row.waitFor({state:'visible'});
  await row.focus();await page.keyboard.press('Enter');await page.locator('.detail-open').waitFor();
  await page.reload();await page.locator('.detail-open').waitFor();
  assert.match(await page.locator('[aria-label="任务详情"]').innerText(),/task-106/);
  await page.locator('[aria-label="任务详情"] code').first().focus();
  const before=await page.evaluate(()=>({scroll:scrollY,tag:document.activeElement.outerHTML}));
  // Refresh workspace data without a navigation or click moving keyboard focus.
  state.revision=2;await page.getByRole('button',{name:'刷新记录',exact:true}).evaluate(e=>e.click());await ready();state.revision=1;
  eq(await page.evaluate(()=>document.activeElement.outerHTML),before.tag);
  eq(await page.evaluate(()=>scrollY),before.scroll);
  await snap(`history-detail-${width}`);
  await go('tasks?task=task-105');await page.locator('.detail-open').waitFor();
  await page.evaluate(()=>{location.hash='#/workspace/wsp-001/tasks?task=task-106';});
  await page.waitForFunction(()=>document.querySelector('[aria-label="任务详情"]').textContent.includes('task-106'));
  await page.goBack();await page.waitForFunction(()=>document.querySelector('[aria-label="任务详情"]').textContent.includes('task-105'));
  await page.goForward();await page.waitForFunction(()=>document.querySelector('[aria-label="任务详情"]').textContent.includes('task-106'));
});
await check('task-filter-pagination',async()=>{
 await page.setViewportSize({width:1280,height:900});
 try {
  for(const pagination of [false,true]){
   state.pagination=pagination;state.large=!pagination;
   for(const filter of ['status','workflow','repository']){
    await go('tasks');await page.getByRole('region',{name:'任务列表'}).locator('.task-card').filter({hasText:'task-106'}).click();
    if(filter==='status')await page.getByRole('button',{name:'进行中',exact:true}).click();
    if(filter==='workflow')await page.locator('.workflow-select select').selectOption('workflow-2');
    if(filter==='repository'){await page.getByRole('button',{name:'筛选',exact:true}).click();await page.locator('.task-extra-filters select').nth(1).selectOption('repo-2');}
    await page.getByRole('region',{name:'链接指定的任务',exact:true}).waitFor();
    const list=page.getByRole('region',{name:'任务列表',exact:true});
    eq(await list.locator('.task-card').filter({hasText:'task-106'}).count(),0);
    eq(await list.locator('.task-card').count(),30);
    assert.match(await page.locator('[aria-label="任务详情"]').innerText(),/task-106/);
    const m=await snap(`filter-${filter}-${pagination?'server':'local'}`);eq(m.overflow,false);
   }
   await go('tasks');await page.locator('.task-card').filter({hasText:'task-106'}).click();
   await page.getByRole('button',{name:'下一页',exact:true}).click();
   await page.getByRole('region',{name:'链接指定的任务',exact:true}).waitFor();
   eq(await page.getByRole('region',{name:'任务列表',exact:true}).locator('.task-card').count(),5);
   await snap(`pagination-${pagination?'server':'local'}`);
   await page.getByRole('button',{name:'上一页',exact:true}).click();
   await page.getByRole('region',{name:'链接指定的任务',exact:true}).waitFor({state:'hidden'});
   await page.locator('.task-card[aria-pressed=true]').filter({hasText:'task-106'}).waitFor();
   await page.getByRole('button',{name:'筛选',exact:true}).click();
   await page.locator('.task-extra-filters select').nth(1).selectOption('repo-2');
   await page.getByRole('button',{name:'已通过',exact:true}).click();
   await page.getByText('当前页没有匹配任务，请切换筛选。',{exact:true}).waitFor();
   eq(await page.getByRole('region',{name:'任务列表',exact:true}).locator('.task-card').count(),0);
   await page.getByRole('button',{name:'清除链接选择',exact:true}).click();
   await page.getByRole('heading',{name:'这个筛选下没有任务'}).waitFor();
  }
  state.pagination=true;state.large=false;
  await page.setViewportSize({width:390,height:900});await go('tasks?task=task-remote');
  await page.locator('.detail-open').waitFor();assert.match(await page.locator('[aria-label="任务详情"]').innerText(),/task-remote/);
  await page.reload();await page.locator('.detail-open').waitFor();await snap('external-deep-link-390');
 }finally{state.pagination=false;state.large=false;}
});
for (const width of [390,768,1280]) await check(`task-target-lifecycle-${width}`,async()=>{
 await page.setViewportSize({width,height:900});
 const id='task-remote', path=`/workspaces/wsp-001/tasks/${id}`;
 const pending=holdTask(id);const requestStart=report.requests.length;
 const status=page.getByRole('region',{name:'链接任务读取状态',exact:true});
 const detail=page.locator('aside[aria-label="任务详情"]');
 try {
  await go(`tasks?task=${id}`);
  await status.getByRole('status').filter({hasText:'正在读取链接指定的任务'}).waitFor();
  assert.ok(pending.started>=1);eq(await detail.count(),0);eq(await page.locator('.task-evidence').count(),0);
  eq(report.requests.slice(requestStart).filter(r=>r.path.endsWith('/evidence')).length,0);
  eq((await snap(`target-loading-${width}`)).overflow,false);
  pending.release();await detail.locator('code').filter({hasText:id}).first().waitFor();
  await page.locator('.task-evidence [role=status]').waitFor({state:'hidden'});
  eq(await status.count(),0);
  // Same-target refresh keeps its own details and evidence, then exposes a recoverable error.
  const refresh=holdTask(id,503);state.revision=11;
  await page.getByRole('button',{name:'刷新记录',exact:true}).evaluate(e=>e.click());
  await status.getByRole('status').filter({hasText:'正在刷新此任务'}).waitFor();
  assert.match(await detail.innerText(),/task-remote/);eq(await page.locator('.task-evidence').count(),1);
  refresh.release();await status.getByRole('status').filter({hasText:'刷新失败'}).waitFor();
  assert.match(await detail.innerText(),/task-remote/);
  const retry=holdTask(id);retry.release();await status.getByRole('button',{name:'重试读取任务'}).click();
  await status.waitFor({state:'hidden'});assert.match(await detail.innerText(),/task-remote/);
  // A new target must not inherit that successful target, even before its effect runs.
  const failed=holdTask('task-missing',503);
  await page.evaluate(()=>{location.hash='#/workspace/wsp-001/tasks?task=task-missing';});
  await status.getByRole('status').filter({hasText:'正在读取链接指定的任务'}).waitFor();
  eq(await detail.count(),0);eq(await page.locator('.task-evidence').count(),0);
  failed.release();await status.getByRole('status').filter({hasText:'未能读取此任务'}).waitFor();
  eq(await detail.count(),0);eq(await page.locator('.task-evidence').count(),0);
  eq((await snap(`target-error-${width}`)).overflow,false);
  const recovered=holdTask('task-missing');
  await status.getByRole('button',{name:'重试读取任务'}).click();
  await status.getByRole('status').filter({hasText:'正在读取链接指定的任务'}).waitFor();
  eq(await detail.count(),0);recovered.release();
  await detail.locator('code').filter({hasText:'task-missing'}).first().waitFor();
  eq(await status.count(),0);eq((await snap(`target-recovered-${width}`)).overflow,false);
  const evidence=report.requests.slice(requestStart).filter(r=>r.path.endsWith('/evidence')).map(r=>r.path);
  assert.ok(evidence.length>=2);assert.ok(evidence.every(p=>[path+'/evidence','/workspaces/wsp-001/tasks/task-missing/evidence'].includes(p)));
  // The failure escape route restores the ordinary list/default selection.
  const exit=holdTask('task-exit',503);exit.release();
  await page.evaluate(()=>{location.hash='#/workspace/wsp-001/tasks?task=task-exit';});
  await status.getByRole('button',{name:'返回任务列表'}).click();
  await page.waitForFunction(()=>!location.hash.includes('task='));
  await page.locator('.task-card').first().waitFor({state:'visible'});
  assert.match(await detail.innerText(),/task-104/);
  return {evidence,delayedTarget:id,failedTarget:'task-missing',sameTargetRefreshRetained:true};
 } finally { for(const read of taskReads.values())read.release();taskReads.clear();state.revision=1; }
});
await check('task-target-late-response',async()=>{
 await page.setViewportSize({width:390,height:900});
 const results=[];
 try {
  for(const statusCode of [200,503]) {
   const a=holdTask('task-a',statusCode),b=holdTask('task-b');
   const start=report.requests.length;
   await go('tasks?task=task-a');
   await page.getByRole('status').filter({hasText:'正在读取链接指定的任务'}).waitFor();assert.ok(a.started>=1);
   await page.evaluate(()=>{location.hash='#/workspace/wsp-001/tasks?task=task-b';});
   await page.getByRole('region',{name:'链接任务读取状态',exact:true}).getByText('task-b',{exact:true}).waitFor();
   eq(await page.locator('[aria-label="任务详情"]').count(),0);
   b.release();await page.locator('[aria-label="任务详情"] code').filter({hasText:'task-b'}).first().waitFor();
   a.release();
   // The earlier fetch may be aborted by the browser, but its mock handler must finish.
   await ready();eq(a.finished,a.started);
   assert.match(await page.locator('[aria-label="任务详情"]').innerText(),/task-b/);
   eq(await page.getByRole('region',{name:'链接任务读取状态',exact:true}).count(),0);
   const evidence=report.requests.slice(start).filter(r=>r.path.endsWith('/evidence')).map(r=>r.path);
   assert.ok(evidence.length>=1);assert.ok(evidence.every(p=>p==='/workspaces/wsp-001/tasks/task-b/evidence'));
   results.push({lateStatus:statusCode,evidence});
   await snap(`target-late-${statusCode}-390`);taskReads.clear();
  }
  return results;
 } finally {for(const read of taskReads.values())read.release();taskReads.clear();}
});
await check('skill-import-validation',async()=>{
 await page.setViewportSize({width:390,height:900});await go('skills');
 await page.getByRole('button',{name:'导入 Skill',exact:true}).click();await page.locator('input[name=directory]').fill('/mock/skill');
 try{for(const [code,fragment] of [['SKILL_SIZE_LIMIT','256 KiB'],['SKILL_ENCODING','UTF-8'],['UNKNOWN','核对输入']]){
  state.importCode=code;await page.getByRole('button',{name:'预览内容',exact:true}).click();
  const error=page.locator('.error-banner');await error.filter({hasText:fragment}).waitFor();
  assert.ok(!(await error.innerText()).includes('test-secret'));assert.ok(!(await error.innerText()).includes('/private/path'));
  eq(await page.locator('input[name=directory]').inputValue(),'/mock/skill');
  const m=await snap('import-'+code);eq(m.overflow,false);
 }}finally{state.importCode='';}
});

assert.deepEqual(report.unexpectedRequests,[]);assert.deepEqual(report.pageErrors,[]);
}catch(e){report.fatal=e.stack;console.error(e);}finally{await browser?.close();await server?.close();report.cleanup={browserClosed:true,serverClosed:true};report.finishedAt=new Date().toISOString();await writeFile(out+'measurements.json',JSON.stringify(report,null,2));}
if(report.fatal||report.checks.some(c=>c.status==='failed'))process.exitCode=1;
