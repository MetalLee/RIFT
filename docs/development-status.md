# P0–P3 开发交付记录

日期：2026-10-25。版本：**0.1.0**。**P0–P3 的 MVP 验收通过**。三个子 agent 按用户要求使用 Astra、高思考强度：两个负责实现，一个独立检视和验收；主 agent 负责业务入口、真实 Lead 编排、集成和整体调度。

最终自动检查：**15 个测试文件、72/72 通过，0 failed / 0 pending**；TypeScript strict 类型检查和构建通过。最终完整真实运行于香港时间 14:59:13–15:02:42 完成，使用 DeepSeek Lead、两个 Opus 5.5 Developer 和 Astra Reviewer，退出码 0。独立验收另核对实际 SQLite、18 份输入/结果产物哈希、4 组候选与审查 checkout、提交祖先链和最终文件内容。

[最终检查汇总](evidence/final-validation.json)记录冻结安装、peer、类型、构建、72 项测试及零模型 smoke，且最终真实流程所记录的实现文件哈希与当前文件一致。[最终 profile smoke](evidence/final-profile-smoke.json)确认 0.1.0、Lead 通道已注册、API 与卸载释放锁；[最终工具 smoke](evidence/final-lead-tools-smoke.json)确认作用域和身份隔离。

## 阶段结论

| 阶段 | Gate | 主要证据 |
| --- | --- | --- |
| P0 | pass | 指定 Codex 双模型与 Opus 5.5、真实 LLM Lead 工具编排、两个开发与精确候选审查同时在途、官方取消隔离及生命周期 |
| P1 | pass | 持久状态、事务配额、幂等、角色隔离、工具权限、排队、迟到结果与清理失败回归 |
| P2 | pass | 四任务真实 Lead 闭环；真实拒审后新上下文修复；最新目标提交上的精确检查、审查和集成；真实冲突隔离 |
| P3 | pass | 四个真实 OS 崩溃窗口、原生在途 Host 强杀、实际 API 暂停/全取消、恢复不重放、安全归档及文档 |

## 分项交付

| 任务 ID | 状态 | 实现与验证 |
| --- | --- | --- |
| P0.1–P0.2 | done | 锁定官方运行组合，公开服务加载、live Agent、工具注册、API 与卸载通过 |
| P0.3 | done | gpt-6.1-sol、gpt-6-astra 均完成官方 Provider 的独立 worktree 标记；两个模型另有下述业务审查证据 |
| P0.4 | done | 标准 Claude Code 登录后，claude-opus-5-5 的 marker、业务开发、并行与取消通过 |
| P0.5 | done | 真实 DeepSeek 模型发起 28 次 RIFT 工具调用；提交计划、先派发后等待、读取乱序结果、主动返工并调用 finish |
| P0.6–P0.7 | done | 启动前中止、能力拒绝、正常 dispose/unload、单项及全流程取消、官方 subprocess 父/孙树清理；作用域与精确提交保护通过 |
| P0.8–P0.10 | done | 官方 profile、管理 API/CLI、兼容结论和失败历史已交付 |
| P0.11 | done | 同一 Claude 实例的两个开发与另一已完成任务的 Astra 候选审查真实交叠；单取消隔离由独立 Provider 探针验证 |
| P1.1–P1.4 | done | 单包 strict TypeScript、SQLite 迁移、Workspace/Role/ProviderBinding、不可变配置与输入/结果产物 |
| P1.5–P1.6 | done | 幂等状态、薄 activation bridge、live parent 身份和清理所有权；不增加另一套原生运行后端 |
| P1.7–P1.9 | done | 七个 RIFT 工具、受控本地 API、事务预留、两开发/一审查配额和持久队列 |
| P2.1–P2.3 | done | 独立中文空格 worktree、真实 source diff、双开发并行、第三请求排队、依赖接受后再启动 |
| P2.4–P2.5 | done | 固定功能检查与空白检查、独立审查目录；检查/审查/接受严格绑定 candidate SHA |
| P2.6 | done | Sol 真实拒审后新 Claude child 修复；返工输入包含实际 diff、旧报告和最新目标；旧现场保留 |
| P2.7 | done | 串行候选从最新 accepted HEAD 合入，CAS 发布，保留所有已接受成果；冲突不污染目标，独立任务继续 |
| P2.8–P2.9 | done | 多 ID/事件游标等待、后台队列、真实 Lead 收尾、CLI 与可追溯报告 |
| P3.1–P3.3 | done | OS 强杀覆盖派发/接受/结果清理/发布窗口；未知执行保额不重放，已发布 ref 只补记；SQLite lease 防并发恢复双 owner |
| P3.4 | done | 真实 API pause 保留第三请求；全流程取消两个真实 Claude，官方 end 均 aborted、清理 confirmed、槽位归零；失败与超时隔离另有故障测试 |
| P3.5–P3.6 | done | dirty/untracked/ignored/活动与越界拒绝归档；doctor、配置提前诊断、日志脱敏和大小限制 |
| P3.7–P3.8 | done | 已验证启动模板与复现命令，A01–A18 独立矩阵和真实/模拟边界已更新 |

## 本轮真实证据

- [完整 Lead / Astra 闭环](evidence/workflow-acceptance-probe.json)：29 次模型请求、28 次业务工具调用、9 次原生执行（5 次 Claude 开发、4 次 Astra 审查）。首个 Alpha 开发结果格式错误，被门禁拒绝；Lead 自主新建 attempt 修复。实际为 **8 个成功 Run、1 个失败 Run 后恢复，4 个任务全部接受**，不能照抄模型摘要中的“所有 Run 成功”。四个接受提交按 fast-b → queued-b → slow-a → dependent-d 形成连续链，最终四个功能值正确。默认分支与原工作目录未改变；测试仓库无 remote。
- [Sol 拒审、返工与冲突](evidence/review-rework-probe.json)：11 次原生执行，真实错误实现被拒，新 attempt 修复并接受；同基线最新 HEAD 保留成果，真实冲突后独立任务继续。此探针由程序驱动业务 API，不冒充 LLM Lead。
- [OS 崩溃窗口及 subprocess](evidence/recovery-acceptance.json)：真实 Host 进程、SQLite、Git；activation 使用明确标注的受控实现。公开 DSH subprocess 的受控 Node 父/孙进程终止另有真实 PID 和文件稳定证据。
- [真实双 Claude 在途崩溃](evidence/recovery-native-acceptance.json)：只强杀探针 Host，已跟踪 Provider 进程身份消失；重启保留两个 interrupted/unknown 槽位，第三请求仍排队，零重放。
- [真实 API 暂停与全取消](evidence/recovery-native-controls.json)：两个 Claude 官方 end 为 aborted，排队项取消，清理确认且配额归零；已跟踪 Provider 进程退出。早期探针测量范围与控制文件权限失败保留，不计成功。

两个 Codex 模型的证据范围分别记录：Sol 有真实定向业务审查，Astra 有最终完整 LLM Lead 闭环；没有声称每个模型各自重跑了全部故障矩阵。

## 修复与保留边界

本轮修复并独立复检：并发双 Lead、Lead 取消异常跳过业务取消、迟到 source 覆盖已取消状态、最终空 diff 进入门禁、旧 Lead provider/model 默认映射错误。另补齐崩溃后 finalization 阻塞、清理超时保留占用、SQLite 排他 lease 与不可变输入产物。完整发现见 [检视记录](review-findings.md)。

Lead 当前默认 deepseek-official/deepseek-flash；缺少注册通道会提前返回明确错误。Claude 默认 Opus 5.5；Codex 默认 Sol，可显式切换 Astra。模型和权限由官方 Provider 实例配置，没有静默模型回退。

acceptEdits / never 不构成文件系统只读沙箱。独立候选与审查 checkout、精确 SHA、实际文件修改检测和固定检查共同决定接受；不声称完整原生工具轨迹已获得。默认 profile 的 git diff --check 只检查空白，实际项目须配置自身构建/测试。

崩溃后即使探针观察到原生进程退出，生产恢复仍保守保留 unknown 占用，不恢复旧 handle、不自动重放，也不提供无证据强制释放。候选/审查现场默认保留。更多 Developer、多工作区并发和长期原生会话属于后续 E1/E2，不在本次 MVP 范围。

历史证据保持独立：[旧 Lead 通道失败](evidence/workflow-lead-provider-failure.json)、[含人工修正探针开关的首次业务运行](evidence/workflow-acceptance-assisted-history.json)。最终完整通过以 workflow-acceptance-probe.json 的无人工业务干预运行及独立核验为准。
