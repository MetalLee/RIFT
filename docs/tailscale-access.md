# RIFT 的 Tailscale IP 直连

以下地址、端口和目录均为示例，请替换为自己的部署值；示例 IP 不代表可连接的服务。

示例访问地址：`http://100.64.0.10:48080`。

应用同时监听 `127.0.0.1:48080` 和指定 Tailscale 网卡 `100.64.0.10:48080`，没有绑定 `0.0.0.0`，不需要 Serve、Funnel 或代理。远程入口只提供页面与浏览器 API，管理 API 继续只允许本机访问。

## 启动

在项目目录执行：

```powershell
node dist/cli/main.js serve --home C:\RiftExample --port 48080 --profile rift-ui --patch profiles/rift.codex.patch.yml --tailscale-ip 100.64.0.10
```

在可访问该服务的 tailnet 设备上直接打开固定地址即可自动连接，无需登录码。服务重启或会话过期后刷新页面即可重新连接。RIFT 不再额外验证访问者身份，访问范围由 Tailscale 网络与访问规则决定。

也可以在另一个终端生成兼容的一次性链接：

```powershell
node dist/cli/main.js ui --home C:\RiftExample --remote
```

一次性链接仍可使用：启动码 60 秒有效，浏览器会话默认 8 小时。无 `--remote` 时仍生成本机链接。

## HTTP 兼容与验证

HTTP 的 Tailscale IP 不属于浏览器安全上下文，因此不要求此监听器上存在 `Sec-Fetch-*`，但显式跨站元数据仍会被拒绝。写入仍要求精确 Origin、JSON、会话、CSRF 和幂等键。本机监听器保留原有严格 Fetch Metadata 检查。

前端在缺少 `crypto.randomUUID` 时使用 `crypto.getRandomValues` 生成 UUID v4；复制功能为 HTTP 提供剪贴板回退。

已通过类型检查、生产构建和 10 项定向测试。`RIFT_REMOTE=1 node scripts/ui-host-assets-check.mjs` 在本机浏览器中通过实际 Tailscale IP 验证登录、资源、受认证写入的输入校验及跨站/管理路由拒绝，不创建业务数据。证据位于 `docs/evidence/stitch-alignment/tailnet-assets-report.json`。未声称已从第二台设备完成端到端网络验证。

上一版 `rift-tailnet-proxy.mjs` 是未启用的 Serve 备选方案，当前直连方式不使用它。
