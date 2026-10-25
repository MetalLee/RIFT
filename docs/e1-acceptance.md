# E1 实现与验收

日期：2026-10-25。结论：**E1.1–E1.5 已完成本轮实现与验收，E1.6 按用户要求暂缓。** 三个 Astra 高思考强度子 agent 分别负责两个实现方向和独立检视，主 agent 负责管理入口、集成、真实执行及文档。未调用 Claude，未发布新版本或更新远程。

## 验收矩阵

| ID | 结果 | 证据与实际范围 |
| --- | --- | --- |
| E1.1 | done | 配额持久化、事务与 SQL trigger 限额；40 任务/6 Developer 受控压力；真实 4 Codex Developer 同时在途 |
| E1.2 | done | 两个真实 Workspace/live Lead 并发；共享预算和工作区取消隔离；真实 Git common-dir 跨进程锁；未知清理保额 |
| E1.3 | done | 任意角色名及 purpose、DSH spawn 配置/能力校验、外部实例模型冲突、不可变快照、角色引用保护；真实 Codex 实例执行 |
| E1.4 | done | 原子新增/重规划、版本竞争、环检测、已执行任务保护、持久工作区轮转、priority/等待老化、10000 节点 DAG |
| E1.5 | done | 官方 Workflow/PTC 的已入账 analysis 批次；真实 Codex 两子项；受控失败/取消/工具隔离；真实 Git 写入拒绝 |
| E1.6 | deferred | SSE 和 Web UI 未开发 |

## 自动与官方服务检查

- `pnpm install --frozen-lockfile`、`pnpm peers check`、`pnpm typecheck`、`pnpm build` 通过。
- 全量 **21 个测试文件、106/106 通过，0 failed / 0 pending**：[机器结果](evidence/e1-automated-tests.json)。旧的全局单 Workflow 断言已更新为新契约，同工作区未知清理仍阻止新 Workflow，其他工作区继续受全局预算限制。
- 独立新增 15 项验收包含真实 SQLite、Git、角色退休、取消隔离和分析写入门禁：[独立检视](evidence/e1-independent-review.json)。
- 官方 Workflow、PTC 进程、Subagent 服务与受控 Provider 的零模型探针验证顺序执行、单项失败、取消阻止下一项、正确 cwd、工具 guard 和所有 child 清理：[官方服务证据](evidence/e1-workflow-service.json)。这不是原生模型调用证据。
- 完整 Codex profile 真实加载、管理 API、官方 Workflow engine、八个 Lead 工具、身份与继承工具隔离、正常卸载通过，模型调用为零：[profile/tools 证据](evidence/e1-profile-tools.json)。报告仅注册 `spawn/codex-dev/codex-review`。
- 官方普通 DSH spawn 通过真实 bridge 创建子 Agent，子 Agent 可见 `pwsh/read_image/working_directory`，不可见 Lead 的八个 RIFT 工具；在初始 prompt 前主动回滚，两次均释放容量和清理，模型请求计数 0：[spawn 作用域证据](evidence/e1-spawn-service.json)。Lead 的工具限制不会使普通 DSH Developer 失去开发工具。

## 真实 Codex 业务验证

香港时间 **18:42:22–18:44:52**，`pnpm exec tsx scripts/e1-acceptance-probe.ts --run` 退出码 0。[原始脱敏报告](evidence/e1-native-acceptance.json)及其临时目录保留完整 SQLite、Git、输入/结果产物。

两个独立真实仓库与 Workspace 各自创建 live DSH Lead，四个 Astra Developer 在独立 worktree 同时在途，结果进入全局串行检查与审查。四个 Reviewer Run 全部由官方 Codex 执行，`reviewedCommit` 与检查、候选及接受提交匹配；两个集成分支分别保留本工作区的 alpha/beta marker。默认分支和原 checkout 未变，测试仓库无 remote。

[独立原生现场审计](evidence/e1-native-independent-audit.json)完成 **76/76** 只读检查：SQLite 与报告逐项一致，18 份输入/结果产物 hash、大小和身份吻合，四个开发共同在途 **14867 ms**，四次审查保持串行，接受提交的实际 Git 父链正确。

随后一个 analysis Run 调用官方 Workflow engine，顺序启动两个原生 Codex 子项，结果分别为 `alpha:11`、`beta:22`；聚合结果入库并通过真实 Git 只读门禁。总计 **9 个业务 Run、10 次原生 Codex 子执行**（4 开发、4 审查、2 批量分析子项），5 个 Task 成功、2 个 Workflow completed，所有 Run 清理 confirmed、槽位释放，Host 卸载后数据库锁释放。

Lead 是真实 DSH Agent，但此探针由程序确定性驱动业务 API，**没有请求 Lead 模型自行规划**。并发证据来自官方接受时间和在途区间，不冒充逐条原生工具同时执行的轨迹。原报告记录的 8 个实现文件 hash 与验收时源码一致；完整最终文件快照另见 [检查汇总](evidence/e1-final-validation.json)。

## 本轮发现与修复

1. 角色配置曾允许移除被未完成任务/排队请求引用的 Developer，导致任务永久等待。现拒绝移除或更改其 purpose，独立回归通过。
2. 原 analysis 成功路径未检查实际 Git 变化。现正式 LocalGit 在接受分析前核验 worktree 归属、HEAD 和 tracked/untracked/ignored；实际文件修改、提交及空提交均阻塞，保留现场与证据。分析不能绕过变更门禁。
3. 无效 Host 配额在构造失败后会释放数据库 lease，允许修正配置后重新启动。探针报告改为逐字符串脱敏后序列化，防止破坏 JSON 布尔值。

## 保留边界与下一步

本轮未重新执行 Claude 路径，也未为 DSH spawn 额外请求真实 LLM；其配置映射、官方服务加载和隔离机制有受控验证。外部 binding.model 是声明元数据，实际模型由 profile 配置，不能只通过角色 JSON 切换。

批量分析限定一次已登记 Run 内的提供文本分析，子项顺序执行，不恢复旧 handle、不跨执行复用原生 Session。原生崩溃/未知清理矩阵沿用 P3 的保守不重放机制，并经 E1 自动回归；本轮没有重做所有 P3 原生 OS 故障场景。Windows 与已锁定依赖之外的平台未验证。

下一项是待用户重新安排的 E1.6；E2 仍按明确需求单独评估。配置与命令见 [E1 使用指南](e1-guide.md)。
