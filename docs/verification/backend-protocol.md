# 后端协议组合验证

本任务基线为已验收 CLI `d7a15b60daa56b916cd10f649b0964f7f1d9807f`，其中已包含前端/协议成果 `1007bbbe02b0a77121984c205a8aa726d3b9509b`。本任务不重写依赖提交、不修改旧工作树或 UI 源码。

## 实现范围

- 后端 workspace/chat/UI/repository/worktree/Skill/evidence/event 类型采用 `@rift/protocol`；旧入口兼容转导出，不保留重复定义。
- `RiftError`、公共错误映射及管理 CLI 使用协议错误类型；错误码仍可扩展，未引入闭集运行时校验。
- API 创建输入同时描述互斥的 key/Host 引用；公共响应显式投影，移除之前意外返回的 `credentialRef`，包括列表、创建、验证及其幂等回执。内部适配器继续读取 Host 记录，凭证所有权/删除/恢复规则不变。
- Skill 的内部版本扩展协议元数据以保留不可变资源字节，列表/预览仍只返回摘要。协议包无后端/Node/SDK 依赖。
- 全业务 HTTP 能力矩阵仍由自动测试核对；共享层不新增 HTTP 回调或路径代理。
- `scripts/check-built-cli.mjs` 直接使用根 `dist/` 与协议包产物，从临时 cwd 启动禁用 UI 的 Host，验证 CLI 命令、重放、版本拒绝、事件页和 SSE。

## 精确证据

执行实现提交：`d220642a6e47ad76eb7c8a0b6f269c3c86c6b857`。8 条检查的执行前后均保持该 HEAD 且工作树干净；后续提交仅附加本验证文档和原始记录，不改变实现、测试或构建配置。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0，当前工作树独立依赖 |
| `pnpm typecheck` | exit 0，后端 + UI |
| `pnpm test:protocol` | exit 0，19 passed；独立 consumer 编译及边界检查 |
| `pnpm test` | exit 0，87 文件、565 passed、1 skipped |
| `pnpm test:ui` | exit 0，48 passed |
| `pnpm build` | exit 0，protocol + 后端 + UI |
| `pnpm test:built-cli` | exit 0，无浏览器构建后 CLI/Host 业务与 SSE |
| `git diff --check` | exit 0 |

完整的命令、执行 HEAD、开始/结束时间、退出码和原始 stdout/stderr 记录在同目录 [backend-protocol.raw.json](backend-protocol.raw.json)。记录仅是本地检查证据，不代替 Host 收集源代码、候选检查或独立 exact-commit 审查；PR 仍由 Lead 在 workflow_finish 后发布。

复现：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:protocol
pnpm test
pnpm test:ui
pnpm build
pnpm test:built-cli
```

首次迭代中，类型检查指出旧测试依赖泄漏字段，协议独立编译暴露 Loader 事件声明依赖，新增 AST 检查暴露测试节点缺少 parent 链；均已修正后重跑。没有删除凭证断言或绕过权限边界。

未执行真实外部模型/公网 npm 安装测试；全量测试中 `RIFT_NETWORK_TESTS=1` 才启用的公网安装用例默认跳过。构建保留现有 Vite 大 chunk 提示（非失败）。没有 push、PR 或最终验收声明。
