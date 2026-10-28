# RIFT 多智能体协作系统

2026-10-26 增量：Codex 聊天与正式任务支持原生持久会话，包含跨进程续接、聊天增量同步和返工记忆。升级迁移、profile 与备份要求见 [原生会话说明](docs/native-sessions.md)。

**Parallel minds. One workspace.**

RIFT 是运行在 DeepSeek Harness（DSH）中的多智能体开发协作插件。给定 Git 仓库和开发目标，由 Lead 拆分任务，让可配置数量的 Developer 在独立 Git worktree 中开发，再经过项目检查和 Reviewer 审查，将成果汇入集成分支。

当前版本为 **0.1.0**，P0–P3 MVP 已完成验收。2026-10-25 的验收记录包含 72/72 自动测试、真实模型编排、拒审返工、冲突处理、暂停/取消与崩溃恢复；实测环境与范围见[运行时兼容记录](docs/runtime-compatibility.md)和[独立验收报告](docs/acceptance-report.md)。

当前源码已完成 E1.1–E1.5 和后续 UI 计划 U0–U8：多工作区聊天、中文成员与 @、DSH/API 和受限原生主 Agent、Skill、多仓库工作目录、任务证据及恢复操作。SSE/Web UI 在本轮交付，原 E1.6 的暂缓记录保留为历史。启动与配置见 [UI 使用指南](docs/ui-guide.md)，当前验证结果见 [UI 验收报告](docs/ui-acceptance.md)；未发布新版本。

构建并启动 Host 后，直接打开本机地址 `http://127.0.0.1:<端口>/` 即可自动连接（端口见同一 home 下的 `endpoint.json`）；会话过期或 Host 重启后重新打开页面也会自动建立会话。`node dist/cli/main.js ui --home <同一 home>` 的一次性链接仍可使用，Tailscale 远程地址也支持直接打开并自动连接，无需一次性链接验证。UI 可先创建无仓库工作区开始对话，代码任务再明确选择仓库。旧 CLI 与 [E1 使用指南](docs/e1-guide.md)继续适用。

## 无浏览器 CLI 与共享协议

CLI 与浏览器的业务入口共用 Host 命令层，能力与权限边界见 [CLI 能力矩阵](docs/cli-capability-matrix.md)。Host 启动后，以下命令不需要打开浏览器；`$RiftHome` 使用与 Host 相同的目录：

```powershell
$workspace = node dist/cli/main.js workspace create --home $RiftHome --name discussion --key discussion-create --json | ConvertFrom-Json
node dist/cli/main.js ws workspace show --workspace $workspace.id --home $RiftHome
node dist/cli/main.js ws agent list --workspace $workspace.id --home $RiftHome
node dist/cli/main.js ws event list --workspace $workspace.id --data '{"after":0}' --home $RiftHome
node dist/cli/main.js connection list --home $RiftHome
```

写操作使用新读取的 `expectedVersion` / `expectedRevision`；仅用**相同输入和相同 key**查询重放结果，超时不代表取消。连接响应不含 API key 或 Host `credentialRef`，现有引用仍可作为受认证的创建输入。

前后端 wire 类型唯一来源为依赖无关的 `@rift/protocol`，后端旧类型入口兼容转导出。部署需保留 workspace 包的 manifest、`dist/` 与依赖链接；不要只复制根 `dist/`。见 [协议边界](docs/client-protocol.md)。组合验证：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:protocol
pnpm test
pnpm test:ui
pnpm build
pnpm test:built-cli
```

`test:built-cli` 在临时目录运行已构建 CLI 和 Host（禁用 UI），检查共享命令、版本/幂等、SSE 和 protocol 的 ESM 加载；不激活外部模型。验证记录见 [后端组合验证](docs/verification/backend-protocol.md)。

## 工作方式

| 角色 | 默认执行方式 | 职责 |
| --- | --- | --- |
| Lead | DSH，`deepseek-official/deepseek-flash` | 拆分计划、处理依赖、派发任务、协调返工和收尾 |
| Developer | Claude Code，`claude-opus-5-5` | 在任务 worktree 中实现变更 |
| Reviewer | Codex，`gpt-6.1-sol` | 在独立 checkout 中审查精确的候选提交 |

新建工作区默认包含一个 Lead、一个 Developer（内部名称 `developer-a`）和一个 Reviewer，可继续手动添加成员；已有工作区配置保持不变。每个工作区最多一个活跃 Workflow，多个工作区共享 Host 的开发预算。原 profile 的 Host 开发预算默认为 2，Codex 专用 profile 为 4，预算不决定默认成员数；审查和集成仍全局串行。审查可以与其他任务开发重叠，有依赖或同仓库写入路径重叠的任务会等待调度。

开发结果通过检查和审查后，RIFT 更新目标仓库中的 `refs/heads/rift/...` 集成分支。你可以在流程完成后查看差异，再自行合并到业务分支。

## 环境准备

- **Node.js 24.x**（项目要求 `>=24 <25`）、**pnpm 11.4.0** 和可在终端运行的 **Git**。
- 一个已有提交的本地 Git 仓库，以及能解析到提交的基线分支或 ref，例如 `main`。开始前先提交希望 Agent 使用的代码；未提交的工作目录修改不会进入新 worktree 的基线。
- Lead 可用的 `DEEPSEEK_API_KEY`，以及 Claude Code、Codex 原生运行时可用的认证和模型权限。

当前验收环境为 Windows x64，以下命令使用 PowerShell。含 submodule 或启用 sparse checkout 的目标仓库会被拒绝，嵌套仓库和越界路径也受检查限制。

DSH 与官方 Provider 随项目依赖安装，不需要再启动另一个 daemon。请保留 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`：项目将 Codex 锁定为 `0.164.0`、Claude Agent SDK 锁定为 `0.3.310`（内置 Claude Code `2.1.310`）。运行时需要 `dist/`、`migrations/`、`profiles/` 和已安装的依赖，不能只复制 CLI 文件。

## 快速开始

### 1. 下载、安装并构建

```powershell
git clone https://github.com/MetalLee/RIFT.git
Set-Location RIFT
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node dist/cli/main.js --help
```

如果已经有源码，直接在 RIFT 项目目录从安装步骤开始。下文所有 `node dist/cli/main.js ...` 命令也都在此目录执行。开发时可用 `pnpm rift ...` 运行源码；修改源码后，使用 `node dist/cli/main.js` 前需重新构建。

### 2. 准备认证并启动服务（终端 A）

在启动服务的同一个终端中设置环境变量。示例中的密钥需要替换为你自己的值；也可以使用当前终端已配置的环境变量。

```powershell
$env:DEEPSEEK_API_KEY = '<你的 DeepSeek API Key>'

# Claude 二选一：完成标准 Claude Code 登录，或设置 API Key。
# 使用原生登录时无需设置下面这一项。
# $env:ANTHROPIC_API_KEY = '<你的 Anthropic API Key>'

node dist/cli/main.js serve --home D:\RiftHome --profile rift
```

Codex 使用原生 Codex 认证；Claude 使用标准 Claude Code 登录或显式的 `ANTHROPIC_API_KEY` 引用。RIFT 不读取或复制桌面应用的内部凭据。桌面应用已打开或 Provider 已注册，均不能证明实际执行实例已经认证；具体核验方式见[使用说明](docs/usage.md)。

保持终端 A 运行。首次启动会在 home 下创建数据库和 DSH profile；管理服务默认监听 `127.0.0.1:47831`。如端口被占用，可在启动时加 `--port 47832`，其他命令会从同一 home 自动读取实际地址。

### 3. 检查服务并登记目标仓库（终端 B）

打开第二个 PowerShell 终端，进入 RIFT 项目目录。下面的 home 必须与终端 A 相同，`$Repo` 应改为你要让 Agent 开发的仓库路径。

```powershell
$RiftHome = 'D:\RiftHome'
$Repo = 'D:\MyRepo'

node dist/cli/main.js doctor --home $RiftHome --json
git -C $Repo status --short
git -C $Repo rev-parse --verify main

$workspace = node dist/cli/main.js workspace create --home $RiftHome --name demo --repo $Repo --base main --key demo-workspace-001 --json | ConvertFrom-Json
$workspaceId = $workspace.id
$workspaceId
```

将 `main` 替换为目标仓库的实际基线。`workspace create` 返回的 `id` 是后续命令使用的 workspace ID，同时自动配置上述三个角色。可以用 `workspace list` 找回已登记的 workspace。

`doctor` 只检查配置、服务和遗留占用，不调用模型；`authentication` 中的 `not-verified` 是预期状态，不等于认证失败。需要真实验证运行时访问时，可在 RIFT 目录按需运行以下探针，**它们会调用模型并产生相应费用或额度消耗**：

```powershell
pnpm poc --claude
pnpm poc --codex
```

### 4. 提交开发目标

在终端 B 继续执行，将目标改成与自己仓库相关的具体需求，写清允许修改的范围和验收条件。

```powershell
$workflow = node dist/cli/main.js run --home $RiftHome --workspace $workspaceId --goal '为现有输入校验逻辑补充边界测试，并修复测试暴露的问题；仅修改相关源码和测试，保持现有公开接口兼容。' --key demo-goal-001 --json | ConvertFrom-Json
$workflowId = $workflow.id
$workflowId
```

`run` 默认启动真实 Lead 并使用模型。返回 workflow ID 表示流程已创建，任务会在后台继续，不能据此判断开发已完成。

### 5. 查看进度和报告

```powershell
node dist/cli/main.js status --home $RiftHome --workflow $workflowId

# 需要进一步读取字段时使用 JSON。
$status = node dist/cli/main.js status --home $RiftHome --workflow $workflowId --json | ConvertFrom-Json
$status.workflow
$status.tasks | Select-Object id, title, status, attempt, blockingReason
$status.runs | Select-Object id, taskId, purpose, status, cleanupStatus
$status.slots

node dist/cli/main.js report --home $RiftHome --workflow $workflowId
```

`status` 是一次状态快照，可重复执行。`workflow.status` 为 `completed` 才表示整体收尾成功；变更任务需通过实际检查和审查，`tasks[].acceptedCommit` 记录接受的提交。若任务处于 `blocked` / `failed`，查看 `blockingReason`、集成记录和对应 Run 的事件：

```powershell
# 将这里的 ID 替换为 status.runs 中的实际 id。
node dist/cli/main.js logs --home $RiftHome --run 'run-实际ID'
```

`logs` 返回与该 Run 关联的 RIFT 事件，并非原生模型的完整终端转录。`report` 同时返回报告内容和保存位置，默认保存在 `D:\RiftHome\workspaces\<workspaceId>\reports\<workflowId>.json`。

### 6. 查看并合并成果

等 Workflow 完成后，从状态中取得真实集成 ref，在目标仓库查看变更：

```powershell
$status = node dist/cli/main.js status --home $RiftHome --workflow $workflowId --json | ConvertFrom-Json
$integrationRef = $status.workflow.integrationRef
git -C $Repo log --oneline main..$integrationRef
git -C $Repo diff main...$integrationRef

# 确认结果后，在干净的业务工作目录中自行合并。
git -C $Repo switch main
git -C $Repo merge --no-ff $integrationRef
```

以上 `main` 同样应替换为自己的目标分支。RIFT 不自动 push 或更新默认分支。流程仍在运行时，不要 checkout 它的集成分支，发布门禁会拒绝更新已被 checkout 的集成 ref。

## 模型和项目检查配置

默认配置文件为 [`profiles/rift.patch.yml`](profiles/rift.patch.yml)。模型在服务启动时绑定到 Provider 实例，配置如下：

| 环境变量 | 默认值 | 可用配置 |
| --- | --- | --- |
| `RIFT_LEAD_MODEL` | `deepseek-flash` | `deepseek-official` Provider 中可用的模型 |
| `RIFT_CLAUDE_MODEL` | `claude-opus-5-5` | 仅接受此精确名称，空值或其他名称会报错 |
| `RIFT_CODEX_MODEL` | `gpt-6.1-sol` | `gpt-6.1-sol` 或 `gpt-6-astra`，空值或其他名称会报错 |

例如使用 Astra 审查：

```powershell
$env:RIFT_CODEX_MODEL = 'gpt-6-astra'
node dist/cli/main.js serve --home D:\RiftHome --profile rift
```

更改模型前先等待在途 Run 结束并确认清理，再停止旧服务并重启。在另一个终端修改变量不会影响已启动的服务。模型不可用或认证失败时不会静默回退，也不支持通过单个任务覆盖模型。

**默认质量检查只有 `git diff --check HEAD^ HEAD`，只检查补丁空白问题。接入实际项目时，请配置对应的构建和测试。** 编辑 profile 中 `id: rift` 节点下的 `config.checks`，保留原有插件配置。例如，目标仓库已有一个无需安装依赖的 Node 检查脚本时：

```yaml
checks:
  - id: diff-check
    executable: git
    args: ['diff', '--check', 'HEAD^', 'HEAD']
  - id: project-tests
    executable: node
    args: ['scripts/rift-check.mjs']
    timeoutMs: 120000
```

示例中的 `scripts/rift-check.mjs` 需要你在**目标仓库**实现并提交，它不是 RIFT 提供的文件。检查会在独立的候选 checkout 中执行，该目录不会自动拥有原仓库未提交的文件、`node_modules` 或构建缓存。请准备适用于新 checkout 的依赖方案，并把生成产物放在 checkout 外；即使是 ignored 文件，遗留在候选目录中也会阻止发布。

每项检查使用固定的可执行程序和参数数组，不经 shell 拼接；Windows 下使用实际 `.exe` 或 `node` 加脚本路径，避免直接依赖 `.cmd`。检查成功后候选必须保持干净且 HEAD 不变。服务也支持 `--patch <配置路径>`，自定义 patch 时须正确保留插件入口及其他必要配置。

### Host 证据与补证（第一批）

`checks` 是 Host 操作员配置的显式必需清单，不从任务描述猜测测试。默认每项 `required: true`；可选检查可设置 `required: false`，普通非零退出保留为 `optional`，不能伪称通过；超时或清理未知始终是硬阻塞，与 required/optional 无关。至少需要一个必需检查；最多 64 项，单项超时上限 3600000 ms。

每次实际执行保存独立、不可通过 API 改写的附件，绑定工作区、仓库、任务/attempt、integration、精确 candidateHead，以及命令/配置和环境指纹、Host 来源、退出状态、脱敏日志和摘要。原始日志无需（也不应）提交源码。环境指纹标识 Host OS/架构/内核、Node 版本和隔离策略版本，不代表依赖安装或构建缓存可复用。附件使用 Host 私有目录和 0600 文件，日志合计最多捕获 64 KiB；截断明确标记，列表只返回每流 8000 字符摘录。历史记录可读取；没有附件绑定的旧记录不会自动升级为可信 Host 证据。

- `GET /ui-api/v1/workspaces/:workspaceId/tasks/:taskId/evidence`：共享协议 `TaskEvidence`，含 `integrations[].readiness` 和检查摘录（最近 20 个 integration）。顶层 `currentCandidate` 仅从 Host 已验证的当前 attempt/source 唯一绑定产生（未知或歧义为 null），不能按列表末项猜测。状态为 `ready / waiting_evidence / failed / environment_unavailable`；`readiness.cleanupStatus` 为 `unknown / confirmed`（旧服务可缺省）；阻塞分类为 `code_defect / evidence_missing / environment_unavailable / optional`。
- `GET .../tasks/:taskId/evidence/log?integrationId=...&checkId=...`：按附件 ID 读取完整的有界脱敏日志，不接受文件路径。
- `POST .../tasks/:taskId/evidence`：受控补证，JSON 为 `{ "integrationId": "...", "candidateHead": "完整提交哈希", "expectedVersion": 任务版本, "idempotencyKey": "补证操作键" }`，HTTP 写请求还需既有 `Idempotency-Key`。同样提供 `/v1/workspaces/...` 管理端点。不能上传日志、命令、退出状态或声明来源。

CLI 对应 `rift ws task evidence TASK --workspace WORKSPACE`、`task evidence-log TASK --data '{"integrationId":"...","checkId":"..."}'`、`task supplement-evidence TASK --data '{...}' --key REQUEST_KEY`。成员仅 Lead 可请求补证；Reviewer 另有只读、仅限自身任务和活跃 Run 的 `rift_read_evidence` 工具。

真实必需检查代码失败保存为 `blocked`，可通过 `task.retry-dispatch` 正式返修；缺必需项或环境不可用时 integration 保存为 `evidence_waiting`，不启动正式审核或发布，也不自动开发返修。操作员修复环境或明确调整检查配置后，可为未变候选请求补证：只执行缺失、失效或失败的配置检查；成功后复用原 integration/candidate，进入独立审核，无需开发者新建源码提交。更换目标 HEAD、attempt、候选或配置会失效相应证据；批准不能跨候选使用。重用同一操作键不会重复执行；中断中的操作键拒绝自动重跑，需先检查状态。每次执行前持久记录清理未知，正常退出后才确认；超时保留 `cleanup_unknown` 和隔离门禁，不能用补证、改 integration 状态或删隔离文件绕过。重启 Host 本身不证明清理；`integration.reconcile` 仅凭 Host 已记录的同机 OS 重启证明恢复超时清理，证明持久保存，不接受请求自报 cleanup。当前未审核候选清理恢复后仍需显式补证并独立审核；失效旧 attempt/source 的等待记录保留历史，不阻断新 attempt，清理未知不因 attempt 变化失效。

待用户分别确认的后续批次（本次不实现）：第二批基线复用/检查 DAG/环境缓存；第三批分阶段队列/跨引用并行。

## 常用管理命令

以下命令沿用终端 B 的 `$RiftHome`、`$workspaceId` 和 `$workflowId`，任务及 Run ID 从 `status` 获取。

| 用途 | 命令 |
| --- | --- |
| 列出工作区 | `node dist/cli/main.js workspace list --home $RiftHome` |
| 暂停新开发和审查 | `node dist/cli/main.js pause --home $RiftHome --workflow $workflowId` |
| 恢复队列 | `node dist/cli/main.js resume --home $RiftHome --workflow $workflowId` |
| 创建或唤醒 Lead | `node dist/cli/main.js lead --home $RiftHome --workflow $workflowId` |
| 取消单次执行 | `node dist/cli/main.js cancel --home $RiftHome --run 'run-实际ID'` |
| 取消任务 | `node dist/cli/main.js cancel --home $RiftHome --task 'task-实际ID'` |
| 取消整个流程 | `node dist/cli/main.js cancel --home $RiftHome --workflow $workflowId` |
| 创建返工 attempt | `node dist/cli/main.js retry --home $RiftHome --task 'task-实际ID' --reason '按审查意见修复'` |
| 归档工作区 | `node dist/cli/main.js workspace archive $workspaceId --home $RiftHome` |

暂停后已开始的执行可以继续收束；取消 Workflow 会取消其在途工作。`retry` 仅适用于非终止 Workflow 中已阻塞、失败或取消且清理确认的任务，每个任务最多两次返工。它保留旧现场并将新 attempt 置为待派发状态，后续仍需 Lead 调度；必要时执行 `lead` 唤醒。

所有管理命令支持 `--home` 和 `--json`。home 的选择顺序为 `--home`、`RIFT_HOME` 环境变量、当前目录的 `.rift`。写命令支持 `--key`：同一键与相同输入会返回原结果，不同输入复用同一键会报错。每个新操作使用新键，重试同一请求使用原键；如果结果未知，先查询状态，避免换键重复创建 Workflow。

高级用法包括 `run --no-lead`、`plan --workflow ID --file plan.json` 和 `role configure --workspace ID --file roles.json`，详见[使用说明](docs/usage.md)。`--no-lead` 只创建业务流程，不调用模型；提交计划本身也不会派发开发，派发需要 Lead 工具或本地 API。

## 停止、恢复与数据保存

在终端 A 按 **Ctrl+C** 停止服务，Host 会清理其拥有的执行。需要恢复时，用同一个 home 启动服务，再在终端 B 检查状态：

```powershell
# 终端 A
node dist/cli/main.js serve --home D:\RiftHome --profile rift

# 终端 B：确认没有未知清理项后，恢复未完成的 Workflow。
node dist/cli/main.js doctor --home $RiftHome
node dist/cli/main.js status --home $RiftHome --workflow $workflowId
node dist/cli/main.js lead --home $RiftHome --workflow $workflowId
node dist/cli/main.js resume --home $RiftHome --workflow $workflowId
```

重启后未完成流程会暂停，需要先建立 live Lead 再恢复队列。`lead` 可能调用模型。崩溃后未知执行会标为 interrupted，并保留角色、槽位和目录占用；`doctor.unconfirmedRuns` 有遗留项时应先核对进程和现场。RIFT 不自动重放未知副作用，也没有强制释放未知执行的快捷命令。

| home 下的文件或目录 | 用途 |
| --- | --- |
| `rift.db` | SQLite 业务账本：工作区、任务、Run、队列和事件 |
| `dsh/` | 默认隔离的 DSH profile 与其运行数据；已有 `DSH_HOME` 设置时遵循该设置 |
| `endpoint.json` | CLI 连接本地服务所用的地址与进程信息 |
| `management.token` | 管理 API 令牌，由 CLI 自动读取，勿提交到仓库或交给子 Agent |
| `workspaces/` | 管理的 worktree、候选、审查现场、操作记录与报告 |

业务输入、结果和审查证据以 JSON 产物保存并关联摘要。备份时应保留完整 home、DSH 数据及对应目标 Git 仓库，并保持路径关系；只保留 `rift.db` 不足以恢复现场。`workspace archive` 只在流程终止后尝试删除已登记、清理确认且干净的任务 worktree，保留分支和候选/审查现场；dirty、untracked、ignored 或未知清理状态会阻止删除。

## 常见问题

| 现象 | 排查方法 |
| --- | --- |
| 找不到 `dist/cli/main.js` 或插件入口 | 在 RIFT 项目目录执行 `pnpm build`，并保留 `profiles/`、`migrations/` 和依赖 |
| 找不到 `endpoint.json` / 连接被拒绝 | 确认终端 A 正在运行、两个终端使用相同 home；旧 endpoint 文件不表示服务仍存活 |
| `doctor` 显示 `not-verified` | 它不做真实模型认证；按需执行上面的真实 Provider 探针 |
| `unrecognized_model` / 模型不可用 | 使用冻结锁文件安装依赖，核对模型精确名称、认证与访问权限，调整后重启服务 |
| 第三个开发请求排队 | 开发上限为两个；依赖未接受、写入路径重叠或未知清理占用也会使请求等待 |
| `CHECK_FAILED` / `CHECK_MODIFIED_CANDIDATE` | 查看报告与候选检查记录，修复测试或检查脚本产生的文件，保留现场供核对 |
| `INTEGRATION_REF_CHECKED_OUT` | 从占用集成分支的工作目录切换到其他分支，再处理受阻任务 |
| `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` | 重新查询状态与版本；仅对相同输入复用请求键，不盲目重复写入 |
| `CLEANUP_UNKNOWN` / `OUTCOME_UNKNOWN` | 先核对 `doctor`、Run 和实际进程，保存证据后处理；重启或换请求键不会自动解决未知状态 |

Claude 默认 `acceptEdits`，需要原生交互审批的操作仍可能被拒绝。Codex 的 `never` 仅表示不请求交互审批，不代表文件系统只读。worktree 是独立工作目录；RIFT 依靠候选检查、独立审查、清理确认和精确提交门禁控制接受过程。

## 开发与进一步阅读

```powershell
pnpm typecheck       # TypeScript 类型检查
pnpm test            # 自动测试
pnpm test:acceptance # 验收测试子集
pnpm build           # 构建 dist
pnpm poc             # 运行时/插件探针，不加模型选择参数时不调用模型
pnpm poc:tools       # Lead 工具作用域探针，不调用模型
```

真实并行、拒审返工和完整 Lead 流程的复现方式见[使用说明中的定向验收](docs/usage.md#复现已完成的定向验收)。实测结果应按模型和测试范围解读：最终完整无人干预流程使用 Astra Reviewer，Sol 另有独立标记与真实拒审返工验收。

- [完整使用说明](docs/usage.md)：认证、模型、手工计划、恢复和定向验收。
- [运行时兼容记录](docs/runtime-compatibility.md)与 [POC 结果](docs/poc-results.md)：锁定版本、模型范围及失败历史。
- [P0–P3 实现与交付记录](docs/development-status.md)与[独立验收报告](docs/acceptance-report.md)。
- [技术开发方案](docs/technical-plan.md)与[实施任务清单](docs/implementation-backlog.md)：架构和后续扩展。
- [对话协作优化开发方案](docs/chat-orchestration-development-plan.md)：C1–C4 已实现且默认开启；短轮次、成员消息/delegate/inbox、事件续办、安全正文流及消息任务 tag。
- [对话协作 C2–C4 验收](docs/collaboration-acceptance.md)：真实双成员拒审返工闭环、锁定协议、独立故障验收、浏览器 P95 和兼容边界。
- [对话协作第一阶段验收](docs/chat-orchestration-acceptance.md)：受控测试、原生协议、真实代码闭环、失败历史及发布边界。
- [Codex 开工提示词](docs/codex-kickoff.md)与[原方案对齐记录](docs/source-alignment.md)。

当前计划修订仅追加任务。高级重规划、多工作区并发和更多 Developer 属于后续扩展范围。

## 安全删除 Worktree

在「仓库与工作树」选择 **删除 Worktree…**，核对确认框中的完整路径后再删除。此操作移除受管磁盘目录，但保留分支、提交、任务、运行、集成、检查与审查记录；无分支的候选提交也由 `refs/rift/deleted-worktrees/` 保持可达。外部目录只解除关联，主仓库不可删除。

任务、候选构建目录和审查目录仅在任务及流程终结、不再用于执行或恢复时开放删除。Host 在 Git 元数据锁内重新核对归属、管理路径和内容，拒绝 dirty、untracked、ignored、隐藏的索引变更、未结束的 Git 操作、执行租约、排队操作及未确认清理。不使用 `--force` 或递归删除兜底。

失败时保留目录、错误及可重试记录，刷新后须重新确认。超时或 Host 中断不会自动重试；「核对删除结果与清理证据」要求已确认的进程退出凭据，或同一机器真实的系统重启证明（仅重启 Host 不算）。目录与 Git 注册不一致时仍保留现场。

浏览器 Host API 以记录 ID 定位：`POST /ui-api/v1/workspaces/:workspaceId/worktree-removals/:kind/:recordId/delete`（`kind=user|task|candidate|review`），请求包含列表返回的不透明 `expectedVersion` 和 `confirmDelete: true`，不接受目标路径。对应 `/reconcile` 只接受 `expectedVersion`；历史 `/worktrees/:id/archive` 入口共用相同安全检查。
