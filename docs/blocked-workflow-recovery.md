# 聊天工作流阻塞恢复记录（2026-10-26）

目标工作流：`workflow-3b359d55-f771-41ce-b71a-7403ad2bd704`，任务为新建 workspace 默认一个 Lead、一个 Developer、一个 Reviewer。

## 原因与修复

- 开发任务要求模型自行 `git add/commit`，与外置 Git 元数据的沙箱边界冲突；并将“独立审查完成”误作开发 Run 返回的前提。开发协议现明确：实现完成后如实返回验证情况，Host 在清理确认后收集、提交、检查及审查。实际行为失败仍需报告，不把不可用检查说成通过。
- 重试创建新工作树，不自动复制旧尝试的未提交文件。新输入包含已清理的旧尝试只读路径和 retry 原因；开发者必须显式恢复需要的文件，在当前 cwd 验证。保留旧 blocked 结果和原现场。
- 分析 Workflow 把子作用域动态注册的 `rift_send_message` 放进只接受继承工具名称的 `tools.restrict` 白名单，导致 `START_NOT_PUBLISHED`。继承工具限制改为空，各子作用域注册自身工具；新增限定本 Run 工作树的只读读取/目录工具，保持身份、租约、取消和路径边界校验。
- 成员只有执行连接时，讨论投递错误地要求另配连接。讨论现优先使用显式连接，缺省时复用合法执行连接；无效显式连接不会静默降级。明确重投仅允许证明从未启动的失败消息，复用消息/inbox，不重播已执行或未知结果。
- `expectedPaths: ["**/*"]` 原被当作字符串前缀，后续 Host 收集会错误拒绝文件。路径检查现兼容 glob，保留绝对路径、越界及窄范围保护。
- 已收集 source 的无改动重试原被误判为 `EMPTY_CHANGE`。只有同任务真实 `source.collected` 事件证明的 source、当前 HEAD/attempt base 与该 source 一致，且相对原收集基线存在非空、范围合法的实际 diff 时，才可复用；不创建空提交。原始基线从 Host 账本推导，不取模型声明或整个 Workflow 的基线，避免把其他任务的已接受改动算进本任务范围。
- 新增管理入口 `POST /v1/tasks/:id/recover-source {expectedVersion}`。用于 Host 收集基础设施失败后的显式恢复：当前开发 Run 必须真实 completed、租约及清理确认、没有 writer/在途操作，重新验证后进入正常候选流程；保留 attempt、Run 与历史错误，不放宽修复预算，不允许从 blocked 模型结果或拒审结果直接恢复。并发版本变化拒绝发布恢复结果。
- 普通成员讨论明确返回自然语言，角色中的 Task Run `resultSchema/JSON` 契约不再误用于聊天，不虚构 `runId`。

## 验证

- [最终全量回归](evidence/blocked-recovery-final-tests.json)：305 项，304 通过，1 项既有 Windows 平台跳过。首次测试误扫描恢复备份的测试文件，后备份移出仓库，最终使用正常 `pnpm test` 通过。新增独立测试初次缺少 repository fixture 的两项失败修正测试数据后复验通过，未据此放宽生产门禁。
- [Host Git 与恢复专项](evidence/blocked-recovery-host-tests.json)：8/8。
- [独立检视](evidence/blocked-workflow-recovery-independent-review.json)：14/14，包含真实 DSH ToolRuntime 注册器及清理未知权限验证。
- [已收集源提交复用的真实 Git 回归](evidence/blocked-recovery-source-reuse-tests.json)：6/6；先接受其他任务，再验证本任务的无改动重试仍经过新检查和审查。
- [恢复路径独立正反例](evidence/source-recovery-independent-review.json)：21/21，覆盖来源、HEAD、祖先、范围、Run 结果、清理、租约、writer、拒审和取消/CAS 并发。
- typecheck 与生产 build 通过。
- [原草稿标准测试](evidence/blocked-task-original-draft-tests.json)：55/55，仅是恢复前参考，不代替正式候选证据。

## 现场恢复

Host 在确认无活跃租约后重启，使用正常管理 API 唤醒 Lead、恢复 Workflow 和 retry；没有手工改写业务数据库状态或伪造 Run 结果。

原尝试 11 个文件的备份位于 `D:/RiftUI-recovery-preserved-20261026`，SHA-256 清单位于 `.runtime-evidence/blocked-recovery-20261026/manifest.json`；一致 SQLite 备份为 `D:/RiftUI-backup-20261026-recovery.db`。另保留原有完整 home 备份 `D:/RiftUI-backup-20261026-164427.tar`。新完整 tar 因耗时中止，已改名 `.tar.partial`，不将该未完成文件算作有效备份。

开发 attempt 2 在新工作树只读恢复 11 个文件，全部与旧草稿 SHA-256 一致，返回真实 completed；Host 收集为 `a22f4bffbf967d2fcc024b49125ae9719c5b0c09`。旧 attempt 1 的 blocked 结果及未提交文件未被改写。

临时恢复 profile 增加精确候选类型检查及 55 项标准测试。首个候选的检查全部通过，但临时检查脚本留下 ignored 依赖目录，触发严格清洁检查并阻止发布。脚本已补齐自身依赖链接/测试输出清理；在该候选重新执行后 55/55、类型检查通过，含 ignored 的 Git 状态为空。没有放宽清洁门禁，后续重新走正常 retry、候选检查和独立审查。

最新失败消息 `message-7b218c37-453d-4d05-a078-dd8eaccbdff5` 经显式安全重投已 consumed，未新增重复消息。其他历史失败记录保留。

[真实分析证据](evidence/blocked-recovery-analysis.json)证明 analysis attempt 2 两个条目完成，基线为 `3e51134a77147c78f431a1805798cfd09636dded`，只读检查、工具与文件哈希可核验，清理确认且租约释放；该结果不冒充实现候选审查。两轮过时讨论无输出且占用成员时，经正常停止接口取消并确认清理后恢复调度。

attempt 3 基于已有 source 返回真实 completed，但旧 Host 的 `EMPTY_CHANGE` 路径再次阻塞收集。上述新恢复入口专门处理这种已完成开发、仅 Host 收集未完成的场景；不得伪造新的开发 diff 或增加预算。

新 Host 通过恢复入口重新验证 source，保持 attempt 3 与 Run `run-61b23b7a-189a-453c-ba3f-2046f7508a09` 不变，生成新候选 `6639bc3123f524044ed49d14139ae86c4d54a7f6`。正式 diff-check、类型检查及 55 项标准测试全部通过且候选保持清洁。独立审查 Run `run-c8119ff0-e1df-41e5-977e-bc75c8b7a88f` 对同一提交 `approve`、无 findings，清理确认后 Host 发布接受。

## 最终结果

Workflow 已 `completed`，两个任务均 `succeeded`。代码任务接受提交及真实 Git 集成分支均为 `6639bc3123f524044ed49d14139ae86c4d54a7f6`。见 [精确候选终验](evidence/blocked-recovery-exact-candidate.json)，其中 `acceptanceVerified`、`workflowCompletionVerified` 均为 true；所有执行租约已释放，旧 11 个文件哈希完整保留。

完成后备份为 `D:/RiftUI-backup-20261026-completed.db`。确认没有活动执行后恢复 `profiles/rift.codex.patch.yml` 常规启动配置，避免本次仅适用于 RIFT 仓库的临时测试脚本影响后续其他仓库；修复代码及默认新模式继续生效。数据库完整性为 `ok`，外键错误为 0。集成结果保留在工作流分支，未覆盖用户当前主检出的未提交改动。

真实浏览器验收证明消息已消费、作者/接收者正确、失败原因与系统进展折叠、任务 tag 跳转正确。Host 重启后重新建立合法浏览器会话并整页刷新；仅 hash 导航会保留旧 JS，不能当作新构建验收。另记录低高度视口（642×330）的输入框遮挡历史控件问题，未将其计为本轮阻塞恢复的修复结果。

## 后续仓库权限调整（2026-10-26）

按用户后续要求，主 agent 与开发子 agent 现在可在 Host 关联的 workspace 仓库及自己的任务工作树直接执行 Git 提交，并具备使用已登录 `gh` 创建 PR 的执行入口。本文早期恢复过程中的“仅 Host 提交”是当时策略，已由新策略替代；Host 仍验证真实 source、收集剩余未提交改动并执行候选检查与独立审查。参见 [workspace 仓库权限](workspace-repository-permissions.md)。

本轮用户选择先提交当前 `main` 的全部改动，GitHub 登录稍后进行，因此不推送、不创建远端 PR。恢复工作流的 `6639bc3` 仍保留在其集成分支，不能把本轮本地主分支提交描述为已经合并该候选。

## Stage recovery API (2026-10-29)

This section describes current recovery entry points; the earlier incident records above are historical evidence, not proof for a new candidate.
No new UI, model fallback, or generic workflow engine is introduced.

| Failure | Explicit action | Preserved facts / remaining gates |
| --- | --- | --- |
| Successful developer Run, source collection failed | `task recover-source {expectedVersion}` or `task recover` below | Same Run, attempt and checkout; Host revalidates ownership, safe paths and real diff, then queues normal candidate checks/review. Already committed deletions/renames are not passed to `git add`; only index-relative unstaged paths and ordinary untracked files need staging. Returned `changedPaths` describes the final committed diff. |
| `INVALID_RESULT` caused by prose around one valid developer result | `task supplement-result`, then reload task version and `task recover` | No provider, shell, Git or other code executes during supplementation. Original failed Run/result/artifact remain immutable. Source is collected only after an original `completed` outcome is verified. |
| Missing/unavailable Host check evidence | `task recover` routes to existing `supplement-evidence` | Exact stored candidate and Host-configured checks only; no uploaded logs/model claims. The existing candidate binding, environment/configuration and cleanup checks remain mandatory. |
| Provider/transport failure during independent review, or explicitly blocked review | `task recover` routes to existing integration retry | Same source and development attempt. Candidate preparation/checks may run again against the current target; an exact new independent approval is required. Old approval is never carried forward. `changes_requested` is not an infrastructure retry. |
| Provider stops/errors/Host interruption before a valid completed developer result | `task recover` returns `CONTINUATION_REQUIRED` | Incomplete output cannot establish completion, even if it contains a valid JSON object. After cleanup proof, use explicit `task retry {expectedVersion,reason}` and dispatch, with a continuation reason instructing read-only inspection/reapplication of preserved attempt edits into the new cwd. Existing retry prompts include prior results/checkout paths. No automatic provider/model change or blind replay of the interrupted command. |
| Real required check failure or substantive review rejection | Explicit code repair with `task retry`, then dispatch | New development attempt and all ordinary source/check/review gates. `task recover` rejects known check defects with `CODE_REPAIR_REQUIRED`. |
| Unknown Run/check cleanup or publication | Existing `run reconcile` / `integration reconcile`, with current versions and actual owned cleanup/reboot/publication proof | Restarting only the Host is not cleanup proof. Recovery refuses uncertain leases, writers, unfinished finalization, cancelled tasks/workflows and stale versions. |

### Result-only supplementation

`POST /v1/tasks/:id/supplement-result` and `rift ws task supplement-result ID --workspace WS --file supplement.json --key supplement-1` accept:

```json
{"runId":"original-run","expectedVersion":7,"outputSha256":"<64 lowercase hex characters>","resultText":"<the unchanged bare JSON result from the original output>"}
```

Read the original Run via `task show` / `run show` (HTTP `GET /v1/runs/:id`): hash the UTF-8 string **`run.result.output`**, not the entire Run, file, JSON string encoding, or provider session log. This is the Host's persisted, sanitized output. For example, in Node: `createHash('sha256').update(run.result.output).digest('hex')`.

The current Run must have failed with `INVALID_RESULT` after a successful provider stop and have confirmed Run **and owned lease** cleanup. The strict schema/task/run identity checks are unchanged. `resultText` must parse as one bare JSON object and occur exactly once, unchanged, in the original output; text outside it may not contain object/array delimiters. This deliberately conservative rule handles prose/Markdown wrappers, not arbitrary extraction, edited fields, merged objects, malformed JSON repair or ambiguous multi-result output. Incomplete/truncated output is refused. Legacy format-failure outputs are eligible only when the complete bounded original output is still present. A blocked business outcome remains blocked.

Success returns `{runId,result}` and appends `result.supplemented` with output hash and original worktree binding, increments task version once, and leaves the task blocked until explicit source recovery. Repeating the same supplement while still recoverable is a no-op; a different supplement conflicts. Historical `result_recorded`, `stopReason`, failure status and original result artifact are not rewritten. HTTP/agent CLI receipt replay also remains available with the same outer request key.

### Stage routing and replay

`POST /v1/tasks/:id/recover` and `rift ws task recover ID --workspace WS --data '{"expectedVersion":8,"idempotencyKey":"recovery-1"}' --key recovery-1` accept `{expectedVersion,idempotencyKey}`. Success returns `{stage:"source"|"checks"|"review",...existingStageResponse}`. The task must be blocked in a running/paused workflow. Paused workflows remain paused; explicit resume consumes queued integration work only after a live Lead is available.

The append-only task event ledger stores keyed recovery receipts. Same task/key/version replays the saved response/error without repeating Git, checks or activation. Changing the version with the same key is `IDEMPOTENCY_CONFLICT`. An interrupted pending receipt is `REQUEST_PENDING`: inspect the persisted stage, reconcile genuine cleanup if necessary, and explicitly choose a new request after inspection; it is never silently replayed. Use a new key/version after fixing a rejected operation's cause.

`RESULT_SUPPLEMENT_REQUIRED` directs format failures to the result-only path. Browser `retry-dispatch` refuses format/source infrastructure failures and interrupted developer executions instead of automatically launching development; explicit `task retry` remains available for a real code repair. Source recovery and result supplementation preserve all normal task/run identity, ownership, cancellation, precise candidate and independent review gates.

### Regression coverage

- `tests/git/integration.test.ts`: real Git committed/staged/unstaged/mixed deletion/rename/add collection, literal names, index-versus-working-tree differences and final changed-path accuracy.
- `tests/acceptance/source-recovery-api.test.ts`: HTTP/CLI result supplementation, provenance/hash/schema/ambiguity rejection, task/run/workspace/Lead authority, versioning/replay, cancellation and unknown cleanup, source recovery without rewriting Run facts.
- `tests/git/core-integration.test.ts`: real Git plus controlled provider; collection failure recovery for committed delete/rename, format-only recovery across restart with unchanged immutable artifact, exact checks/review, check-stage recovery, code defect separation and explicit provider continuation preserving old edits.
- `tests/core/coordinator.test.ts`: failed-review stage recovery, attempt preservation and keyed replay, alongside existing cleanup/cancellation regression.

These tests substitute provider activation; they do not claim real external supplier availability or replace Host candidate checks/independent review. Frontend check-profile changes are a separate task.
