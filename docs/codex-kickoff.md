# RIFT Codex 开发启动说明

**最新状态与优先约束（2026-10-25）：** E1.1–E1.5 已交付；继续前先读 [E1 验收](e1-acceptance.md) 和 [E1 指南](e1-guide.md)。当前用户要求暂不使用 Claude，E1.6（SSE/Web UI）先不开发。本轮三个 Astra 高思考强度子 agent 的实现与检视已结束，106 项测试和真实 Codex-only 双工作区/四开发/官方 Workflow 批量分析通过。下方首次开发及后续提示词属于历史基线，其中“全局一个 Workflow、固定两个 Developer、E1 留后”不再代表当前 E1 契约；未知清理占用、官方 Provider/live parent、精确 SHA 接受及不重放不变量继续适用。

版本：0.3。下方首次开发提示词保留为历史基线。当前 `0.1.0` 已完成 P0–P3 MVP 验收；继续工作时先读 `development-status.md`、`runtime-compatibility.md`、`poc-results.md` 和 `acceptance-report.md`，不要重新创建已完成模块或重复配置认证。Codex Sol/Astra 与 Claude Opus 5.5 均有真实证据；最终完整 LLM Lead/Astra 闭环、Sol 拒审返工、精确提交集成、OS 崩溃恢复及原生暂停/取消均通过。默认 Lead 已修正为 `deepseek-official/deepseek-flash`。后续按新的用户需求选择 E1/E2，不将历史失败或初期 skipped 当作当前阻塞。

## 首次开发提示词

```text
请在当前 RIFT 仓库开始开发。先阅读：
1. README.md
2. docs/technical-plan.md
3. docs/implementation-backlog.md
4. docs/source-alignment.md
以及实际存在的 AGENTS.md 和已有实现。

采用已核对的 DSH 插件架构：
- DSH 是宿主和 Agent 内核。
- 工程主体是一个 rift 包，内部包含 project、task、git 三个业务模块。
- Codex 和 Claude Code 使用 DSH 官方 subagent Provider。
- 委派通过插件内 ctx.subagents.startActivation()，传入真实存活的 Lead Agent 和明确 cwd。
- 不自研通用 RuntimeAdapter、原生 app-server 客户端、Claude SDK 执行后端或独立 Orchestrator daemon。
- 持久化的软件开发任务、worktree 绑定、审查和 Git 集成由插件负责。

本次先执行 P0。目标是用最小插件验证：
1. Codex/Claude 官方 Provider 可以分别在指定独立 worktree 执行。
2. child ID、stopReason、最终结果与业务 Run 能可靠关联。
3. DSH Lead 能通过协作工具编排两种 Provider，并根据结果继续判断。
4. 两个 Claude Developer 的实际执行区间重叠，目录/结果隔离；单任务取消不影响兄弟任务。
5. 两个开发与一个其他任务的 Codex 审查可同时活动，所用 Provider 实例与 DSH 容量配置有证据。
同时验证取消、清理、权限、工具面和 Windows 中文空格路径。

调查源码 commit 为 22ddee3792402c3e70ec5f86a63c3e3e895a2f60，
候选 DSH 版本为 0.2.1-rc.3。实际部署必须核对发布包并锁定兼容依赖。
把版本、命令、证据和结果写入 docs/runtime-compatibility.md 与 docs/poc-results.md。

外部 provider 的 model/权限由注册实例决定，不支持的 agentOptions、
agentPreset、outputSchema 等字段不可强传。需要不同配置时使用不同 provider 实例。
角色长期存在，Codex/Claude Task Run 是一次性的；返工通过任务记录、diff、提交和审查报告恢复上下文。
发布前 AbortSignal 中止准备，发布后用该 activation.dispose() 取消。
不要用关闭共享 DSH Host 的方式取消单个任务。

P0 通过后继续 P1，随后完成最小 MVP：
一个 DSH Lead + 两个可并行的 Claude Developer + 一个 Codex Reviewer。
角色 ID 为 lead、developer-a、developer-b、reviewer；两个 Developer 的任务使用不同 worktree。
同一 Claude Provider 实例可否并行须通过 P0；需要双实例时显式配置并重新验证。
并行开发属于首版，审查和集成队列保持串行；审查可与其他任务开发重叠。
全局一个 Workflow，最多两个开发 Run、一个审查 Run、三个子 activation，每子角色最多一个 Run。
准备、取消及清理未确认仍占槽；事务内预留配额，超额持久排队，不能仅统计 running。
基本 DAG 校验、依赖就绪、空槽消费已请求任务和依赖失败阻塞属于 MVP。
前置变更成功集成后才能派发后继；预期写入路径重叠时保守串行。
先派发两个独立任务再等待，dispatch 返回接受或排队结果，不能等待执行完成才返回。
wait 接受多 runIds/requestIds 与事件游标，任一结果持久化后即返回，支持乱序完成和超时查询。
Lead 等待不能阻塞后台结果入库、清理、队列消费或集成；排队请求始终可追踪。
超过两个 Developer、自由角色和高级动态 DAG 调度放到 E1。
MVP 不要求原生 Codex/Claude 主 Agent、长期会话或完整工具事件流。

所有 source/candidate/target 提交和检查证据必须明确。
Task 只有通过确定性检查、精确提交审查及集成后才能成功。
两个任务同基线并行开发时，后合入者基于最新集成 HEAD 重建候选，重新测试和审查，保留前者成果。
冲突或审查拒绝保存证据并释放集成锁后返工，不持锁等待 Developer。
单任务失败或取消不终止独立任务；全流程取消逐项确认清理，未知执行保持占用。
不自动 push 或合并用户默认分支，不强制删除未保存 worktree。

缺凭据时记录真实 POC 为 skipped，继续 schema、SQLite、fake activation 和 Git 的独立开发；
不能把模拟成功写成原生运行时已验证。
如果官方能力阻塞核心路径，记录具体缺口和最小扩展方案，不暗中改回旧版独立架构。

结束时更新任务 ID、实现文件、检查和真实验证结果、未决问题及下一任务。
本次只实现当前阶段需要的内容，不先创建全部扩展模块或前端。
```

## 后续开发提示词

```text
继续开发 RIFT。读取最新技术方案、实施清单、原方案对齐记录、POC 结论和已有代码。
按第一个未完成且依赖满足的任务推进一个可运行闭环。
保留 DSH 宿主、单 rift 插件和官方 Provider 复用边界。
遵守外部执行一次性、live parent、activation handle 所有权和精确提交验收约束。
主 Agent 提议动作，插件校验业务状态、执行资格及 Git 更新。
优先完成一个 Lead、两个可并行 Developer、一个 Reviewer 的 MVP，验收技术方案 A01–A18。
保留开发最多两个、审查最多一个、每子角色一个 Run 的配额；开发并行，集成串行。
E1/E2 仅在对应阶段确有需要时开展，不把双 Developer 并行误移回扩展阶段。
类型检查和相关测试通过后记录结果；缺失的真实验证清楚标为 skipped。
不要重复之前已完成的 POC，也不要把旧版原生适配器任务清单重新引入。
```

## 开发不变量

1. 软件开发任务的业务状态只在 rift 插件中维护；底层 Agent 生命周期由 DSH 管理。
2. 一个写入 worktree 只属于一个活动 Run，清理结果未知时不释放。
3. Provider 与角色的生效配置在 Run 创建时固定。
4. 外部 child ID 不等于可恢复的 DSH 本地 Session。
5. 模型成功报告不能替代实际差异、测试、审查和集成事实。
6. 审查针对 candidate commit，目标变化后重新验证。
7. 对重复工具调用和迟到结果保持幂等；崩溃后不盲目重放未知副作用。
8. 新 attempt 保留旧记录和代码；取消或失败不自动清空 worktree。
9. 所有管理命令的执行权限来自插件校验，不能由模型输出自行扩大。
10. 首版结束于可追溯的本地集成分支与报告。
11. 配额和角色占用在事务中预留，清理未确认的执行继续占用；准备中也计入上限。
12. 两个 Developer 先派发后等待任一结果，实际执行区间重叠才算并行通过。
13. 前置成果尚未接受时不派发后继；单任务取消、失败和返工不停止其他独立任务。
14. 后续候选包含最新已接受成果，重新检查和审查后才发布；返工不持有集成锁。
