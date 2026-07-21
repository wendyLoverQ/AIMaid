# AIMaid Core

这是从旧 `AI_maid` WPF 项目中抽离出的第一阶段 C# 核心业务解决方案。当前目录不包含
WPF、XAML、WebView2、Electron 或 React UI，也不确定最终 IPC 方案。

## 项目结构

- `AIMaid.Contracts`：Command、Query、Event 与跨边界 DTO。
- `AIMaid.Core`：业务编排、事件发布和外部能力端口。
- `AIMaid.Infrastructure`：SQLite、AIProvider、ComfyUI、TTS/ASR、下载和文件适配。
- `AIMaid.Platform.Windows`：Windows 进程和 PotPlayer 实现。

## 构建

```powershell
dotnet restore AIMaid.sln
dotnet build AIMaid.sln -c Debug
```

## 边界原则

UI 只能发送 Contracts 中的 Command/Query，并订阅 Event。需要用户选择、确认、进度展示
或错误提示的地方使用 `TODO(UI)` 标注；核心项目不引用任何具体 UI 框架。

详细盘点见 [第一阶段抽离报告](docs/phase-1-extraction-report.md) 和
[UI 交互 TODO](docs/ui-interaction-todos.md)。
