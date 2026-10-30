# UI 深链目标身份增量修复（第三轮）

- Task：`task-6240207b-710f-4608-bad5-9a5141bff87b`
- Run：`run-3feb4348-5cd8-49b2-8862-c7b1a7179227`
- 实际基线：`a8b163b74b12ed0a65707200b6a653a822e2d6c4`，开始时工作树干净。
- **本轮实现及验证源码提交：`61172008b4b8d5741da591002bc3b912b0532b22`**；后续提交只修改本报告和报告入口。
- checkout：`/data/projects/RIFT/.rift/workspaces/e168007d2bbb66742fc6990a/worktrees/b53c0d761543e1beb071d924`
- 针对候选 `ae47365699cf57e7e79c6ee2fd74d4beb1c98c0b`、审查 `run-e9d4a57a-de8b-4abc-9149-e5ab45a3df76` 的唯一 P2，不扩展后端或更换视觉体系。

## 实现与目标生命周期

| 路径 | 改动及验证 |
|---|---|
| `ui/src/task-selection.ts` | 显式 `taskId` 与普通列表选择分开；显式目标只能匹配同 ID 的列表/链接对象，未解析不能回退首项。无 task 参数仍保留原选择/首项默认。6 项选择单测覆盖缺失、旧目标、同目标刷新、返回列表及筛选外对象。 |
| `ui/src/pages.tsx` | 目标读取独立存储 ID、数据、错误和加载状态，不再污染分页错误。渲染先按路由 ID 过滤状态，切目标首帧不展示旧任务；effect 清理 abort 且完成分支检查 abort/返回 ID。目标未解析时不挂载 TaskEvidence 或任务详情；显示目标 ID、polite 读取/失败状态、重试与返回入口。同目标后台刷新保留已有正确详情，失败明确标示上次数据，重试成功清错。 |
| `scripts/ui-regression/check.mjs` | 手动释放 mock 请求 gate，在真实 React/fetch/hash 路径上验证，不依赖固定延迟来决定响应先后。390/768/1280 测快照外延迟→成功、同目标刷新→503→恢复、已加载 A→未解析 B→503→重试恢复、失败返回列表与默认选择；390 测未完成 A→B 后 A 的 200/503 迟到。验证未解析期间详情/证据 DOM 均不挂载，证据请求只对应已解析的正确目标。 |

保留已有路由控制 DetailLayout、历史导航、过滤结果与链接对象分区，以及 TaskEvidence 的对象 key 和 Host 证据边界。没有引入通用异步框架或新依赖。

## 本轮实际验证

最终产物目录：

```text
/data/projects/RIFT/.rift/workspaces/workspace-a6791aae-4934-4069-a7d9-870bf02d2539/workspace/playwright-tools/ui-fixes-3feb-final
```

`checks.log`、`execution.log`、`measurements.json`、`screens/`31张、`contacts/`5张。
JSON 记录准确 HEAD、执行过滤表达式、请求、截图测量和清理结果。dirty 仅临时未跟踪的 `node_modules` 符号链接（复用既有依赖，交付前移除），没有未提交实现代码。

```sh
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false build
pnpm --config.verify-deps-before-run=false test:ui
pnpm --config.verify-deps-before-run=false exec vitest run ui/src
UI_CHECK_FILTER='^(tasks-(390|768|1280)|detail-tasks-.*|task-history-.*|task-filter-pagination|task-target-.*|deep-links-evidence|narrow-deep-link-keyboard)$' UI_EVIDENCE_DIR=/absolute/output/path node scripts/ui-regression/check.mjs
```

- typecheck（protocol/服务端/UI）与 build 通过；保留 Vite >500 kB bundle 提示。
- `test:ui`：13文件 / 141项通过；全部 UI：24文件 / 180项通过。
- 最终 Playwright：14项通过，pageerror=0，未匹配请求=0。
- 任务正常态三视口采样对比及横向溢出检查通过；新加载/失败/恢复三视口无整页横向溢出。
- 保留 `ui-fixes-3feb-first/second/third` 诊断产物。初次类型检查发现 JSX 编辑误触 Activity 闭合标签，已还原；first 暴露状态卡缺少 region 角色和测试误认为 StrictMode 只发一次请求；second 测试用可见角色查询返回列表后已隐藏的窄屏详情导致超时。已修正角色和断言，third 与最终回归通过。不把早期失败算成通过。
- 自启 Chromium/Vite 在 finally 关闭；交付前核查5209无监听。没有真实业务写入，没有 push/PR/合并/发布。

## 19项闭环与证据复用

完整首轮实施表及八页三视口、设置四子页证据见 [REPORT.md](REPORT.md)（实现 `d9c94675b8ea0d258ef7e131454f8409bb21845a`，57项/70图）；第二轮三项修复与17项/32图见 [RETRY-2.md](RETRY-2.md)（实现 `32a209908a852cccb8cb66cc5987b25b88462a46`）。本轮只改任务异步身份链路，不把旧图称为本轮全量重测。

| 项 | 实现位置 / 本轮状态 | 验证来源 |
|---|---|---|
| F01 | `stitch.css` 对比修复保留 | 首轮八页历史采样；本轮任务三视口采样 |
| F02 | skip-link/composer焦点保留 | 首轮 `keyboard-entry` |
| F03 | Agents快捷键文案、新对话聚焦保留 | 首轮 `shortcuts` |
| F04 | `SkillLibrary.tsx` 归档确认及真实恢复说明保留 | 首轮 `skill-archive`；本轮Skill单测 |
| F05 | `ConnectionCatalogue.tsx` 读取/验证/保存错误隔离保留 | 第二轮 `connection-recovery` |
| F06 | Chat面板Escape、Agent Dialog返回焦点保留 | 首轮 pickers/dialog 检查 |
| F07 | Skill/接收者选中语义保留 | 首轮选择检查；本轮任务选择/Enter |
| F08 | `stitch.css` 窄屏44px规则保留 | 首轮 `mobile-targets`，本轮无控件样式修改 |
| F09 | `pages.tsx` / `task-selection.ts` 显式目标生命周期修复；设置路由保持 | 本轮 task-target/history/filter/deep-link + 6项选择单测；设置复用首轮 |
| F10 | note/status区分保留；目标加载/错误使用status | 首轮 notice/loading；本轮目标生命周期 |
| F11 | `App.tsx` Copy失败与原文保留 | 首轮复制拒绝/fallback |
| F12 | `api.ts` 中文安全错误映射保留 | 第二轮导入/连接恢复；本轮24项API单测及任务503 |
| F13 | session/同步/观测过期区分保留 | 首轮 stale/sync/session |
| F14 | 详情完整模型名保留 | 首轮 `model-details` |
| F15 | 中屏仓库摘要重排保留 | 首轮摘要断点及三视口 |
| F16 | evidence/retry独立key及Host边界保留 | 本轮 `deep-links-evidence` 与目标身份/证据请求隔离 |
| V01 | 任务未解析态沿用路由详情容器，保留列表与返回路径 | 本轮任务390/768详情与历史导航；skills/activity复用第二轮 |
| V02 | Agent/设置组距与去重复标题保留 | 首轮弹窗及设置三视口 |
| V03 | 辅助卡重排、仓库空态与低频摘要密度保留 | 首轮workspace/repositories/settings三视口 |

## 实际看图与限制

使用 `rift_view_image` 实际查看最终 `contacts/01.png`–`05.png`：15张选定截图（顶部最多1800px缩略裁切），包括加载/失败/恢复三视口、两种迟到响应、history详情及任务默认三视口。未宣称逐张查看31张原图全文。灰色为联系表画布；fullPage 中固定顶栏随截图滚动位置出现不是多个顶栏。

观察：窄屏未解析目标只显示该目标状态，错误提供中文原因与重试/返回，成功后出现对应ID的详情和单一证据区；桌面保持列表/详情双栏，不把外部任务混入筛选结果。品牌暖白/陶土和既有密度未变。

本轮为隔离 mock Chromium 交互，不是后端 E2E、读屏、真实触摸/软键盘或跨浏览器验收。未重跑未受影响的八页完整视觉矩阵；复用边界如上。本地提交表示开发就绪，仍需 Host 检查及独立审查。
