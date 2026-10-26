# 对话协作 C2–C4 验收

日期：2026-10-26。承接 [开发方案](chat-orchestration-development-plan.md)及 [C1 历史验收](chat-orchestration-acceptance.md)。按三个 Astra 高思考强度子 agent、两实现一独立检视的分工完成；主 agent 整合、运行真实模型和浏览器验证、同步文档。未提交项目 Git，也未替换用户正在运行的 Host。

## 后续权限契约更新

以下 C2–C4 真实模型、浏览器与性能记录属于原交付。后续 [工作区仓库权限](workspace-repository-permissions.md) 允许普通讨论和开发使用 Host 关联的全部仓库、精确 Git 元数据和 worktree；正式 review/analysis 保持只读。权限指纹现包含版本、roots 和 cwd，跨 worktree 返工换 thread，经 Host previousResults/sourceEvidence/messages 恢复必要上下文；同边界续接不变。最新协议探针已按此契约重跑，历史真实模型闭环未冒充本轮重新运行。

本轮独立权限回归与 DSH 本地原生命令探针结果见新权限文档；旧只读 shell 的 loopback 网络限制实测失败，正式模式已改为禁 shell 的 Host read/list 边界，Codex 新边界 17/17、DSH 开发命令 6/6 真实探针通过。gh 2.103.2 已安装但用户选择稍后登录，本次不 push、不创建远程 PR。

## 交付

- C2：消息明确区分作者、接收者、来源和 task/run/turn/request；`rift_delegate` 原子提交任务、派发和公共消息，同键重试返回原结果；`rift_send_message` 使用当前 Turn/Run 身份，忙碌成员和任务补充进入持久 inbox。
- C3：有界事件扫描、独立 outbox、幂等投影、合并与优先级；correlation/父消息/自动跳数、协调预算和成员消息预算；故障恢复不重放未知执行。输入在执行边界冻结，按 receipts 同步必要公共消息与有限检查/审查证据。
- C4：安全正文前缀、跨 delta 凭据脱敏、草稿序号与终稿替换；系统进展折叠在对应消息下，关联任务 tag 跳到具体任务。详细诊断留在活动页。
- 默认开启：内置 profiles、配置 schema 和直接构造 Host 的缺省值一致。`RIFT_CHAT_ORCHESTRATION=0` / `chatOrchestration: false` 保留兼容入口；已存在的 Workflow 不自动改变协调归属。

当前用户正文传给 runtime 时使用原文；历史与成员消息采用简短来源说明加正文。业务工具参数、任务输入和证据仍保持结构化数据，避免丢失身份和验收语义。

## 分层证据

全量 **47 文件、270 项：269 passed / 0 failed / 1 skipped**；跳过的是仅适用非 Windows 的进程组清理测试。独立 C2–C4 **19/19** 计入全量，不重复相加。最终顶部状态刷新优化后，迁移、上下文、SSE 和草稿专项 **27/27** 复验通过，并再次完成类型检查、构建及真实浏览器检查。

| 层次 | 范围与结果 |
| --- | --- |
| 自动测试 | [全量报告](evidence/collaboration-tests.json)；Root/UI typecheck、生产构建及差异检查另见 [最终检查](evidence/collaboration-final-validation.json) |
| 独立检视 | [独立报告](evidence/collaboration-independent-review.json)：真实 SQLite 事务故障注入、跨作用域与过期 lease、并行乱序、inbox 输入边界、预算、恢复、迁移和安全草稿 |
| 锁定二进制 | [Codex 0.164.0 协议探针](evidence/collaboration-native-probe.json)：真实 app-server、本地受控 Responses、无外部推理；最新重跑验证跨 worktree 新 thread、Host prior-result/inbox 恢复、review 隔离、工具声明与新 Run 闭包；原交付 11 项结论保留为历史 |
| 真实模型 | [Astra 实际闭环](evidence/collaboration-real-astra-probe.json)：2 个并行开发任务、6 个开发/返工/审查 Run、8 个 Lead Turn（7 个事件续办），14 项检查通过 |
| 精确提交复核 | [独立审计](evidence/collaboration-exact-commit-check.json)：候选 SHA、Host check、reviewedCommit 和接受提交一致；重新检验年龄边界和独立任务保留；原 checkout 干净，所有 Run 清理确认 |
| 真实浏览器 | [Edge 报告](evidence/collaboration-ui/report.json)：真实 Host/SQLite/HTTP/SSE/生产 React UI，受控 runtime；桌面与 390px 手机截图、任务跳转、205 条积压、跨 workspace、保留窗口外快照、刷新、降级均通过 |

真实模型使用临时 Git 仓库和实际开发/审查门禁。首个年龄任务明确要求 attempt 1 产生 `age >= 21` 的负例，正式验收始终要求 `age >= 18`。Host smoke 检查故意不覆盖 18–20，由真实审查者独立发现问题并返回 `changes_requested`；没有注入审查结论。Lead 在事件续办中执行 retry、派发；该历史运行按当时契约沿用原任务 thread，随后真实复审通过。当前权限契约改为跨 worktree 新 thread，此模型记录不能用来证明新契约的私有历史续接。

最终接受提交：`c3da7de30ca87b37c095fb43739b94298b5d18aa`。独立 label 先接受于 `3dde60dc0c88246d5a213758115a54d48f982fbc`，返工后仍保留。初次拒审候选为 `a6dac9f8b38c2507cf84eb19e5ce6c7da1620395`。这些是临时验收仓库的提交，不是项目实现提交。

## C-A01–C-A18 矩阵

| ID | 已执行证据与边界 |
| --- | --- |
| C-A01 | 默认新模式的真实 delegate；普通咨询浏览器 20 轮没有建立 Workflow |
| C-A02 | 受控 Run Promise 持续 pending 时 Lead 已完成且释放 lease；真实双任务首轮结束时两 Run 仍运行、输入框可用。验证生命周期独立，未实际保持单 Run 十分钟 |
| C-A03 | 两成员并行、B 先 A 后、sender/recipient/task/run 逐项核对；后继仅在两个前置 succeeded 且清理确认后开始；真实模型也完成并行双任务 |
| C-A04 | delegate 同键同输入/规范化顺序重试、同键冲突、消息插入失败整笔回滚 |
| C-A05 | 用户排队优先、合并乱序事件、冻结边界；已创建排队 Trigger 不因用户插队误判无后续动作 |
| C-A06 | Run 内汇报沿用同一 lease；忙碌接收者排队；任务补充只在下一输入边界消费 |
| C-A07 | 受控检查失败边界及真实 `changes_requested` → retry → repair → approve；不把开发完成当作接受 |
| C-A08 | 两个 acceptedCommit、候选检查与独立审查、所有 cleanup confirmed 后 Workflow completed；精确对象复核 |
| C-A09 | 实际断线、205 条积压及历史分页、其他 workspace 干扰、超过 10000 事件窗口的快照恢复、刷新无重复 |
| C-A10 | BEFORE INSERT 消息故障导致旧回执/公共消息/outbox ack 同事务回滚；重试恰好一条可见结果、既存任务不重复创建 |
| C-A11 | 原生已接收的成员消息恢复为 interrupted，保留 lease；C1 未知 Lead 执行和 cleanup 门禁回归仍执行 |
| C-A12 | C1 模型不结束、工具挂起、dispose 超时/迟到清理回归；活动页保留阶段诊断，聊天不展示阶段流水 |
| C-A13 | 停止/取消后的过期工具拒绝，终态事件不再次派发；C1 边界回归继续执行 |
| C-A14 | 跨 workspace、跨 task、伪造作者、失效 lease、yield 后消息拒绝；成员消息只作为协作来源 |
| C-A15 | 原生协议新工具闭包；同边界续接，cwd/roots/权限版本变化时新 thread 和 Host 证据恢复；聊天 receipts、迟到消息、成员/任务隔离 |
| C-A16 | 凭据任意 split 点、长 token、引号/转义/多行值、草稿终稿替换、失败/取消不记完成 receipts |
| C-A17 | 进展只投影；成员自动消息第 9 跳阻塞；成员请求不能重置 Lead 预算；有根因果链保留 |
| C-A18 | C1 CLI/聊天统一归属回归；显式关闭和旧 Workflow 无 owner 时保持兼容，不同时启动两套 Lead |

## 性能

Windows、Node 24.16.0、headless Edge、1280×900、真实本机 SQLite 和 HTTP/SSE。使用浏览器 MutationObserver 的实际 DOM 更新时间，排除 Playwright locator 重试轮询带来的观测延迟。每项 20 个样本：

- 数据库确认消息 → UI 可见：P95 **819ms**。
- 模型终止且清理确认 → UI 终稿：P95 **738ms**。
- 轮询降级单独测得 **1851ms**（1 样本，不应用健康 SSE 的 1 秒目标）。reload 后实际拦截 4 次 SSE 且记录 requestfailed，确认 messages 的约 1800ms 轮询响应。

上述指标排除外部模型生成、任务耗时和实际清理耗时，不承诺模型固定响应时间。保留 [初次 locator 计时报告](evidence/collaboration-ui/locator-timing-first-probe.json)；中间浏览器采样在并行负载下出现 1051ms，后续静态 Markdown memo、聊天页减少重复快照刷新后重新采样通过，未放宽阈值。最终仅忽略正文/阶段事件的重复工作区刷新，保留真实 Turn 生命周期事件；顶部人数也验证运行→空闲实时更新，不依赖 15 秒轮询。

## 检视修复与限制

本轮修复了空 inbox 输入缺少冻结标记、跨 Run 幂等键混用、成员自动消息重置预算、用户插队后的事件停滞、公共回执丢失阻塞原因，以及自然成员答复到任务 inbox 的投递边界。旧 schema 升级保留作者、reply-to、native receipts 与未知执行占用。

首次 Sol 真实探针在创建 Workflow 后遇到服务端容量不足，所有清理确认且未启动 Task Run；[失败记录](evidence/collaboration-real-capacity-failure.json)单独保存，不计成功。没有放宽沙箱或绕过业务门禁。

真实模型正常路径在最后因果链定位与自然答复 inbox 边界修复前运行；这些最终边界由针对性独立回归和最终全量测试验证，不虚称重跑了全部外部模型。协议探针使用受控 Responses，不代替真实模型质量验收。浏览器使用受控 runtime，隔离传输与 UI 延迟。

Run 动态工具已支持 Codex 和本地可续接 DSH；其他不支持该扩展的外部 Provider 保持 Host 系统结果投影。不会向当前原生 turn 注入未确认支持的实时 steering，不迁移其他成员的完整私有历史。新增工具声明改变配置指纹时，升级后的第一次执行可以新建 thread；所需公共消息与任务证据按现有边界初始化。

## 复验

```powershell
pnpm typecheck
pnpm test --reporter=json --outputFile=docs/evidence/collaboration-tests.json
pnpm build
pnpm exec tsx scripts/collaboration-native-probe.ts
pnpm exec tsx scripts/collaboration-browser-probe.ts
# 以下明确调用真实外部模型，并在临时 Git 仓库运行：
$env:RIFT_COLLABORATION_PROBE_REPORT='docs/evidence/collaboration-real-astra-probe.json'
pnpm exec tsx scripts/collaboration-real-probe.ts --real
pnpm exec tsx scripts/collaboration-evidence-audit.ts
```

浏览器脚本可通过 `RIFT_PLAYWRIGHT_MODULE` 指向可用的 Playwright 安装。重启 Host 后新建聊天工作流默认使用新模式；升级、备份、兼容开关与恢复方式见 [使用指南](ui-guide.md)。

2026-10-26 现场工作流后续暴露并修复了开发提交协议、分析作用域工具注册、成员讨论连接、glob 路径范围及已收集提交的无改动恢复问题。最终全量 304 通过、1 平台跳过，实际阻塞工作流已通过精确候选检查与独立审查并 completed，详见 [恢复记录](blocked-workflow-recovery.md) 与 [终验](evidence/blocked-recovery-exact-candidate.json)。
