# API 连接诊断与删除

更新：2026-10-26。

## Claude 连接失败原因

现场连接使用 `openai-completions` 协议，配置值为 `https://newapi.deepwisdom.ai/v1/chat/completions`。真实会话记录显示适配器又追加了 `/chat/completions`，实际请求变成 `/v1/chat/completions/chat/completions`，服务返回 404 Invalid URL。原验证逻辑丢失了底层失败原因，只显示未完成验证。

正确基础地址是 `https://newapi.deepwisdom.ai/v1`。修复后使用原有连接的凭据和 `claude-opus-5-5` 模型标识完成一次短请求，真实返回 `RIFT_API_OK`，见 [现场诊断证据](evidence/claude-api-diagnosis.json)。未修改或展示用户密钥。

部署后对现有第 2 版连接执行完整 DSH 验证，两次均收到上游 `Provider finish_reason: content_filter`，没有返回正文。这是修正 URL 后暴露的第二个问题，不能把最小请求成功报告为完整代理验证成功。连接的当前失败记录已更新为该具体原因；密钥与基础路由至少支持上述最小请求，上游为什么过滤完整验证请求需要服务提供方确认。见 [两次现场验证](evidence/claude-api-live-verification.json)。没有删除或自动替换用户的两个连接版本。

保存时将常见完整请求地址按协议规范化为基础地址；已保存的旧地址也在展示与运行时兼容规范化，不重写其历史原值。OpenAI Chat Completions 去掉末尾 `/chat/completions`，Responses 去掉 `/responses`，Anthropic Messages 去掉 `/v1/messages`，保留网关的自定义前缀。DSH 运行时现在保留脱敏、限长的提供方失败原因，验证和聊天失败均可显示具体错误。

## 删除连接

每张 API 连接卡片提供「删除」按钮，点击后可确认或取消。删除撤销该模型路由并从当前列表移除；历史连接版本和已完成执行记录作为审计信息保留。当前 Agent、工作区默认 Lead、排队或未确认清理的执行仍引用连接时，删除被拒绝并解释原因，应先切换连接或等待执行完成。

仅清理由本连接生成并拥有的密钥；环境变量引用及共享密钥不会被误删。迁移 0017 为旧记录补充所有权和删除状态。密钥清理失败时连接保持已删除状态，页面保留重试入口；重启也会继续清理，不会重新挂载已删除路由。

畸形 JSON 请求统一返回 `INVALID_JSON`，不回显请求内容，避免输入中的密钥出现在解析错误中。

## 验收

[独立验收](evidence/api-connection-management-independent-review.json)覆盖真实 DSH 请求路径、404 错误及密钥脱敏、旧配置兼容、删除引用保护、历史保留、凭据所有权和无效 JSON。另有 [浏览器验收](evidence/api-key-ui/report.json)，验证删除确认/取消、引用拒绝、清理失败后重试以及移动端布局。

最终完整回归 362 通过、1 平台跳过、0 失败；类型检查与生产构建通过。Host 已备份并重启至独立工作树构建（PID 43892），数据库版本 17、完整性正常、HTTP/doctor 200；没有删除现场连接。见 [完整回归](evidence/api-connection-management-tests.json) 和 [最终部署记录](evidence/api-connection-management-final-validation.json)。
