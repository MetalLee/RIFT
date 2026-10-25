# E1 配置与使用

日期：2026-10-25。适用于 E1.1–E1.5；E1.6 的 SSE 和 Web UI 暂不开发。原 P0–P3 的证据保留，新增验收见 [E1 验收报告](e1-acceptance.md)。仍是一个 DSH 插件，使用官方 Provider 和 Workflow 服务。

## 不使用 Claude 的启动方式

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:RIFT_DEVELOPERS = '4'
$env:RIFT_TOTAL_LIMIT = '5'
node dist/cli/main.js serve --home D:\RiftE1 --profile rift-e1 --patch profiles/rift.codex.patch.yml
```

此 profile 只注册 Codex 外部实例和 DSH spawn，不加载 Claude。开发使用 `codex-dev`，审查使用 `codex-review`，两者默认 `gpt-6-astra`；分别由 `RIFT_CODEX_DEVELOPER_MODEL`、`RIFT_CODEX_MODEL` 选择 Astra 或 Sol。Lead 仍使用 `deepseek-official/deepseek-flash` 和现有认证引用。改变实例模型需停止 Host 后重启。

原 `profiles/rift.patch.yml` 保留 Claude 兼容默认；本轮未运行它的 Claude 路径。两个 profile 均装载官方 `spawn-in-process`、PTC Node runtime 和 Workflow engine，不向 Lead 开放通用 Workflow/委派工具。

## 配额与多个工作区

Host 的 `limits` 配置如下；`doctor` 返回生效值，Workflow `status` 同时返回本工作区 `slots` 和 Host `globalSlots`。

| 字段 | 默认值 | 范围与作用 |
| --- | --- | --- |
| `developers` | 2；Codex profile 为 4 | 1–128，整个 Host 的开发预算 |
| `total` | developers + 1 | 2–129，必须大于 developers，预留串行审查容量 |
| `maxTasks` | 1000 | 1–10000，单 Workflow 累计任务数 |
| `maxReplans` | 100 | 0–1000，初始计划之后的计划修订预算 |
| `agingMs` | 60000 | 1–3600000，每等待一个周期增加一个调度优先分 |

`RIFT_DEVELOPERS` 和 `RIFT_TOTAL_LIMIT` 同时配置示例 profile 的 RIFT 配额及 DSH 容量。其他字段在 profile 的 `rift.config.limits` 中设置。配额持久化；未提供覆盖项的程序入口沿用数据库值，profile 的显式值在启动时生效。低于已保留占用的配置会拒绝启动。

在同一 Host 登记多个 Workspace，然后分别执行 `rift run --workspace ID --goal TEXT` 即可并发。每个 Workspace 最多一个活跃 Workflow，并拥有独立 Lead、队列、任务目录和集成 ref。准备、取消、未知清理均计入预算；取消一个 Workflow 不取消其他 Workflow。

不同仓库相同相对路径互不阻塞。同一仓库的重叠预期路径保守串行，Git 元数据修改按真实 `commonGitDir` 使用跨进程锁。检查、审查与发布仍在整个 Host 串行。默认分支和远程不自动更新。

## 自由角色

`rift role configure --workspace ID --file roles.json` 仍提交完整配置。角色数量为 3–130，名称支持字母、数字、下划线、连字符和点，最长 64 字符。

- 恰好一个 `purpose: "lead"`，`kind: "dsh-lead"`，不绑定子 Provider。
- 至少一个 `purpose: "developer"` 和一个 `purpose: "reviewer"`，`kind: "subagent"`。
- 原 `lead/developer-a/developer-b/reviewer` 可省略 purpose；自定义名称须声明 purpose。
- 同一角色最多一个未释放 Run；角色数和实际并发预算独立。多个 Reviewer 角色仍共享一个审查槽，当前按名称选择首个启用 Reviewer。

角色可指向已注册的 Codex、Claude 或 DSH `spawn` 实例。外部 Provider 的 `model` 是配置元数据，不能通过角色 JSON 切换实际模型；两个显式不同的外部模型必须使用不同 `providerName`。未知旧元数据不会被当成已核验模型。实际模型由 profile 及真实执行证据确定。

DSH binding 示例（`id` 由配置自行命名，凭据只保存引用）：

```json
{
  "id": "analysis-spawn",
  "providerName": "spawn",
  "packageVersion": "0.2.1-rc.3",
  "configRevision": 1,
  "capabilities": { "agentOptions": true, "agentPreset": true },
  "credentialRefs": ["env:DEEPSEEK_API_KEY"],
  "runtime": "dsh",
  "spawn": { "provider": "deepseek-official", "model": "deepseek-flash" }
}
```

DSH 子角色可设置官方支持的 `reasoningEffort/maxTokens/agentPreset`；运行时再次核验真实 Provider capabilities。批量分析不支持每个子项的 `agentPreset`，配置会明确拒绝。Run 保存角色和 binding 的不可变快照。变更配置须递增 revision，活动或未知清理期间不能修改；被未完成任务或排队请求引用的角色不能移除或改为其他职责。

普通 DSH spawn 子角色保留 profile 的开发工具，不继承 Lead 实例的 RIFT 管理工具。批量分析则单独限制工具，两种作用域均有官方服务验证。

## 动态计划与调度

任务可携带 `priority`（整数 -100–100，默认 0）。调度先在工作区之间轮转，再考虑优先级与等待时间，不能抢占正在执行的任务。依赖成果仍须实际接受才可派发后继。

`rift replan --workflow ID --file replan.json` 对应 `POST /v1/workflows/:id/replan` 和 Lead 工具 `rift_plan_replan`：

```json
{
  "expectedRevision": 1,
  "updates": [
    { "taskId": "tests", "expectedVersion": 0, "dependsOn": ["implementation"], "priority": 10 }
  ],
  "tasks": []
}
```

只允许修改尚未执行任务的依赖和优先级；也可通过 `tasks` 原子新增任务。循环依赖、跨 Workflow 引用或旧版本导致整次事务回滚。已运行、已接受及有执行历史的任务不可改写。排队请求保留原 ID 并更新计划版本；由依赖失败阻塞且从未运行的任务可重规划，原已阻塞请求需重新派发。

HTTP/工具单次最多提交 1000 个任务，仍受 256 KiB 管理请求大小和单 Workflow 总预算限制。计划追加同样消耗修订预算。写请求仍使用 `Idempotency-Key`，重复同键同输入不重复执行。

## 一次 Run 内复用官方 Workflow

在普通计划中提交一个 analysis Task：

```json
{
  "expectedRevision": 0,
  "tasks": [{
    "id": "design-analysis",
    "kind": "analysis",
    "title": "分析提供的设计材料",
    "instructions": "根据每项提供的材料分析，只返回文本。",
    "expectedPaths": [],
    "analysisItems": [
      { "id": "risks", "prompt": "设计材料：……。列出主要风险。" },
      { "id": "checks", "prompt": "验收要求：……。列出检查点。" }
    ]
  }]
}
```

批次必须先登记 Task、预留 Run 和独占 worktree，再由官方 Workflow engine 执行固定脚本。1–32 个子项顺序执行，每项在结束并清理后启动下一项，因此一个批次只占一个业务开发槽。输入是数据，用户或模型不能提交脚本。每项结果与官方 Workflow ID 聚合进入原有结果产物；任一失败使任务阻塞。

这是对提供文本的分析。DSH 分析子项没有工具权限；外部 Provider 使用自身原生工具策略，结束后必须通过真实 Git 只读检查。HEAD 变化、tracked/untracked/ignored 文件变更都阻止成功。`change` Task 携带 `analysisItems` 会被拒绝；代码变更仍需普通开发、确定性检查、精确提交审查与发布。

复用只发生在一次执行内。崩溃后不恢复旧 Workflow handle、不自动重放子项，未知清理保留占槽。SSE、Web UI、长期原生 Session 和运行中人工审批不属于本轮实现。
