# Live2D renderer module

Live2D 直接属于 Pet Renderer，负责 Cubism/Pixi 模型加载、动作、几何命中、连续缩放、GPU 生命周期
和性能采样。`PetRuntime` 负责 Renderer 生命周期与交互，`runtime/Live2DPlayer` 是从原独立 Electron
实现迁入的 SDK 适配层。

模型只通过 Main 返回的 `aimaid-asset://pet/...` URL 加载；本模块不读取本地路径、不使用 Node.js，
也不与 C# 建立独立管道。当前气泡只显式订阅 `system.stream.progress`、
`system.stream.completed` 和 `request.cancelled`，新增桌宠事件必须先进入正式 Core 契约。

完整结构和性能基线见 [`../../../../../docs/live2d-pet-window.md`](../../../../../docs/live2d-pet-window.md)。
