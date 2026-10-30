# 全站下拉选择框统一（2026-10-30）

基线：`a908bb345dc2d9afbd435fee8d4609c7eabd2eb4`。设计依据为当前 `DESIGN.md`、`docs/stitch-reference/IMPLEMENTATION.md` 及 `theme.css` 的 shadcn 语义色。以下为本轮源码排查和新运行的浏览器证据，不引用历史截图作为验证。

## 排查清单

共 **15 处字段定义**（复用组件在执行连接、对话连接、主 Agent 设置中可重复渲染），全部通过同一 `NativeSelect` 适配器：

| 文件 | 字段 | 数量 / 语义 |
| --- | --- | --- |
| Configuration.tsx | 系统职责；API 或原生运行时；模型标识 | 3；职责默认值、可清空连接、必填模型、不可用连接/模型；覆盖添加/编辑 Agent 与主 Agent 设置 |
| ConnectionCatalogue.tsx | API 协议 | 1；非受控默认值，保存时继承 fieldset 禁用 |
| RepositoryManager.tsx | 目录来源；仓库中已发现的 Worktree | 2；联动显示字段、必填空占位、长路径 |
| TaskActions.tsx | 调整计划的任务 | 1；必填空占位、联动依赖与优先级 |
| pages.tsx | 工作流；顺序；仓库；成员 | 4；受控列表筛选与排序 |
| SkillLibrary.tsx | 保存为；查看版本；共享版本；专属版本 | 4；空值表示新 Skill、受控版本、归档/保存禁用与成员 fieldset 禁用 |

额外检查及保留的不同语义入口：

- `AppChrome.tsx` 工作区切换：含搜索、导航链接和管理入口的现有 Radix DropdownMenu；不是表单字段，保留。
- `ChatScreen.tsx` 对话切换：含切换及新建动作的现有 Radix DropdownMenu，保留。
- `ChatScreen.tsx` @ 接收者：聊天内联候选按钮组，选择后回到输入框；上下文是多选 Checkbox，不改为单选下拉。移除该文件无调用的 NativeSelect 导入。
- `pages.tsx` Agent 更多操作：动作菜单而非选择框，不重做。
- Agent/任务状态分段筛选、Skill 作用域 Tabs、Skill 成员覆盖模式单选、依赖 Checkbox 等：非展开式单选字段，不更换交互模式。
- 全部页面 TSX 未发现绕过共享组件的原生 `<select>`；测试固定这项约束。

## 根因与实现

1. 旧组件只给原生 `<select>` 和 `<option>` 加 class，展开菜单仍由浏览器/操作系统绘制，无法统一圆角、间距、选中/禁用态、滚动和弹层样式。
2. 原组件的 `w-fit` / `h-9`、`theme.css` 的 wrapper 全宽覆盖、`styles.css` 的全局 `select` 最小高度/内边距，以及 `stitch.css` 的字体/边框覆盖并存；只改字段局部 class 无法同时解决宽度和展开菜单问题。
3. 使用已安装的 `radix-ui` Select 处理触发器、键盘/typeahead、选项、Portal、碰撞定位、滚动、Escape 和焦点恢复。没有引入依赖或自制键盘状态机。
4. 仍由真实原生字段提供 value/defaultValue、空值、name/FormData、required、禁用、optgroup 禁用与 reset 语义。Radix 内部字段隔离于业务 form，不提交编码值、不重复发送表单 change。全部值统一加前缀送入 Radix（包括空字符串），仅在可视层编码；实际字段值不变。
5. 原生 `reset` 默认动作在 reset 事件之后发生，因此下一任务同步可视值；取消 reset 不覆盖用户状态。动态 fieldset 禁用使用实际 `:disabled` 状态（包含 legend 例外），禁用期间关闭菜单且恢复启用后不自动打开。
6. 白色触发器/浮层、暖灰高亮、陶土选中标记、8px 圆角、44px 目标、2px 实线焦点均复用既有色板。浮层 z-index 60 高于 Dialog/Sheet 的 50，限制在可用视口内。触发器长文本省略但保留完整可访问文本和 title；展开后文本可换行，列表可滚动；窄屏为 16px。
7. 原有业务调用、提交结构和 API 未更改。旧浏览器脚本中直接操纵 native select 的步骤改为点击可见 combobox / option，以继续测试真实用户入口。

## 本轮验证

- `pnpm typecheck:ui`：通过。
- `pnpm test:ui`：14 文件、149 项通过，含新增 3 项共享组件/入口约束测试。
- `pnpm build:ui`：通过。仍有主 JS chunk 大于 500KB 的提示（本轮约 728KB 未压缩），不是构建失败。
- `scripts/ui-regression/select-check.mjs`：8 组浏览器回归全部通过，Chromium **149.0.7827.55**，无 pageerror。使用隔离 Vite 和拦截 API 的夹具，无真实 Host 写入。
  - 默认值、受控/非受控、空值和带前缀值、精确 FormData、单次 change、关联外部 form。
  - required 阻止提交，聚焦可见控件并显示关联错误；选择后可提交。
  - 原生 reset、受控值保持、异步变化选项；禁用字段和选项、动态 fieldset 禁用关闭浮层。
  - Space、上下箭头、Home/End、typeahead、Enter、Escape、Tab 和返回焦点。
  - 添加 Agent：1280 / 375px，系统职责、运行时及模型联动、不可用连接、清空重选、真实提交请求体（被夹具截获），Escape 先关选择菜单再关 Dialog。
  - 任务工作流/顺序/仓库筛选；Skill 查看/共享版本与 375px 版本菜单。
  - 320px 长路径、667×375 横屏、减少动态效果、滚动到末项、无页面横向溢出、菜单在视口内；展开长选项无水平内容溢出。
- 既有 `scripts/ui-regression/check.mjs` 的 `task-filter-pagination`：通过，覆盖本地/服务端筛选分页。
- **未通过的附加检查**：旧 `scripts/ui-secondary-reuse-check.mjs` 跑到末尾 390px 任务页时，在第 158 行等待“准备重试”按钮超时；此前共享版本与工作流的新选择步骤已执行。没有将整个旧脚本记为通过，也未为此扩展到任务页入口改造。`ui-stitch-visual-check.mjs` 本轮只迁移选择步骤，未完整重跑。

`browser-report.json` 和同目录 9 张 PNG 是本轮真实浏览器产物。截图使用视口截图：全页截图会临时改变视口尺寸，Radix 会按其默认 resize 行为关闭菜单。界面几何、命中层级、语义与交互由浏览器断言验证；本次图片查看工具拒绝当前任务路径，**未进行截图人工观感复核**。

复现专项检查（Playwright 与 Chromium 路径按本机配置）：

```sh
RIFT_PLAYWRIGHT_MODULE=/path/to/playwright \
CHROMIUM_PATH=/path/to/chrome \
node scripts/ui-regression/select-check.mjs
```

默认证据输出到 `.runtime-evidence/selects`，脚本自动启动/关闭隔离 Vite 和浏览器。组件表单/键盘测试夹具位于 `scripts/ui-regression/select-fixture.tsx`，不进入生产入口。

## 限制

未验证 Firefox、WebKit、真实移动设备或屏幕阅读器读屏；没有进行真实 Host 端到端写入。保留现有单选业务范围，不引入多选下拉，不改后端，不做新的全站视觉设计。提交仅表示实现准备好，仍需 Host 的独立检查与审查。
