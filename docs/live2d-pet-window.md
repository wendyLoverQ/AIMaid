# Live2D PetWindow

## 结构

```text
C# Core Event -> EventRouter -> preload bridge -> PetPage / PetBubble
PetPage -> PetRuntime -> Live2DPlayer
PetPage -> PetItemInteractionController -> shared image / PNG / Live2D item
```

普通窗口通过 React `lazy()` 与 PetPage 分包，不加载 Pixi、Cubism 或模型资源。Pet Renderer 没有 Node.js 能力，也不直接连接 C# Core。

## 资源与渲染边界

- 模型由 `modelId -> PetAssetService -> aimaid-asset://pet/...` 解析，只映射批准目录和扩展名。
- 命中使用 Cubism HitArea 和 Drawable 三角形，不做同步 GPU 像素回读。
- Canvas 渲染像素比上限为 2；人物 Item 基准尺寸为 560 × 760 DIP。
- React 只装配运行时、生命周期、性能快照和气泡，不参与每帧模型更新。

## Live2D 稳定布局

模型加载完成后，按 560 × 760 DIP 人物 Item 居中适配。BrowserWindow 覆盖整个虚拟桌面，人物 Item 和 Canvas 均不裁剪内部渲染，因此缩放不会碰到小窗口边界。

## 统一交互

图片、PNG 序列和 Live2D 共用 `PetItemInteractionController`：

- 在人物有效命中区域按住并移动超过 8 DIP 后，直接移动人物 Item；拖动帧只更新合成变换。
- 滚轮每次固定增减 0.06，最小 0.12、向上不封顶。缩放围绕首次滚轮位置预览，停止 120ms 后提交实际 Item 尺寸并重新渲染。
- 左键按住期间按时间连续增长，等效于每 16ms 增长约 0.02且不封顶；移动进入拖动或松开后，以 140ms EaseOut 平滑回到按下前大小。
- 人物位置和持久缩放保存为屏幕 DIP 坐标；显示器布局变化时按新的虚拟桌面原点恢复。
- 透明区域保持点击穿透；人物命中区域和打开的业务菜单临时接管输入。

动作、呼吸、眨眼、摆手和头发运动产生的动态 `getBounds()` 不进入窗口档位计算。动态几何只用于人物动作命中和诊断日志，因此模型播放动作不会推动透明窗口扩缩或改变锚点。

## 生命周期与性能

运行时状态为 `uninitialized -> loading -> ready`，并显式支持 `suspended`、`context-lost`、`failed` 和 `disposed`。模型完成首次布局后发送 `pet.ready` 显示透明窗口；失败状态也会显示明确错误，不让窗口永久隐藏。

隐藏、锁屏和休眠会暂停 Pixi 与性能采样；恢复时复用原实例。运行时每 5 秒上报 FPS、帧时间、加载时间、窗口/Canvas 尺寸、渲染像素比、resize 次数和 WebGL Context 状态，Main 限频记录。
