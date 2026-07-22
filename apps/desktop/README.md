# AIMaid Electron 桌面端

正式运行链路为 Renderer → Preload → Main → `StdioCoreClient` → UTF-8 JSON Lines →
`AIMaid.CoreHost`。运行时不会回退到 Mock Core。

## 目录

```text
apps/desktop/
├── src/
│   ├── main/
│   │   ├── core/       # 正式 stdio CoreClient、协议校验和进程管理
│   │   ├── ipc/        # IPC 请求路由和跨窗口事件路由
│   │   ├── lifecycle/  # 唯一应用启动/退出流程
│   │   ├── logging/    # 统一日志入口
│   │   ├── windows/    # WindowManager、Factory 和注册表
│   │   └── main.ts     # 只组装依赖并启动
│   ├── preload/        # 按窗口能力裁剪的 contextBridge
│   ├── renderer/
│   │   ├── live2d/     # 仅由 PetWindow 懒加载
│   │   ├── pages/      # main/pet/chat/settings 骨架入口
│   │   └── components/ # 可复用基础组件
│   └── shared/         # IPC、窗口、Core 与能力契约
└── tests/
```

## 环境与命令

- Node.js：`>= 22.12`
- 包管理器：npm（只维护 `package-lock.json`）
- Electron：`43.1.1`
- electron-vite：`5.0.0`
- TypeScript：严格模式

Electron 43 的二进制按需安装；项目的 `postinstall` 会调用官方 `install-electron`，确保
electron-vite 启动前本地可执行文件已经存在。

```powershell
cd C:\Users\49213\Desktop\A\codex\AIMaid\apps\desktop
npm install
npm run dev
npm run core:build
npm run core:publish
npm run typecheck
npm run lint
npm test
npm run build
npm run pack
```

`npm run dev` 会先构建 Debug Core Host，再启动 electron-vite。`npm run build` 会发布当前平台的
self-contained Core 可执行文件并生成 `out/`；`npm run pack` 再把 Core 复制到 Electron resources。
打包后的自动退出冒烟验证可执行 `release\win-unpacked\AIMaid.exe --smoke-test`。
开发入口可用 `$env:AIMAID_SMOKE_TEST='1'; npm run dev` 做同样的自动退出验证。

## 已落实的边界

- 所有 `BrowserWindow` 只由 `WindowManager` 和 `WindowFactory` 创建。
- 每个窗口使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 和
  `webSecurity: true`。
- 沙箱 Preload 固定打包为 CommonJS `index.cjs`；Electron 的沙箱 Preload 不使用 ESM 上下文。
- Preload 不暴露 `ipcRenderer`，并根据窗口 ID 只构造允许的 API。
- Main 同时校验顶层 Frame、本地页面、窗口身份、请求类型和参数；Renderer 不能靠伪造
  Preload 调用提升权限。
- IPC 契约集中定义统一 request/response/event/error 结构，并处理超时、取消、重复 requestId、
  未知类型和监听清理。
- Core 进程由单个 `CoreProcessManager` 管理，包含启动、握手、Ready、停止、重启、stderr 和异常退出。
- PetWindow 独立懒加载 `renderer/live2d`，普通窗口的入口不导入该模块。

## 正式 Core 协议

- 权威跨语言契约位于仓库根 `contracts/`。
- stdout 每行只能是一条完整协议 Envelope；Core 日志只写 stderr。
- 启动必须先完成 `system.handshake`，协议不兼容时不会继续处理业务请求。
- 当前真实能力：`system.health`、`settings.get`、`system.stream`、`system.cancel`、`system.shutdown`。
- `settings.get` 经过真实 `SettingsApplicationService` 和 `SqliteCoreStore`，并拒绝敏感设置键。
- 窗口按事件类型显式订阅，窗口销毁或 Effect 卸载时自动退订。

完整消息、错误和启动说明见 [`../../docs/core-protocol.md`](../../docs/core-protocol.md)。

## Live2D PetWindow

桌宠窗口使用独立懒加载 Renderer chunk、固定适中透明窗口和受控 `aimaid-asset://` 资源协议。
窗口拖动、点击穿透、跨屏/DPI、锁屏和休眠恢复由 Main 管理；Pixi/Cubism 渲染、命中与缩放
留在 Pet Renderer。实现边界、事件清单与性能记录见
[`../../docs/live2d-pet-window.md`](../../docs/live2d-pet-window.md)。

## 第二阶段 UI 基础层

Renderer 已建立统一 Design Token、19 类共享基础组件、全局错误边界、Toast、统一页面状态、
Renderer Bridge 和自绘 `WindowTitleBar`。MainWindow 是综合演示页，第一阶段的 ChatWindow ID
暂作为独立演示窗口，不包含聊天业务。

Token、组件清单和后续页面规则见
[`src/renderer/README.md`](src/renderer/README.md)。普通页面不得直接访问 `window.aimaid`，
也不得导入 `renderer/live2d`。
