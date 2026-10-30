# Stitch → shadcn/ui 实现映射

来源：<https://stitch.withgoogle.com/projects/1425554633296237378>

读取日期：2026-10-26。用户确认采用当前 HTML；画板截图的大标题不恢复。

## 页面来源

| 文件 | 页面 | Stitch screen ID | 框架 |
| --- | --- | --- | --- |
| UI-01.html | 工作区 | 2167c22d4aa84fd8ae0083fb1e5b0824 | 1024px，40px/32px，12列 7/5，间距32px |
| UI-02.html | 对话 | 57a2af9fa8ce4ec19cd1d97545fd9920 | 760px，顶部40px，内容横向24px，固定输入框 |
| UI-03.html | 主 Agent | 27cd92cc3e3a442a966a6895d3f14b22 | 896px，48px/24px，两种模式卡片，32px参数卡内边距 |
| UI-04.html | Agent | c65932322cdc4d178e32603966337fc2 | 1024px，32px/24px，20px卡片内边距，14px行距 |
| UI-05.html | Skill | 65893d6c7e4d4373920a698b7d5a29cd | 1520px，32px，12列 5/7，间距32px |
| UI-06.html | 仓库 | 15750a7f45104cb699cbeef9c9041163 | 1152px，32px，三列统计卡 |
| UI-07.html | 任务 | e2281bcb253d45dd8843558c854d5ca0 | 1280px，24px/32px，12列 7/5，间距24px |
| UI-08.html | 活动 | 2c95c5b0df524e28b5464f3e4632da5c | 1280px，32px，12列 8/4，间距32px |

## 实现

- `ui/src/theme.css`：shadcn 语义色板；`ui/src/stitch.css`：HTML 的布局、排版和状态样式。旧功能样式进入 base layer，避免压过组件样式。
- 固定侧栏 240px，固定顶栏 56px。底色 `#faf9f5`、侧栏 `#f4f4f0`、卡片 `#ffffff`、强调 `#974324`、导航选中 `#e9e1d9`。
- 保留 Button、Card、Dialog、DropdownMenu、Tabs、Avatar、Tooltip、Input 等 shadcn 组件；新增官方 Sheet、RadioGroup。工作区创建使用右侧 576px Sheet；窄屏导航使用左侧 Sheet。
- Newsreader、Plus Jakarta Sans、JetBrains Mono、Noto Sans SC、Material Symbols 本地载入。`scripts/sync-stitch-fonts.mjs` 可重新获取字体与许可证。
- 工作区照片使用 HTML 引用的原始 JPEG；拓扑直接转换原始 SVG 的坐标、路径和颜色，避免截图重采样。
- 对话采用连续 Markdown 正文、代码复制和浮动输入框；对话切换保留在顶栏菜单。Skill 提供阅读与源码两个视图；共享和专属配置仍走已有 API。
- 主 Agent 参数表保留 Host 实际支持的运行连接、模型和推理强度。原型的模拟延迟、虚构上下文上限和认证状态不写入真实产品。
- 桌面按原始 HTML 校准；768px、390px 补充单列与导航抽屉。实际业务记录及字段与示例不同，局部内容高度不能作为逐像素相等的证据。

## 验证

使用 `RIFT_PLAYWRIGHT_MODULE` 指向可用的 Playwright 模块，启动 `pnpm dev:ui --port 5173` 后运行：

```powershell
node scripts/ui-stitch-reference-check.mjs
node scripts/ui-stitch-visual-check.mjs
```

后者拦截 API，使用浏览器测试夹具，不向真实 Host 写入数据。覆盖八页三种视口、背景色、侧栏/顶栏尺寸、列表卡片裁切、横向溢出、Sheet、Agent 搜索、运行连接保存、对话菜单、Skill 阅读/源码、Markdown HTML/URL 处理。

`report.json` 记录检查结果；截图用于人工对照，不等同于零差异的整页像素测试。

2026-10-26 最终检查：UI TypeScript 通过，16 项 UI 单元测试通过，Vite 生产构建通过，24 个视口页面与 8 项浏览器交互检查通过。浏览器无未捕获异常。全项目 `pnpm typecheck` 在本轮未修改的 `src/agent/codex-provider.ts:15` 报 TS2742（Config 推导类型引用 pnpm 内部依赖路径）；该项不计作通过。Vite 对约 670KB 的主 JS chunk 给出体积提示，构建成功。

## 选择框统一补充（2026-10-30）

表单和列表筛选的 15 处单选字段继续使用共享 `NativeSelect` 调用，但可视层由已安装的 Radix Select 渲染，展开菜单与 shadcn 语义色板一致；原生字段只承担 FormData、校验和重置。导航/动作 DropdownMenu 与聊天内联选择不更换交互模式。完整排查、实现边界和本轮验证见 [选择框记录](../evidence/select-controls/README.md)。
