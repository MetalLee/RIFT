# UI 评估修复交付（F01–F16 / V01–V03）

- Task：`task-6240207b-710f-4608-bad5-9a5141bff87b`
- Run：`run-c4d993cd-7b53-4ee0-8d4a-908460921209`
- 基线：`52b669767703cdf7e4a380be31cc952c244e8477`；开始时工作树干净。
- **实现及最终浏览器验证源提交：`d9c94675b8ea0d258ef7e131454f8409bb21845a`**。后续报告提交不改变代码。
- 当前 checkout：`/data/projects/RIFT/.rift/workspaces/e168007d2bbb66742fc6990a/worktrees/e81798c6d5cb615dccd74d65`。
- 仅前端、相关测试和可重跑脚本；没有后端改动、push、PR、合并或发布。实现就绪，仍需 Host 检查与独立审查。

## 产物与复跑

最终大产物目录（下表截图均相对此目录的 `screens/`）：

```text
/data/projects/RIFT/.rift/workspaces/workspace-a6791aae-4934-4069-a7d9-870bf02d2539/workspace/playwright-tools/ui-fixes-c4d993cd-final
```

包含 `measurements.json`（源 HEAD、时间、57 条断言结果、70 张截图的几何/对比/语义测量、请求与异常记录）、`screens/`、`contacts/01.png`–`21.png`、`contact-index.json`、实际执行日志。

```sh
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false build
pnpm --config.verify-deps-before-run=false test:ui
pnpm --config.verify-deps-before-run=false exec vitest run ui/src
UI_EVIDENCE_DIR=/absolute/output/path node scripts/ui-regression/check.mjs
```

本地复用已安装依赖，通过临时 `node_modules` 符号链接，不安装或修改共享依赖。第一次直接 `pnpm typecheck:ui` 被 pnpm 自动安装的无 TTY 保护终止；上列配置关闭的是**依赖自动检查/安装**，不是 TypeScript 或测试检查。临时链接交付前移除。浏览器报告中 `dirty` 只有该未跟踪链接；验证期间无未提交源码变更。

## 实际检查结果

| 检查 | 结果 |
|---|---|
| `typecheck`（含 protocol、服务端 TS、UI TS） | 通过 |
| `build`（含 protocol、服务端构建、Vite UI） | 通过；保留 >500 kB chunk 提示，未扩大范围做拆包 |
| `test:ui` | 13 文件 / 130 测试通过 |
| `vitest run ui/src` | 22 文件 / 160 测试通过，包含新增错误文案和设置路由测试 |
| 最终 Playwright | 57 项通过；70 张截图；pageerror=0；未匹配接口=0 |
| 八页 390/768/1280 | 24 个正常态均无整页水平溢出；另覆盖设置全部四子页三视口 |
| 中窄屏详情 | skills/tasks/activity 各 390/768：选择、读取、返回原行和原滚动位置通过；手机任务深链及键盘 Enter 补测通过 |
| 窄屏命中区 | 八页可用按钮/按钮式链接尺寸至少 44×44；当前视口内按钮中心 hit-test 无遮挡。checkbox 保留关联 label 命中区，不把图标尺寸当目标尺寸 |
| 回归过程失败 | 首轮一个 Agent 按钮仍为 32px，已修复 CSS 优先级；测试的 status 定位及新增取消按钮计数已更新；Range 分词测量先前选错文本节点已修复。早期日志保留，不当最终通过证据 |

浏览器使用 Playwright 1.64.1 与缓存 Chromium 149.0.7827.55，`127.0.0.1:5209` 启动当前 checkout 的真实 Vite 配置。所有 `/ui-api/` 请求均 mock，非本地请求中止；没有真实模型调用、归档、删除或保存。console 中 401/409/503 为预期故障夹具，非页面 JS 异常。服务与浏览器均由 `finally` 关闭。

## 19 项实现与验证闭环

所有代码路径相对仓库根。测试名对应 `measurements.json.checks[].name`，不是历史评估结果。

| 项 | 实现位置与处理 | 新验证证据 |
|---|---|---|
| F01 | `ui/src/stitch.css`：帮助、tabs/计数、任务元数据改为实色次级文字；照片文字区域采用不透明深色衬底，取消文字透明度 | 24 正常态对比采样与 `contrast-interaction-states`；聊天帮助 **6.12:1**、未选 tabs **5.85:1**、任务元数据 **6.45:1**。`chat-390`、`agents-tab-hover`、`settings-tab-selected` |
| F02 | `stitch.css`：skip-link 离屏且裁切而非 visibility:hidden；composer 键盘 2px 陶土轮廓 | `keyboard-entry`：首 Tab skip-link、Enter main、输入焦点 outline=2px；`skip-link`、`composer-focus` |
| F03 | `pages.tsx` 移除搜索旁 ⌘K；`ChatScreen.tsx` 仅新建成功后给新 composer 焦点 | `shortcuts`：Ctrl/Meta K 均只创建一次并聚焦输入；普通会话加载不抢焦点 |
| F04 | `SkillLibrary.tsx`：就地确认、引用名与影响、取消、busy 防重复、成功回执；仍有共享/专属引用时提示先解除；明确不可取消归档及重新导入路径 | `skill-archive`：初点/取消 0 写入；引用阻止确认；无引用确认 1 次；`skill-referenced-confirm`、`skill-archived` |
| F05 | `ConnectionCatalogue.tsx`：读取、保存、删除、按连接 ID 的验证错误分开；读取成功只清读取错误 | `connection-recovery`：503→200 清读错，刷新不清真正验证失败；`connection-load-error`、`connection-verify-errors` |
| F06 | `ChatScreen.tsx`：候选/上下文内部 Escape 回触发器；`pages.tsx`：Agent Dialog 保存实际触发器 ref 并恢复 | `pickers-escape-selection`、`agent-dialog-focus`，添加和配置入口都检查 |
| F07 | `SkillLibrary.tsx`、`ChatScreen.tsx`：按钮选项 aria-pressed；保留原生分配语义 | `skill-archive`、`pickers-escape-selection` 检查唯一当前选项 |
| F08 | `stitch.css`：仅 ≤767px 扩大控件，处理 Agent toolbar 特异性；桌面保持原尺寸 | `mobile-targets`，`targets-*` 八页截图与 bounds/hit-test |
| F09 | `state.ts`、`App.tsx`、`pages.tsx`：task 点击更新现有参数；设置 tab 白名单参数驱动；标题/面包屑反映当前子页 | `deep-links-evidence`：刷新、后退、前进；`narrow-deep-link-keyboard`；新增 `state.test.ts` |
| F10 | `App.tsx` Notice 默认 note，异步动作错误显式 polite/status；`SkillLibrary.tsx` 加载 role=status | `notice-and-loading`：静态说明无 alert；`skill-loading` |
| F11 | `App.tsx` Copy：复制失败就地 status、可聚焦/可选原文，成功反馈；值变化复位 | `copy-rejection-and-fallback` 覆盖权限拒绝、execCommand 失败和成功；`copy-rejected` |
| F12 | `api.ts` 稳定错误码中文原因/恢复动作，技术信息仅 HTTP/安全码，不显示潜在含凭据的上游原文；`ConnectionCatalogue.tsx` 错误近连接且 aria-describedby，保存错误近表单 | 新增 `api.test.ts` 防原始凭据泄露；`connection-recovery` 两连接各自错误及保存保留输入；`form-error-drafts` 导入/发送保留草稿；`connection-save-error`、`skill-import-error` |
| F13 | `App.tsx` / `AppChrome.tsx`：会话连接不再等同数据读取成功；过期计数明确“上次观测” | `stale-and-sync`、`session-recovery`；`stale-observation`、`sync-error`、`session-expired` |
| F14 | `pages.tsx` 现有更多详情同时列出完整对话/执行模型，长标识可换行，不需进入编辑 | `model-details`；`long-model-details` |
| F15 | `stitch.css`：≤1100px 仓库摘要单列，不缩字号塞三列 | `repository-summary-wrap`：390/767/768/1100/1101/1280 的“已挂载/工作目录/资源占用”各为一行；`repositories-768` |
| F16 | `pages.tsx`：TaskEvidence 与 TaskRetry 原为同一 sibling key `task.id`，改成 `evidence:` / `retry:` 前缀。不是两份不同对象的合法证据，不删任何历史或 Host 边界文案 | `deep-links-evidence` 重复切 task-105→106→105→106，每次仅 1 个证据区及刷新按钮；`task-106-evidence` |
| V01 | 新 `DetailLayout.tsx` 用于 skills/tasks/activity：桌面并列，中窄屏选中进入详情；列表保持挂载，返回恢复焦点/位置。仅用户选择时定位详情并让返回按钮避开顶栏；后台更新不触发导航 | `detail-{skills,tasks,activity}-{390,768}`；`narrow-deep-link-keyboard`；对应详情图 |
| V02 | `Configuration.tsx` 去 Agent 弹窗重复标题；`stitch.css` connection-fields 组间 32px、组内保持原体系；保留执行边界说明 | `agent-dialog-focus` 单一标题；`agent-dialog-390`、`settings-390` 三视口对照 |
| V03 | `stitch.css`：中屏 workspace 辅助卡单列；仓库空态上下 padding=32px；设置低频摘要改紧凑流式摘要 | `workspaces-768`、`repositories-768`、`settings-768`；照片/拓扑保留 |

### 真实契约说明

Skill 当前后端 `src/skill/service.ts:164–165` 允许直接置 archived；但 `resolveEffective` 拒绝仍被选中的已归档 Skill（约 142 行）。前端因此引导先撤销共享和专属引用，防止误操作令后续执行失败；**不声称后端已经禁止归档引用对象**。本次没有添加恢复接口，不假装支持取消归档。历史版本仍可看，需要重用时从原目录导入新 Skill。并发配置变化仍由已有版本校验拒绝。

F16 源码只有一个 TaskEvidence 声明，重复来自 React 兄弟 key 冲突，不是 fixture 缺字段。保持 TaskEvidence 自身请求身份/取消保护，当前候选未知及 Host 与成员声明边界均原样保留。

## 实际视觉评阅

本 Run 使用 `rift_view_image` 打开最终 `contacts/01.png`–`21.png`，覆盖全部 70 张源图；另原尺寸打开 `task-deep-link-390.png`、`task-106-evidence.png`。联系表映射见 `contact-index.json`。不声称 70 张均以原尺寸逐张查看。

- 桌面继续保持暖纸白、陶土主操作、紧凑工程工作台；没有换字体、组件库或增加装饰统计。
- 中屏仓库数字与类别完整，workspace 拓扑/照片不再挤在两条窄列；照片底部文字更清楚。
- 中窄屏列表不再后接整页详情；选中进入后有明确返回。长 Skill 正文/成员配置仍可继续滚动阅读。
- Agent 弹窗只留一个标题；职责、执行连接、对话连接组间有清晰停顿。必需风险说明没有折叠或删除。
- 连接读取/验证/保存错误各归其对象；任务 106 只有一个证据块；复制拒绝有就地提示。
- fullPage 图中的 fixed 顶栏位置随采集时的滚动位置变化，不代表实际视口有多个顶栏。详情返回按钮的视口位置已由断言确认 ≥56px；聊天截图只包含聊天滚动窗口的可见部分。

## 限制

这是隔离 mock 的真实浏览器渲染/交互测试，不是后端 E2E、读屏、真实触摸设备、软键盘或跨浏览器认证。没有真实连接验证、模型调用、成功导入全流程、业务写入、性能基准或生产部署验证。对比度 sampler 排除图片/渐变和 opacity 祖先及装饰/禁用项，不把截图缩图当精确对比数据；图片文字衬底另由样式改为不透明深色。构建体积警告保留。实现提交不等同任务已验收。
