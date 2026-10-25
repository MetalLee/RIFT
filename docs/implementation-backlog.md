# RIFT 分阶段实施任务清单

版本：0.4。2026-10-25 的 `0.1.0` 已完成 P0–P3 MVP；当前源码继续交付 E1.1–E1.5，E1.6 按用户要求暂缓，本轮未使用 Claude。逐项状态见[开发记录](development-status.md)，新增证据见 [E1 验收](e1-acceptance.md)。下表保留原 MVP 验收标准，E1 的配置契约以 [E1 指南](e1-guide.md) 为准。旧版 P0–P6 独立 Orchestrator 任务表已由本清单替代。

## P0 验证 DSH 技术可行性

目标：验证指定 worktree 执行、可靠结果、Lead 跨 Provider 编排，以及两个 Developer 的真实并行。代码局限在最小插件和临时测试仓库，不提前铺开整个产品。

| ID | 工作 | 交付物和通过条件 |
| --- | --- | --- |
| P0.1 | 锁定环境 | 确切 Node、pnpm、DSH、Cordis、Codex/Claude Provider 与平台 payload 版本；候选 DSH 为 0.2.1-rc.3；生成 lockfile |
| P0.2 | 最小插件加载 | 一个 rift 包；公开服务注入和工具注册可编译、可加载、可卸载；可获取 live Lead |
| P0.3 | Codex 官方 Provider 探针 | 由插件调用 startActivation，指定临时 worktree，完成一个标记文件任务，保存 childId、stopReason、最终文本 |
| P0.4 | Claude 官方 Provider 探针 | 同上；使用第二个 worktree，验证文件与运行标识不会串用 |
| P0.5 | Lead 委派探针 | DSH Lead 调用协作工具启动两种官方 Provider，并在结果持久化后继续作出下一步决策 |
| P0.6 | 生命周期和能力探针 | 启动前中止、发布后 dispose、子命令清理、插件卸载；外部 provider 不支持的选项被拒绝 |
| P0.7 | 配置与权限 | 独立 provider 实例的模型、凭据、permissionMode；reviewer 权限；默认全局委派工具是否可被角色 preset 收紧 |
| P0.8 | Host/CLI 管理接入 | 确定可用的官方 profile 启动方式、Lead 生存期、无需模型的状态/取消路径；SDK 与业务 API 分离 |
| P0.9 | 实验性能力取舍 | 记录 Worktrees 创建会切换 Session cwd 的影响；默认选薄 Git CLI；Agent Teams 不做业务核心 |
| P0.10 | 形成结论 | docs/runtime-compatibility.md 和 docs/poc-results.md，列出真实版本、命令、环境、证据、pass/fail/skipped |
| P0.11 | 并行与取消隔离探针 | 两个 Claude Developer 在独立 worktree 的执行区间重叠；另一个开发已完成的任务的 Codex review 可同时执行；记录实例绑定、DSH 容量与时间证据，取消一个开发不影响其余执行 |

P0 gate：P0.3–P0.5 与 P0.11 的真实执行全部通过，且不存在无法处理的清理问题，才称架构 POC 通过。先完成探针再汇总 P0.10。缺凭据时允许继续 schema、SQLite 和 fake activation 等独立工作，但 POC 保持未通过。失败时先明确官方能力缺口和最小扩展方案，不直接切回独立运行时架构，也不静默将 MVP 降为串行。

## P1 建立插件业务骨架

依赖：P0 的插件接入方式已确认；不依赖真实模型的部分可在缺凭据时先做。

| ID | 工作 | 交付物和通过条件 |
| --- | --- | --- |
| P1.1 | 单插件工程 | project/task/git/tools 模块、TypeScript strict、类型检查、测试、迁移；无独立 daemon 或 runtime-* 包 |
| P1.2 | Project 和角色 | Workspace、Repository、Role、ProviderBinding；默认 lead/developer-a/developer-b/reviewer 四角色；Lead 唯一且必须为 DSH |
| P1.3 | SQLite 业务模型 | Workflow、Task、Run、Worktree、Integration、Artifact、TaskEvent、Operation；外键与唯一约束 |
| P1.4 | 配置快照 | Role 和 ProviderBinding 的 revision；Run 固定生效配置；无凭据明文 |
| P1.5 | 任务状态与幂等 | 状态转移、expectedVersion、重复派发拒绝；每 Task、每子角色最多一个占槽 Run，清理未知仍占槽；analysis 与 change 验收区分 |
| P1.6 | 薄 activation bridge | 仅封装 DSH 服务调用、handle 所有权和业务映射；fake service/activation 可模拟异常，不实现新运行时协议 |
| P1.7 | 协作工具 | plan.submit、task.dispatch、wait、status、task.retry、integration.request、workflow.finish；身份从调用上下文推导 |
| P1.8 | 最小管理入口 | Workspace/角色配置、状态和取消可无需模型执行；本地 API 随插件装载和释放 |
| P1.9 | 持久队列与原子配额 | 全局一个 Workflow；两个开发槽、一个审查槽、三个子 activation 上限；事务预留，超额排队，清理后释放，启动前恢复占用；dispatch/integration.request 返回可追踪请求 |

P1 gate：fake activation 通过屏障控制同时启动、乱序结束、并发争抢槽位及清理失败，证明配额不会超限、重复请求不产生第二次执行，未确认清理不释放角色或 worktree。没有真实凭据也能验证这些业务逻辑。

## P2 完成一个 Lead、两个 Developer、一个 Reviewer 的并行闭环

依赖：P1；真实闭环依赖 P0 gate。

| ID | 工作 | 交付物和通过条件 |
| --- | --- | --- |
| P2.1 | Worktree 与提交 | Task attempt 独占目录；真实 diff、基线和结果提交；Git 参数数组；中文空格路径测试 |
| P2.2 | 双开发任务协调 | 基本 DAG、环检测、前置成果已集成的 ready 校验；已请求任务按空槽派发，预期路径重叠串行；失败只阻塞依赖后继 |
| P2.3 | 两个 Claude Developer | 自足任务包与不同 cwd；先派发两者再等待，真实执行重叠；schema 校验、文件与 Run 证据对应 |
| P2.4 | 候选与检查 | 串行集成锁、detached candidate、固定命令配置、检查日志与 candidateHead 绑定 |
| P2.5 | Codex 审查 | 官方 Provider 在独立审查 checkout 执行；reviewedCommit 匹配；修改候选或非法报告不算批准 |
| P2.6 | 返工 | 拒绝或冲突后保存证据并释放集成锁；新 attempt 输入任务、diff、当前目标提交和报告；返工占开发槽，不阻塞独立任务 |
| P2.7 | 接受候选 | 集成队列串行；后续候选从最新目标 HEAD 合入源提交并重新测试与审查，CAS 发布，最终保留并行任务全部已接受成果 |
| P2.8 | 任一结果等待与收尾 | wait 支持多 runIds/requestIds、事件游标和超时，处理乱序结果；Lead 等待不阻塞后台队列；所有任务、门禁及清理完成才收尾 |
| P2.9 | CLI 与报告 | run/status/logs/cancel/retry、--json；显示四角色、cwd、槽位与队列、依赖阻塞、集成 SHA 及检查审查证据 |

P2 gate：一个 Lead 调度两个 Developer，两个独立任务真实同时开发并乱序返回，由单 Reviewer 串行验收后，集成分支保留两者成果。补充验证两个开发与其他任务的审查重叠、第三个开发排队、依赖未接受不派发，以及拒绝后全新 Run 修复成功。测试失败和冲突不污染已接受成果。默认分支及远程仓库未被自动更新。

## P3 恢复与首版交付

依赖：P2。

| ID | 工作 | 交付物和通过条件 |
| --- | --- | --- |
| P3.1 | 启动窗口恢复 | 两个并行 Run 在派发记录后/activation 返回前后注入崩溃；按 Run 恢复队列与占用，未知执行标 interrupted，不盲目重放 |
| P3.2 | 结果和清理恢复 | 乱序/重复结果不重复返工或集成；清理异常保留角色、槽位与写锁；丢失 handle 不伪装可恢复；恢复 Lead 后取得 live parent |
| P3.3 | Git 操作恢复 | 候选、ref 发布和业务提交的操作阶段可核对；已发布候选只补记，不重复合并 |
| P3.4 | 停止与取消 | pause 停止消费开发及审查队列；单任务 cancel 不影响兄弟任务；Workflow 取消全部准备/运行项及排队项，一个清理失败不跳过其他项 |
| P3.5 | 安全归档 | dirty/untracked/ignored、活动进程、越界路径阻止默认删除；不 force |
| P3.6 | doctor 与日志 | 包版本、认证状态、provider 配置、受限能力、清理遗留诊断；日志脱敏及大小限制 |
| P3.7 | 安装与使用说明 | 已验证 profile 模板、环境引用、启动步骤、权限说明、恢复步骤；无未实现命令伪装成可用 |
| P3.8 | 完整验收 | 技术方案 A01–A18；真实与 fake 分开列出，记录 skipped 和失败原因 |

P3 gate：MVP 验收通过才发布首个可用版本。未完成四角色真实并行闭环时只能标记开发预览。

## E1 闭环后的扩展

只有 P2/P3 证明基本方案有效后再安排，不列入 MVP 阻塞项。

| ID | 扩展 | 当前交付与验收 |
| --- | --- | --- |
| E1.1 | 扩大 Developer 并发规模 | 已实现全局持久配额、事务/trigger 兜底；40 任务/6 开发受控压力与真实 4 Codex 开发验证；集成仍串行 |
| E1.2 | 多工作区并发 | 已实现独立 Lead/Workflow、共享预算、跨进程仓库元数据锁和取消隔离 |
| E1.3 | 自由角色配置 | 已实现 purpose/任意角色名、DSH spawn 与官方外部绑定、配置快照和实例模型冲突校验；Claude 本轮未复测 |
| E1.4 | 高级 DAG 调度 | 已实现原子动态重规划、版本与环检测、priority/等待老化/工作区轮转 |
| E1.5 | Workflow 复用 | 已实现一个持久 analysis Run 内顺序批量分析，复用官方 Workflow/PTC；写任务拒绝，实际 Git 只读门禁验收 |
| E1.6 | 事件和界面 | deferred，用户本轮明确暂不做；SSE/Web UI 均未实现 |

## E2 有明确需求时扩展 Provider

逐条评估长期原生 Session、逐条工具事件、运行中提示更新、人工审批往返，以及原生 Codex/Claude 主 Agent。优先扩展官方 Provider 或增加最小兼容插件，并为实际需求写 ADR；不预先构建一套万能 RuntimeAdapter。

DSH 官方外部 Provider 的单次执行限制是 MVP 已接受的取舍，不能在无新增需求时把它当作必须重写底层的理由。

## 任务完成记录

```text
任务 ID：
状态：todo / doing / done / blocked
变更文件：
行为与契约：
自动检查结果：
真实执行：verified / skipped / not-applicable
证据位置：
剩余问题与下一任务：
```

所有阶段以可验证结果为完成标准。不要因为本文提供了详细接口草图，就跳过 DSH 实际发布包的编译和运行验证。
