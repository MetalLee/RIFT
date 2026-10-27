# 工作区仓库执行权限

当前 Codex 配置已按用户要求调整：开发、返工和关联仓库聊天默认 `danger-full-access`，不再用仓库集合限制操作系统访问；Host 的仓库/cwd 归属校验及验收门禁保留。正式审查、分析和无仓库聊天维持显式只读。权限版本为 `workspace-repositories-v5-full-access`。下文的 workspace-write 系统隔离与旧探针结果属于此前配置，不能作为当前 Codex 开发隔离保证；DSH 命令工厂的权限策略未随本次修改改变。

更新：2026-10-26。本次实现把工作区已经关联的全部仓库交给主代理和成员的普通讨论执行，也交给正式开发 Run。权限由 Host 生成，不依赖模型在消息或工具参数里声明路径。本次用户选择先完成本地提交，稍后再登录 GitHub；不推送、不创建远程 PR。

## 授权边界

Host 从 `repositories` 账本按 workspace 读取仓库，默认仓库排第一；逐一解析 `realpath`，核对 Git 顶层目录与登记的 `common_git_dir`。路径被替换成 junction/symlink，或 `.git` 指针改到其他仓库时拒绝启动。其他 workspace 的仓库不加入授权。

运行时收到 `repositoryAccess: { repositoryPaths: [...] }`，由原生层继续推导每个仓库精确的 Git directory、common directory，以及当前已验证属于这些仓库的任务 worktree。写权限包含这些准确目录，不扩大到共同父目录或整个磁盘。普通聊天 cwd 使用默认仓库或第一个关联仓库；正式任务继续在本次分配的 worktree 中执行。输入快照保留当轮仓库集合、cwd 和权限版本，正文、引用、成员消息均不能修改该集合。

| 当前执行模式 | 文件与命令能力 |
| --- | --- |
| 有关联仓库的普通讨论 | 所有成员，包括名为 reviewer 的成员，可使用已授权仓库中的原生命令；能力由当前模式决定 |
| 正式开发、返工 Run | 可在任务 worktree 和已关联仓库内执行开发命令、`git add`、`git commit`；保留其他执行的工作 |
| 正式 review / analysis Run | 仅 Host `rift_read_file` / `rift_list_files` 与协作工具，无 native shell、命令执行或模型可用网络工具；调用方误传开发能力不能升级模式 |
| 无仓库聊天、标题生成、无仓库文本分析 | 使用 staging 与受限业务工具，不因消息提到路径而开放原生仓库执行 |
| 结构化分析批次 | 保留既有只读工具及输入边界，不继承开发命令权限 |

Codex 使用锁定的 0.164.0 app-server 和系统沙箱。本地 DSH 普通讨论与可续接子执行使用原生 `exec_command`，命令经同版本 Codex sandbox 运行；不是在 Host 中直接调用无限制 `pwsh`。DSH 子执行先隐藏继承的全局工具，再给准确的子 agent 安装命令与协作工具。停止时必须清理命令进程，再确认运行时清理和释放 lease。未验证的其他外部 Provider 不因此获得同等能力保证。

开发仓库执行允许网络，以支持正常依赖命令和 `gh`。真实 Windows 探针发现：只设置 read-only 与 network=false 仍可到达 loopback HTTP 服务，虽然仓库写入和外网请求被拒绝。这不足以保证正式审查不能触发本机服务副作用。因此正式 review/analysis 不再提供 shell，改由 Host 的受限 read/list 工具读取当前 checkout，拒绝路径逃逸、Git 元数据、符号链接逃逸和不受限内容读取。模型正常推理连接与 Host 预设检查仍按各自流程执行；不能把它描述成整个 Host 断网。新的正式模式已在真实原生探针中验证：shell 请求拒绝，read/list 可用，仓库外读取拒绝，review/analysis 的探针网络请求未到达服务；保留旧网络配置失败作为修复依据。

## 本地提交与发布

开发提示不再硬性禁止 `git add/commit`，也不再要求必须由 Host 首次创建提交。Host 仍核验实际 source、路径范围、候选检查、精确提交独立审查和清理状态。模型说“已提交”、一个 commit 或一个 PR 都不等于 Task 已接受。

`git push`、创建或更新 PR 要有用户明确请求。已安装 GitHub CLI **2.103.2**，受限命令路径已实际执行 `gh --version`；用户选择稍后登录。本次不进行登录、远程推送或 PR 创建，因此不把本地 CLI 可用写成远程 PR 链路已经验收。

## 原生会话变化

配置指纹包含权限版本 `workspace-repositories-v3`、仓库集合、当前 cwd、执行模式以及既有模型、提示词、工具和 runtime home 配置。同一归属与相同边界继续复用 thread；仓库增删、cwd/worktree 或权限版本变化时使用不同 thread。切回已有的完全相同指纹可恢复对应的旧 thread。

这明确调整了旧 C-A15 中“同 Task 跨 attempt worktree 仍续原 thread”的行为：新 worktree 不再携带旧原生目录权限和完整私有历史。Host 通过 `previousResults`、`sourceEvidence`、当前 task envelope、公共消息和 inbox 恢复必要上下文，不能声称旧私有推理历史无损迁移。角色归属、未知执行不自动重播、消息 receipts 和清理门禁保持有效。

## 验证与证据范围

- [独立权限回归](evidence/repository-permissions-independent-review.json)：15 项通过，覆盖多仓、跨 workspace、Git 指针替换、junction、精确 metadata、cwd/权限不匹配、会话轮换、只读模式及未知命令清理。
- [DSH 命令探针](evidence/repository-shell-probe.json)：真实系统沙箱与 subprocess，在临时主/第二仓库和 linked worktree 提交；共 6 项检查通过：主 worktree/第二仓库本地提交、仓库外写入拒绝、仓库外 cwd 拒绝、取消清理收束、`gh --version` 可用。此命令工厂仅用于可写模式，不再提供只读 shell 分支。没有外部推理、push 或 PR。
- [Codex 仓库探针](evidence/native-repository-probe.json)：真实 app-server、本地受控 Responses、实际临时 Git 提交与隔离检查。最终 17 项检查全部通过，含正式模式拒绝 native shell、read/list 正常、仓库外读取拒绝，以及两个正式模式的探针网络请求均未到达服务。早期只读 shell 的 loopback 失败是改为 Host read/list 的直接依据。
- [原生会话探针](evidence/native-session-probe.json)和[协作协议探针](evidence/collaboration-native-probe.json)：按新契约验证同边界续接、变更 worktree 换线程、Host 证据恢复及本次 Run 工具闭包，不调用外部模型。
- 实现专项覆盖 Chat 权限冻结、无仓库/标题限制、DSH 子 scope/只读/清理顺序和旧会话回归；完整测试与部署状态由最终集成报告另记，不沿用上一轮的测试总数。

Host 的 legacy Lead 入口也使用相同的关联仓库命令 scope。部署须等待旧执行和 lease 收束，重新构建并重启 Host；已运行进程不会自动获得新权限。项目本地提交、完整回归和最终部署状态以主代理的集成记录为准，不能从临时仓库探针提交推断项目已经提交。

## 最终集成与部署

### Astra 工具包装入口修复

2026-10-26 19:45（香港时间）的真实主对话虽然已获得仓库权限，但两次 `exec` 包装调用均返回 `code-mode host is disabled`，未进入 Git 或 RIFT 工具。此错误来自原生运行时的工具开关，不是 workspace Host 未运行。之前直接发送 `exec_command` 的受控探针未覆盖 Astra 实际选择的包装入口。

普通仓库对话和开发执行现在同时启用 `code_mode` 与 `code_mode_host`，仍沿用原有仓库沙箱及工具隔离；正式审查、分析和无仓库讨论保持禁用。权限版本从 v2 更新为 v3，下一轮使用新配置的原生会话，公共消息仍由 Host 恢复。该修复不自动重放已经结束的合并或推送请求。

修复后真实 Astra high 连续两轮通过 `exec` 调用 Host 工具和原生 `git status`，回调计数及原生 tool output 均可核验；直接 JS 的 `process`、`require`、`fetch` 不可用，`node:fs` 导入被拒。见 [真实模型证据](evidence/native-code-mode-real-probe.json)、[受控包装协议探针](evidence/native-code-mode-controlled-probe.json)及[独立检视](evidence/native-wrapper-independent-review.json)。完整回归 337 通过、1 平台跳过、0 失败，类型检查与构建通过；Host 已备份并重启至 PID 40288，HTTP/doctor 200、数据库检查通过。见 [本次部署记录](evidence/native-wrapper-fix-final-validation.json)。

另用真实二进制对正式 review/analysis 发送恶意 `exec` 包装调用，8 项独立负例检查通过：调用均被拒、Host 回调与本机 HTTP 触达为 0、无文件副作用，正常 `rift_read_file` 仍可用。见 [正式只读包装隔离证据](evidence/native-code-mode-readonly-independent-probe.json)。

修复前仓库权限版本的完整回归为 330 项通过、1 项平台跳过、0 失败；类型检查与生产构建通过。Host 已在无活动执行时备份并重启（PID 24588），HTTP/doctor 返回 200，数据库完整性 ok、外键错误为 0，默认新模式继续开启。见 [最终集成证据](evidence/repository-permissions-final-validation.json) 与 [完整测试](evidence/repository-permissions-tests.json)。GitHub 登录按用户选择延后，本次只提交本地 main 全部变更。
