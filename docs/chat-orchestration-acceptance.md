# 对话协作第一阶段验收

本文保留 C1 当时的默认关闭与待办范围。当前 C2–C4 已交付且默认开启，最新结果见 [C2–C4 验收](collaboration-acceptance.md)。

日期：2026-10-26。范围：[开发方案](chat-orchestration-development-plan.md)的 C1.1–C1.4。两名 Astra high 子 agent 分别实现协调队列与活动/UI，一名 Astra high 子 agent 独立检视和功能验收，主 agent 负责整合、协议/真实运行验证和文档。

## 验证边界

本轮交付第一阶段最小单元。成员主动消息、原子 delegate、完整 inbox、完整故障矩阵和安全正文流仍由 C2–C4 承接。系统事件回执与模型作者分开，事件触发无需创建用户气泡。

受控 runtime 测试使用真实 SQLite 验证调度、活动、清理与事件恢复；原生协议探针使用固定 Codex 0.164.0 二进制和本地受控 Responses；真实模型探针使用独立临时 Git 仓库、正式开发/审查 Run 与实际功能检查。浏览器截图使用确定性 API fixture，不作为真实 Host 的端到端延迟证据。

## 执行命令

```powershell
pnpm typecheck
pnpm test --reporter=json --outputFile=docs/evidence/chat-orchestration-tests.json
pnpm build
$env:RIFT_NATIVE_SESSION_PROBE_REPORT='docs/evidence/chat-orchestration-native-session-probe.json'
pnpm exec tsx scripts/native-session-probe.ts
$env:RIFT_CHAT_ORCHESTRATION_PROBE_REPORT='docs/evidence/chat-orchestration-real-final-probe.json'
pnpm exec tsx scripts/chat-orchestration-probe.ts --real
```

浏览器检查：先启动 `pnpm dev:ui`，配置可解析的 `RIFT_PLAYWRIGHT_MODULE` 后执行 `node scripts/chat-orchestration-visual-check.mjs`。`RIFT_UI_URL` 可覆盖默认本机 Vite 地址。

## 证据记录

最终全量：**43 文件、243 项，242 passed / 0 failed / 1 skipped**。跳过项为仅适用于非 Windows 的进程组清理测试；不是本轮协作功能跳过。Root/UI typecheck、生产 build 和 `git diff --check` 通过。构建仍有前端 chunk 大于 500 kB 的已有提示。

独立检视 [12/12](evidence/chat-orchestration-independent-review.json) 与实现专项 [6/6](evidence/chat-orchestration-implementation-tests.json) 已计入全量测试，不能再相加。最后的全局事件跨页及恢复解锁修复使用受控回归复验，真实正常路径闭环在该两项边界修复前完成；两个证据范围分开记录。

| 层次 | 结果与证据 |
| --- | --- |
| 受控运行/真实 SQLite | [自动测试报告](evidence/chat-orchestration-tests.json)；独立测试覆盖首轮结束后后台继续、事件自动完成、未知执行不重放、CLI 唤醒串行、迁移引用完整性、跨工作区/过期授权拒绝、回执去重与脱敏 |
| 原生协议 | [五进程 session 探针](evidence/chat-orchestration-native-session-probe.json)：聊天续接、历史恢复、动态工具新闭包、任务返工 cwd 和独立审查全部通过 |
| 真实模型代码闭环 | [最终运行](evidence/chat-orchestration-real-final-probe.json)：首轮结束时开发仍运行；真实开发、Host 检查、独立审查、接受提交及 Lead 自动收尾通过，无 `rift_wait`、无伪造用户气泡，Lead 续用同一原生 thread |
| 接受提交独立复核 | [精确提交检查](evidence/chat-orchestration-exact-commit-check.json)：候选、审查和 acceptedCommit 均为 `6fecb4da19007d4134aec4eb6f5ee12cde52d290`；重新执行 `node --test test.mjs` 通过，只改变 `feature.mjs`，测试文件和原仓库保持不变，所有 Run 清理确认 |
| Edge 浏览器 | [截图与检查](evidence/chat-orchestration-ui/report.json)：1280/390 宽度回执可见、运行中输入可用、无伪造用户气泡、无横向溢出；按用户要求移除消息下方阶段时间/最后进展，保留清理提示 |

真实运行的失败历史保留在下节。当前没有外部模型的拒审返工成功证据，不把最终单任务通过等同于完整 C-A01–C-A18。

## 独立检视修复

- 取消并确认清理后，迟到工具回调不得把终态阶段回退到清理中；由独立验收覆盖。
- 结果早于 Lead 首轮结束时，待处理事件必须在同一协调归属中继续处理；不启动另一套后台 Lead。
- 全局 `task_events` 超过一页时，其他工作区的积压不能掩盖本工作流尚未扫描的唤醒事件；新增 110 条无关事件后的关键事件回归。
- 业务条件不足导致的自动协调暂停，仅由晚于阻塞记录的真实恢复事实重新唤醒；Lead 清理未知、失败/取消、预算和 Workflow 暂停仍保留各自门禁。
- 新的工具活动包装保持既有失效授权错误码 `UNAUTHORIZED`，不改变安全拒绝契约。
- 事件轮次的回复没有用户 reply-to；后续上下文仍按冻结的消息边界读取，不能漏掉这类已完成回复。
- 审查输入补充绑定候选 SHA 的真实 Host 检查证据，明确审查先于发布与最终清理，避免模型因缺少检查结果而错误要求先接受后审查。

首次真实探针额外要求开发沙箱自行提交 Git，触发 `index.lock` 权限拒绝与 `node --test` 子进程 `EPERM`；自动续办如实报告阻塞，见[首次阻塞记录](evidence/chat-orchestration-real-probe.json)。正式实现原本由 Host 的 `collectSource` 收集并提交 diff，因此修正探针为开发只编辑，Host 负责检查/提交。第二次运行开发和 Host 检查完成，但审查模型只收到检查 ID 并要求最终接受证据，见[审查证据缺口记录](evidence/chat-orchestration-real-code-probe.json)。两次记录均保留为失败历史，不计完整代码验收通过；未放宽原生沙箱或跳过审查。

## 未验证与后续

不把浏览器 fixture、受控 runtime 或旧版本的真实运行报告等同于本次全部 C-A01–C-A18 通过。P95 ≤ 1 秒需要独立采样，未采样前不宣称达到。外部模型耗时与运行时清理耗时不计入该传输指标。
