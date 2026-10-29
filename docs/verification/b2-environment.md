# 第二批环境复用：本地开发验证

日期：2026-10-29。基线 `0ea9d8ce6ff5b92a04bb7a49e609551e17a26a44`，独立任务工作树；未修改主检出、未 push。本记录是开发自测，不代表 Host 精确候选验收或独立审核批准。

环境：Linux x64，Node v24.18.0 / ABI 137，npm 12.0.2，既有 bwrap 沙箱；已有依赖工具仅链接到本树本地 `node_modules`，本树单独构建 protocol dist。

## 实际命令和结果

- `node_modules/.bin/tsc -p packages/protocol/tsconfig.json`：通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `node_modules/.bin/tsc -p tsconfig.build.json`：通过。
- `node_modules/.bin/tsc -p ui/tsconfig.json`：通过。
- `node_modules/.bin/tsc -p tests/protocol/tsconfig.json`：通过。
- `node scripts/check-protocol.mjs`：`Protocol: isolated package consumer, empty runtime, and UI/server boundary passed.`
- `node_modules/.bin/vitest run tests/git tests/protocol ui/src/protocol-contract.test.ts`：16 文件、205 项通过，175.25 s。完整实际输出（仅去 ANSI 颜色）见 [回归日志](b2-environment-regressions.log)。含原有移除 checkPlan 后未知租约保护、serial HOME 重建及 ref_published 租约恢复测试。
- 最后收紧远程包认证/查询参数排除并补对应断言后，再运行 `tsc --noEmit`、后端构建及 `vitest run tests/git/dependency-environment.test.ts`：28 项全过，输出见 [最终环境测试日志](b2-environment-npm.log)。此次最终增量未重跑其他 177 项。
- `git diff --check`：通过。

最初 `pnpm build:protocol` 被 pnpm 工作树自动依赖安装的无 TTY 模块目录探测阻止，未完成构建；改为直接调用既有本地 tsc，以上均是真实运行结果。首次新增环境测试有一项预期错误名不符（实际 CLEANUP_UNKNOWN 已阻断）；修正断言后全过，未把该失败当通过。

## 真实冷暖样本

205 项回归同机并发负载下的单次数据（非统计基准）：

| 阶段 (ms) | 冷 | 暖 |
| --- | ---: | ---: |
| npm 环境准备（含输入/工具链哈希、校验等） | 2149.85 | 1603.36 |
| 真正 npm ci --offline 安装 | 589.36 | 0 |
| 私有复制及复制结果校验 | 0 | 8.38 |
| 安装/恢复 + 当前候选真实检查总时长 | 2300.09 | 1805.89 |

独立环境测试此前样本：prepare 1733.44 → 1151.11 ms，install 561.89 → 0 ms，restore 4.48 ms。每次 fixture 都本地生成固定内容的 `.tgz`，npm `--offline` 真正安装，再真实 `require`；两个失败的 postinstall 脚本均因固定模板而未执行。绝无网络失败即跳过/伪通过。日志保留每次实际样本；tarball 时间戳/临时 Git 树不同导致样本键不同是正常现象。

同次回归还记录现有基线 cold/warm 835.95/369.22 ms、现有 DAG serial/parallel 2439.13/1313.34 ms，仅作保留能力的实测对照，不作为新优化的承诺。

## 覆盖与局限

新增 28 项覆盖真实冷暖/禁用/不适用配置安装、当前检查失败不被命中掩盖、不同任务 HOME/inode 隔离、真实 DAG single-flight、独立 Host 子进程 SIGKILL 保留构建租约、绑定恢复、普通失败/取消/丢失结果、损坏冷启动、正常与越界链接、只读发布与私有可写恢复、凭据跨流块排除、容量及使用租约回收、未知 staging/owner 保留、完整源码/manifest/lock/模板/参数/信任范围失效及恢复配置指纹。

未运行全仓全套测试、线上 registry、大型真实项目、真实 OS 重启/断电、异构 OS/ABI/工具链升级或长时压力测试；同机器重启证明在测试中以既有协议 fixture 注入，不声称实际重启。跨 Host 遇租约 fail-closed 而非抢占等待；仅支持脚本禁用 npm 模板。完整源码/工具链哈希有成本，性能受项目规模和负载影响，保守凭据识别可能使正常依赖回退。未实现第三批跨引用调度、其他包管理器、共享 HOME/下载目录或审核结论复用。

## Attempt 3：独立审核 P1 修复后的重新验证

当前任务树从 `9ed7c7c1b588f98ba84783863f1278be85b569bb` 开始，未写旧树或主检出。此前记录仅为历史证据；本节及新日志为本次实际执行。

- 非根 lock 项不能省略/清空 `resolved`；实际根 `packages[""]` 无 `resolved` 仍合法。对跟踪 manifest、packages 声明和 v2 legacy 图统一检查来源；不支持格式、外部 tarball、链接/工作区、shrinkwrap 优先级、路径歧义、无法验证的远程 integrity 等在读取快照前回退真实安装。只保留可证明输入的普通相对跟踪 tarball 和 HTTPS 完整性来源，未扩展安装脚本能力。
- 键 schema 1 → 2，旧快照键不能再命中；仍按原有租约/容量规则处理，不主动破坏未知租约。输入不可缓存时没有 key，不读取也不发布快照。
- 最终 `node_modules/.bin/vitest run tests/git tests/protocol ui/src/protocol-contract.test.ts`：16 文件、208 项通过，177.27 s（环境测试 31 项）。含取消/跨 Host SIGKILL、未知清理、租约回收、损坏、凭据、跨任务隔离、DAG 发布及 ref_published 恢复回归。见 [完整本次回归日志](b2-environment-attempt3-regressions.log)。
- 最终 protocol/后端构建，后端、UI、协议类型检查及协议边界检查均通过，命令见 [本次构建日志](b2-environment-attempt3-build.log)。直接使用已有工具，本树本地依赖链接与 protocol dist 未提交。
- 初轮 31 项中有两项 fixture 失败：候选 merge commit 与 source commit 的断言不符；npm 12 默认拒绝非 registry 主机的 URL。改用相同 source/target commit 和默认 registry URL 后，定向真实测试通过，并完整重跑上述 208 项；未修改生产安装参数或以跳过代替安装。

最终并发负载下单次真实对照（ms，不是统计基准）：

| 样本 | 冷准备 | 暖准备 | 冷安装 | 暖安装 | 暖私有恢复 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 跟踪 tarball | 2242.91 | 1350.89 | 594.94 | 0 | 6.28 |
| HTTPS + 有效 integrity | 2110.27 | 1639.47 | 587.88 | 0 | 6.81 |

HTTPS 用本地 tarball 填充私有 npm 内容寻址下载缓存，然后真实沙箱 `npm ci --offline` 使用 HTTPS resolved 和 integrity 安装；暖命中不调用安装，随后真实 require 校验。没有联网、没有换成假安装。

P1 外部 tarball 位于 Git 元数据目录：候选 commit 固定为 `8c9e18a8495eef09c6011249fcc472d8a3119fba`，lock 字节不变，非根项只有 version。启用缓存冷执行实际安装 605.36 ms 并读取 `installed`；修改外部 tarball 后暖执行实际安装 609.19 ms 并读取 `changed-external`；关闭缓存实际安装 648.08 ms 同样读取 `changed-external`。三次均 ready、fallback、无 key/恢复/缓存发布，真实检查全部执行。

现有基线 cold/warm 为 847.05/373.64 ms；DAG serial/parallel 为 2488.52/1296.02 ms，仅记录保留能力，不作性能保证。

未运行全仓全部测试、线上 registry、大型项目、真实断电/重启或异构平台；来源白名单保守，部分合法复杂表达式会回退，旧条目在可回收前仍占容量。未实施第三批、未改 Host 门禁、未 push；本次提交仍需 Host 精确候选检查和独立审核。
