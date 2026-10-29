# RIFT 仓库前端检查 profile（显式启用）

## 状态与受支持的部署入口

本轮新增 **`profiles/rift.codex.frontend.patch.yml`**，不是对运行中 Host 的热更新。
默认 `rift.patch.yml` / `rift.codex.patch.yml` 仍只有 diff-check；提交 profile 不会替当前 workspace 补上门禁。
`RiftHostService` 在构造时把 Host `checks/checkPlan/environmentCache` 交给 `LocalGitService`，没有 workspace/task 请求可修改这些命令。
开发者的 `checksClaimed`、本文、终端日志或截图都**不是** Host 检查附件，不能上传来替代检查。

操作员完成下述准备，并在没有活动执行、未知清理租约得到合法处理后，通过现有启动入口选用：

```sh
# 在包含本提交且已构建后端的部署 checkout 中，由操作员执行；不是本轮已执行命令。
node dist/cli/main.js serve --home /path/to/approved-rift-home \
  --profile rift-frontend --patch profiles/rift.codex.frontend.patch.yml
```

`--profile` 选择 DSH profile 名，**`--patch` 才选择这里的 RIFT 检查配置**；采用现有 Codex provider 设置。
不得在运行中再启动一个 Host 争用同一 home；部署应保留原 workspace、task/run、source、attempt、候选绑定及清理协议。
旧附件因整套配置变化失效，必须走 Host 对原精确候选的显式补证流程，不能重派开发或拿旧批准发布新证据代次。

前置条件：Linux bwrap/既有出网代理、沙箱 `/usr/local/bin/node` 为 Node 24、`pnpm` 为 packageManager 指定的 **11.4.0**（含可用 Corepack 包），公共 registry 可达。
检查不能访问主检出 `node_modules`、开发者 HOME/凭据或任意环境变量；不要把它们作为安装前置。
安装使用 frozen lock、私有 `.pnpm-store`、禁用 lifecycle 脚本、显式关闭下载重试；下载失败/超时必须阻断。
本次完整冷安装在 240 秒工具上限中断（大型原生包下载错误），**未证明整个安装链在 Host 中成功**。profile 单项安装上限为 600 秒，不意味着已经通过。

浏览器检查使用仓库已有 `ui-secondary-reuse-check.mjs`，操作员须预置只读、版本匹配的：

- Playwright **1.61.1**：`/usr/local/lib/node_modules/playwright`；
- 其 Chromium 1228 与 headless shell：`/usr/local/share/ms-playwright`；
- Chromium 所需系统库（无显示服务器要求）。

这些路径在现有 Host 沙箱只读 `/usr` 中可见。不要配置 `/root/.cache` 或其他项目路径：本地可用不代表 Host 可见。
本任务不安装系统依赖、不改运行中配置、不读取管理凭据。缺少上述任一条件会真实失败，**浏览器项不是 optional**。
若部署采用其他受控路径，操作员必须显式改 profile 参数，并重新生成 Host 证据；不能只改环境后复用旧通过项。

## 计划与后续组合采用的命令

`checkPlan: { mode: serial, maxConcurrency: 1, resourceSlots: 1 }`，全部 required：

| ID | 命令 | 前置 |
|---|---|---|
| diff-check | `git diff --check HEAD^ HEAD` | 无（辅助检查，不代表 UI 已验证） |
| frontend-install | `pnpm install --frozen-lockfile --ignore-scripts --store-dir .pnpm-store --fetch-retries=0 --fetch-timeout=60000` | diff-check |
| frontend-protocol | `pnpm build:protocol` | install |
| frontend-unit | `pnpm test:ui:prepared` | protocol |
| frontend-types | `pnpm typecheck:ui:prepared` | protocol |
| frontend-build | `pnpm build:ui:prepared` | protocol |
| frontend-buttons-browser | `node scripts/check-ui-browser.mjs /usr/local/lib/node_modules/playwright /usr/local/share/ms-playwright` | build |

`test:ui:prepared` 只运行 `ui/src` 全部前端测试及新增 profile 加载回归（包含按钮、状态、API、证据展示），不重复跑整个后端套件；不会漏掉原 `test:ui` 固定列表之外已存在的 UI 回归。
原 `test:ui/typecheck:ui/build:ui` 保留“先构建协议再执行”的行为，直接使用 prepared 命令前须已构建**当前 checkout**的协议包。

显式 serial 是产物流水线：全部项共享本候选 checkout / 本轮私有 HOME；不并行写 `packages/protocol/dist`、`node_modules`、`dist/ui`。
DAG `dependsOn` 不传递快照产物，所以不把 install/build 与消费者拆成独立 DAG 快照。原有 `environment.kind: npm-ci` 只接受 npm lockfile、不支持 pnpm workspace；此 profile 不启用 environmentCache，也不新建缓存。
所有输出位于现有 ignore 路径，不能改写受管理源码；Host 仍验证候选清洁和完整 SHA。

浏览器入口自动启动随机本机端口的 **当前生产构建**预览，最后关闭预览及浏览器。它使用确定性 API fixture，无真实 Host 业务写入；检查 13 个按钮的样式/hover/focus、忙碌与禁用状态、390px 溢出与写入清单（另含忙碌、展开/收起及版本状态，共 16 个样本）。
截图默认在 `.runtime-evidence/secondary-reuse`，断言报告写 stdout；本地也可用 `RIFT_UI_EVIDENCE_DIR` 改位置。截图不自动变成 Host 附件；Host 权威日志来自进程输出。
本地复现（已准备依赖/协议/构建）：

```sh
pnpm test:ui:prepared
pnpm typecheck:ui:prepared
pnpm build:ui:prepared
node scripts/check-ui-browser.mjs /absolute/path/to/playwright /absolute/path/to/ms-playwright
```

## 已有持久证据与安全复用契约

权威实现：`src/git/integration.ts`、`src/git/evidence.ts`；详细背景见 [check-plan](check-plan.md)、[baseline](baseline-evidence.md)、[依赖环境](dependency-environments.md)。本任务未更改后端机制。

- Host 在 managedRoot 中保存每个 integration 的原子 `operation.json` 及不可变 checks 附件（脱敏 stdout/stderr、退出码、时间、`logSha256`、截断标记）。列表摘录最多 8000 字符；完整读取仍受捕获/脱敏上限约束，不能称无限原始日志。
- 附件绑定 `workspaceId/repositoryId/repositoryFingerprint/taskId/attempt/integrationId/candidateHead`；Host 来源标记 `executionSource: host`、命令配置指纹与环境指纹。开发 run 与独立 review run 仍由既有任务生命周期持有；检查附件不是开发者 result JSON。
- 配置指纹覆盖 executable/args/timeout/required、完整有序计划与依赖/隔离/额度（及配置的 baseline/environment）。环境指纹实际覆盖 sandbox 版本、OS/arch/kernel、Host Node 版本，**不是所有 pnpm、传递工具、浏览器二进制的内容哈希**。
- 已清理、精确同候选/绑定/配置/环境、实际 `exitCode: 0 + passed` 的附件才可复用；失败、missing、pending/running、skipped、取消或超时不能升为通过。未知清理租约仍阻断；Host 重启不等于进程清理证明，不能自动重复命令。
- **显式 serial 补证**：若有一项必须重跑，则在新 HOME 中重跑整个流水线（含安装/协议），生成新附件；全部仍匹配且通过时才保留原证据。不把旧 HOME/安装输出当可恢复环境。其他模式可以保留匹配的通过项，不能据此宣称此 serial 会只重跑单个 UI 检查。
- 历史 baseline 是 expectedTargetHead 的独立证据，不能满足候选检查或复用审核。此 profile 未配置 baseline：联网安装及未声明不可变工具链不应获得虚假的 `environmentId`。pnpm 依赖快照支持缺口不由本任务另建缓存补上。
- **组合/操作员须处理的环境身份限制**：当前 Host 指纹不会自动发现同 Node/OS 下 pnpm、Playwright、Chromium 或系统库替换。要保证同候选复用安全，应保持检查环境不可变；工具变更必须显式版本化 profile 命令/参数来失效整套附件并补证，不能仅替换磁盘文件或重启 Host 后认定已有指纹足够。

读取/补证沿用已有权限及版本门禁：

```sh
rift ws task evidence TASK --workspace WORKSPACE
rift ws task evidence-log TASK --workspace WORKSPACE --data '{"integrationId":"…","checkId":"…"}'
```

HTTP：`GET /ui-api/v1/workspaces/:workspaceId/tasks/:taskId/evidence` 及 `/evidence/log?integrationId=…&checkId=…`。
显式补证为同路径 POST（`integrationId/candidateHead/expectedVersion/idempotencyKey`），只允许 Host 重新执行配置命令，不接受上传 stdout/exitCode。
审核与发布必须继续绑定新的精确候选及 check IDs；开发者本地通过不替代独立审查。

## 前置任务真实本地验证（不是当前 workspace 的 Host 验收）

2026-10-29，Linux / Node 24.18.0，基线 `2f9840378f80208ac4119f0698cf17c12ba8dbbb`。
安装中断后，本地检查显式使用已有 `/data/projects/RIFT/node_modules` 工具链链接，`@rift/protocol` 指向本任务 checkout 并重新构建；未把主检出的旧协议产物当本任务输入。
浏览器本地使用现有外部 Playwright 1.61.1 与 `/root/.cache/ms-playwright`，仅为开发验证，不属于沙箱部署证明。

- 当前协议编译、UI 类型检查、仓库/测试 TypeScript 检查、Vite 生产构建退出 0（构建保留原有 >500 kB chunk 警告；未做 P2 拆包）。
- UI/profile：23 文件、160 项通过；DSH 公共 `loadOverlayPatches` 实际加载，并由 `LocalGitService` 验证计划/命令。
- `tests/git/baseline.test.ts tests/acceptance/host-evidence.test.ts`：2 文件、21 项通过，覆盖跨重启历史证据、配置/来源失效、真实 HTTP/CLI 日志及拒绝伪造附件；不是把 fixture 的命令当 UI 命令。
- `tests/git/check-plan.test.ts` 定向 serial 产物、补证身份、HOME 重建/隔离：7 项通过、23 项未选中，不称整文件全通过。
- 按钮生产预览浏览器回归退出 0，16 样本通过，1280/390px、focus/hover/disabled、fixture 写入清单均实际断言。
- 未成功项：早期 `pnpm exec tsc --version` 超过 10 秒工具上限；完整安装超过 240 秒并有下载错误；首个 Playwright 1.58.2 因 Chromium 1208 缺失退出 1。未自动重复这些命令；改用已安装工具和匹配的 1.61.1/1228 后才取得上述通过结果。

本地原日志在 `.runtime-evidence/frontend-checks/`，不入 Git、不冒充 Host 附件。当前运行 workspace **未启用**此 profile，冷安装/沙箱浏览器部署尚未完成，最终组合候选仍须操作员采用此 profile 后由 Host 实际执行、保存附件并独立审查。没有 push/PR、管理配置修改、缓存重建或 UI/P2 改动。


## 组合任务复验（2026-10-29）

基于集成提交 `44b0bd6f18fc8a5d7cdadbdbcc8bba425583d388`，本轮任务 checkout 的 `node_modules` 与私有 `.pnpm-store` 初始不存在。
相同 profile 安装命令本次成功（80.4 秒），没有链接主检出依赖；这更新了上节历史冷安装失败的本地结论，**仍不证明运行 Host 沙箱安装链已通过**。

- 新增 `tests/acceptance/combined-recovery.test.ts`：真实 Host 管理 API / workspace CLI、Git、租约、不可变结果 artifact 与检查附件，仅外部 provider 受控替代。删除/重命名已提交源码从格式补交、收集失败、幂等恢复，到缺证补证、serial 全链重跑、未变通过附件复用、审查基础设施恢复及精确提交发布，均保持同一开发 Run/attempt；旧失败事实不改写。
- 失败反例：diff-check 真实退出 0，required 源码断言退出 1，仍拒绝审查/发布及基础设施恢复（`CODE_REPAIR_REQUIRED`）。组合 fixture 的小型源码断言不是实际前端检查，真实 UI/profile 测试另行执行。
- 受影响测试：31 文件、382 项通过，涵盖组合/恢复 API、源码收集、coordinator、baseline、安全补证、check-plan，以及全部 `ui/src` 与 profile 加载回归。`pnpm typecheck` 与 `pnpm build` 成功；构建保留既有 >500 kB chunk 警告。
- profile 浏览器命令实际报 `MODULE_NOT_FOUND`：`/usr/local/lib/node_modules/playwright` 不存在；`/usr/local/share/ms-playwright` 也未预置。本轮不宣称浏览器通过，不使用旧截图/旧开发日志替代。

本轮日志在任务 checkout 的 `.runtime-evidence/p1-combined/`（`cold-install.log`、`protocol.log`、`combined-tests.log`、`affected-tests.log`、`typecheck.log`、`build.log`、`profile-browser.log`），不是生产 Host 的候选附件。
本轮未启用运行 Host 的前端 profile，未重启 Host、改模型/连接、预置系统依赖或新增缓存；第四项 P1 的**部署门禁仍待操作员落实**。
操作员仍须按上文预置只读 Playwright/Chromium 与系统库，安全切换 `--patch profiles/rift.codex.frontend.patch.yml`，在不可变工具环境中对精确候选生成真实 Host 附件并独立审查。仅本地冷安装成功、提交本测试或替换工具而不版本化命令，都不能解除此门禁。
