# RIFT 独立代码检视记录

日期：2026-10-25。版本：本地 0.1.0。范围：P0–P3 及 A01–A18。

## 最终结论

**本次检视发现的问题均已修复并复检，P0–P3 的 Windows 单机 MVP 验收门槛通过。** 当前没有本轮已确认而未处理的实现阻塞。本结论不声称软件不存在其他缺陷，也不扩大到未测试平台或所有原生权限行为。

最终全量检查为 **15 文件、72/72 通过，0 failed / 0 pending**（UTC 07:00:00.306 开始）；[机器结果](evidence/automated-tests.json)已独立读取。类型检查与构建通过。独立 `tests/acceptance/` 于本地 14:52:42 运行 **10 文件、41/41 通过**；本验收角色未启动任何真实模型。

[最终校验汇总](evidence/final-validation.json)保留版本、源码/机器结果 hash 和安装、类型、构建、官方 smoke 检查结果。

独立验真不限于读取 pass 字段：直接只读打开真实 SQLite，核对 Run/child/Task/candidate/检查/审查/accepted 关联、Git 父提交、干净 checkout、实际文件及 artifact hash/大小，并比对导出报告的原始 SHA256。完整矩阵、执行范围和证据见[验收报告](acceptance-report.md)。

- [最终真实 Lead 闭环](evidence/workflow-acceptance-probe.json)：DeepSeek Lead 的 29 次模型请求、28 次业务工具调用，5 次 Claude 执行和 4 次 Astra 审查。真实第三任务排队、两开发与其他 Task 审查重叠、乱序结果处理、依赖接受后派发及四次精确提交集成均独立复核。18 份 artifact hash/大小通过；最终 ref 为 `da3251e5f4697c84a40c8e5d716a1bb4d2d1bb32`，用户分支未动。
- 首个 slow-a Run 为 **failed / INVALID_RESULT**，随后 Lead 自主新 attempt 成功。Task 全成功不等于历史 Run 全成功；没有复制模型总结中“所有 Run succeeded”的不准确表述。
- [Sol 定向真实业务](evidence/review-rework-probe.json)：实际拒审、不同原生执行返工、再审及同基线冲突均通过，独立核对真实 diff/前次审查/当前 target 输入、旧目录保留和精确提交链。该探针由脚本驱动，不冒充 LLM Lead 编排。
- [OS 恢复](evidence/recovery-acceptance.json)、[真实 Claude 强杀](evidence/recovery-native-acceptance.json)、[原生暂停和取消](evidence/recovery-native-controls.json)：四故障窗口真实 DB/Git、原生进程身份、保额不重放、已发布只补记、正常取消清理、排队项不启动均已独立核对。受控 fake 故障与真实 native 分开记录。

## 修复记录

以下区分独立失败复现、静态发现与开发者真实探针发现；未将配置目录查询或零模型探针冒充模型运行通过。

| ID | 严重度 | 发现及证据 | 责任人 | 状态 |
| --- | --- | --- | --- | --- |
| R01 | 阻塞 | `src/storage/database.ts` 引入锁定 Drizzle 版本不存在的 `drizzle-orm/node-sqlite`；持久层验收无法导入 | developer_core | 已修复；`persistence.test.ts` 2/2 独立复检通过 |
| R02 | 高 | 新 Workflow 两个 `prepareTask` 同时初始化集成 ref，一个 CAS 创建失败，导致首轮双开发失败；`git-gates.test.ts` 首例实测 1 fulfilled / 1 rejected | developer_git | 已加 commonGitDir 元数据锁；独立复检通过 |
| R03 | 高 | 确定性检查 stdout 原样写入 `operation.json`，环境凭据可能落盘；`git-gates.test.ts` 以纯测试 secret 验证失败 | developer_git | 入库前脱敏；独立复检通过 |
| R04 | 阻塞 | 默认角色使用 `native:` 凭据引用，但 binding 校验只接受 env/keychain/dsh，`POST /v1/workspaces` 独立联测失败 | root | 默认引用与校验统一；独立复检通过 |
| R05 | 中 | review 拒绝后的 repair prompt 缺实际 source diff，独立 A04 回归失败 | developer_core | 加 sourceEvidence、integrationEvidence、当前目标与实际 worktree 基线；独立复检通过 |
| R06 | 阻塞 | CLI serve 的默认 patch 根路径多上一层；静态检视发现 | root | 改 `../..`；主 agent 真实 CLI smoke 验证 |
| R07 | 高 | 已接受依赖未复核当前 target ancestry；静态检视发现 | developer_core | 加 containsCommit；独立“丢失祖先不派发”回归通过 |
| R08 | 高 | ref 已发布后的 SQLite 接受失败若写 blocked 会丢失可补记阶段；静态检视发现 | developer_core | 保留 publishing；独立故障注入证实恢复成功且 publish 仅一次 |
| R09 | 高 | Host 构造早于 provider 注册，固定空 Set 导致 workspace 创建失败；主 agent 真实 smoke 发现 | root | 刷新实际注册实例；独立“构造空→晚注册→创建”回归通过 |
| R10 | 中 | CLI parseArgs 在错误处理外，缺值输出 stack 而非约定 JSON；主 agent 发现后独立复现 | root | 纳入统一错误处理；独立 CLI 回归通过 |
| R11 | 高 | shutdown 只停止 pump，Lead 仍能新建 queued 请求；独立测试实测接受而非拒绝 | developer_core | 写入口 HOST_STOPPING 校验；独立 11/11 fault 回归通过 |
| R12 | 阻塞 | Zod JSON Schema 带不可枚举 `~standard` 函数元数据，真实 DSH 工具注册的无损 JSON 校验拒绝；core 官方工具探针发现，fake 工具容器未暴露此问题 | root | input schema + JSON roundtrip；独立深层纯 JSON/own-keys 检查及 05:31 UTC 官方工具探针复验通过 |
| R13 | 高 | 仅拒绝 Lead 创建时的全局工具快照，之后注册的全局委派工具仍可能可见；core 真实 scope 探针发现 | root | 全局继承为空 allowlist，保留 scope 内 RIFT 工具；05:31 UTC 官方早/晚注册工具、pwsh 与身份隔离探针通过 |
| R14 | 中 | 顶层计划 acceptanceCriteria 通过 schema，但两入口未将其持久化到任务，可能遗漏整个计划的验收要求；主 agent 最后契约对照发现 | root | API 与 Lead 工具入口均合并全局/任务标准；独立双入口持久化回归通过（13:35:31，management 4/4） |
| R15 | 中 | 升级后的 probe 用 `env || default`，会把空模型名静默回退为 Sol，与 profile 明确拒绝空值不一致；本轮静态检视发现 | developer_git | 改 `??` 与 profile 一致，源码已独立核对；未额外启动空值模型探针 |
| R16 | 中 | probe 对整份 JSON 先截断再 JSON.parse，超长输出可能导致证据无法保存；本轮静态检视发现 | developer_git | 改递归字符串脱敏/限长后序列化，源码已独立核对；双模型当前报告均为有效 JSON，未额外请求超长模型输出 |
| R17 | 高 | `startLead` 在异步创建之前未预留 workflow 级归属；并发调用实际创建两个 live Lead，最后 Map 只保留一个，两者均可能拥有同流程工具 | root | 14:35:27 独立复现 create=2；共享创建 promise 后 14:36:45 独立复检通过，并覆盖关闭期间迟到创建清理 |
| R18 | 高 | Workflow cancel 先等待 Lead.cancel；父 Agent 取消抛错时业务协调器取消完全未执行，Workflow 仍 running | root | 14:35:27 独立复现；保证业务取消且明确返回 LEAD_CANCEL_FAILED 后 14:36:45 独立复检通过 |
| R19 | 高 | `executeDevelopment` 在异步 collectSource 后未复核取消，迟到成果将已取消 Task 覆盖为 validating/integrating 并继续候选审查 | developer_core | 新增 coordinator-faults 第12项，14:37:47 实测 integrating（应 cancelled）；已增加事务内状态/attempt复核并保存迟到source证据；14:40:08 独立 fault 12/12 通过 |
| R20 | 中 | 暂存修改后将工作文件恢复基线，collectSource 初始路径非空但 add 后实际 diff 为空，仍返回基线 sourceHead，change 任务可在无实际改动时进入门禁 | developer_git | 独立真实 Git 回归 14:39:44 失败；最终diff为空时拒绝后，14:42:02 独立 Git 6/6 复检通过 |
| R21 | 阻塞 | 默认 Lead 使用 deepseek / deepseek-chat，首次真实模型请求返回未注册 adapter；此前零模型工具探针不能暴露该配置错误 | root | 默认映射修为 deepseek-official / deepseek-flash，缺 adapter 在创建 Agent 前明确拒绝；独立 fail-fast 回归及最终 06:59–07:02 UTC 真实 LLM Lead 闭环通过 |
## 额外恢复与取证加固

- SQLite 独立 EXCLUSIVE lease 覆盖旧 PID 文件核对、删除和新建，避免恢复 Host 的锁竞争窗口。真实 OS 强杀后两进程竞争仅一个取得 lease；独立只读核对最终恢复库。
- cleanupTimeoutMs 对不响应 dispose 设定边界，超时记 unknown 并保留槽位；独立回归确认迟到 dispose 完成也不会自动释放未知占额，兄弟任务仍可完成。
- 已清理 Run 的 finalization 中断恢复为 blocked，允许显式新 attempt；暂停中的候选可取消并释放集成占用，不要求先恢复队列。开发者新增回归和独立复检通过，真实 OS 窗口亦已验证。
- 原生输入持久化为脱敏不可变 artifact，Run 输入事件记录 hash。独立从实际返工输入核验 source diff、前次真实 changes_requested 报告及当前集成目标。
- Git 同时检查暂存区越界内容，候选检查超时保留隔离，CAS 发布后 journal 失败保留可恢复证据；冲突日志保留安全诊断。检查和审查日志脱敏回归通过。

## 保留的历史与范围

旧模型组件不兼容、错误 Lead adapter 默认映射均保留失败证据，升级或修复后的真实运行才计为通过。带人工 gate 修正的历史 Lead 运行没有用于最终无人干预结论；native controls 的测量误纳与 cwd 外 gate 权限拒绝也在 priorAttempts 中保留。所有当前结论以最终成功证据为准。

Sol 的真实拒审/返工/冲突与 Astra 的最终 Lead 闭环合起来覆盖本轮业务要求，未为两模型分别运行整张矩阵。权限证据是实际实例配置、明确拒绝、scoped 工具及候选污染门禁；不声称统一沙箱或任意 shell 权限已全面验证。未知清理仍要求保额并检查现场，不伪造丢失 handle，也不自动恢复旧原生 session。
