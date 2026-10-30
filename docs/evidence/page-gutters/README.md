# 页面外框统一验证

当前任务基线 `0781d42077f53a583c17832a31650ab63a1c3aaa` 加本提交中的 CSS 与浏览器回归变更；实际 Chromium 渲染，API 使用确定性 fixture，无真实 Host 写入。

## 结果

- 44 组布局检查通过：八个页面及设置的四个标签页，390 / 768 / 1280 / 1920px。
- 管理页标题、主体和顶栏内容的左右边界一致（CSS px）：

| 视口 | 左边界 | 右边界 | 主体可用宽度 |
| --- | --- | --- | --- |
| 390 | 16 | 374 | 358 |
| 768 | 272 | 736 | 464 |
| 1280 | 272 | 1248 | 976 |
| 1920 | 472 | 1688 | 1216 |

- 所有上述页面 `document.scrollWidth === innerWidth`；聊天外框同上，内列宽度分别为 358 / 464 / 760 / 760px，居中，消息滚动区不与输入区重叠。
- 另外 9 项浏览器回归通过：390/768 下技能、任务和状态详情返回与焦点；键盘入口和输入框焦点；移动端按钮尺寸与中心点击命中；844×390 横屏及减少动态效果。
- `pnpm test:ui`：14 文件、149 测试通过。
- `pnpm typecheck:ui`：通过。
- `pnpm build:ui`：通过；仍有 JS chunk 超过 500kB 的构建警告，未在本任务扩展打包优化。

`report.json` 保留每组实际矩形、断言结果、浏览器版本及源码基线。随附四张代表截图；全部布局截图保存在本次工作树 `.runtime-evidence/page-gutters/screens/`，亦可复现。

```sh
UI_CHECK_FILTER='^layout-|^detail-.*|^mobile-targets$|^landscape-and-reduced-motion$|^keyboard-entry$' \
UI_EVIDENCE_DIR="$PWD/.runtime-evidence/page-gutters" node scripts/ui-regression/check.mjs
```

浏览器依赖路径配置见 `scripts/ui-regression/README.md`。

## 限制

图像查看工具拒绝访问当前任务工作树路径，因此生成了截图但未进行肉眼截图复核；以上结果来自真实浏览器几何与点击命中断言，不是 CSS 字符串测试。未验证真实设备、其他浏览器引擎或真实后端内容；未修改原始 Stitch 参考、后端或业务逻辑。
