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
