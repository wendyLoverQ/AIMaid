# AIMaid

这是从旧 `AI_maid` WPF 项目中抽离出的 C# 核心业务与 Electron 桌面应用仓库。Electron 主进程
通过单一 C# Core Host 的标准输入输出交换 UTF-8 JSON Lines；启动时必须完成协议握手，不提供运行时 Mock 回退。

## 项目结构

- `src/AIMaid.Contracts`：Command、Query、Event 与跨边界 DTO。
- `src/AIMaid.Core`：业务编排、事件发布和外部能力端口。
- `src/AIMaid.Infrastructure`：SQLite、AIProvider、ComfyUI、TTS/ASR、下载、文件和密钥保护适配。
- `src/AIMaid.Platform.Windows`：Windows 进程、PotPlayer、yt-dlp 和受控 Agent 程序执行器。
- `src/AIMaid.CoreHost`：无 UI 的 C# Core 进程与 JSON Lines 协议入口。
- `contracts`：跨语言协议版本、消息清单、错误码和 Envelope Schema。
- `apps/desktop`：Electron/React 桌面应用；Live2D 位于 `src/renderer/live2d`，不单独打包。

## 构建

```powershell
dotnet restore AIMaid.sln
dotnet build AIMaid.sln -c Debug
cd apps/desktop
npm install
npm run dev
```

## 边界原则

UI 只能发送协议中声明的 Command/Query，并显式订阅 Event。需要用户选择、确认、进度展示
或错误提示的地方使用 `TODO(UI)` 标注；C# 核心不引用任何具体 UI 框架。Live2D 与 React
在 Electron renderer 内部直接集成，不再保留独立进程或 Named Pipe。

通信生命周期、消息表与扩展规则见 [Core 通信协议](docs/core-protocol.md)。详细盘点见
[第一阶段抽离报告](docs/phase-1-extraction-report.md) 和
[UI 交互 TODO](docs/ui-interaction-todos.md)。旧库迁移与清理规则见
[旧 SQLite 迁移说明](docs/legacy-database-migration.md)，运行目录与 `release` 读取规则见
[文件路径统一规则](docs/application-path-policy.md)。Live2D 正式集成见
[第四阶段桌宠说明](docs/live2d-pet-window.md)。
