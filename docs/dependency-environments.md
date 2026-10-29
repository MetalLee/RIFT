# 显式依赖环境快照（第二批）

这是检查的输入优化，不是检查证据或审核批准。默认关闭；没有新增配置的旧检查仍走原串行路径。基线/DAG/cache 的组合配置与最新实测见[组合记录](verification/b2-integration.md)。

## 最小启用配置

Host profile 的 `config` 下（现有 `home` 等配置不变）：

```yaml
checkPlan:
  mode: dag
  maxConcurrency: 2
  resourceSlots: 2
environmentCache:
  enabled: true
  maxBytes: 1073741824
checks:
  - id: test
    executable: /usr/local/bin/node
    args: [scripts/test.cjs]
    isolation: snapshot
    environment:
      kind: npm-ci
      templateVersion: npm-script-free-v1
      offline: false
    timeoutMs: 120000
```

仅支持现有 Linux bwrap 沙箱内的固定 `/usr/local/bin/npm ci --ignore-scripts --no-audit --no-fund` 模板；`offline: true` 额外传 `--offline`，不做联网重试。要求提交 `package.json`、v2/v3 `package-lock.json`。安装失败会阻断当前检查，不会当作通过。超时分别约束安装和检查子进程；键计算/复制不是子进程，不受该超时约束。

`environment` 只允许用于 DAG 的每项私有可写候选快照，不支持 `read_only` 或共享产物的 `serial` 模式。每项检查先准备依赖，再运行其真实 `executable/args`。安装脚本一律不执行；需要 lifecycle/native build 脚本的项目应继续用原先显式安装/检查命令，不应启用这个模板。任意命令、`baseline.environmentId` 都不会自动获得快照能力。

## 键与存储边界

- 键覆盖 workspace ID、repository ID/真实 Git 元数据目录指纹；平台、架构、内核、Node 版本/ABI、运行时 libc、实际沙箱 Node 二进制内容；npm 版本及整个 npm 工具目录内容。
- 覆盖完整 Git 树及所有跟踪文件实际内容、manifest/lockfile、模板版本与固定安装参数（包括 offline）。保守绑定整个源码树，不只检查 lockfile。恢复配置也进入候选/基线证据配置指纹。
- 读取快照前统一验证跟踪的 manifest、lock packages 及 v2 legacy 图的来源；只有实际根条目 `packages[""]` 可以没有 `resolved`。非根缺失/空来源、缺根/不支持 lock 版本、links/workspaces、overrides/bundled、shrinkwrap、不能证明输入的格式均只做真实安装，不发布也不消费快照。键 schema 从 1 升至 2，旧键不再命中；旧条目仍受既有容量回收/租约保护，不绕过未知清理。
- 不缓存带 `.npmrc` 等敏感配置的树、源码符号链接/子模块、已跟踪 `node_modules`、外部/可变本地依赖、无有效 SHA-256/384/512 integrity 的远程依赖、含认证信息的 lockfile。支持有 integrity 且无认证/查询参数的 HTTPS 锁定包及来源明确且路径为普通相对路径、跟踪在仓库内的 `.tgz`（不接受绝对路径、`..`、URL 编码等路径形式）。其他输入不能被界定时，仍在原私有 HOME 的 npm 下载缓存配置下重新安装，不发布依赖快照。
- 只保存 npm ci 产生的 `node_modules`，不保存 HOME、认证配置、构建输出或开发者后续改动。检测到敏感文件名、注册凭据/凭据模式、设备等特殊文件、绝对/越界/悬空/循环链接时，放弃发布，保留本次成功安装供当前真实检查使用。凭据检测保守，普通包源码也可能触发回退。
- 完成项位于 `<managedRoot>/dependency-environments/ready/<key>`。成功安装后复制到 staging，校验内容和可执行位，设只读，再原子改名发布。缓存根从不挂进检查沙箱。
- 暖恢复先校验快照，再复制到每项检查自己的新 `node_modules`；无硬链接、无共享可写依赖、无跨候选 HOME。允许的相对链接必须完全落在依赖树内。检查随后的写入不会回写快照。

## 租约、损坏与容量

同进程同键排队，首个安装完成后其余项分别恢复；跨 Host 同键持久租约不明时保守阻断，绝不超时抢占或重复构建。构建和读取/恢复均持有按键使用租约。正常结束的失败安装释放租约但不发布；超时、取消、丢失结果或 Host 被杀保留租约。

只有**已完成**且校验损坏的项可在持有键租约时安全删除并冷安装。在途/中断租约、未知 staging、损坏 owner 不是普通缓存损坏：不得删除重建。现有候选清理接口通过同机器 OS 重启证明后，按精确候选 owner 清理其环境 staging/租约，然后才释放检查计划租约；不根据 PID/时间推断清理。不引入跳过清理或审批的新接口。历史基线准备的环境租约归属父候选，基线证据本身仍遵守原有历史证据恢复限制。

`maxBytes` 限制所有已发布快照的文件内容（含元数据）总字节数；发布前按最早发布顺序回收没有使用租约的项，无法回收则不发布、本次安装照常用于真实检查。不表示整个工作空间磁盘配额：元数据锁、目录开销、私有恢复副本及临时 staging 不计入；每个 staging 的依赖内容上限也是 `maxBytes`。中断 staging 可能保留到证明清理。缩小配置不会主动删除在用项，下一次发布时尝试回收。没有后台 GC。

## 读取与关闭

现有任务证据/完整检查日志读取接口返回可选 `checks[].dependencyEnvironment`：

```ts
{ status: 'hit' | 'miss' | 'fallback'; key?: string; reason?: string;
  prepareMs: number; installMs: number; restoreMs: number }
```

`prepareMs` 含键计算、排队、校验和安装/恢复；`installMs: 0` 表示命中未安装；`restoreMs` 是复制及复制结果校验，不含命中前的完整源校验。新输入产生新键/`miss`；不安全输入、已完成损坏、容量限制等记录 `fallback` 和原因。安装成功日志与当前检查日志一起持久保存，安装失败保留其原始退出状态和脱敏日志。暖命中仍产生当前候选新的真实检查附件；已有同候选补证规则不变。

设 `environmentCache.enabled: false` 或移除它：不读/写快照，但显式 `environment` 仍执行固定模板安装。移除 `environment` 则完全回到原检查命令流程；若此前依靠该前置安装，操作员须恢复原安装命令，不能只移除后假定依赖存在。关闭不能解除既有未知清理租约，配置变化会使旧检查附件失效，仍需原候选补证及精确提交独立审核。

## 验证与限制

确定性 fixture 在本地生成 `.tgz` 并以 `npm ci --offline` 在真实沙箱安装，项目和依赖的 `postinstall: exit ...` 均不运行；不依赖 npm 网络可达。覆盖冷暖、真实检查失败仍阻断、按任务 inode/HOME 隔离、同键 DAG 排队、跨 Host/SIGKILL、租约回收、失败/取消、腐坏、越界链接、凭据、配置失效及关闭。另有同 commit/lock 不变、Git 元数据目录外部 tarball 变化的真实冷暖/禁用对照，均真实安装并检查新内容；HTTPS 来源以本地内容寻址下载缓存种子完成真实离线安装及暖命中（未测线上 registry）。保守语法白名单也可能使合法复杂版本表达式回退。日志与实测见 [验证记录](verification/b2-environment.md)。

不提供 pnpm/yarn/Python、任意安装脚本模板、共享下载目录、跨引用调度、CoW 或全项目性能保证。完整输入/工具链哈希和复制有成本，小项目可能无收益。未实测真实断电、另一 OS/ABI/工具链升级、在线 registry、生产大型依赖树；这些不被离线 fixture 通过所替代。Host 精确候选检查与独立审核仍是后续验收门禁。
