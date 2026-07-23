# AIMaid UI 截图快照

在 `apps/desktop` 目录运行：

```powershell
npm run ui:snapshots
```

脚本会先构建当前 desktop/Core，然后依据 `src/shared/windows.ts` 和
`src/main/windows/window-registry.ts` 的当前内容，按顺序启动真实 AIMaid
实例并通过 Chromium DevTools Protocol 生成截图。输出位于：

`artifacts/ui-review/current/`

其中包含 `manifest.json`、`index.html`、PDF 和原图 ZIP。截图辅助背景只通过
CDP 临时注入，透明窗口的产品代码不会被修改；截图使用当前真实数据和配置，
不会写入数据库，也不会提交输出产物。
