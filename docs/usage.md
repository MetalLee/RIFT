# RIFT 使用说明

**原生会话更新（2026-10-26）：** Codex 聊天按对话＋成员持久续接，正式 Codex 任务按任务＋角色续接，返工保留原生记忆并更新 worktree。请重新构建并使用随源码更新的 profile。升级迁移 0009，备份还需保留对应 `CODEX_HOME` 的原生会话数据。配置、恢复边界和验证命令见 [原生会话说明](native-sessions.md)。

**当前 UI 交付（2026-10-25）：** U0–U8 已实现。浏览器启动、成员与 @、连接验证、Skill、多仓库及恢复操作见 [UI 使用指南](ui-guide.md)，验证范围见 [UI 验收](ui-acceptance.md)。同一 Host 构建后运行 `node dist/cli/main.js ui --home <同一 home>` 获取一次性入口。以下 E1/P0–P3 的测试数量和延期说明属于历史记录。

**E1 更新（2026-10-25）：** 多工作区、更多 Developer、自由角色、重规划和批量分析已接入。新功能配置与不加载 Claude 的启动命令见 [E1 指南](e1-guide.md)，验证边界见 [E1 验收](e1-acceptance.md)。下文 Claude 默认 profile 和 P0–P3 真实探针保留作历史兼容说明，本轮未执行 Claude。

版本为 `0.1.0`，P0–P3 的 MVP 范围验收与 72/72 自动测试已通过。最终真实 LLM Lead/Astra 流程无人干预地完成四任务、精确审查和串行集成；另有真实拒审返工、冲突、并行取消与崩溃恢复证据。已测模型组合及边界见 [POC 结果](poc-results.md)，不将不同范围的探针扩大为所有模型和权限组合的保证。

## 安装与检查

在项目目录使用 Node 24 与 pnpm 11.4.0：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node dist/cli/main.js --help
```

保留 `dist/`、`migrations/`、`profiles/` 和锁定的依赖。一个 `rift` 包，不需要另一个 daemon。所有业务状态保存在所选 home 的 `rift.db`；DSH 自己的 Session 仍由 DSH 管理。

## 启动

```powershell
node dist/cli/main.js serve --home D:\RiftHome --profile rift
```

首次创建隔离的 `D:\RiftHome\dsh` profile，以官方 `sdk-minimal` 为基础。`serve` 拥有本次 DSH Host，其他命令仅连接它。管理 HTTP 仅监听 `127.0.0.1`；token 文件位于 `D:\RiftHome\management.token`，CLI 自动读取，不要交给子 Agent 或提交到仓库。

默认 profile 是 `profiles/rift.patch.yml`，可用 `--patch <path>` 指定维护者配置。Lead 默认 **`deepseek-official/deepseek-flash`**，与实际 DSH 官方 Provider/模型目录一致；`RIFT_LEAD_MODEL` 可设置该 Provider 可用的模型，需要可用的 `DEEPSEEK_API_KEY`。旧的 `deepseek/deepseek-chat` 配置不再作为默认。目录查询不消耗推理，也不保证一次工作流成功：

```powershell
pnpm exec tsx scripts/lead-catalog-probe.ts
$env:RIFT_LEAD_MODEL = 'deepseek-flash'
```

Claude Provider 保留 `ANTHROPIC_API_KEY` 的显式环境引用，也支持经实际 Provider 验证的标准 Claude Code 登录。RIFT 不读取或复制 Claude Desktop 凭据，不改动全局配置，密钥不写入角色 JSON。

Developer A/B 共用的 `claude-code-dev` Provider 实例明确默认使用 **Opus 5.5，`claude-opus-5-5`**，精确名称见 [Claude 官方模型配置说明](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)。`RIFT_CLAUDE_MODEL` 未设置时使用此默认值，也可显式设置为同一名称；空值或其他模型名称会拒绝加载配置，不静默替换模型。权限保持 `acceptEdits`。

```powershell
$env:RIFT_CLAUDE_MODEL = 'claude-opus-5-5'
node dist/cli/main.js serve --home D:\RiftHome --profile rift
```

更改 Claude 模型配置后，先让在途 Run 结束并确认清理，停止原来的 `serve`，再重启服务。模型固定在 Provider 实例上，后续 activation 使用该配置；不能用单个任务的 `agentOptions` 覆盖。Claude Desktop 已启动、Provider 已注册或环境变量存在，都不代表该执行实例已经认证或能够访问目标模型。`doctor` 将环境变量存在情况单独列为配置事实，认证标为 `not-verified`，不调用模型；真实执行和并行验证结果以 [POC 结果](poc-results.md) 为准。

项目锁定 Claude Agent SDK `0.3.310`（内置 Claude Code `2.1.310`）以支持 Opus 5.5，务必使用上面的 pnpm 冻结安装命令。完成标准 Claude Code 登录或配置明确的 API key 环境引用后，可重复验证：

```powershell
pnpm poc --claude
pnpm exec tsx scripts/provider-parallel-probe.ts --run
```

第一条真实验证 Opus 5.5 独立 worktree 文件任务及正常清理；第二条会调用两个 Opus 5.5 和一个 Codex，验证三任务交叠、只取消其中一个 Claude 后其余完成。并行脚本不带 `--run` 时不调用模型。两种探针已于 2026-10-25 通过；它们本身不验证业务 Lead、候选审查或故障恢复。后续真实业务返工已由专门脚本验证，复现方式见下文。报告与保留的临时 worktree 位于 `.runtime-evidence/`。

Codex Reviewer 的 `codex-review` Provider 实例明确默认使用 **`gpt-6.1-sol`**，可通过 `RIFT_CODEX_MODEL` 改为 **`gpt-6-astra`**：

| `RIFT_CODEX_MODEL` | 实例使用的模型 |
| --- | --- |
| 未设置 | `gpt-6.1-sol` |
| `gpt-6.1-sol` | `gpt-6.1-sol` |
| `gpt-6-astra` | `gpt-6-astra` |
| 空值或其他名称 | 拒绝加载配置并报告错误 |

例如，先让在途 Run 结束并确认清理，停止原来的 `serve`，再设置模型并重启：

```powershell
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
node dist/cli/main.js serve --home D:\RiftHome --profile rift
```

切回时把变量设为 `gpt-6.1-sol`，同样需要重启服务。模型是在 profile 加载时固定到官方 Codex Provider 实例、用于该实例后续 activation 的配置；`rift_task_dispatch` 不接受逐任务 `model`、`agentOptions` 或其他模型覆盖项。不要仅修改当前终端变量就认为已运行的 Host 生效。

RIFT 不会在模型不可用、认证失败或执行报错时静默改用其他模型，也不依赖用户全局 Codex 配置中的默认模型。上述两种名称已在 [OpenAI 模型文档](https://developers.openai.com/api/docs/models) 中列出；本项目实际包版本、账户可用性和执行结果以 [运行兼容性记录](runtime-compatibility.md) 与 [POC 结果](poc-results.md) 为准。配置接受某个名称不代表四角色真实并行验收已通过。

**默认仅配置 `git diff --check HEAD^ HEAD`，它只检查补丁空白问题，不等于项目构建、测试或业务行为正确。** 在使用真实仓库前，为 profile 的 `checks` 配置可信的构建/测试程序与参数数组。Windows 使用实际 `.exe` 或 `node` + 脚本路径，避免依赖 `.cmd` shell 拼接。模型不能提供任意检查命令。检查不得改写候选；生成产物应保存在 checkout 外，遗留 dirty、untracked 或 ignored 文件会阻止发布。

Claude 的 `acceptEdits` 没有启用 `bypassPermissions`；需要交互审批的原生操作可能被拒绝。Codex 的 `never` 表示不请求交互审批，**不等于只读 sandbox**。任务目录也是隔离工作目录，不是权限安全边界。RIFT 通过独立审查 checkout、清理确认、HEAD/文件检查和精确 SHA 发布门禁验证成果，不声称替代原生运行时的全部权限控制。

## 复现已完成的定向验收

先构建，并避免这些真实模型脚本在同一账号上同时争抢 Provider 容量：

```powershell
pnpm build
pnpm poc:tools                                  # 真实DSH工具作用域，0模型调用
pnpm exec tsx scripts/review-rework-probe.ts --run # 真实Claude/Codex、拒审新attempt、精确候选与冲突
pnpm exec tsx scripts/recovery-acceptance-probe.ts # 0模型；真实临时Host/SQLite/Git/进程故障窗口
```

`review-rework-probe` 在独立临时仓库中程序提交计划；第一次故意提供不满足年龄边界的代码，要求真实 Reviewer 拒绝，再由新 native child 根据真实报告修复。还验证最新 HEAD 保留独立成果、冲突不回滚接受结果、独立任务继续。它已经通过，但没有运行 LLM Lead。检查脚本和完整语义复核属于该夹具，不能代替用户仓库自己的测试。[脱敏证据](evidence/review-rework-probe.json)

默认恢复脚本使用真实 DSH Host、数据库、Git 和受控进程，但 activation 为明确标注的 fake；它会终止自己创建的临时测试进程，验证未知运行不重放、已发布提交只补记、占用和单实例锁恢复，并检验公开 DSH subprocess 服务的受控父/孙进程清理。[恢复证据](evidence/recovery-acceptance.json)

以下恢复脚本调用真实 Claude，已分别通过原生在途 Host 终止/恢复和真实 API 暂停/全取消：

```powershell
pnpm exec tsx scripts/recovery-acceptance-probe.ts --native # 在原生Claude运行中终止自己的临时Host
pnpm exec tsx scripts/recovery-acceptance-probe.ts --native-controls # 暂停第三请求，再取消两真实开发
```

[原生崩溃证据](evidence/recovery-native-acceptance.json)验证重启后未知执行仍占两个槽、第三请求排队且不盲目重放；[API 控制证据](evidence/recovery-native-controls.json)验证两官方终止为 aborted、清理确认、槽位归零及进程退出。它们不代表原生 Reviewer 暂停或任意模型子命令树全部已测。

真正 LLM Lead 通过业务工具完成整个流程的最终 Astra 复验已通过，复现命令为：

```powershell
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
pnpm exec tsx scripts/workflow-acceptance-probe.ts --run
```

[最终报告](evidence/workflow-acceptance-probe.json)记录 Lead 自主处理一次非法格式结果并新建 attempt、第三开发排队、两个开发与一个审查重叠、依赖接受后派发、四次最新 HEAD 精确审查集成和 `workflow_finish`。该轮使用 Astra；默认 Sol 已通过 marker 和独立真实拒审返工业务。不要把旧的[人工修正探针 gate 的 Sol 历史运行](evidence/workflow-acceptance-assisted-history.json)当成最终无人干预报告。

`provider-parallel-probe`、`review-rework-probe` 和 `workflow-acceptance-probe` 不带 `--run` 时不调用模型。`recovery-acceptance-probe` 默认只跑无模型故障测试，`--native` 或 `--native-controls` 才请求原生 Claude。证据保存在 `.runtime-evidence/` 的独立运行目录，包含 SQLite/产物/保留的 Git 现场；导出的脱敏报告位于 `docs/evidence/`。失败历史不应被最新一次成功覆盖或改写。

## 管理流程

```powershell
node dist/cli/main.js doctor --home D:\RiftHome --json
node dist/cli/main.js workspace create --home D:\RiftHome --name demo --repo D:\MyRepo --base main --key demo-create --json
node dist/cli/main.js run --home D:\RiftHome --workspace <返回的workspaceId> --goal '为输入校验添加测试' --key goal-001 --json
node dist/cli/main.js status --home D:\RiftHome --workflow <workflowId> --json
node dist/cli/main.js logs --home D:\RiftHome --run <runId> --json
node dist/cli/main.js report --home D:\RiftHome --workflow <workflowId> --json
```

新建 Workspace 默认配置一个 Developer（`developer-a`）、一个 Lead 和一个 Reviewer，成员数与 Host 开发预算独立；已有配置保留，也可手动添加成员或提交显式角色配置。Lead 只能调用八个 `rift_*` 协作工具（新增 `rift_plan_replan`）。Developer 在独立 attempt worktree 执行；成功开发自动进入串行集成队列，检查及精确候选审查后才更新 `refs/heads/rift/...`。不会 push 或更新用户默认分支。

`--no-lead` 只创建业务 Workflow，不调用模型，适合管理测试。`plan --workflow ID --file plan.json` 接受 `expectedRevision`、`tasks`；任务需声明 `kind/title/instructions/expectedPaths`，可指定 `id/roleName/dependsOn/acceptanceCriteria`。开发派发由 Lead 工具或本地 API 请求。

所有写命令支持 `--key`，同一个键及同样输入返回同一结果；不同输入复用同一键被拒绝。发生未知启动结果时先查询，不要换键盲目重试。`retry`、`pause`、`resume` 可显式传 `--version`；省略时客户端查询当前版本再写入，服务端仍检测竞争。

## 取消与恢复

```powershell
node dist/cli/main.js cancel --home D:\RiftHome --run <runId>
node dist/cli/main.js cancel --home D:\RiftHome --workflow <workflowId>
node dist/cli/main.js pause --home D:\RiftHome --workflow <workflowId>
node dist/cli/main.js lead --home D:\RiftHome --workflow <workflowId>
node dist/cli/main.js resume --home D:\RiftHome --workflow <workflowId>
node dist/cli/main.js retry --home D:\RiftHome --task <taskId> --reason '按审查意见修复'
```

取消只处理指定 activation；全流程取消会逐项处理，某项 dispose 失败不会跳过其他项。暂停停止启动新开发/审查，已开始的执行可以收束。返工创建新 Run 与 attempt，保留旧工作目录、diff、结果和审查报告。

重启先恢复数据库，再允许管理；未完成 Workflow 暂停。通过 `lead` 创建/唤醒 live Lead 后再 `resume`；`lead` 可能调用模型，不能当成无需模型的状态查询。未知执行标为 interrupted，仍占角色、槽位与目录；不能仅凭 child ID 恢复旧进程，也没有“强制释放未知执行”的快捷命令。用 `doctor` 查看遗留项，人工核对进程与工作目录，保存证据后再处理。不存在自动重放未知副作用。

发布 ref 后数据库提交失败，会在启动核对真实 ref；匹配已记录候选时补记成功，不重复合并。无法解释的状态继续阻塞。

## 归档与证据

`workspace archive ID` 只在流程终止后尝试移除已登记且清理确认的干净 task worktree。dirty、untracked、ignored、未知清理、路径越界或隔离标记会阻止删除；不用 `--force`。保留任务分支及候选/审查现场供检查。检查命令超时后，候选留有持久隔离标记，因为无法保证其自行派生的所有进程已退出。

业务输入与结果保存在不可变 JSON 产物中，数据库记录 SHA-256、字节数及相对路径；返工可核对实际携带的 source diff、旧审查与当前目标提交。检查日志和审查证据绑定 candidate SHA。报告包含四角色、版本、Run、工作目录、槽位、队列、依赖、候选和接受提交。输出脱敏且有大小限制。

本版本计划修订只追加任务，不改写已存在任务的输入。高级重规划、多工作区并发和更多 Developer 属于 E1。
