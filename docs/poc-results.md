# RIFT P0 探针结果

日期：2026-10-25。工程版本 `0.1.0`，自动测试 **72/72 通过**。**P0–P3 的 MVP 范围验收已通过**，最终无人干预 LLM Lead/Astra 业务闭环退出码为 0。单任务、程序驱动业务、真实 LLM Lead、无模型故障窗口和原生恢复分别留证；不将本结论扩大为任意权限或双模型各自的完整矩阵。

| 项目 | 结果 | 证据及边界 |
| --- | --- | --- |
| P0.1 版本锁定 | pass | `package.json`、`pnpm-lock.yaml`、[兼容记录](runtime-compatibility.md) |
| P0.2 官方 profile / 插件 / live Agent | pass | `pnpm poc`：实际 profile、API、两个 provider 注册、live Agent、正常卸载；[证据](evidence/profile-smoke.json) |
| P0.3 Codex 标记任务 | pass | Codex 0.164.0 下 `gpt-6.1-sol`、`gpt-6-astra` 均在独立中文空格 worktree 完成标记；[Sol](evidence/codex-gpt-6.1-sol-probe.json)、[Astra](evidence/codex-gpt-6-astra-probe.json) |
| P0.4 Claude 标记任务 | pass | 用户已完成标准登录；`claude-opus-5-5` / SDK 0.3.310 在独立 worktree 完成，marker、结果及清理通过；[证据](evidence/claude-opus-5-5-probe.json) |
| P0.5 Lead 跨两 Provider 编排 | pass | `deepseek-official/deepseek-flash` 经真实工具驱动 Opus 5.5 开发和 Astra 审查，29 次模型请求/28 次工具调用，四任务 accepted 并 workflow_finish；[最终证据](evidence/workflow-acceptance-probe.json) |
| P0.6 生命周期 | pass（已列测试范围） | 两 Provider 启动前中止、能力拒绝、正常清理与卸载；真实 Claude 单取消隔离、双开发 API 全取消及在途 Host 崩溃恢复通过；公开 DSH subprocess 的受控父/孙进程终止通过。不扩大为任意模型子命令树或全部权限组合 |
| P0.7 配置/工具权限 | pass（MVP 边界） | 官方 capabilities、scoped 工具隔离、配置模型及独立审查 checkout 门禁通过；[工具证据](evidence/lead-tools-probe.json)。`acceptEdits` / `never` 不等于只读沙箱，不声称全部原生权限矩阵已测 |
| P0.8 Host/CLI | pass | 官方 profile + 插件 HTTP，实际 serve/workspace create/run --no-lead/status/cancel/report；[CLI 证据](evidence/cli-smoke.json) |
| P0.9 实验能力 | pass（选择完成） | 薄 Git，不使用会切换 cwd 的 Worktrees，不用 Agent Teams；不宣称实测未运行插件 |
| P0.10 结论 | done | 本文件与兼容记录，真实和 fake 分开 |
| P0.11 并行与取消隔离 | pass | [Provider 探针](evidence/provider-parallel-probe.json)证明同实例双 Claude/单取消隔离；[最终业务流程](evidence/workflow-acceptance-probe.json)另外证明两开发与精确候选审查同时在途、第三开发排队及乱序结果处理 |

首次 Codex 运行时间为 2026-10-25 13:22:11–13:22:16（香港时间），child ID 为 `a27a6a95-8b02-4810-8c65-32702969065f`。受控 API 返回安全诊断 `Product subagent failure (product: Codex; stage: turn; category: product-error)`；原生 stderr 明确报告默认 `gpt-6-sol` 的 `model_not_found`。这里只保存诊断摘要，不保存认证值。

## Codex 模型兼容修复复验

项目内官方 Codex 从 `0.153.4` 升级到 `0.164.0`，DSH 与官方 Provider 保持 `0.2.1-rc.3`。默认明确选择 `gpt-6.1-sol`，可通过 `RIFT_CODEX_MODEL` 选择 `gpt-6-astra`；没有修改全局认证或模型配置，没有静默回退。

| 模型 / Codex 版本 | 香港时间 | 结果与证据 |
| --- | --- | --- |
| `gpt-6.1-sol` / 0.153.4 | 14:03:24–14:03:29 | fail，`stopReason=error`、未写标记；[升级前证据](evidence/codex-gpt-6.1-sol-0.153.4-probe.json) |
| `gpt-6-astra` / 0.153.4 | 14:02:37–14:02:48 | pass；[升级前证据](evidence/codex-gpt-6-astra-0.153.4-probe.json) |
| `gpt-6.1-sol` / 0.164.0 | 14:08:27–14:08:40 | pass，child `fb4ee63f-45e0-45fc-9406-ef4492a267df`；[升级后证据](evidence/codex-gpt-6.1-sol-probe.json) |
| `gpt-6-astra` / 0.164.0 | 14:08:50–14:09:02 | pass，child `8324ecbe-524e-47a7-bb5b-a60ac3ab33a7`；[升级后证据](evidence/codex-gpt-6-astra-probe.json) |

升级后两次均使用不同真实 Git worktree，中文和空格路径正确，返回绝对 cwd 与 `RIFT_P0_CODEX`，实际 `marker.txt` 校验通过，`stopReason=completed`。预中止及不支持能力拒绝通过，activation 和 parent 清理、Host 卸载释放锁通过，退出码均为 0。模型、Provider、Codex 及平台包版本从实际运行配置和安装依赖链记录。14:09 的 [官方工具回归](evidence/lead-tools-codex-compatibility.json) 也通过，调用模型数为 0。

该轮验证消除了两个指定 Codex 模型的单任务执行阻塞；后来完成的 Provider 取消隔离及业务审查证据见下文，不能把历史单任务测试扩大解释为完整四角色编排。

## Claude Opus 5.5 与并行复验

用户本轮要求继续配置 Claude，并已在标准 Claude Code 登录流程完成认证；14:22:18 的 [安全认证状态](evidence/claude-auth-status.json)为 `loggedIn=true`、`authMethod=claude.ai`。桌面版正在运行不作为认证或模型成功证据。前一轮“用户选择 skipped”只保留为历史状态。

| 运行组合 | 香港时间 | 结果与证据 |
| --- | --- | --- |
| Opus 5.5 / SDK 0.3.263 / Claude Code 2.1.263 | 14:22:21–14:22:26 | fail，原生 stderr 报 `unrecognized_model`，`stopReason=error`；[升级前证据](evidence/claude-opus-5-5-sdk-0.3.263-probe.json) |
| Opus 5.5 / SDK 0.3.310 / Claude Code 2.1.310 | 14:23:43–14:23:56 | pass，child `358886e9-3b02-41ff-ab14-fc3bfdf1e053`，completed、实际标记及正常清理通过；[升级后证据](evidence/claude-opus-5-5-probe.json) |
| 双 Opus 5.5 + Codex Sol | 14:24:54–14:25:18 | Provider 层交叠、单取消和兄弟完成 pass；[独立证据](evidence/provider-parallel-probe.json) |

三任务探针在 14:25:08.380 确认三个不同目录的 ready 标记都存在且三个结果都未终止。只 dispose Claude A 后，A 于 14:25:08.407 返回 `aborted`；此时 B 与 Codex 仍在途，主进程随后分别放行它们自己的 gate，二者返回 `completed` 并写入各自唯一 done 标记。所有 activation、parent、Host 清理成功，锁释放，退出码 0。

该探针由测试脚本直接调用官方服务，验证同一 Claude 实例可并发执行与取消隔离。它本身不包含真实 LLM Lead、第三开发排队或精确候选审查；这些业务证据由下文独立的最终 LLM Lead 流程补齐。Claude 保持 `acceptEdits`，没有升级为 `bypassPermissions`。

官方无模型探针在 13:29 完成，正常 shutdown 后 `rift.db.host.lock` 已消失。CLI smoke 的测试进程最后由执行工具中断，留下 stale host lock；下一次启动只在确认该 PID 已不存在后回收锁。此项不冒充在途真实 Provider 的正常取消测试。

## 真实业务拒审、返工与串行集成

**14:44:51–14:47:06，pass，退出码 0。** [独立报告](evidence/review-rework-probe.json)保存实际 SQLite 事实、Task/Run/childId/cwd、source/candidate/target/accepted SHA、检查与审查关联，以及不可变输入/输出产物引用。使用真实 RiftHostService、TaskCoordinator、官方 Claude Opus 5.5 和 Codex Sol，共 6 个开发与 5 个审查 activation；计划、派发和 retry 由脚本确定性驱动，未调用 LLM Lead。

- 首轮刻意不满足年龄边界的代码由独立 Codex 真实返回 `changes_requested`；新 attempt 使用新 worktree 和新 native child，实际输入携带原 diff、前次报告与最新目标提交。修复通过真实检查与审查，另经完整年龄边界检查确认。
- 初始两个开发源来自同一基线；独立 label 先接受，后续修复候选在最新 target 上重新检查与审查，最终同时保留两项成果。
- 每份 reviewedCommit 均匹配检查通过的 candidateHead；审查 checkout 的 HEAD 与文件均未改变。检查记录与真实退出码绑定候选 SHA。
- 两个同基线的真实冲突源依次处理：alpha 接受，beta 被实际 Git 冲突阻塞，已接受 ref 不变；独立 receipt 继续集成。默认分支未变，无远程更新，清理与锁释放确认。

这证明定向 P2 门禁与返工路径，不能替代 P0.5 的 LLM Lead 决策证据。默认 profile 的检查仍只有 `git diff --check HEAD^ HEAD`，仅验证补丁空白；此探针自己配置了可信 Node 检查，并没有把默认检查提升为完整项目测试。

## 无模型的真实故障窗口与清理

[恢复验收](evidence/recovery-acceptance.json)当前为 pass。DSH Host、SQLite、Git 和进程终止均为真实操作；activation 边界为明确标注的受控 fake，模型调用为零。

覆盖派发启动窗口、运行中、结果记录后收尾窗口、ref 发布后业务提交前窗口；重启不重放未知运行、不重复移动已发布 ref，未确认清理继续占用。还覆盖暂停/继续、单项超时与兄弟隔离、取消时逐项清理及数据库单实例竞争。

公开 DSH subprocess 服务的受控 Node 父/孙进程终止和 service dispose 通过，核对完整进程身份、无存活进程及 heartbeat 停止。下列原生证据另行记录，未使用 fake 结果替代。

## 真实原生崩溃恢复与 API 控制

| 场景 | 结果 | 真实证明与边界 |
| --- | --- | --- |
| 双 Claude 在途 Host 强制终止 | pass | [报告](evidence/recovery-native-acceptance.json)：两真实 child、两个 worktree ready 文件；杀后已记录进程身份消失、文件稳定。重启保留两项 interrupted/unknown 占用，第三 queued，0 Provider 重启、0 重复发布 |
| 管理 API 暂停与全流程取消 | pass | [报告](evidence/recovery-native-controls.json)：暂停不消费第三请求；取消两官方 Claude 均 aborted、cleanup confirmed、槽位 0、第三请求 cancelled；已记录 Provider 进程退出、文件稳定、Host 正常关闭 |

原生崩溃报告不声称杀前已观测到持续 heartbeat 增长，也不把杀后进程消失自动转换为持久 Run 的 cleanup confirmed。API 控制的最终通过轮使用各自 worktree 内的 gate；报告保留误纳 Host 控制台进程和目录外 gate 审批拒绝的早期失败，未修改权限绕过。原生 Reviewer 暂停未在该两开发场景运行，审查队列暂停仍由受控测试覆盖。

## 最终无人干预的 LLM Lead 闭环

**14:59:13–15:02:42，pass，退出码 0。** [最终证据](evidence/workflow-acceptance-probe.json)使用 `deepseek-official/deepseek-flash` Lead、两 Opus 5.5 Developer 与 Astra Reviewer；没有人工修正运行中的 gate 或任务状态。29 次真实 Lead 模型请求、28 次真实协作工具调用，产生 5 次 Claude 开发/修复和 4 次 Astra 审查。

Lead 先派发两个任务再等待，实际观察先完成结果；第三开发排队，采样确认两个开发与一个真实候选审查同时在途。首轮一项开发返回 `INVALID_RESULT` 后，Lead 自主发起新 attempt 修复，失败 Run 和原输出保留。依赖必须在前置成果接受后才能派发。四个任务最终均 accepted，并通过 `workflow_finish` 结束。

四次集成均重新基于最新接受 HEAD；检查日志绑定精确 candidateHead，reviewedCommit 匹配，审查目录无修改。最终接受链、默认分支不变、远程未更新、槽位归零、Host/runtime 清理和锁释放均由报告核对。

历史分开归档：[Lead Provider 名称配置失败](evidence/workflow-lead-provider-failure.json)；[首次 Sol Lead 辅助运行](evidence/workflow-acceptance-assisted-history.json)，该轮业务完成但中途人工修正探针的新 attempt gate，不能当成最终无人干预通过。最终采用 Astra；Sol 的独立 11-activation 定向业务验收也有效，但不写成两个模型分别覆盖了全部矩阵。

## 可重复执行

```powershell
pnpm build
pnpm poc             # 官方profile、live Agent、API、卸载；不调用模型
pnpm poc:tools       # 真实DSH工具作用域与访问控制；不调用模型
$env:RIFT_CODEX_MODEL = 'gpt-6.1-sol'
pnpm poc --codex     # 调用真实Sol，失败返回非零
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
pnpm poc --codex     # 调用真实Astra，失败返回非零
$env:RIFT_CLAUDE_MODEL = 'claude-opus-5-5'
pnpm poc --claude    # 调用真实Opus；选中Provider也做前置取消与能力拒绝
pnpm exec tsx scripts/provider-parallel-probe.ts --run # 两Claude+Codex、单取消及正常清理
pnpm exec tsx scripts/lead-catalog-probe.ts # 官方Provider/模型目录；0模型调用
pnpm exec tsx scripts/review-rework-probe.ts --run # 真实Provider业务拒审/新attempt/候选与冲突门禁；程序编排
pnpm exec tsx scripts/recovery-acceptance-probe.ts # 无模型，真实Host/SQLite/Git故障窗口和受控进程树
pnpm exec tsx scripts/recovery-acceptance-probe.ts --native # 原生Claude在途Host终止与恢复
pnpm exec tsx scripts/recovery-acceptance-probe.ts --native-controls # 真API暂停/全取消
# 已通过的完整LLM Lead/Astra复现；会调用真实模型：
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
pnpm exec tsx scripts/workflow-acceptance-probe.ts --run # 真正LLM Lead调用RIFT业务工具
```

探针输出在 `.runtime-evidence/`：按 `codex` / `claude` 分别保留 `<provider>-runtime-probe.json` 与 `<provider>-runtime-probe-<模型>.json`，覆写前归档上一份；不带对应 flag 不覆盖该 Provider 的证据。并行、业务返工和 Lead 探针使用独立 home 与唯一运行目录；返工另存 `review-rework-probe.json`，恢复分别保存 `recovery-acceptance.json` / `recovery-native-acceptance.json` / `recovery-native-controls.json`。模型探针不要在同一账号上无控制地同时运行。版本对照和已完成结果另存 `docs/evidence/`；当前自动检查清单见[验收报告](acceptance-report.md)。

## 阶段结论与范围

| 阶段 | MVP 结论 | 主要依据 |
| --- | --- | --- |
| P0 | pass | 官方 Host/Provider 真实运行、Lead 跨 Provider 工具编排、并行及取消隔离 |
| P1 | pass | 持久业务/事务配额/队列/工具与管理入口；72 项自动测试及真实业务调用 |
| P2 | pass | 最终 LLM Lead 完整闭环，加上独立真实拒审返工、精确提交检查/审查、最新 HEAD 集成与冲突隔离 |
| P3 | pass | 无模型的真实 OS 故障窗口、原生在途崩溃恢复、API 暂停/全取消、安全归档及诊断测试 |

这些结论针对已锁定的 Windows MVP 和记录的模型组合。默认检查只验证补丁空白，实际项目仍需维护者配置真实构建/测试。官方权限不是安全沙箱；未执行的任意模型子命令、原生 Reviewer 暂停及双模型完整交叉矩阵不作为已有保证。后续扩展仍复用官方 Provider，不另造 Orchestrator 或原生执行后端。
