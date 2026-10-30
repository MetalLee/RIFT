// Run against `pnpm dev:ui`; all API traffic is mocked, no Host data is changed.
// RIFT_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.RIFT_UI_URL || 'http://127.0.0.1:5173';
const capabilities = Object.fromEntries(['workspaceCreate', 'chat', 'agentConfiguration', 'skills', 'multipleRepositories', 'worktreeManagement', 'workflowActions', 'events', 'pagination'].map(key => [key, { available: key === 'multipleRepositories', reason: 'Fixture' }]));
const repo = id => ({ id, canonicalPath: `/fixture/${id}`, baseRef: 'main', workspaceId: 'fixture' });
const workspace = { id: 'fixture', name: '目录统计回归', status: 'active', version: 1, workflowCount: 0, taskCount: 1 };
const detail = {
  workspace, capabilities, observedAt: new Date().toISOString(), snapshotCursor: 1,
  repositories: [repo('one')], roles: [], bindings: [], workflows: [], runs: [], integrations: [], managedWorktrees: [], presence: [], conversations: [], workflowRepositories: [],
  tasks: [{ id: 'task', repositoryId: 'one', title: '目录任务', status: 'completed' }],
  worktrees: [{ id: 'task-active', taskId: 'task', path: '/fixture/task', status: 'active', branch: 'task' }],
};
const target = (kind, recordId, state = 'available') => ({ kind, recordId, repositoryId: 'one', path: `/fixture/${kind}/${recordId}`, state, canDelete: false, canReconcile: false, expectedVersion: 'fixture', reason: 'Fixture: read only', error: null });
const inventories = {
  one: { worktrees: [
    { id: 'user', path: '/fixture/user', branch: 'user', status: 'active', origin: 'managed' },
    { id: 'history', path: '/fixture/history', branch: 'history', status: 'detached', origin: 'external' },
  ], discovered: [], removals: [{ ...target('user', 'user'), canDelete: true }, target('task', 'task-active'), target('candidate', 'integration'), target('review', 'integration'), target('review', 'old', 'missing')] },
  two: { worktrees: [], discovered: [], removals: [target('candidate', 'second')] },
};
let hold = true;
let failedRepo = '';
const pending = [];
const errors = [];
const browser = await chromium.launch({ headless: true, ...(process.env.RIFT_BROWSER_EXECUTABLE ? { executablePath: process.env.RIFT_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/ui-api/v1/**', async route => {
  const path = new URL(route.request().url()).pathname.replace('/ui-api/v1', '');
  const match = path.match(/^\/workspaces\/fixture\/repositories\/([^/]+)\/worktrees$/);
  if (match) {
    const id = match[1];
    const body = structuredClone(inventories[id]);
    const failure = failedRepo === id;
    if (hold) await new Promise(resolve => pending.push(resolve));
    await route.fulfill(failure ? { status: 503, json: { message: '目录核对失败' } } : { json: body }).catch(() => {}); // Superseded requests can already be aborted.
    return;
  }
  const body = path === '/session' ? { csrfToken: 'fixture', expiresAt: '2099-01-01' }
    : path === '/workspaces' ? { workspaces: [workspace], capabilities, observedAt: detail.observedAt }
    : path === '/workspaces/fixture' ? detail : null;
  assert.ok(body, `Unexpected request: ${path}`);
  await route.fulfill({ json: body });
});
const metric = page.locator('.repository-metrics [role="status"]');
async function metricIs(text) { await page.waitForFunction(text => document.querySelector('.repository-metrics [role="status"]')?.textContent === text, text); }
function release() { hold = false; pending.splice(0).forEach(resolve => resolve()); }
async function rows(count) { await page.waitForFunction(count => document.querySelectorAll('.worktree-row').length === count, count); }
async function refreshDetail() {
  detail.observedAt = new Date(Date.parse(detail.observedAt) + 1).toISOString();
  detail.snapshotCursor++;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
}
try {
  await page.goto(`${origin}/#/workspace/fixture/repositories`);
  await metricIs('正在核对工作目录…');
  assert.equal(await page.locator('.worktree-row').count(), 0);
  release();
  await metricIs('4 个当前工作目录');
  await rows(4);
  const history = page.getByRole('button', { name: '查看目录历史 / 异常记录（2）', exact: true });
  await history.focus();
  await page.keyboard.press('Enter');
  await rows(6);
  assert.equal(await metric.textContent(), '4 个当前工作目录');
  assert.ok(await page.getByText('当前工作目录：4；历史 / 异常记录：2（不计入当前数量）。', { exact: true }).count());
  await page.getByRole('button', { name: '收起目录历史 / 异常记录', exact: true }).click();
  await rows(4);

  // Background snapshot refresh must not unmount a pending confirmation or lose keyboard focus.
  await page.getByRole('button', { name: '删除 Worktree…', exact: true }).first().click();
  const cancel = page.getByRole('group', { name: '确认删除 Worktree' }).getByRole('button', { name: '取消', exact: true });
  await cancel.focus();
  hold = true;
  detail.observedAt = new Date(Date.parse(detail.observedAt) + 1).toISOString();
  // DOM click leaves focus on the confirmation, like an automatic workspace snapshot refresh.
  await page.getByRole('button', { name: '刷新记录', exact: true }).evaluate(button => button.click());
  await metricIs('正在核对工作目录…');
  assert.equal(await page.getByRole('group', { name: '确认删除 Worktree' }).count(), 1);
  assert.ok(await cancel.evaluate(button => button === document.activeElement));
  assert.ok(await page.getByText('正在核对工作目录，以下为上次核对结果…', { exact: true }).count());
  release();
  await metricIs('4 个当前工作目录');
  assert.ok(await cancel.evaluate(button => button === document.activeElement));
  await cancel.click();

  // One failed repository must not turn a partial multi-repository total into zero or a complete count.
  detail.repositories.push(repo('two'));
  failedRepo = 'two';
  hold = true;
  await refreshDetail();
  await metricIs('正在核对工作目录…');
  release();
  await metricIs('当前数量无法确认');
  await rows(4);
  assert.ok(await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).count());
  failedRepo = '';
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await metricIs('5 个当前工作目录');
  await rows(5);

  // An explicit refresh invalidates the count even if the workspace timestamp stays unchanged.
  hold = true;
  await page.getByRole('button', { name: '同步所有状态', exact: true }).click();
  await metricIs('正在核对工作目录…');
  // Remove one repository while its old inventory request is still pending.
  detail.repositories = [repo('two')];
  await refreshDetail();
  await page.waitForFunction(() => document.querySelectorAll('.repository-card').length === 1);
  await metricIs('正在核对工作目录…');
  release();
  await metricIs('1 个当前工作目录');
  await rows(1);

  // A completed deletion moves the row into history; refresh must update the metric too.
  inventories.two.removals[0].state = 'deleted';
  await refreshDetail();
  await metricIs('0 个当前工作目录');
  await rows(0);
  await page.getByRole('button', { name: '查看目录历史 / 异常记录（1）', exact: true }).click();
  await rows(1);
  assert.equal(await metric.textContent(), '0 个当前工作目录');
  detail.repositories = [];
  await refreshDetail();
  await rows(0);
  await metricIs('0 个当前工作目录');
  assert.deepEqual(errors, []);
  console.log('PASS: initial loading; four directory kinds; keyboard history disclosure; refresh preserves confirmation/focus; partial failure/retry; explicit refresh; repository removal with pending requests; deletion; empty repository set. Mocked API, real Chromium UI.');
} finally {
  release();
  await browser.close();
}
