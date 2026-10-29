// Browser check for the 13 secondary actions that sit on white cards (class `secondary on-card`).
// Usage: pnpm dev:ui  # then: RIFT_PLAYWRIGHT_MODULE=... RIFT_UI_URL=http://127.0.0.1:5173 node scripts/ui-secondary-on-card-check.mjs
// Uses deterministic API fixtures only; no real Host, writes are never sent.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.RIFT_UI_URL || 'http://127.0.0.1:5173';
const output = path.resolve(process.env.RIFT_UI_EVIDENCE_DIR || '.runtime-evidence/secondary-on-card');
await mkdir(output, { recursive: true });

const now = () => new Date().toISOString();
const capabilities = Object.fromEntries(['workspaceCreate','chat','agentConfiguration','skills','multipleRepositories','worktreeManagement','workflowActions','events','pagination'].map(k => [k, { available: !['events','pagination'].includes(k), reason: 'fixture' }]));
const connection = { runtime: 'dsh', provider: 'anthropic', model: 'Claude 3.7 Sonnet' };
const workspace = { id: 'wsp-001', name: 'RIFT 界面组', rootPath: '/workspace/0', repositoryPath: '/workspace/rift-web', baseRef: 'main', status: 'active', version: 1, leadConnection: connection, defaultConversationId: 'c1', workflowCount: 1, activeWorkflowId: 'workflow-1', taskCount: 2, createdAt: now() };
const roles = [{ id: 'role-0', name: 'lead', displayName: '协调者', prompt: 'x', kind: 'dsh-lead', purpose: 'lead', enabled: 1, version: 1, chatConnection: connection }];
const repositories = [{ id: 'repo-1', workspaceId: 'wsp-001', canonicalPath: '/workspace/rift-web', baseRef: 'main', commonGitDir: '/workspace/rift-web/.git' }];
const mkTask = (id, title, status) => ({ id, title, instructions: 'x', status, workflowId: 'workflow-1', repositoryId: 'repo-1', roleId: 'role-0', dependsOn: [], attempt: 1, acceptanceCriteria: ['a'], expectedPaths: ['ui/'], version: 1, blockingReason: null, priority: 0 });
const tasks = [mkTask('task-1', '被阻塞任务', 'blocked'), mkTask('task-2', '待开始任务', 'pending')];
const detail = () => ({ workspace, roles, bindings: [], repositories, tasks, workflows: [{ id: 'workflow-1', goal: '示例工作流', status: 'running', planRevision: 1, version: 1 }], runs: [], worktrees: [], integrations: [], managedWorktrees: [], workflowRepositories: [], presence: [], capabilities, observedAt: now(), conversations: [], snapshotCursor: 1, leadConfiguration: { ...connection, source: 'workspace' } });
const version = (id, n) => ({ id, version: n, createdAt: now(), digest: 'sha256:fixture', sourceDirectory: '/workspace/skills/a', requirements: { resources: false, scripts: false, runtimes: [] }, resources: [], instructions: '# Skill\n\n正文' });
const skills = [{ id: 'skill-0', name: '工程协作', description: '示例', revision: 1, archived: 0, shared: { enabled: 1, versionId: 'v1', revision: 1 }, assignments: [], versions: [version('v2', 2), version('v1', 1)] }];
const saved = [{ id: 'conn-1', name: '示例连接', protocol: 'openai-responses', endpoint: 'https://example.com/v1', model: 'm', revision: 1, available: true, verificationStatus: 'unverified' }];
let verifyDelay = false;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const writes = [];
await page.route('**/ui-api/v1/**', async route => {
  const req = route.request(); const p = new URL(req.url()).pathname.replace('/ui-api/v1', ''); let body;
  if (req.method() !== 'GET') { writes.push(p); if (p.endsWith('/verify')) await new Promise(r => setTimeout(r, 1500)); body = {}; }
  else if (p === '/session') body = { csrfToken: 'x', expiresAt: '2099-01-01T00:00:00Z' };
  else if (p === '/workspaces') body = { workspaces: [workspace], capabilities, observedAt: now() };
  else if (p === '/connections') body = { connections: [], savedConnections: saved, configuration: { available: true, reason: null }, executionProviders: [] };
  else if (p.endsWith('/skills')) body = { skills };
  else if (p.endsWith('/worktrees')) body = { worktrees: [], discovered: [], removals: [] };
  else if (p.endsWith('/conversations')) body = { conversations: [] };
  else if (p.endsWith('/evidence')) body = { taskId: 'task-1', acceptedCommit: null, integrations: [] };
  else body = detail();
  await route.fulfill({ json: body });
});

const white = 'rgb(255, 255, 255)';
const style = loc => loc.evaluate(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { bg: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopColor, shadow: s.boxShadow, h: r.height }; });
const report = [];
async function check(label, loc, { hover = true, disabled = false } = {}) {
  await loc.scrollIntoViewIfNeeded();
  let card = await loc.evaluate(el => { let n = el.parentElement; while (n && getComputedStyle(n).backgroundColor === 'rgba(0, 0, 0, 0)') n = n.parentElement; return getComputedStyle(n).backgroundColor; });
  assert.equal(card, white, `${label}: expected white container, got ${card}`);
  const s = await style(loc);
  assert.notEqual(s.bg, white, `${label}: fill must differ from container`);
  assert.match(s.border, /^1px /, `${label}: needs a visible edge`);
  assert.equal(s.h, 38, `${label}: height must match other secondary buttons`);
  const entry = { label, normal: s };
  if (hover && !disabled) { await loc.hover(); await page.waitForTimeout(350); entry.hover = await style(loc); assert.notEqual(entry.hover.bg, s.bg, `${label}: hover must change`); await page.mouse.move(0, 0); }
  if (!disabled) { await loc.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await page.waitForTimeout(350); entry.focus = await loc.evaluate(el => { const s = getComputedStyle(el); return { matches: el.matches(':focus-visible'), outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor }; }); assert.ok(entry.focus.matches && !entry.focus.outline.startsWith('none'), `${label}: focus ring missing`); }
  assert.equal(await loc.isDisabled(), disabled, `${label}: disabled state`);
  report.push(entry);
}
const open = async route => { await page.goto(`${origin}/#/workspace/wsp-001/${route}`); await page.waitForFunction(() => !document.querySelector('.loading') && document.querySelector('.workspace-switch')); };
const byName = (name, scope = page) => scope.getByRole('button', { name, exact: true });

// Settings → 工作区 (1, 2)
await open('settings'); await page.getByRole('tab', { name: '工作区' }).click();
await check('1 重命名工作区', byName('重命名工作区'));
await byName('重命名工作区').click();
await check('2 重命名取消', byName('取消'));
await page.screenshot({ path: path.join(output, 'workspace-1280.png') });
await byName('归档工作区…').click();
const unaffected = [['保留工作区', byName('保留工作区')]];
for (const [l, loc] of unaffected) { const s = await style(loc); assert.match(s.border, /^0px /, `${l} must stay unchanged`); }

// Settings → API 连接 (3, 4)
await open('settings'); await page.getByRole('tab', { name: 'API 连接' }).click();
await check('3 添加连接', byName('添加连接'));
await check('4 验证实际对话与工具调用', byName('验证实际对话与工具调用'));
await byName('验证实际对话与工具调用').click();
const busyBtn = byName('正在验证对话与工具…');
await busyBtn.waitFor();
await check('4 验证（忙碌文案）', busyBtn, { hover: false, disabled: true });
await page.screenshot({ path: path.join(output, 'connections-busy-1280.png') });
await page.getByRole('button', { name: '验证实际对话与工具调用' }).waitFor();
await byName('删除连接').click(); const cancelDelete = await style(byName('取消删除')); assert.equal(cancelDelete.border.slice(0, 3), '0px', '取消删除 stays out of scope'); await byName('取消删除').click();

// Skills (5-8)
await open('skills');
await byName('导入 Skill').click();
await check('5 导入取消', byName('取消'));
await page.screenshot({ path: path.join(output, 'skills-import-1280.png') });
await byName('取消').click();
await check('7 展开正文', byName('展开正文'));
await byName('展开正文').click(); assert.equal(await byName('收起正文').getAttribute('aria-expanded'), 'true');
await check('7 收起正文', byName('收起正文'));
await check('8 更新共享版本（当前版本，禁用）', byName('更新共享版本'), { hover: false, disabled: true });
await page.getByLabel('共享版本').selectOption('v2');
await check('8 更新共享版本', byName('更新共享版本'));
await page.screenshot({ path: path.join(output, 'skills-1280.png') });
// 6 preview "返回": needs preview API
await page.route('**/skills/preview', r => r.fulfill({ json: { previewId: 'p', name: 'n', description: 'd', sourceDirectory: '/x', resources: [], requirements: { scripts: false, resources: false }, instructions: 'i', currentReferenceAgents: [] } }));
await byName('导入 Skill').click(); await page.locator('input[name=directory]').fill('/x'); await byName('预览内容').click();
await check('6 预览返回', byName('返回'));
await byName('返回').click(); await byName('取消').click();

// Repositories (9, 10)
await open('repositories');
await check('10 添加 Worktree', byName('添加 Worktree'));
await byName('添加 Worktree').click();
const wtCancel = await style(page.locator('.worktree-form').getByRole('button', { name: '取消', exact: true })); assert.equal(wtCancel.border.slice(0, 3), '0px', 'worktree create cancel stays out of scope');
await byName('关联新仓库').click();
await check('9 关联新仓库取消', page.locator('form.configuration-form').getByRole('button', { name: '取消', exact: true }));
await page.screenshot({ path: path.join(output, 'repositories-1280.png') });
const refresh = await style(byName('同步所有状态')); assert.equal(refresh.border.slice(0, 3), '0px', 'header refresh stays out of scope');

// Tasks (11, 12, 13)
await open('tasks');
await check('11 准备重试', byName('准备重试'));
await byName('准备重试').click();
await check('12 重试取消', page.locator('.task-retry').getByRole('button', { name: '取消', exact: true }));
await page.screenshot({ path: path.join(output, 'tasks-retry-1280.png') });
await page.locator('.task-retry').getByRole('button', { name: '取消', exact: true }).click();
await page.locator('.workflow-select select').selectOption('workflow-1');
const rs = await style(page.getByRole('button', { name: '调整依赖与优先级', exact: true })); assert.equal(rs.border.slice(0, 3), '0px', 'replan opener is not in the list');
await page.getByRole('button', { name: '调整依赖与优先级', exact: true }).click();
await check('13 调整取消', page.locator('form.configuration-form').getByRole('button', { name: '取消', exact: true }));
await page.screenshot({ path: path.join(output, 'tasks-1280.png') });

// 390px: no horizontal overflow for the pages that host the buttons
await page.setViewportSize({ width: 390, height: 844 });
for (const route of ['settings', 'skills', 'repositories', 'tasks']) { await open(route); const o = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth); assert.equal(o, false, `${route} overflows at 390px`); }
await open('repositories'); await byName('关联新仓库').click(); await page.screenshot({ path: path.join(output, 'repositories-390.png') });
await open('tasks'); await byName('准备重试').click(); await page.screenshot({ path: path.join(output, 'tasks-390.png') });
assert.deepEqual(errors, []);
assert.deepEqual(writes, ['/connections/conn-1/verify'], 'only the verify click should write');
console.log(JSON.stringify({ checked: report.length, report, writes }, null, 1));
await browser.close();
