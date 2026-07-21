# AIMaid Core

这是从旧 `AI_maid` WPF 项目中抽离出的 C# 核心业务与后续 Electron 桌面壳仓库。当前阶段
不包含 WPF、XAML、WebView2，也没有迁入 Electron Demo 资源。

## 项目结构

- `src/AIMaid.Contracts`：Command、Query、Event 与跨边界 DTO。
- `src/AIMaid.Core`：业务编排、事件发布和外部能力端口。
- `src/AIMaid.Infrastructure`：SQLite、AIProvider、ComfyUI、TTS/ASR、下载、文件和密钥保护适配。
- `src/AIMaid.Platform.Windows`：Windows 进程、PotPlayer、yt-dlp 和受控 Agent 程序执行器。
- `apps/desktop`：后续 Electron/React 桌面壳；Live2D 位于 `src/renderer/live2d`，不单独打包。

## 构建

```powershell
dotnet restore AIMaid.sln
dotnet build AIMaid.sln -c Debug
```

## 边界原则

UI 只能发送 Contracts 中的 Command/Query，并订阅 Event。需要用户选择、确认、进度展示
或错误提示的地方使用 `TODO(UI)` 标注；C# 核心不引用任何具体 UI 框架。Live2D 与 React
在 Electron renderer 内部直接集成，不再保留独立进程或 Named Pipe。

详细盘点见 [第一阶段抽离报告](docs/phase-1-extraction-report.md) 和
[UI 交互 TODO](docs/ui-interaction-todos.md)。
