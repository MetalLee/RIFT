# RIFT UI 验收报告

日期：2026-10-25。范围为 [UI 开发计划](ui-gap-analysis-and-plan.md) U0–U8、S1–S8，以及 X1–X5。两个 Astra 高思考强度子 agent 实现、一个 Astra 高思考强度子 agent 独立检视和功能验收，主 agent 集成并执行真实模型与浏览器检查。历史 E1 的延期记录不追溯改写。

**结论：U0–U8 完成，31 个测试文件、176/176 项通过，0 failed / 0 pending。** Root/UI 类型检查、生产构建、冻结安装、peer 与差异空白检查通过；独立检视无未解决 P0–P2。最终检查和实现摘要见 [ui-final-validation.json](evidence/ui-final-validation.json)。

## 验证层次

| 层次 | 证据 | 范围 |
| --- | --- | --- |
| 自动回归 | [ui-automated-tests.json](evidence/ui-automated-tests.json) | 本轮完整 Vitest 输出；最终计数另汇总在 ui-final-validation.json |
| 独立检视 | [ui-independent-review.json](evidence/ui-independent-review.json) | HTTP、SQLite、真实 Git、受控 runtime 故障；不冒充模型自主执行 |
| 原生工具边界 | [u0-native-tools-probe.json](evidence/u0-native-tools-probe.json) | 真 Codex app-server + 本机受控 Responses，零外网模型调用 |
| 原生主 Agent | [u0-native-workflow-probe.json](evidence/u0-native-workflow-probe.json) | 真 gpt-6.1-sol Lead、真 codex-dev 子执行、规划/派发/等待/状态/完成 |
| DSH/API 主 Agent | [ui-dsh-workflow-probe.json](evidence/ui-dsh-workflow-probe.json) | 真 DeepSeek API Lead 与原生子执行，整个工作流完成 |
| 新 API 连接 | [ui-api-connection-probe.json](evidence/ui-api-connection-probe.json) | 官方 DSH pi-ai + 真 DeepSeek Chat Completions；保存、验证与不可变版本身份 |
| 跨仓代码闭环 | [ui-code-workflow-probe.json](evidence/ui-code-workflow-probe.json) | 真原生 Lead、Astra Developer/Reviewer、两个仓库、功能测试、精确接受 |
| 浏览器 | [ui-browser-acceptance.json](evidence/ui-browser-acceptance.json) | 真实 Edge 表单与操作；实际 SQLite 记录佐证 |
| 最终构建 | [ui-built-browser-smoke.json](evidence/ui-built-browser-smoke.json) | 全新 home 迁移、生产 UI、真实 DSH 回复、清理确认及 Agent 空闲状态 |

## S1–S8

| 场景 | 验收结果与依据 |
| --- | --- |
| S1 工作区 | 无仓库创建、已有仓库兼容；切换后草稿/接收者/消息隔离，刷新恢复。真浏览器创建并切换两个工作区。 |
| S2 主连接 | DSH 与受限 Native 两条路径都有真实自主工作流完成。新 API 保存不等于已认证，显式验证成功后才显示通过。 |
| S3 自定义成员 | 真浏览器新增“中文分析员”，Codex 模型明确选择，@ 回复由指定成员产生；稳定身份、CAS、停用占用保护由独立测试覆盖。 |
| S4 Skill | 真浏览器预览、不可变导入、共享分配、有效集合；原生回复出现 `【共享技能已生效】`。旧版本快照和 Run prompt 注入另有独立受控验证。 |
| S5 聊天 | 实际 DSH 默认发送与 Native 定向发送、Ctrl+Enter、Enter 换行、停止。队列、幂等、历史固定边界、摘要来源、contextRefs 跨空间拒绝由自动检查覆盖。 |
| S6 仓库/目录 | 真浏览器关联 alpha/beta 并创建受管分支；独立真实 Git 测试覆盖多仓、外部关联/接管/解除、脏/ignored/占用/越界拒绝。 |
| S7 任务闭环 | 两个真实代码任务依次完成开发、Node 功能测试、独立审查与每仓集成；任务均 succeeded，两个精确 acceptedCommit，四个 Run 均 cleanup confirmed。独立测试另覆盖拒审返工、跨仓依赖和 replan 新任务。 |
| S8 活动 | Turn/Run/排队/unknown/disabled 可追溯；停止真实 Native 回复后 cancelled 且 cleanup confirmed。新对话完成后根据持久租约显示空闲；旧式 Lead 无生命周期事实时保留未知。 |

跨仓真实验收只修改临时仓库的 `feature.mjs`，alpha 最终导出 11、beta 最终导出 22；每个仓库的 `test.mjs` 预先定义期望值并保持不变。检查使用 `node --test test.mjs` 与 Git diff 检查，审查绑定具体候选提交。无远程仓库或推送。

## 隔离与故障

| ID | 覆盖 |
| --- | --- |
| X1 | URL、工具和数据库实体归属校验；伪造原生 thread/turn、未知工具、继承委派、跨 workspace Agent/仓库/消息/事件被拒绝。 |
| X2 | 重启不重放在途副作用；Run/Turn 共用租约；延迟 startup、超时、dispose 未确认继续保留；迟到清理收据或同机 OS 重启证明才允许恢复。候选发布按真实 Git 证据核对。 |
| X3 | 事务事件/快照游标、重放、过期游标重新快照；UI 实体版本和 snapshotCursor 防旧请求覆盖；断线保留草稿和历史。 |
| X4 | 启动码过期/一次性、Host/Origin/CSRF/Fetch Metadata、跨端口拒绝、会话失效、SSE 作用域、静态路径/junction 边界；旧 Bearer API 的 Origin 拒绝仍通过。 |
| X5 | 浏览器实测 320/390/768/1440 像素、中文内容、Ctrl+Enter 与 Enter、长路径换行；输入法 isComposing/keyCode 229 防误发、焦点与草稿逻辑由 UI 自动测试及源码检查补充。 |

浏览器的实际 CSS 宽度为 320/390/768 时，document scrollWidth 分别为 305/375/753（15px 为垂直滚动条），未出现页面横向溢出。未把事件逻辑测试描述为自动化的 OS 输入法组合会话，也未声称完成正式可访问性认证。

## 检视中修复的问题

- 原生模型目录覆盖功能开关，最初仍暴露委派/代码工具；改成固定、摘要校验的受限目录后重新验证，并通过真实业务闭环。旧 gpt-5.4 候选因账号不支持而退出可选名单。
- Run 与聊天各自计数可绕过全局容量；改为共享租约，旧 unknown Run 迁移仍占用。
- 启动迟到、runtime 不响应取消、分片密钥、毒化队列、活动讨论归档、过期 SSE 重连循环、旧请求回退快照均有定向修复和回归。
- API verify 与 Host close 的生命周期竞态、追加连接撤销旧 route、非标准凭据变量泄漏已修复，独立检查确认旧 provider 在拓扑事件期间持续可用。
- 多仓库归档上下文、仓库页面串展示、历史 Turn 完成状态、移动/候选状态未知的恢复门禁、写接口返回内部对象等问题由独立检视发现并逐项回归。
- worktree 接管预检期间解除关联和重复归档的并发竞态已通过真实 Git 回归。旧故障测试按迟到 owned dispose 收据的恢复契约增强：收据前保留租约/writer，收据后释放，但任务仍 blocked、没有自动重跑；全量重跑通过。

## 明确边界

- 对话输出完成后整体脱敏；没有伪造逐字输出。SSE 用于真实状态和持久事件。
- 当前纯指令 Skill 已验证。资源/脚本型版本导入成功后仍须通过运行时兼容检查；当前适配器明确拒绝，不静默忽略资源。
- 原生对话仅开放 Codex 0.164.0 / gpt-6.1-sol 的已验证组合。开发/审查 Provider 模型声明与对话白名单分开。
- API 协议能力来自官方适配器，外网验收覆盖 DeepSeek Chat Completions。任意自定义服务仍需显式验证。
- 丢失原生 handle 后，单凭 Host 重启或人工确认不能释放未知进程。无法得到清理或同机重启证明时保持阻塞。
- UI 开关不回滚数据库。升级前停止 Host、备份完整 home；旧二进制回退需要完整旧备份。

## 浏览器截图

| 画面 | 截图 |
| --- | --- |
| 真实对话和共享 Skill 回复 | [1440px](evidence/ui-screenshots/chat-1440.png) |
| 窄屏聊天 | [320px](evidence/ui-screenshots/chat-320.png) |
| Skill 版本/分配 | [1440px](evidence/ui-screenshots/skills-1440.png) |
| 双仓库与长路径 | [390px](evidence/ui-screenshots/repositories-390.png) |
| API 连接设置 | [768px](evidence/ui-screenshots/settings-768.png) |
| 最终构建的空闲状态和零占用 | [1440px](evidence/ui-screenshots/activity-final-1440.png) |

完整启动、配置、恢复和备份操作见 [UI 使用指南](ui-guide.md)。
