# RIFT 独立验收报告

日期：2026-10-25。版本：本地 0.1.0。依据技术方案 0.3 的 A01–A18 与 P0–P3 实施清单。

**最终结论：P0–P3 的 Windows 单机 MVP 门槛通过，A01–A18 在下列明确的测试范围内通过。** 本结论来自真实 LLM Lead 闭环、官方 Claude/Codex 执行、真实 Git/SQLite、真实 OS 强杀及独立自动测试的组合；确定性故障注入与真实模型结果分别标明。未向外部发布软件。

最终全量自动检查：**15 文件、72/72 通过，0 failed / 0 pending**，开始于 UTC 07:00:00.306；机器结果已独立读取，见 [automated-tests.json](evidence/automated-tests.json)。主 agent 完成类型检查和构建，均通过。独立验收目录另于本地 14:52:42 全量复检，**10 文件、41/41 通过**，未调用模型。

[最终校验汇总](evidence/final-validation.json)记录 0.1.0、机器结果与源码 hash，以及冻结安装、peer、类型检查、构建、官方 profile 和 scoped 工具 smoke 的成功退出；最终 profile/工具 smoke 均为零模型验证。

## 阶段门槛

| 阶段 | 结论 | 关键证据 |
| --- | --- | --- |
| P0 | pass | 官方 profile/工具加载与卸载；指定双 Codex 模型和 Opus 标记任务；真实 LLM Lead 工具编排；双开发与真实候选审查交叠；取消隔离及进程清理 |
| P1 | pass | SQLite 事务预留、角色与配额、幂等、持久队列、乱序结果、清理失败/超时保额等自动验收 |
| P2 | pass | 无人工业务干预的 Lead + 两 Claude + Astra 闭环；Sol 真实拒审/新执行返工/冲突；精确提交检查、审查及串行发布 |
| P3 | pass | 四个真实 OS 崩溃窗口、真实 Claude 在途强杀、原生管理 API 暂停/取消、归档保护、日志及使用文档 |

P0.3/P0.4 的标记任务曾只支持单项通过，P0.11 曾仅为 Provider 层 partial；最终业务闭环补齐了这些历史缺口。P0.7 按 MVP 要求验证实例模型/权限配置、能力拒绝、Lead 工具限制及审查污染门禁，不将“完整原生权限矩阵”或任意 shell 行为加入额外发布门槛。

## A01–A18 验收矩阵

| ID | 实际证据与范围 | 结论 |
| --- | --- | --- |
| A01 | 真实 SQLite 双 Workspace 记录/角色隔离；fake 并发验证全局单 Workflow、未知占额阻止新流程 | pass |
| A02 | 真实 DeepSeek Lead 经 RIFT 工具驱动两个 Opus Developer 与 Astra Reviewer，四任务 completed；脚本没有替 Lead 计划/派发/重试/批准/finish | pass |
| A03 | 三种指定模型实际 cwd/marker；业务 Run、child、输入/结果 artifact、source commit 与 worktree 独立核对 | pass |
| A04 | Sol 实际 changes_requested；不同 Claude child/attempt 读取前次 diff/报告/当前目标后修复；旧记录与目录保留，重新审查通过 | pass |
| A05 | 最终真实 Lead 运行中 INVALID_RESULT 被拒后自主重试；非法 schema、失败检查、审查 SHA 错误另由自动真实 Git/fake 测试拒绝 | pass |
| A06 | 真实模型形成的同基线冲突源被拒；真实 Git CAS/目标变化测试拒绝未经重验的发布 | pass |
| A07 | 真实单 activation 取消隔离、原生全流程取消、公开 DSH subprocess 父/孙进程退出；清理失败/超时通过受控注入保锁保额 | pass |
| A08 | 真实 Host OS 强杀后重开 SQLite；未知执行不重放；真实 Git ref 发布/DB 提交窗口只补记一次，未重复发布 | pass |
| A09 | 真实临时 Git 仓库验证 dirty/untracked/ignored、junction 越界、未知清理及超时隔离均阻止默认删除 | pass |
| A10 | 实际认证/模型运行、负向能力拒绝、live 对象身份与 scoped 工具；API token/Origin/Host、配置引用和日志脱敏自动测试；历史模型/adapter 错误明确失败 | pass |
| A11 | 真实官方工具拒绝未完成 finish；最终 LLM finish 仅在所有 Task 接受且清理确认后成功 | pass |
| A12 | 四任务成果只进入 RIFT ref；检查、审查与提交链齐备；用户 main 和 checkout 未变，临时仓库无 remote | pass |
| A13 | 两真实 Claude 开发区间重叠；后派发 fast-b 先完成，Lead 在 slow-a 仍 running 时读取其持久结果 | pass |
| A14 | 真实两开发+一个其他任务的精确候选审查交叠；第三开发返回 queued，等待角色清理后才预留；配额争抢与清理未知保额另有自动回归 | pass |
| A15 | 真实 dependent-d 在 fast-b 接受后才启动；DAG 环、祖先丢失、路径重叠串行及独立推进由自动测试覆盖 | pass |
| A16 | 真实单 Provider 取消不停止兄弟；真实管理 API 暂停不消费第三请求，取消全部原生执行；超时/清理故障/迟到结果由受控测试验证 | pass |
| A17 | 最终四候选逐次使用最新已接受 HEAD，重新检查/审查，保留全部成果；真实冲突不回滚先前成果 | pass |
| A18 | 真实派发前后 OS 强杀及 native 强杀均恢复占用、保留排队且不重放；重复/乱序结果、请求追踪由自动测试覆盖 | pass |

## 最终真实 LLM Lead 闭环

[最终闭环证据](evidence/workflow-acceptance-probe.json)来自 UTC **06:59:13.597–07:02:42.791**，原始目录 `.runtime-evidence/workflow-acceptance-jEGZQ7`。Lead 为 `deepseek-official / deepseek-flash`，Developer 为 `claude-opus-5-5`，Reviewer 为 `gpt-6-astra`。实际记录 **29 次 Lead 模型请求、28 次 RIFT 工具调用、9 次原生执行**：5 次 Claude（含一次新 attempt）和 4 次 Astra 审查。

独立验收以只读方式打开实际数据库，核对 18 份输入/结果 artifact 的 SHA256 与字节数、9 个唯一 child、所有检查 ID、Git 对象父提交和真实 checkout。四个候选与审查 checkout 均干净；reviewedCommit、candidateHead 和 acceptedCommit 相等，检查 exitCode 均为 0，source 与 target 均是对应候选的父提交。

- UTC 06:59:32.532 的真实 Lead 工具结果已经包含 fast-b succeeded 与 slow-a running，证明 Lead 读取了乱序持久结果。
- UTC 07:00:06.945 同时存在 slow-a 开发、queued-b 开发及 fast-b 精确候选审查，槽位为 2+1。采样时间落在三次真实执行区间内。
- queued-b 的实际 dispatch 工具结果为 queued；队列样本存在且 fast-b cleanup.confirmed 事件先于 queued-b dispatch_reserved。
- dependent-d 的 activation_accepted 晚于 fast-b integration.accepted。
- slow-a 首次返回带额外文本的结果，实际 Run 为 failed / INVALID_RESULT。Lead 自主调用 retry 并派发新 attempt 成功；**不是九次 Run 全部成功**。此后四个 Task 全部 succeeded，最后 finish 成功。

| 接受顺序 | Task | 已检查、审查并接受的提交 |
| --- | --- | --- |
| 1 | fast-b | `ea3c2d7fa9cdf115fa86c63b5c73d6649afbca68` |
| 2 | queued-b | `c884afd6b88fa6859419cbdb529a04de62d5c83c` |
| 3 | slow-a | `9b974ce9d042c340f3be9d5603f552e862fa351f` |
| 4 | dependent-d | `da3251e5f4697c84a40c8e5d716a1bb4d2d1bb32` |

后一候选的 expectedTargetHead 均等于前一已接受提交。最终 Git 对象包含 alpha=11、beta=22、gamma=33、delta=44；用户 main 保持 `ab391abb7bc9e64426c706410142541dd20134b1`。所有执行清理确认、槽位归零，Host 卸载与锁释放通过。对外报告原始 SHA256 `b2e95d776a624f6301c2ddda8f13733ff61f26253b1dc03f955270a4b84fe054` 已独立比对。

探针使用明确的测试计划和可重复文件 gate 控制完成顺序，脚本只观测并自动释放 gate；模型实际执行全部业务工具调用及修复决策。本轮没有人工修改控制文件或代调业务接口。

## Sol 真实返工、审查与冲突

[定向业务证据](evidence/review-rework-probe.json)记录 UTC **06:44:51.242–06:47:06.568**，共 11 次真实原生执行（Claude 6、Sol 5）。它由脚本调用生产协调器，附加 live parent 但不请求 Lead 模型回合；因此该证据用于返工、Git 和审查，不单独证明 P0.5。

第一次 age 实现故意使用 21 岁边界，真实 Sol 返回 changes_requested；不同 Claude child 在新 attempt 收到实际 diff、前次审查报告和已接受 label 的目标提交，修正为 18 岁，再由不同 Sol child 批准。独立核对该阶段 12 份 artifact 的 hash/大小，旧目录仍保留错误实现，审查 checkout 均干净且 SHA 与实际报告一致。

修复集成结果为 `32bc283b35be526389d3403613618167ef34ebd5`。随后 alpha/beta 两个真实源提交来自同一基线；alpha 接受后 beta 实际发生 Git 冲突，没有移动已接受 ref。独立 receipt 任务继续成功，最终 `6d90e5376b11adf9e01ce103beb9ab2366d08607` 保留 alpha、receipt 与先前成果。刻意冲突的 Workflow 最后 cancelled，未冒充全任务成功。用户 main 保持原值，业务/Host 清理确认、锁释放。

Sol 与 Astra 均有真实业务审查证据，但**没有为每个模型分别运行完整矩阵**。两模型另有各自 [Sol 标记任务](evidence/codex-gpt-6.1-sol-probe.json)和 [Astra 标记任务](evidence/codex-gpt-6-astra-probe.json)。

## 恢复、取消和进程清理

[OS 故障窗口证据](evidence/recovery-acceptance.json)使用真实 DSH Host、SQLite、Git 和实际 OS 强杀，activation 结果由受控 fake 提供，以精确注入四个窗口：派发已登记但 handle 未返回、handle 已返回、结果清理后业务 finalization 未结束、Git ref 已发布而 SQLite 接受事务未提交。

独立核对最终四份实际数据库及 Git：前两个窗口保留两个 interrupted / cleanup unknown Run 及第三个 queued 请求；finalization 窗口阻塞任务供显式新 attempt；publication 窗口的 ref 等于 acceptedCommit，integration.recovered 事件恰好一次，provider 重启与重复 publish 调用均为 0。两个恢复进程竞争旧锁时仅一个取得 SQLite lease。该探针还通过公开 DSH subprocess 服务实际启动 Node 父/孙进程，terminate 与服务卸载后 PID/创建时间均不再存在，心跳停止；这是受控子命令，不是模型生成命令。

[真实原生强杀证据](evidence/recovery-native-acceptance.json)在两个官方 Opus child running 时强杀 Host。独立核对两份真实文件保留、两次原生执行的 PID/创建时间退出，以及实际 SQLite 两个 Run 变为 interrupted、unknown、继续占槽，第三请求保持 queued，未重放。文件在杀后观察期稳定；没有把 counter=0 推断为已观测持续心跳后停止。即使探针观测到进程已退出，生产恢复仍保守保留未知清理，未伪造丢失的 handle。

[真实管理暂停/取消证据](evidence/recovery-native-controls.json)通过 loopback API 暂停并取消两个官方 Claude 执行。暂停时两 Run 仍 running、第三请求 queued；取消后两个官方 end 均为 aborted，实际 DB cleanup confirmed、槽位归零，第三请求 cancelled 且未生成 Run。四个 Provider wrapper/CLI 身份退出，先确认这些结果，再正常关闭 Host。清理失败、不响应 dispose、单执行超时及 review 队列暂停另由受控故障注入验证，未知清理不会释放占额。

三份导出报告的原始 SHA256 均已独立比对。正常清理通过不等于任何系统上所有可能的外部进程行为均已证明。

## 配置、权限与历史记录

锁定 DSH/官方 Provider 0.2.1-rc.3；项目定向使用 Codex 0.164.0 / Windows payload 0.164.0-win32-x64，Claude Agent SDK 0.3.310 / Claude Code 2.1.310 / Windows payload 0.3.310。未另建原生执行后端。默认 Codex 为 Sol，最终 Lead 验收明确选用 Astra。

Claude 通过标准登录流程认证，见[安全状态摘要](evidence/claude-auth-status.json)与[Opus 标记任务](evidence/claude-opus-5-5-probe.json)。只读取安全状态，没有提取 Desktop 内部凭据。权限保持 Claude acceptEdits、Codex never；这不是统一文件系统沙箱。Lead 的全局工具继承限制、实际 live 身份、非法调用与未完成 finish 经[官方工具探针](evidence/lead-tools-probe.json)验证。外部模型权限错误与不支持能力必须明确返回；候选/审查 checkout 变化仍阻止接受。

以下为历史事实，不是当前阻塞，也没有计为最终成功：

- 旧 Codex 0.153.4 的 [Sol 失败](evidence/codex-gpt-6.1-sol-0.153.4-probe.json)，以及旧 Claude SDK 的 [Opus 模型不识别](evidence/claude-opus-5-5-sdk-0.3.263-probe.json)。升级后的指定模型真实复验通过。
- [Lead provider 失败](evidence/workflow-lead-provider-failure.json)暴露错误默认映射；按[官方模型目录](evidence/lead-catalog-probe.json)修正，最终真实 Lead 闭环验证通过。
- [人工修正探针 gate 的历史运行](evidence/workflow-acceptance-assisted-history.json)保留，未用于最终无人干预结论。
- 原生 controls 的 Host conhost 测量误纳、cwd 外 gate 权限拒绝两轮失败，保存在最终 controls 报告的 priorAttempts，未覆盖或计为 pass。

验收仅针对本次锁定版本、Windows、临时仓库和单机 MVP。默认 profile 的 git diff --check 仅检查空白；真实功能验收使用固定功能检查，实际项目仍须配置自己的构建与测试。未知清理保额、单次原生执行、无自动远程推送是保留的明确边界。
