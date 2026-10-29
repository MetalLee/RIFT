# Host 历史基线证据与阶段计时（v1）

这是第二批的基线子任务，不是第二批 DAG/依赖缓存的交付或第三批调度。
默认配置不增加任何基线执行，原有串行 required/optional、超时清理、同候选补证、独立审核和精确 SHA 发布门禁不变。

## 显式启用

仅由 Host 操作员在 profile 的 `config.checks` 条目中配置：

```yaml
checks:
  - id: unit
    executable: node
    args: [scripts/check.mjs]
    timeoutMs: 120000
    baseline:
      environmentId: immutable-node24-project-image-v1
```

`environmentId` 是操作员对**不可变工具链及仓库外输入快照**的声明，不是任务/模型输入，也不是任意“缓存名称”。
工具、系统库、依赖来源、外部服务或其他非 Git 输入改变时必须换版本；不能保证输入不可变时，不配置 `baseline`。
直接可执行文件会额外计算 SHA-256，但这不能替代整个工具链的不可变快照。
不能用该功能证明联网获取的可变输入、时间/随机结果或任意可变 Git 引用仍有效。

每个启用条目的历史命令在独立、全新的基线 checkout 执行，**必须自行完成所需准备**，不能依赖其他检查条目的可写产物。
例如需要安装依赖时，用项目现有的单个可信检查脚本完成准备与检查，而不是假定另一个 `install` 条目已为它生成 `node_modules`。
基线、候选、角色之间没有复制或共享可写 HOME、依赖目录、索引或工作树；本轮不实现依赖缓存。

## 复用规则与持久化

- 基线是本次整合前的 `expectedTargetHead`，不是开发者自报 commit，也不是当前候选。
- `BaselineIdentity.schemaVersion: 1` 绑定 workspace、仓库注册 ID、canonical commonGitDir 哈希、有效 Git 配置哈希、基线完整 commit/tree、命令 ID/配置、完整有序检查计划指纹、sandbox/OS/Node 环境指纹、Host `environmentId` 与直接可执行文件 SHA-256。
- 配置包含 executable、参数、有效 timeout、required 和 baseline 配置。完整 tree 保守覆盖所有受 Git 管理的输入；无路径级缓存。
- `key = fingerprint(identity)`，即现有 SHA-256(JSON.stringify)；字段顺序由 Host v1 构造器固定。后继 DAG/cache 应使用此版本化身份/现有命令指纹，不把自然语言验收转换成命令。
- 以 `baseline-<key>` 为独立 operation ID，使用现有 Host operation/不可变检查 JSON 附件持久化；原子创建目录只允许一个生产者。同一可信范围内不同角色、任务、attempt 或 Host 重启可以读取同一份已完成基线。
- 只有完成 checkout 验证、清理确认、附件/日志校验的 `passed` 或 `failed` 才可复用。失败特征是退出码、失败状态、脱敏日志摘要和截断标记的哈希；只用于历史对照。
- 基线附件使用独立 `$baseline` task 绑定，**永不加入候选 `checks`/`checkIds`，不计入通过，不豁免任何必需检查，不存储或复用审核批准**。当前候选的实际失败照常阻塞。
- 无法确认身份且尚未执行时，返回 `unavailable`，仍执行候选检查。已有 claim 损坏、中断、正在执行或超时时，保守返回 `unavailable/unknown` 并阻塞候选；不自动重跑、不自动删除或重置记录。
- 父候选在进入基线执行前先落盘 cleanup unknown。重启不能用“进程可能已经退出”解锁；仍走既有 Host 同机器重启证明门禁。损坏基线记录不会自行修复或重新成为命中项；需操作员先完成真实清理/环境重建，再使用新的不可变环境版本，不能靠改名绕过旧候选的 cleanup unknown。
- 未完成 claim 没有自动重试/等待队列；本轮不新增租约绕过、手动 DB 修复或跨引用调度。

## 现有读取契约

`@rift/protocol` 的增量字段保持旧客户端兼容：

- `TaskEvidence.integrations[].baselines[]`、内部 `Candidate.baselines[]`：`key/identity/integrationId`、`recorded | reused | unavailable`、`cleanupStatus`、`lookupMs`、可选历史 `check/failureFingerprint/reason`。
- `TaskEvidence.integrations[].timings`、`Candidate.timings`：`prepareMs`（候选 Git 准备到绑定完成）、`baselineMs`（本次基线身份核对/收集/复用总开销）、`checksMs`（该候选所有实际执行代次的检查耗时累计）。
- `CheckEvidence.durationMs`：单次 sandbox 准备与命令执行耗时。使用单调时钟；`startedAt/finishedAt` 保留墙钟时间用于核对。阶段数据不是整个任务/审核/排队的总耗时。
- `lookupMs` 包括冷路径执行或热路径校验，历史 check 的 `durationMs` 不当作本次复用的执行时间；补证跳过已通过项不重复增加 `checksMs`。

继续使用现有 `GET /ui-api/v1/workspaces/:workspaceId/tasks/:taskId/evidence` 和 `rift ws task evidence <taskId> --workspace <id>`。
从 `baselines[].check.id` 获得历史附件 ID，再通过同一个候选 integration 的 `/evidence/log?integrationId=...&checkId=...` 或 `task evidence-log` 读取完整脱敏日志；workspace/task/仓库校验不放宽。
列表日志沿用 8000 字符摘录；完整附件保留已有捕获/脱敏限制。历史 `candidateHead` 是基线 SHA，不能在客户端标成当前候选通过。
本轮没有新增 UI 展示或伪造前端字段。

## 本地验证与性能样本

2026-10-29，Node 24.18.0 / Linux，真实临时 Git、bwrap、持久 JSON/SQLite、鉴权 HTTP、CLI 子进程：

- `tests/git/baseline.test.ts`：跨任务/attempt/重启命中、失败保留、命令/timeout/required/环境/Git 配置/完整基线输入/有序计划失效、workspace/仓库隔离、损坏/中断安全阻塞、optional 超时、可写输出隔离、旧配置串行。
- `tests/acceptance/evidence-ui-integration.test.tsx`：真实 HTTP/CLI 的基线附件/计时读取及 Host 重启持久化，当前失败不会进入 Reviewer；仅模型执行使用受控适配器。
- 组合 Git/恢复/证据/协议回归：21 文件、195 项通过（71.24 s）；保留第一批附件/DB 中断恢复及同候选门禁测试。
- 同一失败基线、150 ms 的夹具检查，组合回归中测得冷基线 1098.02 ms、重启复用 576.64 ms；历史检查执行 330.12 ms，当前候选仍执行 319.89 ms。冷/热开销均包含身份与 Git/文件校验；这是单次本机样本，不是生产吞吐或通用提速保证。
- 后端/测试、UI、独立协议消费者类型检查及协议边界检查已执行。使用已安装依赖的 `node node_modules/typescript/bin/tsc ...` / `node node_modules/vitest/vitest.mjs ...`；初次 pnpm 包装入口超时后没有盲目重试。

未运行全量 107 文件测试、外部模型实机探针或真实浏览器交互；未验证生产项目安装成本。DAG、安全并行、依赖缓存与第三批调度不在本子任务中实现；最终验收仍需 Host 精确提交检查与独立审核。
