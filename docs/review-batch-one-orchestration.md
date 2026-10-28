# 第一批：审核编排本地实现记录

基线：`2440df92777f4b2c8373fe47df3bff02ce658c8a`。
本记录不是 Host 独立审核、清理或验收证明。

## 行为与边界

- 同任务、同 source、同计划的活动 integration 请求合并为原 operation，即使客户端使用不同 key 或旧版本。
- 增量迁移 26 保存其他请求 key 到原 operation 的绑定。失败、取消、显式重试或存储重启后重放旧 key，只返回原记录，不启动新审核。
- 显式基础设施/blocked 审核重试仍使用新 key、新 operation、新 reviewer Run，保留原记录，不新增开发 attempt。`changes_requested` 仍必须正式返修。
- 正式审核只有 coordinator 的原有串行预留入口；讨论澄清不创建默认第二轮，讨论批准不替代精确候选正式结果。新候选必须重新审核，旧 reviewedCommit 不能发布。
- Reviewer 输入新增 `reviewContext`：绑定的上轮 findings/结果、Host Git 候选间差异、实际检查摘要和 integration/check 引用。未记录的人工检查范围明确未知；开发 checksClaimed 不升级为检查事实。差异最多 24000 字符，截断显式标记；不可读取时标为 unavailable。
- 复用证据 gate/resume、operation 附件与 currentCandidate；没有另建补证入口，没有 UI 或公共 wire 协议变更。
- source/cleanup 等例行事实只生成持久回执，不在流水线已推进时唤醒 Lead。首次 wake/no-wake 分类随 outbox 回执持久化，重放不能重新分类。
- 待处理但尚未分配执行的过期进度 trigger 标记 consumed；事实账本和回执不删除。异步 parent 准备后再次核对状态。
- 用户输入路径、真实阻塞/补证需求、cleanup 未知、取消、接受/恢复后的依赖就绪和收尾仍保留；不修改预算、不释放未知租约、不绕过清理与发布门禁。

## 本地真实检查（2026-10-28）

- `pnpm install --offline --frozen-lockfile`：成功，锁文件/依赖声明未修改。
- `pnpm test` 最终重跑：105 文件通过，780 tests passed，1 skipped（`RIFT_NETWORK_TESTS` 未启用的外网 npm 安装测试）。
- `pnpm typecheck`：后端及 UI 通过。
- `pnpm build`：通过；Vite 仍提示 >500 kB chunk 警告。
- `pnpm test:built-cli`：通过（独立 cwd、协议加载、管理命令、重放/版本错误和 SSE）。
- `git diff --check`：通过。
- 代表性触发计数：同一流水线阶段的 source.collected + cleanup.confirmed，原类型策略 2 个 wake 意图，现策略 0 个；2 条事实和回执均保留。integration.accepted 后 1 次 Lead 入队；cleanup 未知等决策边界保留。
- 覆盖不同 key/重复请求、显式 retry、存储重启、取消、旧提交批准失效、差异不可用、异步状态竞争、重放和持久事件合并。
- 全量包含原有真实 Git 的 required/optional timeout 硬阻断、同候选补证不增 attempt、真实 code_defect 返修，以及附件落盘/DB 更新中断的协调恢复故障注入。
- 新增测试曾发现重放会重分类旧进度，已修复并回归；全量首次发现旧顺序用例的保守阻塞保留问题，修正后最终全量通过。

本地日志：`/tmp/rift-orchestration-full-tests-final.log`、`/tmp/rift-orchestration-typecheck.log`、`/tmp/rift-orchestration-build.log`、`/tmp/rift-orchestration-built-cli.log`。

未运行真实模型会话、真实浏览器交互或外网 npm 安装测试；组合链路独立验收仍由后继 integration/Host 完成。没有 push 或 PR。
第二批基线复用/检查 DAG/环境缓存、第三批分阶段队列/跨引用并行仅登记，均未实现；须用户分别明确确认，第一批完成及 Host 事件不构成授权。
