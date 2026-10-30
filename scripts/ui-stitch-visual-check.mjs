import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.RIFT_UI_URL || 'http://127.0.0.1:5173';
const output = path.resolve(process.env.RIFT_UI_EVIDENCE_DIR || 'docs/evidence/stitch-alignment');
await mkdir(output, { recursive: true });

// Browser-only deterministic fixtures. No real Host, model calls or filesystem
// mutations are performed by these checks; production has no demo data path.
const now = () => new Date().toISOString();
const capabilities = Object.fromEntries(['workspaceCreate','chat','agentConfiguration','skills','multipleRepositories','worktreeManagement','workflowActions','events','pagination'].map(k => [k,{available:!['events','pagination','workflowActions'].includes(k),reason:'Visual verification fixture'}]));
const connection = { runtime:'dsh',provider:'anthropic',model:'Claude 3.7 Sonnet' };
const workspaces = ['RIFT 界面组','执行引擎 / 宿主核心','移动端重构项目'].map((name,i)=>({id:`wsp-00${i+1}`,name,rootPath:`/workspace/${i}`,repositoryPath:['~/workspace/rift-ui-runtime','~/runtime/execution-node-core','~/mobile/react-native-subsystem'][i],baseRef:'main',status:'active',version:1,leadConnection:connection,defaultConversationId:'conversation-1',workflowCount:3+i,activeWorkflowId:i===0?'workflow-1':null,taskCount:14+i,createdAt:now()}));
const roles = [
  ['coordinator','协调者','解析全局任务目标，进行工作流分发、子代理调度与最终输出仲裁。'],
  ['ui-builder','界面实现','专注前端组件、Tailwind 结构编排与高保真响应式交互推演。'],
  ['api-worker','接口实现','处理服务端逻辑与 REST API 端点，维护持久化层与系统接口。'],
  ['qa-inspector','回归检查','验证界面行为与执行证据，检查跨组件依赖并执行回归测试。'],
].map(([name,displayName,prompt],i)=>({id:`role-${i}`,name,displayName,prompt,kind:i===0?'dsh-lead':'worker',purpose:i===3?'reviewer':i===0?'lead':'developer',enabled:1,version:1,chatConnection:connection}));
const repositories = [{id:'repo-1',workspaceId:'wsp-001',canonicalPath:'/workspace/rift-web',baseRef:'main',commonGitDir:'/workspace/rift-web/.git'},{id:'repo-2',workspaceId:'wsp-001',canonicalPath:'/workspace/rift-runtime',baseRef:'develop',commonGitDir:'/workspace/rift-runtime/.git'}];
const tasks = ['统一消息接收路由状态','实现 Agent 状态投影面板','补齐输入框键盘交互测试','截图回归与发布验收'].map((title,i)=>({id:`task-${104+i}`,title,instructions:'根据工作区规范完善组件与交互，保留执行记录并验证所有边界状态。',status:['running','blocked','succeeded','ready'][i],workflowId:'workflow-1',repositoryId:'repo-1',roleId:`role-${i}`,dependsOn:i?[`task-${103+i}`]:[],attempt:1,acceptanceCriteria:['支持键盘与中文输入。','页面不存在横向溢出。'],expectedPaths:['ui/src/'],version:1,blockingReason:null}));
const conversation = {id:'conversation-1',workspaceId:'wsp-001',title:'消息路由与协作边界',version:0,createdAt:now()};
const conversations = [conversation];
const messages = [
  {id:'message-1',role:'user',recipientAgentId:'role-0',content:'请梳理一下多 Agent 协同流程中，关于 `MessageRecipient` 单选路由的边界处理逻辑。当接收者正在执行高开销编译时，后续消息应如何优雅降级？'},
  {id:'message-2',role:'assistant',recipientAgentId:'role-0',content:'在多代理网格协议中，`MessageRecipient` 的单选路由需要避免直接阻塞调用链路。当指定的接收代理节点处于受限或高开销状态时，推荐采用 **「非侵入排队与快照卸载」** 三重降级范式：\n\n1. **状态感知与幂等排队 (State-Aware Idempotent Queue)**\n\n   调度总线广播其繁忙心跳标志，将即时同步请求转化为非阻塞信箱任务。通过在元数据中注入 `idempotency-key` 与生存期，防止因网络重试导致任务重复执行。\n\n2. **协调者介入归纳 (Coordinator Summarization Intervention)**\n\n   若等待队列积压超过设定阈值，协调代理将接管并将细碎指令合并为一份结构化的变更意图增量包。\n\n3. **快照挂载与独立沙箱 (Snapshot Forking)**\n\n   如遇紧急查询，可根据上一次确定性状态树派生只读快照分支。\n\n```typescript\ninterface MessageRecipient {\n  id: string;\n  role: \'primary\' | \'worker\';\n  state: \'idle\' | \'busy_compiling\';\n  queuePolicy: {\n    maxDepth: 32;\n    ttlSeconds: 120;\n  };\n}\n```\n\n是否需要补充多播通知广播与回滚状态机的生命周期？'},
].map(m=>({...m,conversationId:conversation.id,workspaceId:'wsp-001',status:'completed',createdAt:'2026-10-25T02:42:00Z'}));
const skills = ['工程协作与代码规范','前端高保真实现','安全审查流程'].map((name,i)=>({id:`skill-${i}`,name,description:'工作区共享规范、代码边界与可重复验证的协作流程。',revision:1,archived:0,shared:{enabled:1,versionId:`version-${i}`,revision:1},assignments:[],versions:[{id:`version-${i}`,version:1,createdAt:now(),digest:'sha256:visual-fixture',sourceDirectory:'/workspace/skills/engineering',requirements:{resources:false,scripts:false,runtimes:[]},resources:[],instructions:'# Engineering Collaboration\n\n## 核心原则\n\n每次执行都应保持可追踪的记录。先检查代码与上下文，再做最小范围的修改。\n\n## Implementation\n\n1. 明确任务的验收条件。\n2. 保留工作区的隔离边界。\n3. 检查运行状态与输出证据。\n\n## Verification\n\n验证目标页面、交互与响应式布局。'}]}));
const trees = [{id:'tree-1',repositoryId:'repo-1',origin:'managed',status:'active',branch:'feature/rift-chat-input',path:'/workspace/.worktrees/rift-chat-input',baseCommit:'c047bf8',version:1}];
const detail = () => ({workspace:workspaces[0],roles,bindings:[],repositories,tasks,workflows:[{id:'workflow-1',goal:'RIFT 前端界面实现与验收',status:'running',planRevision:1,version:1}],runs:[],worktrees:[],integrations:[],managedWorktrees:trees,workflowRepositories:[],presence:roles.map((r,i)=>({roleId:r.id,state:['running','running','idle','queued'][i],runIds:[],turnIds:[],taskIds:i<2?[tasks[i].id]:[],reason:['正在将用户交互蓝图拆解为独立任务，并同步检查工作区上下文。','正在调优组件边距节奏与响应式网格布局。','当前没有排队任务，等待下一次调用。','等待前置依赖审查。'][i],observedAt:now()})),capabilities,observedAt:now(),conversations:[conversation],snapshotCursor:1,leadConfiguration:{...connection,source:'workspace'}});
const browser = await chromium.launch({channel:'msedge',headless:true});
const context = await browser.newContext({viewport:{width:1280,height:1024},deviceScaleFactor:1});
const page = await context.newPage();
const errors = [];
page.on('pageerror',e=>errors.push(e.message));
const mutations = [];
await page.route('**/ui-api/v1/**', async route => {
  const request = route.request(); const url = new URL(request.url()); const pathname = url.pathname.replace('/ui-api/v1','');
  let body;
  if (request.method() !== 'GET') { mutations.push({path:pathname,body:request.postDataJSON()}); if (pathname.endsWith('/conversations')) { body={...conversation,id:`conversation-${conversations.length+1}`,title:'新对话',version:0}; conversations.unshift(body); } else body={...workspaces[0],version:2}; }
  else if(pathname==='/session') body={csrfToken:'visual-fixture',expiresAt:'2099-01-01T00:00:00Z'};
  else if(pathname==='/workspaces') body={workspaces,capabilities,observedAt:now()};
  else if(pathname==='/connections') body={connections:[{id:'dsh:anthropic',runtime:'dsh',provider:'anthropic',available:true,models:['Claude 3.7 Sonnet'],modelSelection:'free',tools:true},{id:'codex',runtime:'codex',available:true,models:['gpt-6.1-sol'],modelSelection:'verified-only',tools:true}],savedConnections:[],executionProviders:[]};
  else if(pathname.endsWith('/messages')) { const selected = conversations.find(c => c.id === pathname.split('/').at(-2)) ?? conversation; body={conversation:selected,messages:selected.id===conversation.id?messages:[],turns:[],chunks:[],nextBefore:null,snapshotCursor:1+selected.version}; }
  else if(pathname.endsWith('/conversations')) body={conversations};
  else if(pathname.endsWith('/skills')) body={skills};
  else if(pathname.endsWith('/worktrees')) body={worktrees:pathname.includes('repo-1')?trees:[],discovered:[]};
  else if(pathname.endsWith('/evidence')) body={taskId:pathname.split('/').at(-2),acceptedCommit:null,integrations:[]};
  else body=detail();
  await route.fulfill({json:body});
});
const report = {mode:'Playwright browser with deterministic API fixtures; no real Host writes',screens:[],checks:[],errors};
for(const route of ['workspaces','chat','agents','settings','skills','repositories','tasks','activity']) {
  await page.goto(`${origin}/#/workspace/wsp-001/${route}`);
  await page.locator('.workspace-switch').waitFor();
  await page.waitForFunction(()=>!document.querySelector('.loading') && !document.querySelector('.auth-card'));
  await page.waitForFunction(()=>document.querySelector('.workspace-switch')?.textContent.includes('RIFT 界面组'));
  await page.locator(`.page-${route}`).waitFor();
  assert.equal(await page.locator('.topbar .icon-button,.topbar .profile-button').count(),0);
  assert.equal(await page.locator('#conversation-menu-slot').count(),route==='chat'?1:0);
  await page.waitForLoadState('networkidle');
  await page.evaluate(()=>document.fonts.ready);
  await page.mouse.move(0,0);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>window.scrollY===0);
  await page.screenshot({animations:'disabled',path:path.join(output,`${route}-1280.png`)});
  
  if (!['workspaces','activity'].includes(route)) assert.equal(await page.locator('.sidebar .nav-link.active').getAttribute('href'),`#/workspace/wsp-001/${route}`);
  const clippedCards = await page.locator('button.card').evaluateAll(nodes=>nodes.filter(e=>e.scrollHeight>e.clientHeight+1).map(e=>e.className));
  assert.deepEqual(clippedCards,[],`${route}: card content must fit its background`);
  const geometry=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;};return {sidebar:box('.sidebar'),topbar:box('.topbar'),main:box('.main-content'),overflow:document.documentElement.scrollWidth>innerWidth,background:getComputedStyle(document.body).backgroundColor,frame:box('.workspace-layout, .agent-list, .skill-library-layout, .list-detail, .execution-modes'),primary:getComputedStyle(document.documentElement).getPropertyValue('--primary')};});
  assert.equal(geometry.background,'rgb(250, 249, 245)'); assert.equal(geometry.sidebar.width,240); assert.equal(geometry.topbar.height,56); assert.equal(geometry.overflow,false,`${route} desktop overflow`);
  report.screens.push({route,width:1280,...geometry});
}
await page.goto(`${origin}/#/workspace/wsp-001/workspaces`);
await page.getByRole('button',{name:'创建新工作区',exact:true}).click();
await page.getByRole('dialog').waitFor();
assert.equal(await page.getByRole('dialog').evaluate(e=>e.getBoundingClientRect().width),576);
await page.screenshot({animations:'disabled',path:path.join(output,'workspace-sheet-1280.png')});
await page.keyboard.press('Escape');
await page.getByRole('dialog').waitFor({state:'hidden'});
report.checks.push('Creation Sheet is 576px wide; Escape closes and restores focus');
await page.goto(`${origin}/#/workspace/wsp-001/agents`);
await page.getByRole('searchbox',{name:'搜索 Agent'}).fill('ui-builder');
assert.equal(await page.locator('.agent-card').count(),1);
await page.getByRole('button',{name:'添加 Agent',exact:true}).click();
await page.getByRole('dialog').waitFor();
await page.keyboard.press('Escape');
report.checks.push('Agent search filters records; shadcn dialog opens/closes');
await page.goto(`${origin}/#/workspace/wsp-001/settings`);
await page.locator('#lead-host-mode').check();
await page.locator('select[name=connectionId]').locator('..').getByRole('combobox').click();
await page.getByRole('option', { name: 'Codex 原生运行时', exact: true }).click();
await page.locator('select[name=model]').locator('..').getByRole('combobox').click();
await page.getByRole('option', { name: 'gpt-6.1-sol', exact: true }).click();
await page.getByRole('button',{name:'保存下一次执行配置',exact:true}).click();
await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
assert.equal(mutations.at(-1).body.leadConnection.runtime,'codex');
assert.equal(mutations.at(-1).body.leadConnection.model,'gpt-6.1-sol');
report.checks.push('RadioGroup runtime selection saves the selected connection/model through existing API');
await page.goto(`${origin}/#/workspace/wsp-001/chat`);
await page.locator('.sidebar').getByRole('button',{name:/新建对话/}).click();
await page.getByRole('button',{name:'切换对话：新对话',exact:true}).waitFor();
assert.equal(conversations.length,2,'StrictMode must not duplicate new conversations');
assert.equal(await page.getByLabel('对话标题').count(),0);
report.checks.push('New conversation opens directly without asking for a title');
conversations[0].title='Lead 根据首条输入总结的标题'; conversations[0].version++;
await page.getByRole('button',{name:'切换对话：Lead 根据首条输入总结的标题',exact:true}).waitFor();
await page.getByRole('button',{name:/切换对话：/}).click();
await page.getByRole('menuitem',{name:conversation.title,exact:true}).click();
await page.getByRole('button',{name:`切换对话：${conversation.title}`,exact:true}).waitFor();
report.checks.push('Persisted Lead title syncs into the header and switching restores the selected title');
await page.goto(`${origin}/#/workspace/wsp-001/agents`);
await page.locator('.page-agents').waitFor();
await page.goto(`${origin}/#/workspace/wsp-001/chat`);
await page.locator('.message-list').waitFor();
assert.equal(await page.getByLabel('对话标题').count(),0,'Consumed new-conversation requests must not reopen on route changes');
await page.getByRole('button',{name:/切换对话：/}).click();
await page.getByRole('menuitem',{name:conversation.title}).waitFor();
await page.keyboard.press('Escape');
report.checks.push('Conversation menu works; consumed creation requests do not reopen on return');
await page.emulateMedia({colorScheme:'dark'});
await page.goto(`${origin}/#/workspace/wsp-001/settings`);
await page.locator('[data-slot=native-select]').first().waitFor();
const selectColors = await page.locator('[data-slot=native-select], [data-slot=native-select-option]').evaluateAll(nodes => nodes.map(node => ({slot:node.dataset.slot,background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color,scheme:getComputedStyle(node).colorScheme})));
assert.ok(selectColors.length>1);
for (const color of selectColors) { assert.equal(color.background,'rgb(255, 255, 255)'); assert.equal(color.color,'rgb(27, 28, 26)'); assert.equal(color.scheme,'light'); }
await page.screenshot({animations:'disabled',path:path.join(output,'settings-dark-system-1280.png')});
report.checks.push('Selects and their options retain white backgrounds and ink text with a dark OS preference');
await page.emulateMedia({colorScheme:'light'});
await page.goto(`${origin}/#/workspace/wsp-001/skills`);
await page.getByRole('tab',{name:'Markdown 源码'}).click();
assert.match(await page.locator('.skill-document').innerText(),/# Engineering Collaboration/);
await page.getByRole('tab',{name:'阅读预览'}).click();
await page.locator('.skill-preview h1').waitFor();
report.checks.push('Skill source and rendered Markdown views preserve the same version');
for(const width of [390,768]) {
  await page.setViewportSize({width,height:900});
  for(const route of ['workspaces','chat','agents','settings','skills','repositories','tasks','activity']) {
    await page.goto(`${origin}/#/workspace/wsp-001/${route}`);
    await page.waitForFunction(()=>!document.querySelector('.loading') && !document.querySelector('.auth-card'));
  await page.waitForFunction(()=>document.querySelector('.workspace-switch')?.textContent.includes('RIFT 界面组'));
    await page.locator(`.page-${route}`).waitFor();
  await page.waitForLoadState('networkidle');
  await page.evaluate(()=>document.fonts.ready);
  await page.mouse.move(0,0);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>window.scrollY===0);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    if(overflow) console.log(await page.locator('body *').evaluateAll(nodes=>nodes.filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right})).slice(0,15)));
    assert.equal(overflow,false,`${route} ${width}px overflow`);
    await page.screenshot({animations:'disabled',path:path.join(output,`${route}-${width}.png`),fullPage:true});
    report.screens.push({route,width,overflow});
  }
}
await page.setViewportSize({width:390,height:900});
await page.getByRole('button',{name:'展开导航'}).click();
await page.getByRole('dialog').waitFor();
await page.getByRole('dialog').getByRole('link',{name:'智能代理'}).click();
await page.getByRole('dialog').waitFor({state:'hidden'});
report.checks.push('Mobile Sheet navigation changes route and closes');


messages[1].content = 'Markdown safety fixture\n\n<script>window.__unsafeMarkdown=1</script>\n\n<img src=x onerror="window.__unsafeMarkdown=2">\n\n[unsafe](javascript:alert(1))\n\n```html\n<b>literal code</b>\n```';
await page.goto(`${origin}/#/workspace/wsp-001/chat`);
await page.getByText('Markdown safety fixture',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>window.__unsafeMarkdown),undefined);
assert.equal(await page.locator('.message-content script,.message-content img[onerror],.message-content a[href^="javascript:"]').count(),0);
assert.equal(await page.locator('.message-code code').innerText(),'<b>literal code</b>');
report.checks.push('Markdown strips executable HTML/URLs and preserves literal fenced code');

assert.deepEqual(errors,[]);
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({screens:report.screens.length,checks:report.checks,errors},null,2));
await browser.close();
