# 第一批审核证据 UI

范围仅限第一批。页面在任务详情中读取现有
`GET /ui-api/v1/workspaces/:workspaceId/tasks/:taskId/evidence`，不执行检查、审核、清理或发布操作。

## 当前读取与回退

- `ui/src/task-evidence.ts` 是浏览器局部投影，不是另一套公共协议；校验任务身份及实际检查/审核记录。
- 旧响应缺少 Host 来源、当前候选权威绑定、必需项、分类和复审上下文，明确显示未知；退出码 0 和批准记录不等于当前 Host 验收通过。
- 检查或审核提交与记录候选不一致时标记不可用于此候选；不依据历史已接受提交补造当前通过。
- 未读取、读取失败、空记录、文件不可读分别展示；失败可重试，成功后可手动刷新。取消后的迟到响应不会发布到新任务。
- 新公共契约由后端维护；已按 Lead 确认的 `checks[].host`、`integrations[].readiness` 和 `currentCandidate` 形状接入真实 GET adapter，不修改 protocol。
- 当前候选只认 `currentCandidate` 的唯一集成/候选映射，缺失/null/异常时未知；不按时间或数组末项推断。
- Host 附件校验来源、版本、命令、日志哈希及指纹；工作区/任务/集成/候选及 `host.attempt === currentCandidate.taskAttempt` 一致才标为当前 Host 结果。
- 就绪四态、必需项及阻塞分类分别展示；optional 明确不阻断。就绪报告为 ready 时仍需必需检查存在一致的当前 Host 成功结果；缺文件、失败、缺失项或非 optional 阻塞不能显示当前就绪。
- ready 不是独立审核批准、任务验收或发布许可。复审上下文未提供时显示未记录，后继 orchestration 负责补齐，不制造数据。
- fixtures 只验证映射/渲染/客户端请求，不是真实新后端证据链联通证明。

## 协作事件

只折叠白名单内且无原因的同任务例行事件。错误、阻塞、修复请求、未知类型、需要用户确认的事件默认展开，保留原因和任务链接。
事件按事件身份去重，消息保留最高版本，不按文案或任务合并不同决定。乱序回放不改变决定列表。
公共成员进度仍作为成员自己的对话消息展示；不修改后端唤醒策略。

## 本地检查入口

- `pnpm test:ui` 包含证据兼容、API 读取、空/错/加载状态及决定事件 fixtures。
- `pnpm exec vitest run ui/src` 包含相关流式消息和其余 UI 回归。
- `pnpm typecheck:ui`、`pnpm test:protocol`、`pnpm build:ui`。
- 无浏览器运行器时不声称完成实际 375px、键盘操作或明暗主题截图验收。
- 真实后端全链路由 `review-b1-integration` 验证，独立审核及 Host 精确候选检查仍为后续门禁。

## 本次真实自查（attempt 2）

- 从基线 `ee68b448` 的干净新任务树恢复前轮部分提交，随后补齐契约映射；未修改旧树或主检出。
- 离线冻结锁文件安装依赖；未新增依赖或更改锁文件。
- 首次 UI 类型检查发现投影字面量被扩宽，已修复并重跑通过。
- 完整 UI、协议、类型及生产构建结果见任务结果；构建有 >500 kB chunk 警告。
- 未运行真实浏览器交互、375px/横屏截图、明暗主题或真实服务端组合链路；后者仍由集成任务验证。

## 本次真实自查（attempt 3）

- 在新任务树从 `eb70ca0` 合并已验收的 producer 提交 `32d945469f331216c48bdea65111593844506a02`，没有重写 producer 或修改旧任务树。
- `mergeChatHistory` 统一合并分页与刷新消息，并按工作区/对话/事件序号保留去重回执。ChatScreen 的初始 snapshot、后续 snapshot、before 翻页、gap 补读及最终渲染均使用该路径，不再仅传最新页的回执。
- 匹配到回执时保留完整公开 `reason`；旧消息仅含截短摘要时补充展示，不通过文案猜测类型。未知、错误、决策或带原因事件保持展开。
- `tests/acceptance/timeline-ui.test.tsx` 启动真实临时 SQLite/Host/orchestration/HTTP 会话，使用浏览器 `request` 客户端、共享历史合并及 ChatTimeline 服务端渲染，覆盖 before、refresh、首屏刷新项、重叠页面、乱序重放、跨页 gap 和缺失元数据。
- 本组合测试只证明聊天回执读取与 UI 消费，不代表 Host 证据/审核全链路验收，也不是挂载 ChatScreen 的浏览器端到端测试。
- 检查入口：`pnpm exec vitest run ui/src tests/acceptance/timeline-ui.test.tsx tests/acceptance/timeline-receipts.test.ts tests/acceptance/chat-orchestration-review.test.ts tests/acceptance/collaboration-review.test.ts`；另运行 `pnpm test:ui`、`pnpm typecheck`、`pnpm test:protocol`、`pnpm build:ui` 和 `git diff --check`。
- 新 HTTP/UI 测试首次因测试目录的经典 JSX 转换缺少 React import 失败，补齐后重跑通过。构建仍有 >500 kB chunk 警告。
- 无可用浏览器运行器，未运行真实键盘交互、375px/横屏、明暗主题或 reduced-motion 验收；未新增依赖、执行第二三批或 push。

## 仅登记，不实施

- 第二批：基线复用、检查 DAG、环境缓存；待用户单独明确确认。
- 第三批：分阶段队列、跨引用并行；待用户单独明确确认。

第一批完成或 Host 事件均不自动授权以上批次。
