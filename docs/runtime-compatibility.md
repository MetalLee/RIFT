# RIFT 运行时兼容记录

核对日期：2026-10-25。工程版本：`0.1.0`。**P0–P3 的 MVP 验收范围已通过**：最终无人干预的真实 LLM Lead 完整业务流程、官方 Provider 并行/取消、定向拒审返工与 Git 集成、无模型故障窗口、原生双 Claude 崩溃恢复及管理 API 暂停/全取消均有证据。[当前自动测试](evidence/automated-tests.json)为 **72/72 通过**。结论限于本文记录的 Windows、锁定版本和模型组合，不扩大为全部权限或模型矩阵。

## 锁定环境

| 组件 | 实际版本 |
| --- | --- |
| Windows / 架构 | Windows，x64 |
| Node.js | 24.16.0 |
| pnpm | 11.4.0 |
| Git | 2.54.0.windows.1 |
| DSH CLI、Agent、Subagent、Tools、官方 Codex / Claude Provider | 0.2.1-rc.3 |
| Cordis / Schemastery | 4.0.5 / 3.18.5 |
| 官方 Codex 及 Windows x64 payload | 0.164.0 / 0.164.0-win32-x64 |
| Claude Agent SDK / Windows x64 payload | 0.3.310 |
| Claude Code（SDK 内置） | 2.1.310 |
| TypeScript / Vitest / Zod | 5.9.3 / 4.0.18 / 4.4.3 |
| SQLite | Node 24 内置 `node:sqlite` |
| Drizzle | 0.45.2，使用公开 schema API |

完整依赖和平台可选包见 `pnpm-lock.yaml`。`pnpm install --frozen-lockfile` 与 `pnpm peers check` 已通过。OpenTelemetry API 固定为 1.9.0，解决上游宽松依赖选中 1.10.0 后与 SDK 的 peer 范围冲突。

为支持 `gpt-6.1-sol` 与 `gpt-6-astra`，在 `pnpm-workspace.yaml` 仅对 `@deepseek-ai/dsh-subagent-codex>@openai/codex` 设置项目内 override `0.164.0`。官方 DSH Provider 仍为 `0.2.1-rc.3`，其原始依赖声明为 `0.153.4`；实际运行版本由探针从 Provider 的安装依赖链解析，包含 Windows 平台包版本。未修改 Provider 源码、用户全局 Codex 配置或认证。该 override 的兼容范围以本页实测为限，上游升级后须重新验证。

Claude 同样通过定向 override `@deepseek-ai/dsh-subagent-claude-code>@anthropic-ai/claude-agent-sdk: 0.3.310` 修复 Opus 5.5 兼容性。官方 Provider 保持 `0.2.1-rc.3`，原始 SDK `0.3.263` / Claude Code `2.1.263` 在登录成功后仍报告 `unrecognized_model`；升级到 SDK `0.3.310` / Claude Code `2.1.310` 后真实执行通过。没有改写 SDK、Provider 或自建原生执行后端。标准登录由用户在官方流程中完成，RIFT 不提取或复制 Desktop 内部令牌。

`pnpm-workspace.yaml` 明确允许 DSH subprocess helper、esbuild、koffi、node-pty 的安装构建；其余无关安装脚本禁用。没有省略原生平台 optional dependencies。

Drizzle 0.45.2 没有公开 `drizzle-orm/node-sqlite` 驱动。因此使用其公开 `sqlite-core` 定义 schema，使用 Node 官方 SQLite 执行版本化 SQL 迁移和 `BEGIN IMMEDIATE` 事务；没有 deep import 私有驱动。迁移文件必须与 `dist/` 一起保留。

## 已核验的公开接入

- `@deepseek-ai/dsh/profile-boot` 的 `initializeProfileFromDefault`、`runProfile`，以及 `@deepseek-ai/dsh-app-boot` 的 `loadLayeredEnv`。
- 以官方 `sdk-minimal` 为基底，关闭 SDK 的 stdio app/server，插入 RIFT、Subagent 服务及两个 provider-only 实例；本地 HTTP 由 RIFT 自己装载与卸载。
- `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })` 返回拥有清理权的 handle；`ctx.agents.get(id) === agent` 验证真实存活对象。
- `ctx.subagents.startActivation({ provider, label, request: {parent,cwd,prompt}, signal, delivery:'caller' })`；只传官方支持字段。Run 持有 `childId/result/dispose`，不实现原生客户端。
- Cordis 插件 `apply` 返回异步 disposer；官方 Host shutdown 后 API 和数据库锁均释放。
- 官方 Tools 采用 Agent scope 的本地工具注册及继承工具限制。RIFT 工具使用下划线名称，例如文档的 `rift.plan.submit` 映射为 `rift_plan_submit`。

实际命令：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm poc
pnpm poc:tools
$env:RIFT_CODEX_MODEL = 'gpt-6.1-sol'
pnpm poc --codex
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
pnpm poc --codex
$env:RIFT_CLAUDE_MODEL = 'claude-opus-5-5'
pnpm poc --claude
pnpm exec tsx scripts/provider-parallel-probe.ts --run
pnpm exec tsx scripts/review-rework-probe.ts --run
pnpm exec tsx scripts/recovery-acceptance-probe.ts # 不调用模型；会终止自己的临时测试进程
pnpm exec tsx scripts/recovery-acceptance-probe.ts --native # 真实双Claude在途Host终止/恢复
pnpm exec tsx scripts/recovery-acceptance-probe.ts --native-controls # 真实API暂停/全流程取消
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
pnpm exec tsx scripts/workflow-acceptance-probe.ts --run # 真正LLM Lead完整业务闭环
```

## 配置和权限

`profiles/rift.patch.yml` 注册 `claude-code-dev` 与 `codex-review`，DSH 容量为 3。RIFT 另外以 SQLite 事务限制两个开发、一个审查、每个角色及每个任务最多一个未释放 Run。

Lead 当前默认是官方 DSH 模型 Provider **`deepseek-official`**、模型 **`deepseek-flash`**。2026-10-25 的官方模型目录查询实际返回该 Provider 以及 `deepseek-flash` / `deepseek-v4-pro`；目录查询不调用模型，也不证明一次 Lead 工作流已成功。旧文档中的 `deepseek/deepseek-chat` 不是当前默认，不能继续据此启动。`RIFT_LEAD_MODEL` 可覆盖 Lead 模型，凭据由 DSH 的 `DEEPSEEK_API_KEY` 环境引用提供；模型调用和完整编排结果另行核验。

Claude 使用 `acceptEdits`，没有设置 `bypassPermissions`。API key 只能通过明确的环境引用进入官方实例；数据库只保存引用。Codex 使用 `never`，它不等于只读 sandbox：实际 sandbox 仍受原生配置控制。因此审查在独立 checkout 执行，清理后必须检查 HEAD 和文件未变，才允许精确候选发布。

Claude 明确默认 `claude-opus-5-5`（Opus 5.5），`RIFT_CLAUDE_MODEL` 仅允许此精确名称，拒绝空值和其他模型；见 [Claude 官方模型配置](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)。`acceptEdits` 允许相应文件编辑，但官方 Provider 会拒绝需要交互审批的工具请求，不能据此认为所有 shell 命令已授权。`doctor` 只报告配置引用和环境变量存在情况，认证统一为 `not-verified`；它不读取凭据，也不调用模型。

Claude Desktop 与项目使用的 Agent SDK 认证必须分别核验。标准 `claude auth status` 可报告 Claude Code 登录状态；RIFT 使用官方 DSH Provider 内置 SDK/平台包，不依赖 PATH 中另装 CLI。Desktop 已启动或模型选择器显示 Opus 5.5，不替代官方 activation 的真实完成证据。登录须通过 [Claude 官方认证流程](https://code.claude.com/docs/en/authentication) 完成，不从桌面应用内部存储提取令牌。

Provider 的 model/permission 是实例级配置。未设置 `RIFT_CODEX_MODEL` 时明确默认 `gpt-6.1-sol`；可设置为 `gpt-6-astra`。空值和其他模型名称拒绝加载，不做静默模型回退。修改配置后停止并重新启动 Host；不通过任务级 `agentOptions` 覆盖模型。操作见 [使用说明](usage.md)。

默认检查只有 `git diff --check HEAD^ HEAD`，仅检测补丁空白错误，不证明项目构建、测试或业务行为正确。真实仓库需要维护者配置固定的构建/测试命令。定向拒审探针使用额外的 Node 检查及最终完整边界验证，不能把其检查覆盖率归给默认 profile。检查与审查 checkout 必须保持干净；工作目录隔离及提交门禁不等于外部 Provider 的安全沙箱。

没有采用 Worktrees 插件创建任务目录，避免其切换 Lead Session cwd。没有采用 Agent Teams 作为业务调度核心。

## 双模型实测与范围

2026-10-25 的真实探针使用同一账号原生认证、官方 Provider 及 `0.164.0` Codex，在各自独立的中文空格路径 Git worktree 中执行。两次均返回 `completed`、文件标记校验成功、activation/parent 清理成功、Host 卸载释放数据库锁，进程退出码为 0。

| 模型 | 香港时间 | 结果 | 证据 |
| --- | --- | --- | --- |
| `gpt-6.1-sol`（默认） | 14:08:27–14:08:40 | pass | [Sol 真实探针](evidence/codex-gpt-6.1-sol-probe.json) |
| `gpt-6-astra` | 14:08:50–14:09:02 | pass | [Astra 真实探针](evidence/codex-gpt-6-astra-probe.json) |

官方握手、单任务结果、指定 cwd、启动前 abort、能力拒绝与正常清理在两次运行中通过；14:09 的 [官方工具作用域回归](evidence/lead-tools-codex-compatibility.json) 通过，模型调用为零。当时的类型检查、构建、冻结安装、peer 检查及 57 项自动测试通过。该单任务历史记录不代表在途取消、交互审批路径及完整权限矩阵已验证。

旧版对照保留：`0.153.4` 的 [Sol 探针失败](evidence/codex-gpt-6.1-sol-0.153.4-probe.json)，原生 stderr 报告该模型不支持；同版本 [Astra 探针通过](evidence/codex-gpt-6-astra-0.153.4-probe.json)。升级后两个指定模型均能执行，支持将兼容问题定位到旧版运行组合，但不推断账号永久授权。模型目录列出名称也不等于可执行；本记录以完成真实推理为准，参见 [OpenAI app-server 指南](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## Claude Opus 5.5 实测

2026-10-25 14:22，标准 Claude Code 认证报告 `loggedIn=true`、`authMethod=claude.ai`；[安全状态快照](evidence/claude-auth-status.json)仅保留状态，不含账号标识或凭据值。14:23:43–14:23:56，Opus 5.5 在独立中文空格 worktree 完成 `RIFT_P0_CLAUDE` 标记任务，`stopReason=completed`；主进程读回标记确认，启动前中止、能力拒绝、activation/parent 清理、插件卸载释放锁全部通过，退出码 0。

- [旧版 SDK 失败证据](evidence/claude-opus-5-5-sdk-0.3.263-probe.json)：已认证，但模型不被旧版运行组合识别。
- [Opus 5.5 成功证据](evidence/claude-opus-5-5-probe.json)：实际 SDK、CLI、平台包及精确模型均记录。
- [配置与 doctor smoke](evidence/claude-configuration-smoke.json)、[官方工具作用域回归](evidence/claude-configuration-tools.json)：配置阶段以零模型调用验证；其中旧版 SDK 元数据属于升级前记录，不代表当前锁版。

模型最终文本报告其 shell 检查被无人审批策略拒绝；这是模型输出，不是完整原生工具轨迹。host 实际文件校验通过，不能把此次完成推断为所有 shell 命令均获准。

14:24:54–14:25:18 的 [并行与取消探针](evidence/provider-parallel-probe.json)通过：同一 `claude-code-dev` 实例的两个 Opus 5.5 加一个 `codex-review` Sol activation 各自写入唯一 ready 标记；三者仍在途时只取消 Claude A，A 返回 `aborted`，随后 Claude B 与 Codex 均完成各自 done 标记。三份 worktree、childId、时间区间及全部清理确认均独立记录。

并行脚本给 Claude 仅使用 Read/Write/Edit 的任务指令；Codex 无独立 Read 工具，指令允许一条精确 `Get-Content -LiteralPath '<自身gate.json>'` 查询，写入用 apply_patch。这是探针输入约束，不能代替工具事件审计。没有放宽 Provider permissionMode。

该次探针证明 Provider 层三任务交叠和单 activation 取消隔离，不单独证明业务 Lead 编排、另一已完成任务的精确候选审查或第三开发排队。升级后当时的 **14 文件、60/60 测试通过**；后续测试数量以[自动测试证据](evidence/automated-tests.json)与[独立验收](acceptance-report.md)为准，避免把历史数量当成当前总数。

## 真实业务审查、返工与集成

2026-10-25 **14:44:51–14:47:06** 的[真实审查返工报告](evidence/review-rework-probe.json)通过，退出码 0。它在一个真实 DSH Host 内运行 RiftHostService / TaskCoordinator，调用 6 个真实 Claude 开发 activation 和 5 个真实 Codex 审查 activation；计划与派发由脚本驱动，未调用 LLM Lead。

第一次年龄判断代码刻意使用错误的 `age >= 21`，独立 Codex 对真实候选返回 `changes_requested`。新 attempt 使用不同 worktree 和新的 native child，实际输入产物经哈希核对含原 diff、前次真实审查与当前目标提交；修正后通过真实审查，并另做完整年龄边界验证。同基线的独立 label 先被接受，后续候选基于其最新 HEAD 重建，最终保留两项成果。每次检查绑定 candidate SHA，五份审查报告的 reviewedCommit 均匹配且审查目录未修改。

第二个场景产生两个真实、同基线的冲突源提交。alpha 被接受后 beta 合并冲突，已接受 ref 不变；独立 receipt 随后仍成功集成。刻意冲突任务没有被伪装为成功，场景最后取消该未完成流程。两个场景的用户默认分支未移动、无远程仓库、activation/Host 清理和数据库锁释放均确认。

报告中的 `acceptEdits` / `never` 是注明时间和哈希的 profile 配置快照，不是原生权限事件日志；实际证明的是上述结果与 checkout 门禁。

## 恢复验证与当前边界

无模型恢复探针已通过真实 Host/SQLite/Git 的 OS 终止窗口：派发启动中、运行中、结果已记录但收尾未完成、Git ref 已发布但 SQLite 事务未提交。恢复核对持久事实，不重放未知启动，不重复发布；清理未知继续保留占用。受控 activation 使用 fake，不能将这些结果写成原生 Claude/Codex 的崩溃恢复。[恢复证据](evidence/recovery-acceptance.json)

同一探针还通过公开 DSH subprocess 服务管理的受控 Node 父/孙进程终止与服务卸载测试，核对 PID/创建时间、无存活进程和停止的 heartbeat。这是真实 OS 进程测试，但不是模型触发的任意子命令树测试。

[真实原生崩溃恢复](evidence/recovery-native-acceptance.json)已通过：两个 Claude Opus 5.5 activation 在独立 worktree 写出 ready 文件且仍运行时，测试进程于 14:50:58 强制终止其自己的 Host。已记录的两个 `claude.exe` 及对应进程身份随后消失，ready 文件在事后观察窗口内保持稳定。新 Host 将两 Run 标记 `interrupted/unknown` 并保留两个槽位及目录占用，第三个请求仍 queued；Provider 重启数和重复发布数均为 0。这里不声称杀前已经观测到文件计数连续增长，也不把事后进程退出等同于业务清理已确认。

[真实暂停/全流程取消](evidence/recovery-native-controls.json)也通过：loopback 管理 API 暂停期间第三个请求保持 queued；取消后两个官方 Claude 终止事件均为 `aborted`，业务 cleanup 均 confirmed，槽位归零，第三请求取消。四个已记录的 Provider 进程身份退出，ready 文件稳定，Host 正常关闭。首轮误纳 Host 控制台进程、第二轮工作目录外 gate 触发权限拒绝的失败尝试保留在报告中；最终使用本 worktree gate，没有放宽权限。审查队列的暂停门禁仍由受控 activation 测试覆盖，不冒称本次有原生 Reviewer 暂停。

## 最终 LLM Lead 完整业务验收

2026-10-25 **14:59:13–15:02:42（香港时间）**，[最终报告](evidence/workflow-acceptance-probe.json)为 pass、退出码 0。组合为 **`deepseek-official/deepseek-flash` Lead + 两个 `claude-opus-5-5` Developer + `gpt-6-astra` Reviewer**。该轮没有人工修正运行中的 gate 或业务状态；测试夹具按预设条件自动放行。

真实 Lead 发出 29 次模型请求、28 次协作工具调用，先派发两个独立开发，再观察先完成的结果。第三开发曾真实排队；15:00:06 的采样确认两个开发与已完成任务的一个审查同时占用三个槽。Lead 自主识别首轮 `INVALID_RESULT`，通过 retry 创建新 attempt，随后完成四个任务和 `workflow_finish`。共 5 个真实 Claude 开发/修复 activation、4 个真实 Astra 审查 activation；首轮格式失败保留为事实，没有伪装成所有 Run 一次成功。

依赖前置成果接受后才派发后继；四次接受形成连续最新 HEAD 链，每次都有精确 candidate SHA 检查、匹配 reviewedCommit 和干净审查 checkout。最终四任务全部 accepted，默认分支不变、远程未更新，槽位为 0，Host/runtime 清理与数据库锁释放均通过。

验收组合分开记录：Sol/Astra 各有 marker；Sol 完成 11-activation 定向拒审返工/冲突业务；Astra 完成上述无人干预 LLM Lead 全流程。不声称两个 Codex 模型各自跑过全部矩阵。

历史运行继续保留：[最初 Lead Provider 配置失败](evidence/workflow-lead-provider-failure.json)在修复官方 Provider 名称后消除；[首次 Sol Lead 辅助运行](evidence/workflow-acceptance-assisted-history.json)虽完成业务，但中途人工修正了探针的新 attempt gate，因此不作为最终无人干预验收。它们不覆盖或取代最终 Astra 报告。

最初 `gpt-6-sol` 失败、Codex `0.153.4` 的 Sol 失败，以及旧 Claude SDK `0.3.263` 的 Opus 5.5 失败均继续保留，描述的是当时组合。当前单任务兼容性已修复；正式 gate 状态以[POC 结果](poc-results.md)和[独立验收](acceptance-report.md)为准。
