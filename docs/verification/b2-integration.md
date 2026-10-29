# 第二批组合验证收口（2026-10-29）

起点：`1bd65b5183d51e77a5f2d713d014e621447aba18`。仅在分配的任务 worktree 修改测试和文档，未修改后端/前端生产逻辑、主检出或第三批调度，未 push。本地提交是待 Host 检查/独立审核的实现，不是最终验收。

## 组合使用与回退

在现有 Host profile 的 `config` 下配置（保留原插件入口、home 等）：

```yaml
checkPlan:
  mode: dag
  maxConcurrency: 2
  resourceSlots: 2
environmentCache:
  enabled: true
  maxBytes: 1073741824
checks:
  - id: unit
    executable: /usr/local/bin/node
    args: [scripts/unit.cjs]
    environment:
      kind: npm-ci
      templateVersion: npm-script-free-v1
      offline: false
    baseline:
      environmentId: immutable-node24-project-inputs-v1
  - id: integration
    executable: /usr/local/bin/node
    args: [scripts/integration.cjs]
    dependsOn: [unit]
    environment:
      kind: npm-ci
      templateVersion: npm-script-free-v1
      offline: false
```

脚本由目标仓库提交，不是 RIFT 内置。`dependsOn` 只定顺序，不传递产物；每项依赖都是私有可写副本。需要共享安装/构建产物时用 [serial 模式](../check-plan.md)，不能给 serial 配 `environment`。

- **基线不是通过或批准**：`environmentId` 是 Host 对不可变工具链/仓库外输入的声明，不能保证时不要启用 baseline；外部输入改变必须换版本。完整有序计划/缓存配置变化使旧基线身份失效；当前候选仍实际执行所有必需检查，独立审核绑定精确候选及本代 check IDs。
- **缓存仅为输入**：键 schema 2，旧键不命中。要求受跟踪的 manifest 和 lock v2/v3、可证明来源；非根缺 `resolved`、仓库外 tarball 等不发布/消费快照，仍真实安装。只支持 Linux bwrap 内固定 `npm ci --ignore-scripts --no-audit --no-fund`，不执行 lifecycle/native build 脚本；需要这些脚本的项目不要使用此模板。详见[安全输入和容量边界](../dependency-environments.md)。
- **slots 不是 OS 硬限**：并发/加权 slots/互斥为单候选调度额度，不限制实际 CPU、内存、磁盘；每项快照、HOME、ignored 输出保留，须预算磁盘。无跨引用调度、共享可写依赖或自动 GC。
- **关闭顺序**：暂停派发并确认在途清理，停止 Host，再设 `environmentCache.enabled: false`（或移除缓存配置）并重启。保留 `environment` 时每项仍执行真实 npm 安装；移除 `environment` 必须自行恢复原安装命令。配置变化需显式补证并重新审核，不能复用旧批准。未知租约不会因关闭缓存或移除 `checkPlan` 而释放，不能手删目录绕过；继续走[已有清理/重启证明恢复](../check-plan.md#发布租约的持久恢复顺序)。程序版本降级须按 README 使用配套完整备份，不直接用旧程序写新 home。
- **读证据**：HTTP task evidence 和 `rift ws task evidence TASK --workspace WORKSPACE --home HOME --json` 返回有效 checkPlan、计时、基线和 `dependencyEnvironment`；日志用 `task evidence-log` 传 integrationId/checkId。不上传命令或伪造通过。同 source/attempt 多次重审产生多条有效 integration 时，现有 API `currentCandidate` 可为 null，UI 保守显示当前绑定未知，不猜最近项；后端仍凭精确 integration/候选/check IDs 审核发布。

## 覆盖及证据来源

新增组合测试复用 `tests/acceptance/evidence-ui-integration.test.tsx` 的真实 Git、持久 SQLite、鉴权 HTTP、CLI 子进程与 UI consumer；npm tarball/lock fixture 抽取自既有 dependency-environment 测试供两者复用。仅模型激活/Reviewer 输出是显式测试适配器，不冒称外部模型审核。

| 交界 | 本轮验证入口与断言 |
| --- | --- |
| 三项联通 | 新测试同轮历史失败基线 recorded → 重启 reused；DAG 候选 npm miss/hit → 重启 hit/hit；关闭后 fallback/fallback 并真实安装，基线配置身份失效。每轮候选真实执行、依赖私有写入/HOME 无串扰、新附件 IDs，历史失败不进入候选 IDs。两次阻塞审核均未发布，最后新审核绑定当前 IDs 和精确 ref。 |
| HTTP → UI | 既有 skipped 场景新增实际响应 adapter/SSR 断言；新增取消正在执行计划及未启动后置项，HTTP/CLI 读到 cancelled/skipped，adapter 两项 passed=false，渲染已取消/已跳过且不显示通过，重启持久保留。未改前端生产代码。 |
| 基线失效/精确批准 | 复用 baseline、host-evidence、evidence-ui-integration、integration/core-integration 回归：完整源码/配置/环境/有序计划失效，旧候选 SHA/旧代附件不能充当新批准。 |
| 门禁/恢复 | 复用 check-plan、core-integration：去除/降级 checkPlan 不能越过未知租约；serial HOME 前置全重建及子进程重启；发布 CAS 后释放租约前中断，恢复后实际执行/审核/发布下一候选；operation 附件/DB 窗口、清理/owner 错配保守阻塞。OS reboot proof 使用合成 boot identity，未重启宿主。 |
| 环境安全回退 | 复用 dependency-environment：同 commit/lock 的仓库外 tarball 改变且非根缺 resolved，缓存开启和关闭均真实安装新内容；安全来源仍可命中；跨任务 inode/HOME 隔离、同键排队、损坏/取消/未知 staging/租约不误通过。HTTPS 来源用本地内容寻址缓存种子离线安装，不代表 registry 联网实测。 |

## 同环境实测（毫秒）

Linux 6.8.0-134-generic x86_64，Node 24.18.0、npm 12.0.2、pnpm 11.4.0，4 个可用逻辑 CPU；测量时主机约 7685 MiB RAM、无 swap。所有命令使用当前树依赖/构建。不是生产项目、统计基准或性能承诺。

为避免其他测试文件竞争，专门采样 `--maxWorkers=1`，各夹具内冷暖及串并行使用相同命令/输入：

| 项目 | 冷/串行 | 暖/并行 | 解释 |
| --- | ---: | ---: | --- |
| 历史基线收集 `baselineMs` | 864.76 | 266.19 | 历史真实检查 311.47；暖轮当前候选仍执行 281.33。 |
| 两项各等待 1000 ms 命令 `checksWallMs` | 2420.62 | 1246.03 | 原串行 vs DAG read_only；包含调度/隔离/落盘，非整任务耗时。 |
| npm 环境 `prepareMs` | 1617.69 | 1101.75 | 冷安装 594.48；暖 installMs=0，复制校验 restoreMs=3.84。 |
| 上述候选真实检查 `durationMs` | 1758.45 | 1243.96 | 包括环境准备；暖命中仍运行候选命令。 |

三项联通测试在相关回归（3 workers）中的样本：

| 轮次 | baselineMs | checksWallMs | 候选环境 |
| --- | ---: | ---: | --- |
| 冷 | 3329.64 | 5420.20 | miss / hit |
| 重启暖 | 449.65 | 4060.84 | hit / hit |
| 关闭快照 | 1583.20 | 1822.98 | fallback / fallback（均真实安装） |

这里 **关闭快照反而更快**：极小离线依赖的安装成本低于完整源码/工具链哈希与复制成本，不能把暖命中或合成等待命令的近两倍表现推广为生产提速。联通夹具有依赖顺序，并非吞吐基准。

`/usr/bin/time -v` 观测（整条测试命令，不是单检查资源配额/并发峰值总和）：

| 运行 | elapsed | user / system 秒 | max RSS KiB | filesystem outputs |
| --- | ---: | ---: | ---: | ---: |
| 单 worker 专门采样 | 14.64 s | 5.73 / 5.76 | 169412 | 6592 |
| 相关回归 | 194.65 s | 189.39 / 255.40 | 285540 | 962656 |
| 全量测试 | 296.72 s | 308.08 / 358.08 | 554680 | 3287104 |

RSS 为 GNU time 进程/后代报告口径，非整棵同时存活进程树内存之和；filesystem outputs 是工具计数，不是缓存净容量。未做逐项 CPU/内存采样、cgroup 资源隔离、生产大依赖树磁盘/吞吐基准。当前环境无可读的 cgroup v2 cpu.max/memory.max，未据此推断硬限。

## 命令及结果

原始输出已去 ANSI、去行尾空白并统一单个 EOF 换行，存于本目录 `b2-integration-*.log`；见日志内命令与计时。开发期测试先修正了 fixture 请求字段、重启后需显式 resume、CLI 请求键复用及 currentCandidate 歧义的错误期望，初轮失败不计通过。尝试后台运行相关回归被工具生命周期终止（日志为空、未产出结果），改为前台长时命令后才获得以下结果。

```sh
pnpm install --frozen-lockfile --offline
pnpm typecheck
pnpm build
pnpm test:protocol
pnpm test:built-cli
pnpm test
# 相关回归的完整文件列表见 b2-integration-regressions.log 的 time 命令行
# 专门性能采样：
node node_modules/vitest/vitest.mjs run tests/git/baseline.test.ts tests/git/check-plan.test.ts tests/git/dependency-environment.test.ts --maxWorkers=1 -t 'persists and reuses a failed historical|proves real independent command speedup|runs real offline npm ci cold/warm'
```

- 相关回归：29 文件 / **391 通过**，194.31 s（Vitest 口径）。
- 全量：109 文件 / **933 通过、1 跳过**，294.32 s。跳过的是 `RIFT_NETWORK_TESTS=1` 才启用的公共 npm 安装/更新/删除网络测试，不声称联网通过。
- `pnpm typecheck` 后端/测试与 UI 通过；另以临时 tsconfig 显式包含本次 acceptance TSX，启用 react-jsx/Bundler/DOM 类型检查通过（根配置默认仅包含 tests/**/*.ts）。
- `pnpm build` 包含协议、后端和 UI 通过；Vite 保留现有 >500 kB chunk 提示，无新增依赖或拆包改造。
- `pnpm test:protocol`：5 文件 / 19 通过，含隔离包消费者和边界检查；`pnpm test:built-cli`：外部 cwd、无 UI 的编译产物 CLI/HTTP smoke 通过。

未执行外部模型实机调用、真实浏览器交互、线上 registry、真实 OS 重启/断电、生产负载或第三批调度；测试适配器和合成重启证明不能替代这些验证。Host 仍须对实际候选提交运行检查与独立审核。
