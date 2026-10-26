# RIFT UI 使用与升级

更新：2026-10-26。UI 与业务服务在同一个本机 DSH Host 中运行。设计依据为 [Stitch 项目](https://stitch.withgoogle.com/projects/1425554633296237378) 的八个页面与仓库 [DESIGN.md](../DESIGN.md)。沿用暖白底、陶土色强调、240px 桌面导航和聊天阅读区。

## 启动

要求 Node 24、pnpm 11.4.0。下面只装载 Codex 开发/审查实例，主对话可选择 DSH/API 或受限 Codex。

```powershell
pnpm install --frozen-lockfile
pnpm build
node dist/cli/main.js serve --home D:\RiftUI --profile rift-ui --patch profiles/rift.codex.patch.yml
```

在另一个终端执行：

```powershell
node dist/cli/main.js ui --home D:\RiftUI
```

也可以直接打开 `D:\RiftUI\endpoint.json` 中的本机 `url`，页面会自动建立会话；服务重启或会话过期后刷新即可重新连接。本机与已配置的 Tailscale 远程入口均支持自动连接，无需一次性链接验证。自动连接接受同源 JSON POST，仍校验精确 Host、Origin；本机要求 Fetch Metadata，HTTP tailnet 允许缺省但拒绝显式跨站请求。

命令返回的启动码有效期 60 秒、只能兑换一次，兑换后从地址栏清除。浏览器使用 HttpOnly、SameSite=Strict 会话 cookie；写入另需内存中的 CSRF token。管理 token 只留在 Host home，不放进浏览器存储或前端构建。退出会话后停留在连接页，可手动重新连接；重新打开本机或远程页面都会自动连接。

默认静态目录为 `dist/ui`，可用 `serve --ui-dist <绝对路径>` 指定自有构建目录。开发入口为 `pnpm dev:ui`；实际认证与交付验收使用同源 Host 构建。

## 工作区、连接与成员

工作区可以只创建主 Agent，之后再添加仓库和成员。切换工作区不会取消后台执行。草稿和接收者按工作区、对话隔离；历史消息由 Host 保存。系统设置支持改名和带解释的归档，活动执行或清理未知时拒绝归档。

主 Agent 的连接在系统设置中配置。成员的显示名、职责、对话连接和代码执行连接分别保存；中文名称不改变稳定 Agent ID。停用有排队、在途或未确认清理的成员会被拒绝。配置修改带版本检查，已创建的 Turn/Run 保留自己的配置快照。

两种已验证的主对话路径：

| 路径 | 选择方式 | 已验证范围 |
| --- | --- | --- |
| DSH/API | `deepseek-official` 与 `deepseek-flash`，或系统设置创建的 API 连接 | 真实回复、RIFT 工具规划/派发/等待/完成 |
| 原生 Codex | `codex` 与 `gpt-6.1-sol` / `gpt-6-astra` | 固定 0.164.0 app-server；两模型通过本地受控响应的工具隔离探针，外部账号访问能力需单独验证 |

原生对话使用固定工具隔离目录 [rift-native-models.json](../profiles/rift-native-models.json)，其摘要和 payload 版本在启动时校验。模型只获得本 Turn 的 `rift_*` 工具；原生执行、文件写入、插件、MCP 与再次委派均关闭。新增模型或改变目录必须重新运行边界探针。原生开发/审查任务仍经官方 DSH subagent Provider 执行，与对话适配器分开。

API 连接表单支持 OpenAI Chat Completions、Responses 和 Anthropic Messages 协议。填写名称、endpoint、model 和 API 密钥，无需配置环境变量。密钥使用密码输入框，保存成功后清空，页面和连接目录不回显密钥或内部引用；编辑为新版本时必须重新输入。旧环境变量引用连接仍由 Host 兼容加载。endpoint 使用 HTTPS，或本机 loopback HTTP；禁止 URL 内嵌凭据。保存只登记配置，“验证连接”才发送一次真实短请求并记录结果。每次修改创建新的不可变 provider 身份，旧版本继续供历史执行引用。当前实际外网验证覆盖 DeepSeek Chat Completions；其他协议是否可用由目标服务与显式验证决定。

成员的任务执行连接与对话连接使用相同的 API / 原生运行时选择方式，可独立指定模型和推理强度，无需预先登记执行实例。API 使用系统设置中保存的端点和密钥，原生 Codex 可直接选择 Sol 或 Astra。保存后由 Host 建立不可变执行绑定，重启后恢复原生执行能力；已保留执行占用时拒绝切换绑定。纯文本分析优先使用执行连接，旧成员未配置执行连接时兼容其对话连接。连接配置不等于认证通过。

原生模型工具边界证据：[Sol](evidence/u0-native-tools-probe-gpt-6.1-sol.json)、[Astra](evidence/u0-native-tools-probe-gpt-6-astra.json)。复验命令：`pnpm exec tsx scripts/u0-native-tools-probe.ts gpt-6-astra`（不调用外部模型）。

## 对话与任务

- “新建对话”直接打开输入区域。首条输入提交后，由工作区 Lead 单独总结标题并保存，首条消息发给子 Agent 时也一样。生成期间或失败时显示首条输入的简短预览；后续消息不会改写标题，已有自定义标题保留。
- 对话标题与切换菜单只在对话页顶栏显示。标题生成使用 Lead 队列与连接，不调用业务工具，不写入可见聊天历史，也不复用普通聊天的原生 thread。
- 默认发送给主 Agent；点击 `@` 选择一个成员。失效接收者会阻止发送，不静默改投主 Agent。
- Enter 换行，Ctrl/⌘+Enter 发送；输入法组合期间不触发发送。
- 可以附上本工作区的任务、仓库和工作目录引用。Host 再次验证归属并固定上下文版本。
- 同一成员的消息串行入队；子成员聊天与代码 Run 共用容量。发送回执有 `clientMessageId`，未知结果重试使用同一身份。
- 正文只发布已确认安全的脱敏前缀；尚不能安全切分的内容继续缓冲。草稿在最终回复提交后替换，失败或取消标记为未完成，清理未知继续保留执行占用。
- 聊天以实际作者的消息为主，接收成员单独显示为 `@成员`。关联任务以消息下方 tag 提供到具体任务的跳转；系统回执和成员进展收进对应消息的“协作进展”，默认折叠。消息下方不显示冗余 `failed`、阶段开始或最后有效进展，完整诊断留在活动详情页。
- “停止这次回复”只停止当前 Turn，已经登记的任务继续按自己的状态运行。
- Codex 聊天按对话＋成员复用原生持久 thread，按消息 receipts 同步其他成员新增的已完成发言；发言者身份保留，自己的已知回复不重复注入。DSH/API 仍使用近期内容与可追溯摘录。配置变化与恢复边界见 [原生会话说明](native-sessions.md)。

代码工作必须先登记任务，再由调度器执行。`@` 开发成员登记自身任务后先返回回执并结束讨论，释放租约后任务才能启动。正式批准来自精确候选提交的审查 Run；聊天中的“同意”不能绕过验收。

任务页提供仓库、工作流、成员和状态筛选、服务端分页、依赖、检查与审查证据，以及暂停/恢复/取消、重试、重规划。任务计数依据真实接受状态和当前计划版本；没有计划时不显示虚假的百分比。无仓库工作区可运行受限纯文本分析任务，代码变更仍要求仓库及可用执行角色。

### 成员协作与自动续办（默认开启）

两个内置 profile 和自定义 Host 的缺省配置均开启新模式。启动前设置 `$env:RIFT_CHAT_ORCHESTRATION='0'` 或显式配置 `chatOrchestration: false`，可让后续新建工作流使用兼容模式。既有工作流保留原协调归属，不会因开关变化自动切换。当前交付和证据见 [C2–C4 验收](collaboration-acceptance.md)。

Lead 可用 `rift_delegate` 在同一事务内登记任务、派发与定向消息；成功回执关联真实 task/request。派发后调用 `rift_yield` 并完成当前回复，后台 Task/Run 独立继续。必要事件会回到持久队列，触发检查、返工、后继派发或收尾。浏览器关闭不会停止事件消费，开发结果收集仍须通过检查与审查才能接受。

成员通过 `rift_send_message` 汇报、提问或报告阻塞；Run 内发送沿用当前执行身份，不启动自己的第二个聊天轮次。忙碌成员的请求进入 inbox，任务补充只在下一次任务输入构建时消费，不改写正在运行的输入。普通 progress 只投影消息，不唤醒模型互答。Codex 和本地可续接 DSH 支持 Run 动态工具；不支持工具注入的外部 Provider 仍由 Host 投影真实业务结果，不冒充成员主动发言。

工作流只有一个主对话和协调归属。该模式下管理/CLI 的 `lead` 操作也排入同一队列；其他对话可读取状态，不能成为第二个编排者。用户补充先保存，等待当前 Turn 结束；不会把新文字直接插入运行中的原生 turn。停止回复仍只停止该 Turn，取消 Task/Workflow 需使用任务页对应操作。

可配置 `coordinationToolLimit`（默认 48）、`coordinationStagnantLimit`（默认 12）、`coordinationAutomaticTurnLimit`（默认 32）；成员自动消息链最多 8 跳，超限留存阻塞。成员自动请求不能清空 Lead 预算；真实用户输入或显式唤醒才可恢复。`coordinationTimeoutMs` 仅作用于新模式 Lead，默认沿用 600000 毫秒硬超时。未知清理时先使用活动页核对退出证据；Host 重启可补投系统回执，但不会自动重放未知执行。工作流按原暂停/恢复门禁处理。

若 Lead 已因业务条件不足暂停自动协调（`COORDINATION_ACTION_REQUIRED`），晚于该阻塞记录的真实任务清理确认或集成恢复事实可以重新排队协调。它不会解除 Lead 自身清理未知、执行失败/取消或预算阻塞，也不会自动运行暂停中的工作流；这些情况仍需核对退出证据、恢复或显式唤醒。

## Skill

从本机含 `SKILL.md` 的目录导入，先预览再保存不可变版本。导入不执行脚本，不跟随符号链接或 junction，不纳入 `.git`、`node_modules` 和环境凭据文件。

先选择工作区默认共享版本，再按成员继承、排除或专属覆盖。最终生效检查会显示来源、版本及冲突。发布新版本不会自动修改在途执行；归档保留旧版本和历史快照。

首批运行时验证了纯指令 Skill 的实际 Turn/Run 注入。带资源或脚本的包可以保存和预览，但当前执行适配器会明确拒绝其兼容性；导入成功不代表资源或脚本可执行。不会静默忽略这些要求。

## 多仓库与工作目录

一个工作区可以关联多个仓库。工作流固定所选仓库的基线与集成 ref，每个代码 Task 明确属于一个仓库；跨仓目标拆成有依赖的任务，不做跨仓原子发布。一个仓库尚未接受会阻止整个工作流完成。

受管工作树支持选择基线、合法分支和受管根目录内的路径。外部目录先作为只读关联，可解除关联而保留文件。显式接管要求独占确认、干净目录、真实 Git 归属和无活动写入，随后通过 Git 移入受管目录；不会把原外部路径直接标成可删目录。

归档检查 tracked/untracked/ignored 变化、活动租约、清理结果和目录边界。任务、候选与审查现场按所属仓库展示。受管目录归档移除 checkout；已接受提交和账本仍保留。

## 断线、停止与恢复

SSE 用持久游标重放，过期游标触发重新快照。断线保留已显示数据与草稿，界面标记状态未同步并以轮询补充。回到后台标签页时重新对账；旧快照不能覆盖较新的实体版本。

Host 崩溃后的在途 Turn/Run 标为中断、清理未知，占用继续保留，不自动重放副作用。正常停止通过运行时取消与清理释放租约。清理超时但所属 disposer 稍后确认完成时可自动补记。恢复按钮只接受已有清理收据，或同一机器的真实 OS 重启标识变化作为旧进程已退出的证明；仅重启 Host、不同机器复制数据库或点击确认均不能强制释放未知占用。无法证明时继续显示阻塞。

## 升级与回退

迁移 0004–0016 添加聊天/租约、Skill、多仓库、上下文/恢复、API 连接、原生会话及协作消息/inbox/因果链账本。启动会执行增量迁移及外键检查；旧 Run 未确认清理的占用被保留。升级前停止 Host，再备份**完整 home**，不要只复制 SQLite 主文件或漏掉 WAL、工作目录和产物。Codex 原生历史位于实际 CODEX_HOME（默认 ~/.codex），也需按 [会话备份要求](native-sessions.md#持久化恢复与备份)保留；只有 RIFT home 不足以恢复原生记忆。

```powershell
# 先在 Host 所在终端 Ctrl+C，并确认所有执行已停止。
$riftSource = (Resolve-Path -LiteralPath 'D:\RiftUI').Path
$riftBackup = 'D:\RiftUI-backup-before-ui'
if (Test-Path -LiteralPath $riftBackup) { throw '备份目标已存在，请选择新目录。' }
Copy-Item -LiteralPath $riftSource -Destination $riftBackup -Recurse
```

`RIFT_UI_ENABLED=false` 可在下一次启动时关闭静态 UI、浏览器 bootstrap/API/SSE，保留原 CLI `/v1` 边界。这个开关不回滚数据库。回到旧二进制须停止服务并恢复升级前完整备份，不能直接打开新 schema。CLI 和浏览器认证仍各自使用原有的边界，未放开通配 CORS。

## 检查与证据

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec tsx scripts/u0-native-tools-probe.ts
pnpm exec tsx scripts/native-session-probe.ts
# 以下明确执行真实模型，只在需要重新验收时运行：
pnpm exec tsx scripts/u0-native-workflow-probe.ts --real
pnpm exec tsx scripts/u0-native-workflow-probe.ts --real --dsh
pnpm exec tsx scripts/ui-api-connection-probe.ts --real
pnpm exec tsx scripts/ui-code-workflow-probe.ts --real
```

交付矩阵、实际计数与边界见 [UI 验收报告](ui-acceptance.md)。历史 E1 文档保留其当时范围，不覆盖本次 UI 的新增结论。
