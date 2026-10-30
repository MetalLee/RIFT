# UI 独立审查增量修复（第二轮）

- Task：`task-6240207b-710f-4608-bad5-9a5141bff87b`
- Run：`run-fb39c479-0bdb-435a-b4fa-960479ef4b99`
- 实际基线：`56ad2e7440821a641579fd15152c27e9b3d9e46e`；开始时工作树干净，完整继承上一轮19项实现。
- **本轮实现与最终验证源码提交：`32a209908a852cccb8cb66cc5987b25b88462a46`**。本报告后续提交只修改文档。
- checkout：`/data/projects/RIFT/.rift/workspaces/e168007d2bbb66742fc6990a/worktrees/b8fbeb1289ede8913ba8acf6`
- 对应独立审查：`run-8d5abad1-84d9-41a3-8918-5bcd1da08049`，候选 `5b02f6250f767170023bb7f5179e42ba9d045f8b` 的三项 P2；不是提交 ID 不匹配问题。
- 未改后端、依赖或视觉体系，未 push/PR/合并/发布。开发就绪仍需 Host 检查与准确候选独立复审。

## 三项修复

| 审查项 | 实现 | 本轮验证 |
|---|---|---|
| 窄屏详情与历史路由不同步 | `DetailLayout.tsx` 增加由当前路由控制的 `detailKey`，Tasks 返回列表清除 task 参数；保留上次列表选择及原行/滚动位置。焦点效果仅依赖导航 key，不依赖数据版本；skills/activity 保持本地展开模式。 | `task-history-390/768`：列表→106→浏览器后退/前进、返回按钮→后退/前进、Enter、刷新、直接深链105→106的历史切换；后台快照游标变更不抢焦点/滚动。`detail-*` 六项验证三类页面390/768返回原行和位置；新增SSR契约单测，不将其当作DOM交互测试。 |
| 链接任务混入筛选及分页 | `pages.tsx`、`task-selection.ts`：匹配列表和链接对象分离；筛选外/其他页链接对象置于独立标注区，可清除链接选择，匹配数/每页条目不增加；保留外部深链按ID读取。 | `task-filter-pagination`：本地及服务端分页，分别状态/工作流/仓库筛选、空交集、30+5分页与返回首页、清除选择；外部深链不在快照中仍能读取/刷新。纯函数单测验证不改变列表及不重复当前页对象。 |
| Skill已知导入校验丢失恢复提示 | `api.ts` 对照 `src/skill/service.ts:9–12,44–86`：大小、编码、元信息、运行时、符号链接、越界、源变化、预览数量限制；修正非空入口/真实目录/危险资源提示。不显示任意上游原文。 | 新增11项错误测试，校验限制/动作及敏感路径/凭据不回显；`skill-import-validation` 真实UI分别显示大小超限、UTF-8、未知错误并保留目录输入。 |

`SKILL_SIZE_LIMIT` 是多个限制共用的码，当前响应没有结构化“哪一个限制”字段。因此显示所有实际阈值：SKILL.md 256 KiB、单文件4 MiB、总计32 MiB、512文件、2048条目、嵌套32层；不猜测本次具体超限项，不解析或回显原文。预览上限提示保存已有预览或等待15分钟过期，不虚构页面上的丢弃入口。

## 执行证据

最终产物目录：

```text
/data/projects/RIFT/.rift/workspaces/workspace-a6791aae-4934-4069-a7d9-870bf02d2539/workspace/playwright-tools/ui-fixes-fb39-final
```

`checks.log`、`execution.log`、`measurements.json`、`screens/`32张、`contacts/`6张。JSON记录源码HEAD、准确过滤表达式、时间、截图几何/对比采样、请求与异常、清理结果；dirty仅临时未跟踪 `node_modules` 符号链接，没有未提交源码。链接指向已安装依赖，交付前移除，没有修改共享依赖。

```sh
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false build
pnpm --config.verify-deps-before-run=false test:ui
pnpm --config.verify-deps-before-run=false exec vitest run ui/src
UI_CHECK_FILTER='^(tasks-(390|768|1280)|detail-.*|task-history-.*|task-filter-pagination|skill-import-validation|deep-links-evidence|narrow-deep-link-keyboard|connection-recovery|form-error-drafts)$' UI_EVIDENCE_DIR=/absolute/output/path node scripts/ui-regression/check.mjs
```

- typecheck（protocol、服务端、UI）和build通过。保留Vite >500 kB chunk提示。
- `test:ui`：13文件 / 141项通过；`vitest run ui/src`：24文件 / 177项通过。
- 最终Playwright：17项全部通过，32张截图，pageerror=0、未匹配请求=0。任务正常态390/768/1280无页面水平溢出且采样普通字对比通过；新错误/筛选截图无页面水平溢出。
- 保留前几轮诊断产物 `ui-fixes-fb39-first/second/third`。first 的旧返回焦点断言未等待新的hash导航；新增脚本用精确“工作流/仓库”定位隐式label超时，后改为现有select定位。修复脚本后相应检查通过，早期失败不充当通过证据。
- Chromium与Vite由脚本finally关闭；实查5209无监听。没有真实业务写入。

## 19项闭环与复用范围

上一轮实施位置与完整70张图/57项验证见 [REPORT.md](REPORT.md)，源码 `d9c94675b8ea0d258ef7e131454f8409bb21845a`，报告提交 `56ad2e7440821a641579fd15152c27e9b3d9e46e`。以下“复用”均明确是历史证据，不冒称本轮重跑八页全部图片。

| 项 | 本轮状态 / 实现位置 | 证据 |
|---|---|---|
| F01 | 保留 `stitch.css` 合成对比修复 | 复用八页采样；本轮任务三视口重新采样通过 |
| F02 | 保留skip-link及composer轮廓 | 复用 `keyboard-entry` |
| F03 | 保留删除误导⌘K、新建对话聚焦 | 复用 `shortcuts` |
| F04 | 保留归档确认、引用阻止及重新导入说明 | 复用 `skill-archive`；本轮Skill单测通过 |
| F05 | 保留连接读取/保存/逐连接验证错误隔离 | 本轮 `connection-recovery` |
| F06 | 保留Escape与Dialog焦点返回 | 复用 `pickers-escape-selection` / `agent-dialog-focus` |
| F07 | 保留按钮选中语义 | 复用选择测试；本轮任务选择/Enter流程 |
| F08 | 保留仅窄屏44px目标 | 复用 `mobile-targets`，未改控件样式 |
| F09 | 增量修复路由控制详情、筛选外对象分区 | 本轮history/filter/deep-links检查及单测 |
| F10 | 保留note/status区分 | 复用 `notice-and-loading` |
| F11 | 保留复制失败及可选原文 | 复用 `copy-rejection-and-fallback` |
| F12 | 增量补齐Skill导入校验码与实际限制 | 本轮api单测、`skill-import-validation`、`form-error-drafts`、`connection-recovery` |
| F13 | 保留连接/同步/观测过期区分 | 复用 `stale-and-sync` / `session-recovery` |
| F14 | 保留详情完整模型名 | 复用 `model-details` |
| F15 | 保留仓库中屏摘要单列 | 复用 `repository-summary-wrap`及三视口图 |
| F16 | 保留evidence/retry独立key与Host边界 | 本轮 `deep-links-evidence` 验证切换后只一块证据 |
| V01 | 增量修复任务历史导航；保持共享组件行为 | 本轮三类详情390/768六项、history及外部深链 |
| V02 | 保留表单组距、单一Dialog标题 | 复用Dialog和设置三视口图片 |
| V03 | 保留辅助卡重排、空态及低频摘要密度 | 复用workspace/repositories/settings三视口图片 |

## 实际看图与限制

本轮通过 `rift_view_image` 查看最终 `contacts/01.png`–`06.png`：17张选定截图的顶部最多1800px缩略裁切，包括任务三视口、history列表/详情、状态/工作流/仓库分区、分页、外部深链、skills/activity详情、三种导入错误。没有声称逐张看完32张原图全文；另查看了first轮大小错误原图和third轮筛选原图。最终联系人图保留裁切标记，灰色是联系表画布而非UI。

任务窄屏只显示当前层级，返回入口清楚；桌面保留原双栏，链接对象有独立说明而不伪装匹配任务；大小/编码提示中文可读、输入仍保留。沿用暖纸白/陶土与紧凑工作台，没有视觉重设计。fullPage中fixed顶栏随滚动出现在文档中部是截图方式，不表示多个顶栏。

本轮为隔离mock Chromium渲染和交互，不是后端E2E、读屏、原生触摸/软键盘或跨浏览器测试。未重新生成不受影响的八页全量图片；历史证据复用边界如上。实现提交不等于任务已验收。
