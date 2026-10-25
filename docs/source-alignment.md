# RIFT 原 DSH 方案对齐记录

核对日期：2026 年 10 月 25 日。当前对应技术方案版本：0.3。下文原方案与 0.2 对齐内容保留为历史记录；首版范围以“0.3 用户后续决定”为准。

来源为[多智能体架构设计](https://chatgpt.com/g/g-p-6ab14a1b6be481919f8c7135baec3573-jevmo-xing-shi-yan/c/6add1b36-58f0-83e9-804c-25b1ed0c2494)中，用户询问加入 DeepSeek Harness 后的完整回答。此次已通过浏览器直接读取该回答的开头、各节、限制、MVP 和结论。此前对话读取接口返回的占位符问题不再阻止方案对齐。

本文件保存与开发有关的决策摘要和差异，不包含浏览器侧边栏、其他聊天或账户信息。原对话中的产品能力描述已结合官方源码文档核对；原文不是已经运行验证的技术事实，真实兼容性仍由 P0 判定。

## 原方案的完整决策脉络

1. **DSH 成为基础设施。** 复用 Agent Loop、模型接入、会话、工具、沙箱、子 Agent、工作流及事件，减少自行开发的底层模块。
2. **保留原生 Harness。** Codex 与 Claude Code 继续使用各自原生工具和执行上下文，通过 DSH 官方 subagent Provider 接入，不把它们当作普通 LLM API。
3. **接受一次性外部执行。** 官方 Codex/Claude Provider 执行独立任务、支持指定 cwd、结果与取消；长期角色配置与短期 Run 分离，返工依靠任务记录、diff 和审查报告。长期原生 Session 属于后续需求。
4. **业务代码收敛到一个插件。** 该插件包含 Project、Task Coordinator、Git Integration 三个模块及协作工具；通过 `ctx.subagents.startActivation()` 统一调用官方 Provider。插件名称按用户后续要求统一为 `rift`。
5. **复用并保留业务映射。** DSH Workspace 是目录与 Session 管理，插件仍需保存逻辑 Workspace 与多个 Task worktree 的关联；DSH Workflow 组织一次执行，持久开发任务由插件管理。
6. **谨慎使用实验性功能。** Worktrees 插件可做可行性验证或以薄 Git CLI 代替；Agent Teams 不直接作为整个异构系统的核心调度器。
7. **首版做一主两子。** DSH Lead、Claude Code Developer、Codex Reviewer，完成注册、规划、隔离开发、审查、返工、合并和记录，再增加多个 Developer、自由角色与自动 DAG 调度。
8. **锁定版本。** 使用官方扩展接口，尽量不 fork DSH；承认开发预览版本的破坏性变更风险。
9. **先做 POC。** 验证两种原生 Provider 在独立 worktree 中执行、可靠获取结果，以及主 Agent 对两种运行时的编排。

## 与 0.1 文档的具体修订

| 主题 | 0.1 的选择 | 0.2 对齐结果 |
| --- | --- | --- |
| 宿主 | 独立 RIFT 守护进程，DSH 只是执行后端 | DSH Host 装载 rift 插件；CLI 只是薄入口 |
| 工程组织 | 多包核心、三个 runtime adapter 和监督器 | 一个插件包中的 project/task/git 业务模块 |
| Codex/Claude | 首版自行对接 app-server 与 Agent SDK | 首版复用官方 DSH Provider，不重复实现原生协议 |
| 外部一次性限制 | 用长期会话需求推动自研适配器 | 接受原方案的一次性 Run，返工用证据包重建上下文 |
| 主 Agent | MVP 要求任意运行时均可作主 Agent | 首版固定 DSH Lead；原生主 Agent 作为 E2 需求 |
| 角色默认组合 | DSH Lead、Codex Developer、Claude Reviewer | 按原方案设为 DSH Lead、Claude Developer、Codex Reviewer |
| 调度 | 从全局并行、统一状态与 outbox 平台开始 | 插件内持久任务加串行派发，复杂并行延后 |
| 生命周期 | RIFT 自研进程监督和统一取消 | DSH activation handle 管理；插件保存业务状态与恢复证据 |
| 事件与审批 | 统一完整事件、人工交互和 SSE | 按官方 Provider 能力暴露结果；完整轨迹、审批桥接和 SSE 延后 |
| 实施顺序 | P0–P6 逐步搭建独立系统 | P0 POC → P1 插件骨架 → P2 小闭环 → P3 恢复与交付 |

工作区隔离、任务与 Run 分离、独占 worktree、精确提交审查、串行集成、幂等与保守恢复继续保留。这些属于落实原方案所需的工程细节，不改变 DSH 宿主边界。

## 0.3 用户后续决定：并行开发纳入首版

用户明确要求将 MVP 调整为“一个 Lead、两个可并行的 Developer 和一个 Reviewer”，并同步更新技术方案、实施清单与 Codex 开工说明。此决定取代原方案及 0.2 的串行开发范围，不把原对话改写成已经包含并行 MVP。

- 概念为 **Parallel minds. One workspace.**：共同逻辑工作区、独立任务 worktree、成果受控汇合；产品仍支持注册多个工作区。
- 默认角色为一个 DSH Lead、两个 Claude Code Developer、一个 Codex Reviewer。DSH Host、单 `rift` 插件、官方 Provider、一次性 Run 的选择保持不变。
- 并行开发、基本 DAG 就绪判断、持久队列和原子槽位预留提前到 P1/P2。全局一个 Workflow；最多两个开发、一个审查、三个子 activation，每子角色一个 Run。
- Lead 先派发两个独立任务，再等待任一持久结果；允许乱序完成。准备中、取消中和清理未确认的执行仍占槽位。
- 候选审查与集成串行，可与其他任务开发重叠。后合入任务必须基于最新集成 HEAD 重建、测试和审查，不能覆盖先前成果。
- P0 新增真实并行和取消隔离探针；P3 验收扩展到 A01–A18。超过两个 Developer、多工作区并发、自由角色与高级动态调度仍属 E1。

这些是用户批准的 RIFT 产品与实现契约，不代表 DSH Provider 并行行为已实测；验证状态仍为待 P0。

## 持续保留的实现约束

- `startActivation` 要求真实存活的 parent Agent，不能用数据库中的 ID 代替对象。
- 外部 Provider 的模型与权限由已注册实例决定；不同配置使用不同 providerName，不传不支持的逐次覆盖选项。
- activation 发布前使用 AbortSignal，发布后用该 handle 的 dispose；单任务取消不关闭共享 Host。
- caller delivery 下插件自行保存外部 Run 记录，并在业务结果入库后通过 wait 工具交回 Lead。
- review 是 change Task 的验收阶段，不能要求开发 Task 先成功才运行 review。
- 官方 Worktrees 创建操作会切换 Session cwd，因此首版默认以薄 Git CLI 分配目录，避免移动 Lead 的工作目录。
- 业务 API 必须通过实际存在的插件扩展或插件 listener 实现；DSH stdio SDK 不自动具有任意业务 RPC。

这些约束来自已核对的固定版本文档或明确的 RIFT 实现设计，仍需要 P0 对实际发布包验证。未安装运行时、未消费模型 API，也未完成三运行时闭环测试。
