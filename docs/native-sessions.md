# Codex 原生持久会话

本页按 [工作区仓库权限更新](workspace-repository-permissions.md) 修订：同 cwd/仓库集合/权限版本才续原生 thread；跨 worktree 的返工改用新 thread 和 Host 证据恢复上下文。普通成员讨论和开发可执行已关联仓库中的本地提交，正式 review/analysis 仍按执行模式只读。

有仓库执行权限的原生对话（包括 Lead）和开发任务默认开启 `features.code_mode` 与 `features.code_mode_host`，启动进程及恢复 thread 时均传入，支持通过 `functions.exec` 调用 RIFT 工具和仓库命令。无需手工修改工作区开关。权限版本已更新，升级后的下一轮会以公共消息或任务证据建立新 thread，避免沿用关闭 Host 的旧配置。无仓库对话和正式 review/analysis 继续使用受限工具模式。真实二进制的 Code Mode 调用、跨进程恢复及仓库边界验证见 [仓库执行探针](evidence/native-repository-probe.json)。

对话协作 C1–C4 已交付，见 [开发方案](chat-orchestration-development-plan.md)与 [最新验收](collaboration-acceptance.md)。短轮次与持久事件续办默认开启，成员消息和任务 inbox 在固定输入边界同步。原生 thread 持久化与业务续办仍是两个独立机制。

当前用户消息以原文传给 runtime，历史/成员消息加短来源说明后引用；Host 事件使用明确 Trigger 和最多 8 个关联任务的有限检查/审查快照。公共消息按 ID/version receipts 同步，失败/取消草稿不进入完成回复收据。任务补充和自然答复只在下一次 Run 输入边界消费，已开始的 Run 不变；不复制成员私有原生历史。

`rift_delegate` / `rift_send_message` 等新增工具声明会改变配置指纹，升级后第一次执行可能建立新的原生 thread，以公共消息或任务证据初始化。每次恢复重新绑定本次 Host 的动态工具闭包；失效 Run 闭包拒绝写入。新增 [真实二进制协作协议探针](evidence/collaboration-native-probe.json)按新契约验证 changed-worktree 换 thread、review 隔离、Host prior-result/inbox 恢复及工具闭包；[真实模型闭环](evidence/collaboration-real-astra-probe.json)另验证实际返工质量。

更新：2026-10-26。聊天与正式任务均通过 Codex **0.164.0 app-server** 创建持久 thread，并在后续执行中 `thread/resume` 后追加 `turn/start`。RIFT 保存会话归属与执行映射；历史、原生工具上下文和上下文压缩由 Codex 管理。不需要 LangGraph，也不把模型内部历史复制到 RIFT 聊天账本。

## 会话范围

| 场景 | 会话归属 | 续接行为 |
| --- | --- | --- |
| 原生 Codex 聊天 | workspace + conversation + 成员 + 配置指纹 | 同一成员在同一对话且权限/cwd 不变时复用 thread |
| Codex 开发、返工 | workspace + task + 开发角色 + 配置指纹 | 同 cwd/权限复用；新 attempt worktree 使用新 thread 和 Host 证据 |
| Codex 审查 | workspace + task + Reviewer + 配置指纹 | 独立审查 thread；复审读取最新候选，不继承开发 thread |
| Codex 批量分析 | workspace + task + item ID + 角色 + 配置指纹 | 每项独立记忆，顺序执行；相同 item ID 且 cwd/权限不变才续接 |
| 无仓库 Codex 文本分析 | workspace + task + 成员 + 配置指纹 | 受限聊天运行时执行，但使用独立任务 thread |

聊天配置指纹包含连接/模型、角色提示词、用途、Skill 指令、动态工具声明、Codex 版本和运行时 home。任务指纹包含 provider 实例、模型、用途、角色提示词、Skill 指令、绑定修订、版本和 home。两类指纹还包含规范化 cwd、权限版本和授予的仓库集合，执行模式仍独立。不同指纹使用不同 thread；切回已有指纹可恢复该指纹的旧 thread。修改名称或仅新增聊天消息不会重建 thread。

同一成员仍受 `execution_leases` 串行约束：聊天和正式任务不能同时占用该成员。不同成员、不同任务和聊天/任务之间不共用原生 thread。当前没有面向用户的 fork、reset 或跨角色记忆合并接口。

已有原生 thread 的任务，未显式指定角色时，返工调度会等待上次开发成员空闲，以保持角色归属；只有 cwd/权限等配置也相同才恢复原 thread。显式改派其他成员会使用另一份会话。原成员已禁用时会明确阻塞，须重新启用或显式改派。

## 聊天消息同步

公共 conversation 账本与成员的原生 thread 分开保存。每轮启动时，RIFT 在当前用户消息的边界内读取已完成历史，并排除该成员 thread 已接收的消息。输入保留消息 ID、版本、发言者、接收者、reply-to 和正文；其他成员的发言作为引用上下文，只有最后一条当前用户消息是本轮请求。

启用 `chatOrchestration` 后，工作流事件可创建 `trigger_id` 关联的 Lead Turn，其 `message_id` 为空。Host 在入队时固定公共消息边界，并把触发批次标识为 Host 账本事实；不会向公共对话写入假的用户请求。权限和 cwd 未变化的事件轮次继续使用原 conversation＋Lead 的原生 thread，任务与审查 thread 仍独立。系统回执单独存储，UI 明确标注来源。

短轮次模式把动态工具中的 `rift_wait` 换成 `rift_yield`，工具声明变化会改变原生配置指纹，因此首次启用可能建立新 thread。必要上下文从公共消息同步；旧 thread 的全部内部历史不会自动迁入。交接只登记后续处理，不代表原生模型已结束；模型结束、运行时清理和 lease 释放仍分别确认。

同步记录按**消息 ID**建立，不用单个最大 rowid 游标。因此一个先前排队、较晚完成的成员回复，仍会在下一次调用时被同步；当前请求之后的用户消息不会提前进入本轮。成员自己的原生回复在写入公共账本时也标记已接收，避免下一轮重复注入。

`turn/start` 确认接收后，在同一 SQLite 事务内保存原生 turn ID 与输入消息 receipts。状态变化导致的消息版本增长不会重新同步正文。若原生接收与本地提交之间崩溃，边界存在不确定性；清理未知仍阻塞执行，不能宣称分布式 exactly-once，也不会自动重放旧用户请求。

原生 Codex 路径不再使用 40 条近期历史＋机械摘录替代原生记忆。单次待同步正文超过 256,000 字符时，明确报 `CONTEXT_LIMIT`，不静默丢弃或标记已消费；可新建对话并提供聚焦交接。显式引用仍遵守原来的总计 64,000 字符限制。DSH/API 聊天仍使用原有有界历史与摘录机制。

## 任务与权限

两个内置 profile 的 Codex 插件入口改为 `../dist/agent/codex-provider.js`，provider 名称和模型环境变量保持原值。RIFT 的 `DshActivationBridge` 在验证 live Lead 后识别持久 Codex Provider，交给 Host 专用 `startTask`。这一路径使用已预留的 RIFT Run/租约和 DSH subprocess，不再使用官方一次性 Codex Provider 的 ephemeral activation。本地可续接 DSH activation 也使用受限原生命令 scope；其他 Provider 不自动视为已验证相同权限边界。

自定义 profile 也需要将 Codex 插件入口从 `@deepseek-ai/dsh-subagent-codex` 改为上述路径（相对于 profile 文件解析），保留各实例的 `providerName` 和 `model`，使用 `permissionMode: never`。继续加载旧官方插件的实例仍是一次性执行。

普通 DSH 调用该插件的通用 `start` 仍获得隔离的一次性执行，不能凭模型提供的 thread ID 接入 RIFT 任务历史。RIFT 的 Codex `analysisItems` 由本地固定顺序循环执行，每项结束并清理后才启动下一项；非 Codex 批次继续使用官方 DSH Workflow engine。

返工仍创建新 attempt worktree，cwd 改变会改变指纹并创建新 thread；同边界续接才调用 `thread/resume`。每次核验 app-server 返回的 cwd，使用当前 task envelope、previousResults/sourceEvidence 和 inbox 初始化必要上下文。旧 session 中的路径、检查结果、runId 和候选提交不能作为当前事实；最新任务输入要求重新检查现场。恢复 thread 不会恢复或回滚 Git/文件系统。

| 运行模式 | 权限 |
| --- | --- |
| 关联仓库的普通聊天 | 默认 `danger-full-access`，可用原生 shell/git/gh；Host 仍核验关联仓库与 cwd，模型限 Host 已验证的模型 |
| 无仓库聊天 / 标题 / 无仓库文本分析 | staging、受限业务工具，不授予仓库执行 |
| 开发 / 返工 | 默认 `danger-full-access`，允许原生命令及其子进程；任务仍在分配的 worktree 执行，并通过 RIFT 验收 |
| 正式审查 / 分析 | `read-only`，关闭原生 shell，只提供 Host read/list 与协作工具；结构化批次保持既有受限读取边界 |

任务运行固定 `approvalPolicy: never`。按用户配置，Codex 可执行模式默认采用 `danger-full-access`：进程配置、thread start/resume 和 turn/start 均明确设置，不再强制 Windows `unelevated`。这取消了原生执行的文件系统与网络沙箱隔离；关联仓库与 cwd 校验用于任务归属，不能再描述成操作系统级访问限制。正式 review/analysis 与无仓库讨论仍采用显式只读设置。该调整不修改用户全局配置；权限版本更新为 `workspace-repositories-v5-full-access`，旧会话历史保留，新执行使用新指纹会话。MCP、Apps、插件、hooks 和原生跨会话 memories 不从任务配置继承。开发的项目指令和原生工具保留，候选检查、精确提交审查、Git 只读检查和清理门禁继续生效。

Codex 0.164.0 在 resume 时恢复持久化动态工具声明；聊天每次启动进程都绑定新的 Host 工具闭包，并核对 thread/turn 身份与当前业务租约。工具声明变化会改变会话指纹。旧 Turn 不能借恢复的声明继续调用已失效的授权。

全访问配置已通过[真实运行时探针](evidence/native-full-access-probe.json)：使用锁定的 0.164.0 app-server 与本地受控 Responses，验证启动、续接、Node/esbuild/Windows 子进程、Git 提交，以及正式审查和分析的只读工具边界。探针不调用外部模型。

## 持久化、恢复与备份

迁移 `0009_native_sessions.sql` 添加：

- `native_sessions`：会话范围、配置指纹、thread ID、运行时 home 和最近 cwd。
- `native_executions`：RIFT Turn/Run（批次带 item 后缀）对应的原生 turn ID 和协议状态。
- `native_message_receipts`：某个原生聊天会话已接收的公共消息及当时版本。

聊天 Turn API 返回可选的 `nativeExecution`；workflow `status` 返回 `nativeExecutions`，包含 RIFT execution、session、原生 thread/turn ID 和协议状态。原生 completed 仅表示该次模型 turn 完成，业务成功仍以 Task 的检查与接受状态为准。

thread 创建/恢复确认后、发送新 turn 前立即保存 thread ID。每次执行仍创建受管 app-server 进程，结束后释放进程而保留原生会话文件。Host 重启不会丢失已完成的会话映射。

原生会话存放在启动时的 `CODEX_HOME`，未设置时使用当前用户的 `~/.codex`。正式任务允许 profile 的 `env.CODEX_HOME` 显式覆盖。RIFT 不复制认证凭据，也不接管 Codex 桌面中已有会话；只使用自己创建并登记的 thread ID。迁移机器或备份时须保留 **RIFT 完整 home、对应 Codex 运行时持久化数据，以及相关 Git 仓库/现场**。只有 `rift.db` 不能恢复 Codex 历史；原生 home 可能包含凭据，应按现有凭据管理方式保护。

恢复找不到 thread、返回另一 thread、cwd/权限不匹配或 thread 仍 active 时会明确失败，不静默创建空会话。Host 启动将遗留的原生 starting/running 记录标为 interrupted；业务 Turn/Run 仍遵守已有 cleanup reconciliation。清理确认后，用户后续消息或明确的任务 retry 才能启动新 turn，不自动重放未知工具副作用。会话历史和原生内部压缩不保证无限、无损记忆。

升级前的 ephemeral thread 没有可续接的持久历史：升级后聊天首次创建新 thread 并同步可用公共消息；已有任务的首次持久执行使用任务 envelope 和此前结构化结果初始化。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec tsx scripts/native-session-probe.ts
```

探针使用真实锁定的 app-server 和本机受控 Responses 接口，不调用外部模型。它验证五个独立进程中的聊天续接、历史恢复、动态工具恢复和新闭包、任务账本重开后的 cwd 变更隔离、Host 证据恢复，以及独立审查历史。结果见 [native-session-probe.json](evidence/native-session-probe.json)。此证据不是外部模型推理质量、真实开发写入或完整 Git 验收的重新认证。

单元/集成测试另覆盖成员和 conversation 隔离、迟到回复同步、消息去重、模型/权限/身份失败不回退、取消清理，以及 task/repair/reviewer 会话映射。官方接口背景见 [App-server 文档](https://learn.chatgpt.com/docs/app-server)；具体兼容行为以本项目锁定二进制探针为准。

原生持久化首次交付的历史完整测试为 [186/186 通过](evidence/native-session-tests.json)，Root/UI 类型检查与生产构建通过。部署时停止旧 Host，保留运行时数据后使用新构建启动；已经运行的旧进程不会热切换到持久会话实现。
