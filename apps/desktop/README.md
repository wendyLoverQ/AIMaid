# AIMaid Electron 桌面端（第一阶段）

本目录是独立的 Electron 架构骨架。它不引用或修改仓库中的 C# Core，当前只通过
`MockCoreClient` 验证 Renderer → Preload → Main → Core Client 链路。

## 目录

```text
apps/desktop/
├── src/
│   ├── main/
│   │   ├── core/       # 可替换 Core Client、进程管理骨架
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

```powershell
cd C:\Users\49213\Desktop\A\codex\AIMaid\apps\desktop
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run pack
```

`npm run dev` 使用 electron-vite 的本地开发服务器；`npm run build` 生成 `out/` 中随应用发布的
本地资源；`npm run pack` 再生成未安装的 Windows 应用目录，用于验证打包后的资源路径。

## 已落实的边界

- 所有 `BrowserWindow` 只由 `WindowManager` 和 `WindowFactory` 创建。
- 每个窗口使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 和
  `webSecurity: true`。
- Preload 不暴露 `ipcRenderer`，并根据窗口 ID 只构造允许的 API。
- Main 同时校验顶层 Frame、本地页面、窗口身份、请求类型和参数；Renderer 不能靠伪造
  Preload 调用提升权限。
- IPC 契约集中定义统一 request/response/event/error 结构，并处理超时、取消、重复 requestId、
  未知类型和监听清理。
- Core 进程由单个 `CoreProcessManager` 管理，包含启动/停止/重启/握手/健康/日志/退出状态骨架。
- PetWindow 独立懒加载 `renderer/live2d`，普通窗口的入口不导入该模块。

## 后续接入真实 C# Core

1. 新建实现 `CoreClient` 的真实传输客户端，不改变 Renderer 或 Preload API。
2. 新建实现 `CoreProcessAdapter` 的 C# 启动器，并把 stdout、stderr、exit 路由给
   `CoreProcessManager`。
3. 在双方 Contracts 稳定后扩展 `shared/core.ts` 中的最小 Command、Query、Event 类型。
4. 在 `main.ts` 的组装点把 Mock 实现替换为真实实现；不要把传输逻辑放入窗口或 Renderer。

当前阶段故意不选择 stdio、Named Pipe 或 WebSocket，也不迁移 WPF、正式业务页面或 Live2D SDK。
