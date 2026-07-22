# 并行任务 A：桌宠、状态与音乐运行态

本文件由当前对话执行，不交给其他对话。

## 负责范围

1. 桌宠右键菜单仍未闭环的“好感度切换”和“清除语音缓存/重新生成”动作。
2. 桌宠显示模式、暂停/继续、鼠标命中、拖动和右键链路的最终逐项核对；交互实现必须直接参照老 Live2D/Electron demo 与老项目，不重新编写另一套拖动算法。
3. 状态窗口六块卡片的真实数据、错误状态及老项目刷新周期。
4. 音乐可视化窗口的真实播放/停止事件、FFT 数据和桌宠伴随行为。
5. “当前对话”现有音频缓存回放链路的最终核对，不重新合成旧回复。

## 主要目标文件

- `apps/desktop/src/renderer/pages/pet/PetPage.tsx`
- `apps/desktop/src/renderer/pages/pet/PetBubble.tsx`
- `apps/desktop/src/renderer/pages/pet/pet-page.css`
- `apps/desktop/src/renderer/live2d/`
- `apps/desktop/src/renderer/pages/status/`
- `apps/desktop/src/renderer/pages/music/`
- `apps/desktop/src/main/windows/pet-window-manager.ts`
- 为本范围新建的 C# contracts、services 和 Windows platform adapters

## 老项目依据

- `src/MainWindow.xaml`、`src/MainWindow.xaml.cs`
- `src/Views/ContextMenuWindow.xaml`、`src/Views/ContextMenuWindow.xaml.cs`
- `src/Views/StatusWindow.cs`
- `src/Services/SystemMonitorService.cs`
- `src/Services/NetworkPingService.cs`
- `src/Views/MusicVisualizerWindow.cs`
- `src/Resources/Web/music_visualizer/`
- 老 Live2D 项目：`C:\Users\49213\Desktop\A\codex\Live\src\Live2DRendererElectron`
- 已验证 Electron demo：`C:\Users\49213\Desktop\A\codex\AI_maid\electron_transparency_demo`

## 必须闭环

- 好感度沿用老项目当前角色/当前等级键、等级名称、循环顺序和气泡反馈。
- 清除缓存只处理老项目规定的当前角色、当前好感等级和当天懒加载语音缓存，并沿用原确认/完成/失败反馈。
- 状态页不得保留 `--` 假数据；CPU、GPU、进程内存、五个网络目标、TTS 健康、模型/延迟、角色状态和服务器状态均来自真实服务。
- 各状态分区按老项目现有周期刷新，不能用单一固定轮询替代。
- 音乐可视化必须消费真实音频播放状态和频谱数据；没有播放时按原逻辑隐藏/停止，不制造随机频谱。
- 暂停/继续不能破坏人物右键菜单或永久切换鼠标穿透；拖动结束不能漂移。

## 不负责

- `SettingsPage.tsx` 的剩余配置绑定由任务 B 负责。
- 角色模板和 Agent 由任务 C 负责。
- 视频、远程视频、BTC 和市场模块不改。
