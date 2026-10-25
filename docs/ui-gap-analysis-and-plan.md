# RIFT UI 缺口分析、实现方案与开发计划

日期：2026-10-25。对应 [DESIGN.md](../DESIGN.md) 的 S1–S8。依据本地**当前工作树**检查，包含已有未提交的 E1 改动，不能把 HEAD 当作完整实现基线。本轮交付设计和计划，没有开发 UI、修改业务源码、调用真实模型或发布应用。

## 1. 结论与范围

当前 RIFT 已有可复用的执行底座：多 workspace 并发、可配置角色、任务 DAG、公平调度、Run 快照、任务 worktree、检查/审查/集成、取消与恢复。但它仍然是 CLI + 本地管理服务，尚不是用户描述的聊天型工作区产品。

差距不只是页面：**持久聊天与 @ 路由、workspace 级主 Agent 连接、Skill 生命周期、多仓库领域模型、Agent 活动投影和浏览器接入**都需要增加或调整后端契约。建议在现有 DSH 插件与账本上增量实现，保留现有执行与验收门禁。

历史 [E1 验收](e1-acceptance.md) 将 E1.6 标为 deferred，这是历史交付事实。本次重新安排 UI 目标和方案，不追溯修改原验收状态，也不把本次文档交付记为功能完成。

目标首版的明确取舍：

- workspace 允许无仓库、只有一个主 Agent，先讨论再接入代码；执行代码变更时校验开发与审查能力。
- 每条消息一个接收者，默认主 Agent，@ 可定向任一可用子 Agent；多人广播不在首版。
- 一个 workspace 可有多个对话，但仍至多一个活跃开发 Workflow；对话与 Workflow 通过引用关联。
- 一个 Task 首版只写一个 Repository；跨仓库目标拆成多任务依赖。一次跨仓库原子发布不在首版。
- 主 Agent 与子 Agent 可选择受支持的运行时或模型 API。首批至少交付 DSH/API 与一种已验证的原生运行时主 Agent 路径；未通过编排工具探针的组合显示不可用，不能冒充可配置。
- UI 创建并管理受管 worktree；外部 worktree 可发现/关联，默认只读关联，接管和删除权限显式区分。

## 2. 八个场景的实现差距

“部分已有”只代表后端具备其中一部分，不代表已有可操作页面。

| ID | 用户需求 | 当前代码事实 | 需要补齐 | 优先级 |
| --- | --- | --- | --- | --- |
| S1 | 创建、切换多个 workspace | 已有创建/列表/归档和跨 workspace 调度；创建强制要求一个仓库；列表仅返回 workspace 表字段 | 应用壳、切换状态、草稿隔离；可无仓库创建；workspace 详情/摘要/更新及历史查询 | P0 |
| S2 | workspace 设置主 Agent 运行时/API | 主 Agent 固定 `dsh-lead` 且禁止 binding；provider/model 来自 HostConfig，全 workspace 共用 | 主 Agent binding、workspace 级配置快照、运行连接目录、主 Agent 适配与编排工具通道 | P0，最高技术风险 |
| S3 | 自由添加子 Agent，名称/职责/运行配置 | 角色支持自定义 ASCII 名称、prompt、purpose 和 binding；整组 PUT；强制至少 lead/developer/reviewer；外部 model 是实例声明 | 稳定身份与中文 displayName，增量 CRUD，职责/能力分离；移除创建时强制三角色；真实连接配置与生效语义 | P0 |
| S4 | workspace 共享与 Agent 专属 Skill | RIFT 源码/迁移没有 Skill 实体、分配/版本表或执行注入；role.prompt 不等于 Skill 系统 | 导入与版本库、共享默认项、Agent 分配/覆盖、兼容检查、有效集合解析和执行快照 | P0 |
| S5 | 聊天首页，默认主 Agent，@ 子 Agent | startLead 内部调用 followup，但只有 Workflow goal / 唤醒入口；子 Agent 为一次 activation；没有消息表/聊天路由 | conversation/message/turn 账本、投递队列、接收者校验、输出事件、重连、停止和上下文重建 | P0，主体验 |
| S6 | 多仓库、多 worktree 管理 | repositories.workspace_id UNIQUE；Workspace/Workflow/GitContext 均单仓库；自动创建任务/候选/审查现场 | 多仓库关联、repo 级 Workflow 快照与集成分支、task.repositoryId、worktree 管理 API 和归属检查 | P0，结构改造 |
| S7 | 任务列表与进度 | workflow status 已返回 tasks、runs、operations、worktrees、integrations、eventSeq；有状态和门禁 | workspace 范围列表、分页/过滤/依赖边、进度投影、任务 UI 和实时更新；不造百分比 | P1，复用较多 |
| S8 | 查看每个 Agent 工作状态 | 子 Run 有生命周期；Lead 仅有内存 handle 和会话 ID；不存在完整 Agent presence API | 汇总聊天 Turn、任务 Run、队列、清理和连接状态；主 Agent 生命周期入账；状态侧栏 | P0，聊天必需 |

### 代码证据索引

| 编号 | 源码与定位 | 支持的判断 |
| --- | --- | --- |
| C01 | [package.json](../package.json)、[tsconfig.json](../tsconfig.json) | 只有 TypeScript 后端/CLI 构建，无 UI 入口与浏览器应用构建 |
| C02 | [host-service.ts](../src/api/host-service.ts)：route / defaults | workspace create/list/archive，roles PUT；没有 chat/skills/repositories/worktrees/presence 路由 |
| C03 | [workspace.ts](../src/project/workspace.ts)、[schemas.ts](../src/api/schemas.ts)：workspaceSchema | 创建必带 repositoryPath/baseRef 并立即插入一条 repository |
| C04 | [agent-roles.ts](../src/project/agent-roles.ts)：configureRoles | 3–130 个角色、一个 DSH Lead、至少开发与审查；ASCII 名称、整组更新、引用保护 |
| C05 | [host-service.ts](../src/api/host-service.ts)：ensureLead / startLead | Lead 使用全局 config.leadProvider/leadModel；持久化只关联 workflow.leadSessionId |
| C06 | [provider-bindings.ts](../src/project/provider-bindings.ts)：validateBinding / validateInstanceModels | DSH spawn 可以传模型选项；外部模型属于已注册实例；credentialRefs 只是引用契约 |
| C07 | [activation-bridge.ts](../src/task/activation-bridge.ts)：start；[rift-tools.ts](../src/tools/rift-tools.ts)：installLeadTools | 子执行需要 live DSH parent；八个编排工具校验具体 DSH Agent 对象身份，不能直接换成原生 Lead |
| C08 | [schema.ts](../src/storage/schema.ts)、[0001_initial.sql](../migrations/0001_initial.sql)、[database.ts](../src/storage/database.ts)：workspace | 仓库 workspace 外键唯一；工作区查询 JOIN 单个 repository；worktree 强依赖 task |
| C09 | [contracts/index.ts](../src/contracts/index.ts)：Workspace / Workflow / Task / Worktree / TaskEvent | Workflow 只有一个 baseCommit/integrationRef；Task 无 repositoryId；没有 Conversation、Skill、AgentTurn |
| C10 | [coordinator.ts](../src/task/coordinator.ts)：createWorkflow / reserve / status / wait / prompt / recover | 每 workspace 单活跃流程；已有调度、快照与状态；wait 是按 Run/request 过滤的 POST 长轮询；无完整聊天流 |
| C11 | [integration.ts](../src/git/integration.ts)、[worktree-binding.ts](../src/git/worktree-binding.ts) | Git 上下文取 workspace.repositoryPath；有目录边界、common-dir 锁、候选门禁与保守归档 |
| C12 | [local-api.ts](../src/api/local-api.ts)；[management-security.test.ts](../tests/acceptance/management-security.test.ts) | 精确 loopback Host + Bearer token；拒绝带 Origin 请求；写入要幂等键；没有 SSE |
| C13 | [0003_scalable_scheduler.sql](../migrations/0003_scalable_scheduler.sql) | Lead kind/binding 的数据库 CHECK、唯一 active Workflow、Run 配额 trigger 也必须同步迁移 |
| C14 | [roles-and-reuse.test.ts](../tests/core/roles-and-reuse.test.ts)、[e1-management.test.ts](../tests/acceptance/e1-management.test.ts) | 已有角色快照、实例冲突、Lead/子执行与 workspace 隔离等回归基础 |
| C15 | [analysis-reuse.ts](../src/task/analysis-reuse.ts) | analysis 批次是一次 Run 内顺序处理给定文本；不是聊天会话、Skill 机制或跨 Run 记忆 |

缺失能力的判断来自对 src、migrations、profiles 和 package.json 的检索与入口核对；不推断 DSH 或原生运行时依赖内部完全没有相似能力。现有依赖能力仍需按各适配器实际暴露的接口验证。

### 容易误判的六处

1. **“自由角色”还不是完整自定义 Agent。** name 同时参与角色 ID 构造与配置匹配；重命名需要 displayName/稳定标识设计。purpose 只支持 lead/developer/reviewer。运行期间整个 workspace 的配置也可能被占用限制。
2. **模型标签不是执行配置。** binding.model 更改不能改变已启动的外部实例；不同模型需要不同已登记实例。不能用 UI 下拉框制造热切换假象。
3. **已有 followup 不代表聊天可用。** 当前 Lead 生命周期绑定 Workflow，终止后不再接受输入；没有用户消息回执、持久历史、输出订阅或子 Agent 定向队列。
4. **已有 worktree 不代表多仓库管理。** 候选和审查现场有部分信息存在 integration/candidate 记录中，需要统一查询投影；只展示 worktrees 表可能漏掉场景。
5. **已有 eventSeq 不代表 SSE。** task_events 强依赖 Workflow；空 workspace、配置更新和聊天事件没有自然归属。新事件协议必须涵盖这些对象。
6. **浏览器不能直接复用 CLI 认证。** C12 的 Origin 拒绝是现有边界；不能简单删除检查、放开 CORS，再把管理令牌塞进 localStorage。

## 3. 技术方案

### 3.1 模块与职责

建议新增 `ui/` 浏览器应用，与现有 `src/` 后端保持独立 TypeScript 构建。前端使用 React + TypeScript + Vite 作为待落地技术选型；版本在实施时按 Node 24 与锁文件统一核验，不在本次引入依赖。

这项选择基于本地客户端界面和已有 Host 后端的项目条件。React 官方给出了 Vite 的 react-ts 起步方式，同时说明路由、数据获取和缓存仍需单独设计；Vite 官方列出运行环境要求，实施时需一起核验模板和插件，而不只检查 Vite 本体。参考：[React 官方构建指南](https://react.dev/learn/build-a-react-app-from-scratch)、[Vite 官方入门文档](https://vite.dev/guide/)。

| 层 | 建议位置（尚未创建） | 责任 |
| --- | --- | --- |
| 应用壳与页面 | ui/src/app、ui/src/features | workspace 路由、聊天、Agent、Skill、仓库、任务；缓存按 workspace 隔离 |
| 浏览器会话与查询 API | src/api/browser-*、src/api/workspace-views.ts | 浏览器认证、聚合读模型、分页、输入校验、SSE |
| 聊天服务 | src/chat/* | Conversation / Message / AgentTurn、收件队列、停止、历史上下文 |
| Agent 配置与执行适配 | src/agent/*，复用 src/project/* | 稳定身份、配置快照、连接目录、能力检查、工具网关 |
| Skill 服务 | src/skill/* | 导入、版本、继承解析、上下文/资源编译与兼容性 |
| 仓库与 worktree 服务 | src/project/repositories.ts、src/git/* | 多仓库归属、受管/外部目录、任务执行上下文 |
| 事件与活动投影 | src/events/*、src/agent/activity.ts | 事务事件、游标、连接新鲜度、Agent/任务状态 |
| 执行底座 | 现有 coordinator / scheduler / storage | 所有工作入账、依赖、预算、清理、审查和接受门禁 |

前端只提交意图和展示服务端事实，不直接调用模型 API、操作 Git 或推导关键执行权限。业务服务继续运行在现有 Host 中；浏览器接入不需要另起一个调度 daemon。

### 3.2 主 Agent 与运行连接

运行连接按“运行时实例”和“模型 API”建模。模型 API 由 Host 通过受支持的 DSH 模型适配器执行，保存 endpoint/model/凭据引用；原生运行时复用已注册 Provider。首版只开放实际验证过的协议与能力组合。

新增运行目录返回：实例 ID、runtime、支持的模型/参数来源、是否支持聊天、流式输出、编排工具、Skill 资源、取消、是否需要重载。能力未知时显示未知，不根据实例名称猜测。凭据值由 Host 的明确配置入口处理；UI 只拿引用和验证结果。当前 keychain/env/native 的字符串合法性校验不等于已经有通用凭据管理器。

**主 Agent 是本方案最先验证的技术闸门。** 当前 DSH Lead 同时承担面向用户的智能体、子执行父对象、工具授权身份。建议拆分：

- 保留内部 DSH 执行父对象/控制器，管理官方 subagent 生命周期；它不作为额外成员占据用户的 Agent 列表。
- 用户选择的主 Agent 通过统一适配器产生回复与编排工具请求；DSH 路径可直连现有工具，原生路径需支持受限工具网关。
- 工具网关按服务端保存的 workspace、workflow、agent、turn 授权；模型不能自行声明身份。规划、派发和完成仍经 TaskCoordinator 校验。
- 原生主 Agent 不得通过原生 shell 或二次委派绕开账本写入项目；必须验证该运行时可施加必要工具限制。不能满足的实例不开放主 Agent 模式。

U0 探针必须证明：原生主 Agent 通过工具提交计划 → 指派子 Agent → 读回状态 → 正确收尾，并通过伪造身份/跨 workspace/继承委派拒绝测试。若官方适配器不支持工具注入，先开发受限桥接适配器并重新估算；不把“只能聊天的原生实例”验收为主 Agent。

配置修改采用 expectedVersion。新 Turn/Run 创建时固定 Agent 配置、连接和 Skill 版本；运行中不替换。外部实例需重载时保持“待生效”，在占用清零后由受控重载或服务重启生效，不通过更新元数据宣称成功。

### 3.3 聊天与 @ 投递链路

`输入 + 接收者 ID → 保存 Message 与投递请求 → 校验 workspace/Agent → 串行收件队列 → AgentTurn → 适配器 → 回复/业务工具 → 持久结果 + 事件`。

- workspace 创建后可建立默认 Conversation；用户可在同一 workspace 创建后续对话。恢复的是 RIFT 历史上下文，不保证原生会话 handle 永久存在。
- 发送请求携带 clientMessageId、recipientAgentId、contextRefs 和幂等键。空接收者由服务器解析为当前主 Agent；显式失效接收者必须报错。
- @ 候选是当前 workspace 的可用成员；正文保留结构化 mention token，实际路由以 recipientAgentId 为准。显示名变化不破坏旧消息。
- 同一 Agent 的消息按服务端序号串行；忙碌时持久排队，不擅自打断。不同 Agent 可以并发，但受统一容量与同一 Agent 独占约束。
- 普通讨论生成聊天 Turn，不强制建 Workflow。提出代码执行目标时，主 Agent 通过受控动作创建/接入 Workflow；缺仓库、审查者或有其他活跃流程时在聊天内说明阻塞。
- @ 子 Agent 的讨论只产生回复；如果要求修改代码，必须登记 Task 并经调度执行。将目标 Agent 固定在任务引用中，不绕过路径冲突、审查或集成。
- 子 Agent 的聊天 Turn 创建自身代码任务后，先返回任务回执并结束、确认清理，释放该 Agent 的聊天租约，再由调度器启动任务 Run；不能持有聊天租约同步等待同一 Agent 的任务，否则会自锁。每次执行只有一个租约，Turn 与 Run 的关联不重复占额。
- @ 审查成员可做讨论，但“正式批准”必须来自关联精确 candidate commit 的审查 Run，不能从聊天文本直接获得。
- 提供上下文选择（任务、仓库、worktree）；对跨仓库代码目标要求明确仓库。上下文预算使用可追溯摘要 + 最近消息，保存摘要来源与版本。
- 输出保存最终消息及有序增量片段；运行时不支持流式时只有 started/completed/error 事件，UI 不模拟逐字回复。
- stop-turn 与 cancel-task/cancel-workflow 为不同命令。停止回复取消对应 Turn；已创建任务继续按各自状态处理，并给出任务链接。
- 重复发送返回原 message/turn；未知发送结果先查询 clientMessageId。崩溃后已开始但结果未知的执行保留 interrupted/cleanup_unknown，不自动重放有副作用的工具。

持久 AgentTurn 需要和 Task Run 共用执行租约。非主 Agent 的聊天也计入子执行总额/工作容量，避免从聊天绕过 scheduler。主 Agent Turn 采用每 workspace 单执行与独立可配置 Host 上限；不把主 Agent 活动混入现有子槽位数字。

### 3.4 Skill 的存储与注入

SkillVersion 保存 SKILL.md 指令、资源清单、内容摘要、来源与兼容需求；以不可变版本发布。workspace 维护共享默认分配，Agent 维护专属分配及显式覆盖/排除。

解析顺序：workspace 默认启用项 → Agent 覆盖/排除 → Agent 专属项 → 版本/名称冲突检查 → 兼容校验 → effectiveSkills 快照。按稳定 ID 去重；同名不同 ID 必须提示，不能按字符串静默合并。更新版本后等待下次执行采用；历史消息、Run 仍能读取旧版本。

Runtime SkillCompiler 将有效集合转换为适配器支持的指令或受限资源目录，不默认所有运行时采用相同搜索路径。普通指令可注入 prompt，脚本/文件资源必须验证运行时能力和授权；分析批次仍保留其“仅给定文本、无工具”的限制。Skill 指令不提高工具权限。

导入只在 Host 读取选定文件/目录，检查路径边界、符号链接、大小与清单；不自动执行安装脚本。预览来源、内容和受影响成员。撤销共享不删除历史版本；有历史引用的版本只能归档。验收需要检查实际发给适配器的指令/资源，而不是只检查数据库分配记录。

### 3.5 多仓库与 worktree

单仓库抽象需要贯穿替换，不能只移除 UNIQUE：

- Repository 按 workspace 关联，保留 canonicalPath/commonGitDir/baseRef；同一真实仓库在不同 workspace 的冲突仍通过规范 commonGitDir 识别。
- WorkflowRepository 保存每个仓库的 baseCommit、integrationRef 和状态；Workflow 原有单个字段迁移为兼容投影。
- Task 增加 repositoryId；可无仓库的纯文本分析与聊天不创建虚假 Git 上下文，代码任务必须指定仓库。旧任务回填原 workspace 仓库。
- GitContext 显式携带 Repository + WorkflowRepository；检查、审查、恢复、containsCommit 和发布都使用这个上下文。
- 依赖可跨仓库，但 commit 只在所属仓库验证；跨仓库依赖通过任务通过状态表达，不尝试跨仓库 cherry-pick。
- 集成按每仓库分支记录；目标首版保留全局串行审查/集成，不额外扩张并行范围。

Worktree 增加 workspaceId/repositoryId、origin、ownership、用途和可空 taskId；区分任务目录、候选/审查现场、用户受管目录、外部关联目录。查询层将 worktrees 与 integrations 中的候选/审查现场归一展示。

执行前绑定目录归属与唯一写入租约；外部关联只允许查看，接管要验证目录边界、真实仓库、基线、占用和内容状态。受管归档继续检查 dirty/untracked/ignored、清理确认与产物保存，不提供绕过按钮。多仓库结果分别验收；一个仓库成功另一个失败时显示各自结果，Workflow 不声称整体完成。

### 3.6 浏览器接入与实时事件

建议同一 Host 进程提供 UI 静态资源和独立 `/ui-api/v1` 路由。保留旧 `/v1` CLI 认证契约；新路由用浏览器会话认证，不让前端持有 management.token。

新增 `rift ui` 启动入口生成短时、一次性 bootstrap code，通过 URL fragment 交给 UI，兑换服务器端会话后立即清除 fragment。会话使用 Host-only、HttpOnly、SameSite=Strict cookie，绑定精确 loopback Host/端口与过期时间；本机 HTTP 的 cookie 属性需实测，不把 Secure cookie 方案照搬到不支持的连接。启动码不写日志，不作为 SSE 查询参数。

写请求校验精确 Origin + 会话 + CSRF token + 幂等键；SSE/读取校验会话和来源元数据，拒绝跨站。无 Origin 的同源读请求按 Host、会话和 Fetch Metadata 判定，不能假定每个浏览器 GET 都带 Origin。禁止通配 CORS；开发服务器通过受控代理接入。验证重绑定、重放、跨站、失效会话与现有 CLI 回归。

新增 workspace_events（workspaceId、seq、type、entityId、entityVersion、payload、occurredAt）。业务状态与持久事件在同一事务提交；seq 可采用 Host 全局单调值，按 workspace 过滤，允许序号有间隔。task_events 历史保留，新增变更同步投影到统一事件流。

快照 API 在同一读事务返回 snapshotCursor + 各实体版本；客户端获取快照后订阅 cursor 之后的 SSE，去重并只接受较新版本。cursor 超出保留窗口返回 resync_required，客户端重新取快照。首次无 Workflow 的 workspace 也可订阅。

工程目标：服务端每 15 秒心跳，45 秒无事件或心跳显示“状态未同步”；后台标签页恢复时立即对账。这些为待验证的设计参数，不是现有效能结论。设置连接数、缓冲与重放上限；慢消费者要求重新同步，不无限积压。断流时允许退回快照轮询，保留草稿和发送回执查询。

### 3.7 状态与进度投影

AgentActivity 关联 AgentTurn、Run、待发消息/operations、执行租约和连接状态。优先区分 unavailable/disabled、清理未知、实际运行/停止、排队、空闲；独立保留 freshness，过期时不能从“没有看到 Run”推断空闲。显示当前工作、上次活动、受阻原因和配置版本。

主 Agent 要记录 started/finished/cancelled/interrupted，不能仅由 lead.attached 推断正在工作。子 Agent 的职责 prompt 不用于判断擅长程度或工作状态。

任务进度为 succeeded / 当前 planRevision 的 task 总数，另外显示失败、取消、阻塞数量。代码任务只有通过现有接受门禁才计入 succeeded；analysis 沿用对应只读验证。没有任务时显示“尚未形成计划”，不显示 0/0 或 100%。

任务查询应补齐依赖边、分页、筛选与时间信息；当前 status 只有 dependencyStatus，不能凭该字符串绘制完整 DAG。显示检查执行记录与 Agent 自报检查的区别，不把 diff-check 冒充测试套件。

## 4. 数据与 API 契约草案

以下均为待实现接口，不可当作现有可调用能力。

### 4.1 数据变更

| 对象 | 主要新增/调整 | 迁移注意 |
| --- | --- | --- |
| workspaces | version、defaultConversationId、默认仓库引用（可空） | repository JOIN 改为可选关联；旧 workspace 原样可用 |
| roles → Agent 配置 | 保留稳定 role ID，新增 displayName、handle、description、能力及配置版本 | 老 name 变 handle/displayName 初值；不因改名重建身份；放宽 Lead kind/binding CHECK |
| provider bindings / connections | scope、运行方式、API 配置引用、实际生效 revision | 旧外部 model 未知时保持未知；不能从 profile 名猜测 |
| conversations / messages | workspaceId、recipientAgentId、clientMessageId、序号、正文、状态、引用 | 唯一 clientMessageId 限定 workspace；消息不能引用另一 workspace 成员 |
| agent_turns / message_chunks | 接收者、连接/Skill 快照、序号、生命周期、输出、cleanup | 不复用 TaskStatus；中断后可查询但不自动重放 |
| execution_leases | ownerType/ownerId、Agent、workspace、容量类别、清理/释放 | 从未释放 Run 回填；与 Run/Turn 创建原子占用，统一改造原 quota trigger/查询，不能双计数 |
| skills / skill_versions / assignments | 来源、摘要、版本、资源、workspace/Agent 作用域、覆盖策略 | 历史版本不可变，运行快照不能悬空 |
| repositories / workflow_repositories | workspace 一对多、仓库标识、每仓库基线与集成 ref | 重建唯一约束和查询，原 Workflow 回填一个快照 |
| tasks / worktrees | repositoryId；worktree 来源、归属、可空 taskId | 旧任务回填，候选与审查目录归一；保留 writer 与清理门禁 |
| workspace_events | 游标、实体版本、类型、载荷 | 无 Workflow 也可发事件，旧 task_events 仍可追溯 |

不直接改写已有 migrations/0001–0003。新增后续迁移，按“新增可空结构 → 回填 → 验证 → 收紧约束/切换查询”实施。SQLite 重建表必须保留外键和 trigger，执行 foreign_key_check；迁移前停止新派发并备份完整 home。旧未知清理占用必须迁入租约，不能因升级释放。

以 feature flag 保持 UI 功能关闭可回退；数据迁移后不承诺旧二进制直接兼容，回退需配套恢复升级前快照。防止把“关 UI”当成数据库回滚。

### 4.2 浏览器 API

浏览器前缀统一为 `/ui-api/v1`。JSON 写入使用 Idempotency-Key；更新使用 expectedVersion。暂不兼容的字段在读模型显式标 unknown。

| 接口草案 | 内容 |
| --- | --- |
| GET/POST /workspaces；GET/PATCH /workspaces/:wid | 摘要、可无仓库创建、详情、修改 |
| GET /workspaces/:wid/snapshot | 对话/成员/任务/仓库摘要、容量、snapshotCursor |
| GET/POST /workspaces/:wid/agents；PATCH /workspaces/:wid/agents/:aid | 主/子 Agent 配置与停用，版本校验 |
| GET /connections；POST /connections；POST /connections/:id/verify | 实际连接能力、Host 侧配置、显式验证 |
| GET/POST /workspaces/:wid/conversations | 对话历史与新建 |
| GET/POST /workspaces/:wid/conversations/:cid/messages | 分页消息、定向投递、按 clientMessageId 对账 |
| POST /workspaces/:wid/turns/:tid/stop | 只停止本次回复 |
| GET/POST /workspaces/:wid/skills；POST /workspaces/:wid/skills/:sid/versions | Skill 导入/版本/归档；以动作或版本化 PATCH 更新状态 |
| PUT /workspaces/:wid/skill-assignments；PUT /workspaces/:wid/agents/:aid/skill-assignments | 共享默认与专属/覆盖配置 |
| GET /workspaces/:wid/agents/:aid/effective-skills | 最终生效项、来源、版本与兼容结果 |
| GET/POST /workspaces/:wid/repositories | 仓库列表、连接/关联 |
| GET/POST /workspaces/:wid/repositories/:rid/worktrees | 发现/列表与创建；请求指定来源和所有权 |
| POST /workspaces/:wid/worktrees/:id/archive 或 /detach | 分开受管归档与外部解除关联 |
| GET /workspaces/:wid/tasks；GET /workspaces/:wid/agents/activity | 跨该 workspace Workflow 的筛选/分页与活动摘要 |
| GET /workspaces/:wid/events?after=:cursor | SSE，只允许已认证作用域 |
| POST /workspaces/:wid/workflows/:id/pause、/resume、/cancel 等 | 浏览器包装现有业务动作，复用相同门禁 |

服务端对 URL 的 wid、实体归属、Agent/仓库引用、动作权限逐项校验，不能相信前端下拉列表。原 CLI 单仓库用法继续可用；存在多个仓库时显式指定 repositoryId，旧参数不明确时返回可解释错误，不任取第一条。

## 5. 分阶段开发计划

采用 U0–U8 标识这次 UI 计划，避免与历史 E1/E2 交付状态混淆。估算为一名熟悉仓库的全栈工程师的有效工程日，含定向测试与评审；不是承诺日期，不以多个 Agent 自动折算工期。

| 阶段 | 工作包与代码边界 | 前置 | 验收闸门 | 估算 |
| --- | --- | --- | --- | --- |
| U0 契约与风险探针 | 冻结 S1–S8；主 Agent 工具桥接、原生取消/输出能力；浏览器认证原型；仓库/租约迁移设计 | 无 | 原生主 Agent 规划/派发/状态/完成链路及越权拒绝证据；确认接入方案 | 3–5 日 |
| U1 领域与迁移 | Agent 稳定身份、可空仓库、多仓库 Workflow 快照、聊天/Skill/event 表、统一执行租约 | U0 | 旧数据库升级、外键/配额/未知清理保留、旧 CLI 回归 | 5–8 日 |
| U2 浏览器服务 | 同源 UI 服务、bootstrap/session/CSRF、聚合读 API、SSE 游标与重放 | U1 | 跨站/过期拒绝；快照+流无缺口，旧 /v1 安全测试保持通过 | 3–5 日 |
| U3 应用壳与主聊天 | workspace 切换/草稿、主 Agent DSH/API 聊天、消息账本、队列、停止、历史/重连 | U2 | 两 workspace 消息与草稿隔离；重复请求不重复执行；刷新恢复 | 6–9 日 |
| U4 Agent 与 @ / 运行时 | 增量 CRUD、中文名/职责、连接生效、@ 路由、原生主 Agent 适配落地、活动投影 | U3 + U0 探针 | 两种受支持执行方式实际生效；指定成员正确接收；busy/disabled/unknown 状态正确 | 6–10 日 |
| U5 Skill | 导入/版本/共享/专属、有效解析、执行注入、兼容反馈与快照详情 | U4 | 两成员共享同版本、专属配置隔离、在途版本不漂移、注入证据 | 4–6 日 |
| U6 多仓库 worktree | GitContext 全链路、仓库与目录 API/UI、任务绑定、归档/解除关联 | U1、U4 | 同 workspace 两仓库多目录；写入/提交不串仓，外部目录不误删 | 5–8 日 |
| U7 任务与证据闭环 | 列表/详情/依赖/阶段、消息跳转、完整 Agent 状态、取消/重试/重规划控件 | U5、U6 | 从聊天到代码任务、审查、每仓库集成、回执与真实进度完整一致 | 5–7 日 |
| U8 故障与交付 | 重连/重启/未知结果、长列表/移动端/键盘/输入法、构建与运行说明 | U7 | S1–S8 全部通过，真实适配与受控故障证据分开记录 | 4–6 日 |

**总量约 41–64 工程日。** 最大变动项是原生主 Agent 工具桥、Skill 资源兼容和多仓库迁移；U0 未通过前不把这一区间当成固定交期。多人并行可在 U1 契约冻结后分前端、聊天/运行连接、Skill/Git 三条工程线，但数据库、租约和事件合同需统一集成。

中间交付边界：

- U3：可用的单主 Agent 聊天工作区；不能据此宣称八场景完成。
- U4：多 Agent @ 和运行连接闭环；Skill/多仓库仍待完成。
- U7：全部功能联通；U8 完成后才验收本次目标。

建议 PR 切分：契约/迁移 → 浏览器接入/事件 → workspace 壳 → 消息服务与主聊天 → Agent/连接 → @/活动 → Skill → 多仓库 Git → worktree 管理 → 任务证据 → 故障验收。每个 PR 附对应 UI-ID、S-ID、迁移风险和真实检查结果。

## 6. 端到端验收清单

| 验收 ID | 操作 | 必须观察到的结果 |
| --- | --- | --- |
| A1 / S1 | 创建两个 workspace，一处发送后切换并刷新 | 后台工作继续；消息、草稿、接收者与导航不串空间；无仓库也可创建 |
| A2 / S2 | 两 workspace 配置不同主连接；其中一个从 API 改为受支持原生运行时 | 新 Turn 真实走各自连接；旧 Turn 保持快照；原生主 Agent 能调用受控编排工具 |
| A3 / S3 | 添加中文显示名子 Agent，修改职责、连接，停用被占用成员 | 名称与职责可编辑；稳定引用保留；占用/未完成引用被正确解释或拒绝 |
| A4 / S4 | 共享 Skill + A 专属 Skill；发布新版本时保留旧 Run | A/B 有效集合和实际注入正确；旧执行版本不变；冲突/不兼容可见 |
| A5 / S5 | 默认发送、@ 指定、成员忙碌、失效 @、中文输入法 Enter、重复提交 | 接收者正确、忙碌入队、失效不回退；无误发送；同消息至多一次启动或保留未知待核对 |
| A6 / S6 | 同 workspace 加两仓库，各建多个 worktree；尝试归档脏/占用/外部目录 | 仓库/Task/Run 归属一致；危险删除被阻止；外部解除关联不删文件 |
| A7 / S7 | 一次跨仓库目标包含依赖、失败返工和新增计划任务 | 阶段、分母、planRevision、审查和 acceptedCommit 正确；未完成仓库阻止整体完成 |
| A8 / S8 | 主回复、子开发、排队、停止、清理未知和断流 | 每个 Agent 状态能追到 Turn/Run；主 Agent 不因 attach 就显示工作；清理未知不显示空闲 |
| X1 隔离 | 伪造其他 workspace 的 Agent/Task/仓库/消息 ID | 服务端拒绝；无跨 workspace SSE 事件或工具访问 |
| X2 恢复 | 在发消息、工具调用、流式输出和清理期间中断服务 | 已保存内容可查；未知副作用不自动重放；容量仍准确占用 |
| X3 事件 | 快照期间发生变化；断线后重放；过期游标 | 无丢失/重复业务处理，旧版本不覆盖新版本，必要时重新快照 |
| X4 浏览器 | 外站请求、过期启动码/会话、CSRF、错误 Host、SSE 越权 | 逐项拒绝；management.token 不进入浏览器包或存储 |
| X5 可访问性 | 320/390/768/1440px、键盘操作、长路径、减少动态效果 | 无页面横向溢出、触控区至少 44px、焦点/阅读位置保持、状态不用颜色独自表达 |

测试实施分层：

- 领域测试覆盖队列幂等、Agent 归属、Skill 解析、租约和多仓库迁移；扩展现有 Vitest 测试，避免只验证 UI mock。
- HTTP/SQLite/Git 集成测试覆盖浏览器会话、事件游标、worktree 边界、重试和崩溃恢复。
- 浏览器测试覆盖真实表单、@、中文输入法、切换、重连、窄屏和深链；实施时再确定兼容的测试工具版本。
- 原生运行时/API 真正调用的验收与 mock/零模型探针分开报告；不沿用旧 E1 证据证明新聊天或主运行时能力。
- 每阶段运行 typecheck、相应测试与 build；完成后全量回归。实际模型调用安排在明确的验收步骤中，记录实例、模型声明/观测、范围与结果。

## 7. 本轮交付与核对口径

已生成新的聊天优先 DESIGN.md，以及本文的逐项缺口、架构、迁移/API 草案、U0–U8 开发计划和 S1–S8 验收矩阵。只检查本轮文档的内容、路径引用和格式；历史 E1 测试结果仅作为背景，不作为本轮新执行结果。

下一步可直接从 U0 开始：冻结消息/接收者、Agent 连接、Skill 继承与多仓库契约，并验证原生主 Agent 工具桥。完成技术闸门后再实施 U1 迁移和 U2 浏览器接入。
