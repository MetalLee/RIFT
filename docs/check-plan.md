# Host 检查 DAG 与受限并行

本任务只扩展**一个精确候选内**的检查执行，不实现依赖缓存、跨引用调度或审核批准复用。
旧 `checks` 不变：按配置顺序串行，省略 `required` 等同 `true`，没有隐式新增检查或依赖。

## 配置

在 profile 的 RIFT `config` 下显式启用：

```yaml
checkPlan:
  mode: dag
  maxConcurrency: 2
  resourceSlots: 2
checks:
  - id: lint
    executable: node
    args: [scripts/lint.mjs]
    isolation: read_only
  - id: unit
    executable: node
    args: [scripts/unit.mjs]
    resourceSlots: 1
    mutexGroup: database
  - id: integration
    executable: node
    args: [scripts/integration.mjs]
    dependsOn: [unit]
    mutexGroup: database
```

- `mode: dag` 才允许并行。默认 `maxConcurrency: 2`、总 `resourceSlots: 2`，均为 1–64 的整数；单项默认占 1 slot，不能超过总额度。它们是**调度额度**，不是 cgroup CPU/内存硬限或实际资源使用探测。
- `dependsOn` 为显式检查 ID；前置项必须实际通过，optional 前置失败也不会启动下游。未知 ID、环、自依赖、重复依赖/检查 ID、非法额度在 Host 构造阶段拒绝；`checkIds` 子集也必须包含依赖闭包。最多 64 项。
- `mutexGroup` 为非空 Host 配置名称。同组不能重叠；无关组仍受并发数及加权 slots 限制。就绪项按配置顺序挑选，不增加优先级/公平队列。
- `isolation` 默认 `snapshot`：每项在从**同一个确切 candidateHead** 新建的独立 Git worktree 开始，允许写入自己的输入副本和输出。不同检查不复制/共享可写 `node_modules`、索引或构建输出。所有快照先准备完成再运行，避免 Git 元数据枚举与 worktree 创建竞争。
- 只有 Host 明确设置 `read_only` 的项共享候选目录，并且实际以只读挂载强制执行，不只是相信声明。每项仍有独立可写 HOME/缓存、`/tmp`、PID/网络命名空间（端口可重复使用）；仓库父目录和其他检查目录不授予可写能力。复用既有 Linux bwrap 隔离，未启用不安全降级。
- 图/互斥/隔离/额度字段必须伴随 `checkPlan`；不允许悄悄忽略图配置后按旧语义运行。

### 需要 build/install 产物时

**`dependsOn` 只表示顺序，不传递产物。** 快照内的 `build` 输出不会自动出现在下游 `test` 目录；它不是可用的 install/build/test 共享环境。
选择最小的安全路径：让每个并行项的受控仓库脚本自行准备依赖，或者为整个产物流水线显式使用串行兼容模式：

```yaml
checkPlan:
  mode: serial
  maxConcurrency: 1
checks:
  - id: build
    executable: node
    args: [scripts/build.mjs]
  - id: test-build
    executable: node
    args: [scripts/test-build.mjs]
    dependsOn: [build]
```

`serial` 模式所有项共享本候选 checkout 和本轮私有 HOME；全计划只有一项在途，不宣称安全并行。不能配置 `isolation: snapshot`，以免把需要的产物隔离掉；可为纯读取下游设置 `read_only`。产物需在已提交 `.gitignore` 覆盖的路径；改动受 Git 管理的候选文件仍阻断，ignored 产物保留但会阻止直接删除有内容的工作树。

serial 显式补证只要有一项需重跑，就在新私有 HOME 中重跑整个串行计划（包括先前通过的安装/构建前置），保存新的真实附件；不从 passed 附件推断 HOME 产物存在，也不恢复或信任旧 HOME。因此旧 HOME 缺失/损坏不会被当作可复用环境。同候选 checkout 中的 ignored 产物仍保留，串行脚本须支持显式重跑；Host 不自动删除产物或回退源码。全部项仍匹配且通过时仅保留原证据，不新建执行环境。

历史 `baseline` 仍必须是独立自足命令，在全新基线 checkout 中执行；即使采用 `serial`，也不能依赖另一个历史条目的可写产物。Host `environmentId` 契约不变。

## 证据、取消与恢复

- runner 只写自己不可变的附件；单一调度器按完成顺序收集并串行更新 `operation.json`，结果列表按配置顺序稳定排列。每个附件绑定同一 workspace/repository/task/attempt/integration/candidateHead；基线附件仍分开保存、不计候选通过。
- 普通失败不丢弃已启动独立项；失败后置项保存 `skipped` 状态和可读的依赖原因，**不算通过**。必需项失败/跳过/未执行不能进入审核或发布；optional 普通失败保留原非阻断语义。
- 任务/工作流取消和 Host shutdown 会向 Host 检查传播 AbortSignal。未启动项跳过，已启动项收集取消结果。required/optional 超时、取消、丢失结果或清理未知均硬阻断审核、补证、发布。
- 每项启动前落盘 running/cleanup unknown；历史基线执行也必须先持有本候选计划租约，不能绕过旧计划未释放的资源。调度 slots 和互斥组只在已收到正常进程关闭结果后归还；超时/取消不把“已发 kill”当清理证明。停止新项并保留整个 Host 计划租约，直到既有同机器 OS reboot proof 恢复协议完成。进程重启不等于机器重启。
- `managedRoot/check-plan-lease` 是持久、排他的 Host 计划租约；旧无 `checkPlan`、显式 serial、DAG 和历史基线统一遵守，删除/降级配置或进程重启均不能绕过。读取就绪状态、补证和发布也检查此门禁，发布期间持有租约以避免检查后竞态。释放前验证 owner 文件的确切候选绑定；无 owner、损坏、多 owner 或错误绑定均阻断，重启证明也不能代替 owner 修复。当前最小实现一次只允许一个候选检查计划，不做跨候选排队/资源调度。Host 中断或租约损坏不自动删除、不自动重复命令。极窄的创建租约目录/写 owner 之间中断可能留下无 owner 的锁，需操作员在真实清理/重启证明后人工检查修复，不能靠新配置绕过未知清理。
- 重启保留 pending/running，不把它们升级成通过；重启证明只确认旧进程已退出，不补造检查证据。同候选显式补证不增加 attempt；DAG 和旧串行保留仍匹配配置/环境的通过项，显式 serial 按上文重建完整前置并生成新证据。旧代次附件只读保留，旧 check IDs 的批准不能发布新代次。任意有序计划、依赖、互斥、隔离或额度变化保守使整个计划附件失效，也进入历史基线 `configurationFingerprint` 和 `planFingerprint`。
- 快照、HOME、ignored 输出和日志保留用于排查，不自动删除/GC；实际项目需预算磁盘开销。绝不自动清除未知清理的目录。

## 读取契约

沿用 `GET /ui-api/v1/workspaces/:workspaceId/tasks/:taskId/evidence`、`rift ws task evidence TASK --workspace WORKSPACE` 和现有按 check ID 读取日志的 API/CLI；不增加命令执行或上传证据接口。

`TaskEvidence.integrations[]` / 内部 `Candidate` 增量字段：

- `checkPlan`: `mode`、有效 `maxConcurrency/resourceSlots`、`nodes[]`（commandId、dependsOn、mutexGroup、isolation、resourceSlots、status、可选 reason）。status 包括 pending/running 和实际退出状态；`HostCheckAttachment.exitStatus` 新增 `skipped`、`cancelled`，均不能标成通过。
- `timings.checksWallMs`: 最近一轮候选检查的墙钟耗时，包含隔离快照准备、调度和统一落盘，不包括候选 merge、基线、审核或排队。旧 `checksMs` 仍是各代次单项执行耗时累计；并行时可大于墙钟，不能当总延迟。
- 单项 `startedAt/finishedAt/durationMs`、精确绑定、日志摘要、脱敏和大小限制不变。skipped 为 Host 生成的未执行证据，不是实际命令通过。

UI 解析和中文展示需兼容新增状态；本后端任务不接管 UI，已将契约集中通知 Lead。HTTP/CLI 提供完整新字段，老 UI 不应把未知状态视为通过。

## 实测与局限

2026-10-29，Linux / Node 24.18.0，真实临时 Git、bwrap、进程、JSON/SQLite 和鉴权 HTTP/CLI，仅模型激活使用受控测试适配器。

命令与重复验证入口（使用已安装依赖）：

```sh
/usr/local/bin/node -e 'setTimeout(()=>console.log("a"),1000)'
/usr/local/bin/node -e 'setTimeout(()=>console.log("b"),1000)'
node node_modules/vitest/vitest.mjs run tests/git/check-plan.test.ts
node node_modules/vitest/vitest.mjs run tests/git tests/core/coordinator.test.ts tests/core/review-retry-route.test.ts tests/core/boot-identity.test.ts tests/core/boot-identity-platform.test.ts tests/core/scheduler-migration.test.ts tests/acceptance/coordinator-faults.test.ts tests/acceptance/host-evidence.test.ts tests/acceptance/evidence-ui-integration.test.tsx tests/acceptance/review-result.test.ts tests/acceptance/source-recovery-review.test.ts tests/acceptance/blocked-workflow-recovery-review.test.ts tests/protocol ui/src/protocol-contract.test.ts ui/src/task-evidence.test.tsx
node node_modules/typescript/bin/tsc --noEmit
```

同样两项命令，旧串行 2418.14 ms、DAG 只读并行 1262.28 ms（约 1.92×，下降 47.8%）；随后带 HTTP/CLI 回归负载的样本为 2508.87 / 1310.19 ms。最终组合回归样本为 2442.86 / 1285.42 ms（约 1.90×）。数据为 `checksWallMs`，不是 mock 调度计时，也不是生产吞吐保证。依赖/互斥/额度以真实单项起止时间断言；并行写入同名文件、HOME/cache、`/tmp` 与同一 TCP 端口仍无串扰。

最终相关回归 27 文件、272 项通过（85.46 s）；后端/测试、UI、独立协议消费者类型检查、协议边界检查及后端编译通过。

验证还覆盖实际 Host 子进程中断、required/optional 超时、三类取消、同候选补证和附件/DB 更新之间崩溃恢复、旧 waiting 不阻塞新 attempt、历史基线策略指纹失效。测试使用合成 boot identity 验证恢复门禁，没有重启宿主操作系统。

未实现自动产物传递、依赖缓存、跨引用调度、CPU/内存硬限或快照 GC；未运行生产项目依赖安装性能/外部模型探针/真实浏览器交互。最终验收仍由 Host 对精确提交执行检查及独立审核。

### 第二轮修复验证（2026-10-29）

- 以上组合回归通过 27 文件 / 287 项（126.53 s）；随后收紧“确认日志仍持有租约”的恢复窗口，再跑 `tests/git/check-plan.test.ts tests/git/core-integration.test.ts tests/git/integration.test.ts tests/git/baseline.test.ts`，4 文件 / 99 项通过（80.21 s）。不把先前受工具时间上限中断的运行计为通过。
- 新增覆盖旧串行/serial/DAG 各自 required/optional 超时后的配置降级、重启、基线及候选执行阻断、无 owner/损坏/错误绑定租约、合法 reboot proof 恢复；即使日志临时显示 confirmed，仍持有的租约也不能仅凭该日志释放。基线超时的旧测试改为断言在下一次基线读取前阻断。
- serial 的真实 `$HOME/tool` 安装与调用覆盖同进程补证、独立 Host 子进程消费持久记录、旧 HOME 保留/缺失/损坏、跨任务/候选隔离、新前置附件、旧代次批准失效和 attempt 不增加。
- 最新真实命令对照：串行 2501.52 ms、DAG 并行 1318.42 ms（约 1.90×）。后端/测试、UI、协议消费者类型检查、协议边界检查及后端编译通过；协议先在当前工作树构建，不使用主检出的旧构建。
- 未实际重启宿主 OS，恢复使用合成 boot identity；未做全量测试、生产依赖安装或浏览器探针。serial 重建会增加补证耗时且要求脚本可重跑；不自动删除 ignored 产物、恢复旧 HOME 或增加缓存功能。未修改前端，新状态契约不变，前端修复由 Host 合入。
