// Deterministic browser coverage; API writes are intercepted, never sent to a Host.
// RIFT_PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chrome node scripts/ui-regression/select-check.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as f from './fixtures.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.resolve(process.env.RIFT_UI_EVIDENCE_DIR || '.runtime-evidence/selects');
const { chromium } = createRequire(import.meta.url)(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const report = { mode: 'Isolated Chromium, mocked API; no Host writes', checks: [], screenshots: [], errors: [] };
const server = await createServer({ configFile: path.join(root, 'ui/vite.config.ts'), root: path.join(root, 'ui'), server: { host: '127.0.0.1', port: 5187, strictPort: true } });
let browser, page;
await mkdir(out, { recursive: true });
const selected = async (trigger, text) => { await trigger.click(); await page.getByRole('option', { name: text, exact: true }).click(); };
const focused = async locator => page.waitForFunction(e => e === document.activeElement, await locator.elementHandle());
const formData = () => page.locator('#fixture-form').evaluate(form => Object.fromEntries(new FormData(form)));
async function check(name, fn) { await fn(); report.checks.push(name); console.log('PASS', name); }
async function snap(name) { await page.screenshot({ path: path.join(out, name + '.png'), fullPage: false }); report.screenshots.push(name + '.png'); }
async function fits() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page overflow');
  for (const box of await page.locator('[data-slot=select-content]').evaluateAll(es => es.map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, top: r.top, width: innerWidth, height: innerHeight }; }))) {
    assert.ok(box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height + 1, JSON.stringify(box));
  }
}
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => report.errors.push(e.message));
  const origin = 'http://127.0.0.1:5187';
  await page.route('**/__select_test__', route => route.fulfill({ contentType: 'text/html', body: `<html><body><div id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/@fs/${root}scripts/ui-regression/select-fixture.tsx"></script></body></html>` }));
  await page.goto(origin + '/__select_test__');
  const purpose = page.getByRole('combobox', { name: '默认职责' });
  const model = page.getByRole('combobox', { name: '受控模型' });
  const required = page.getByRole('combobox', { name: '必填连接' });
  await check('native defaults, labels, empty values, single change and exact FormData', async () => {
    await purpose.waitFor(); assert.equal(await purpose.innerText(), 'Beta');
    await selected(purpose, '不配置'); assert.equal((await formData()).purpose, '');
    assert.equal(await page.locator('[data-testid=changes]').innerText(), '1');
    assert.equal(await page.locator('[data-testid=form-changes]').innerText(), '1');
    await selected(purpose, '带前缀的真实值'); assert.equal((await formData()).purpose, 'value:');
    await selected(model, 'Alpha'); assert.equal((await formData()).model, 'a');
    assert.equal((await formData()).external, 'b'); assert.equal((await formData()).disabled, undefined);
  });
  await check('required validation focuses the visible trigger and blocks submission', async () => {
    await page.getByRole('button', { name: '提交', exact: true }).click(); await focused(required);
    assert.equal(await required.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('[data-testid=submitted]').innerText(), '');
    await selected(required, '已登记连接');
    await page.getByRole('button', { name: '提交', exact: true }).click();
    assert.equal(JSON.parse(await page.locator('[data-testid=submitted]').innerText()).find(([key]) => key === 'required')[1], 'ok');
  });
  await check('reset, external form reset, controlled values and changing options', async () => {
    await selected(page.getByRole('combobox', { name: '外部关联字段' }), 'Alpha');
    const before = await page.locator('[data-testid=changes]').innerText();
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('select[name=purpose]').parentElement.querySelector('[role=combobox]').textContent === 'Beta');
    assert.equal(await purpose.innerText(), 'Beta'); assert.equal((await formData()).external, 'b');
    assert.equal(await page.locator('[data-testid=changes]').innerText(), before, 'reset must not synthesize a change');
    assert.equal(await model.innerText(), 'Alpha');
    await page.getByRole('button', { name: '更新模型选项' }).click();
    assert.equal(await model.innerText(), 'Gamma'); assert.equal((await formData()).model, 'c');
  });
  await check('disabled fieldsets and disabled options preserve semantics', async () => {
    await page.getByRole('button', { name: '切换 fieldset 禁用' }).click();
    const inherited = page.getByRole('combobox', { name: '继承禁用' });
    assert.equal(await inherited.isDisabled(), true); assert.equal((await formData()).fieldset, undefined);
    assert.equal(await page.getByRole('combobox', { name: '直接禁用' }).isDisabled(), true);
    await page.getByRole('button', { name: '切换 fieldset 禁用' }).click();
    assert.equal(await inherited.isEnabled(), true); assert.equal((await formData()).fieldset, 'b');
    await inherited.click();
    await page.locator('select[name=fieldset]').evaluate(e => { e.closest('fieldset').disabled = true; });
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await page.locator('select[name=fieldset]').evaluate(e => { e.closest('fieldset').disabled = false; });
    assert.equal(await inherited.getAttribute('aria-expanded'), 'false');
    await purpose.click();
    for (const name of ['不可用', '组内不可用']) assert.equal(await page.getByRole('option', { name, exact: true }).getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Escape'); await focused(purpose);
  });
  await check('keyboard arrows, Home/End, typeahead, Escape and focus return', async () => {
    await purpose.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
    await page.keyboard.press('Home'); await page.waitForFunction(() => document.activeElement?.textContent === '不配置');
    await page.keyboard.press('ArrowDown'); await page.waitForFunction(() => document.activeElement?.textContent === 'Alpha'); await page.keyboard.press('Enter');
    assert.equal(await purpose.innerText(), 'Alpha'); await focused(purpose);
    await page.keyboard.press('Space'); await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
    await page.keyboard.press('End'); await page.waitForFunction(() => document.activeElement?.textContent === '带前缀的真实值'); await page.keyboard.press('Enter');
    assert.equal((await formData()).purpose, 'value:');
    await page.keyboard.press('b'); assert.equal(await purpose.innerText(), 'Beta');
    await page.keyboard.press('Space'); await page.keyboard.press('Escape'); await focused(purpose);
    await page.keyboard.press('Tab'); await focused(model);
  });
  await check('320px long tokens, scrollable menu, reduced motion and landscape', async () => {
    for (const viewport of [{ width: 320, height: 700 }, { width: 667, height: 375 }]) {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
      const long = page.getByRole('combobox', { name: '长路径' });
      await long.click(); await page.getByRole('listbox').waitFor(); await fits();
      assert.equal(await page.getByRole('option').first().evaluate(e => e.scrollWidth <= e.clientWidth), true, 'long option text overflows'); await snap(`long-${viewport.width}`);
      await page.keyboard.press('End'); await page.waitForFunction(() => document.activeElement?.textContent === '工作目录 29'); await page.keyboard.press('Enter');
      assert.equal((await formData()).long, 'path-29');
    }
  });

  const skills = structuredClone(f.skills);
  skills[0].versions.unshift({ ...skills[0].versions[0], id: 'version-new', version: 2, instructions: '# 第二版本' });
  const writes = [];
  await page.route('**/ui-api/v1/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname.replace('/ui-api/v1', ''); let body;
    if (req.method() !== 'GET') { writes.push({ path: p, body: req.postDataJSON() }); body = {}; }
    else if (p === '/session') body = { csrfToken: '[REDACTED]', expiresAt: '2099-01-01T00:00:00Z' };
    else if (p === '/workspaces') body = { workspaces: f.workspaces, capabilities: f.capabilities, observedAt: f.now() };
    else if (p === '/connections') body = { configuration: { available: true }, savedConnections: [], connections: [
      { id: 'codex', runtime: 'codex', available: true, executionAvailable: true, models: ['model-one', 'model-two'], modelSelection: 'verified-only' },
      { id: 'dsh:offline', runtime: 'dsh', provider: 'offline', available: false, executionAvailable: false },
    ] };
    else if (p.endsWith('/skills')) body = { skills };
    else if (p.endsWith('/evidence')) body = { taskId: p.split('/').at(-2), integrations: [] };
    else if (p.endsWith('/conversations')) body = { conversations: [] };
    else body = f.detail();
    await route.fulfill({ json: body });
  });
  await check('Add Agent dialog: responsibilities, connections, linkage, layer, Escape and submission', async () => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + '/#/workspace/wsp-001/agents');
      const add = page.getByRole('button', { name: '添加 Agent', exact: true }); await add.click();
      const dialog = page.getByRole('dialog');
      const role = dialog.getByRole('combobox', { name: '系统职责' });
      await selected(role, '审查');
      const connection = dialog.locator('fieldset').filter({ has: page.getByText('任务执行连接', { exact: true }) }).getByRole('combobox', { name: 'API 或原生运行时' });
      await connection.click(); await fits();
      assert.equal(await page.getByRole('option', { name: '模型 API · offline（不可用）' }).getAttribute('aria-disabled'), 'true');
      const item = page.getByRole('option', { name: 'Codex 原生运行时' });
      assert.equal(await item.evaluate(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + 10, r.y + r.height / 2)); }), true);
      await snap(`agent-open-${width}`); await item.click(); await focused(connection);
      const execution = dialog.locator('fieldset').filter({ has: page.getByText('任务执行连接', { exact: true }) });
      await selected(execution.getByRole('combobox', { name: '模型标识' }), 'model-two');
      await selected(connection, '暂不配置任务执行连接');
      assert.equal(await execution.getByRole('combobox', { name: '模型标识' }).count(), 0);
      await selected(connection, 'Codex 原生运行时');
      await selected(execution.getByRole('combobox', { name: '模型标识' }), 'model-one');
      await role.click(); await page.keyboard.press('Escape'); await focused(role);
      assert.equal(await dialog.isVisible(), true); await fits(); await snap(`agent-selected-${width}`);
      if (width === 1280) {
        await dialog.getByLabel('显示名称').fill('选择框回归');
        await dialog.getByRole('button', { name: '保存成员', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const body = writes.find(w => w.path.endsWith('/agents')).body;
        assert.equal(body.purpose, 'reviewer'); assert.equal(body.executionConnection.model, 'model-one');
      } else { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await focused(add); }
    }
  });
  await check('Task workflow/filter and Skill view/shared versions use the same selection UI', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(origin + '/#/workspace/wsp-001/tasks');
    await selected(page.getByRole('combobox', { name: '工作流', exact: true }), 'RIFT 前端界面实现与验收');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await selected(page.getByRole('combobox', { name: '顺序', exact: true }), '依赖优先');
    await page.getByRole('combobox', { name: '仓库', exact: true }).click(); await snap('task-filter'); await page.keyboard.press('Escape');
    await page.goto(origin + '/#/workspace/wsp-001/skills');
    const version = page.getByRole('combobox', { name: '查看版本', exact: true });
    await version.click(); await page.getByRole('option').last().click();
    assert.equal(await page.locator('select[data-slot=select-native]').first().inputValue(), 'version-0');
    await page.getByRole('combobox', { name: '共享版本', exact: true }).click(); await snap('skill-version'); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 900 });
    await page.locator('.skill-list-item').first().click(); await version.click(); await fits(); await snap('skill-version-375'); await page.keyboard.press('Escape');
  });
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack; console.error(error); process.exitCode = 1;
  await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server.close();
}
