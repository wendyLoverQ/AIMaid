# AIMaid 第一阶段抽离报告

## 结论

旧 `AI_maid` 共有约 279 个 C# 文件，其中服务文件约 140 个。对 Models、Services、
Repositories、Data、Managers 的 194 个业务候选文件扫描后，至少 46 个直接引用了 WPF、
窗口、Dispatcher、WebView2 或其他 UI/平台代码。因此本阶段没有整目录复制，而是按现有
业务语义建立无 UI 的契约、核心编排和适配器。

## 已抽取模块

| 模块 | 旧项目依据 | 新位置 | 完成内容 |
|---|---|---|---|
| 聊天与会话 | `ChatMessage`、`IChatHistoryService`、`ChatHistoryService`、`ChatGptService` | Contracts / Core / Infrastructure | 保留 conversation ID、user/assistant 持久化、最近 20 条上下文、流式 delta 和最终完成事件 |
| 角色与角色卡 | `VoiceRoleCard`、`VoiceRoleLibraryService` | Contracts / Core / SQLite | 角色查询、更新、当前角色选择、角色变化事件 |
| 配置管理 | `AppSetting`、`ISettingsRepository`、`SettingsRepository` | Contracts / Core / SQLite | 单项/批量查询与保存、数据库覆盖、配置变化事件 |
| SQLite 与数据访问 | `TimerDbContext`、Repositories | Infrastructure | 独立 SQLite Store，覆盖聊天、配置、角色、后台任务和扩展业务文档；WAL、复合主键与索引 |
| AIProvider / LLM | `ChatGptService` | Core port / HTTP adapter | OpenAI-compatible SSE 与 Responses delta 解析，API 地址、模型和密钥由外部配置注入 |
| ComfyUI | 旧生成调用与 Bridge 约定 | Contracts / Core / HTTP adapter | `comfyui.generate`、workflow/inputs、`/prompt` 队列响应 |
| TTS / ASR | `ITtsService`、`TtsService` | Contracts / Core / HTTP adapter | `/v1/tts`、`/v1/asr`，返回音频路径或转写文本 |
| 下载与任务 | `MediaDownloadServices`、远程下载任务模型 | Contracts / Core / HTTP adapter / SQLite | 可取消后台任务、字节进度、完成/失败事件、`.partial` 原子落盘 |
| 文件管理 | 旧文件与媒体服务 | Contracts / Core / Infrastructure | 移动、覆盖、删除端口；破坏性操作明确交给 UI 确认 |
| 媒体与外部程序 | `PotPlayerBridgeService`、`ExternalToolRunner` | Core port / Platform.Windows | 参数化启动进程和 PotPlayer，不在核心硬编码本机路径 |
| Live2D 展示边界 | `Live2DProtocol`、`Live2DRendererClient` | Character/Event contracts | 不迁移 Named Pipe；角色与动作业务状态通过通用事件交给 Electron 内部 Live2D 模块消费 |
| Agent 能力 | `AgentCapability`、`AgentToolCall` | Contracts / Core / Platform.Windows / SQLite | 能力配置、执行记录、一次性审批 token、无 Shell 外部程序执行器和完成事件 |
| 主动行为 | `MaidProactiveRule`、打扰设置 | Contracts / Core / SQLite | 安静时段、全屏抑制、规则优先级、冷却时间、决策事件；桌面状态采集保留为平台端口 |
| 提醒、笔记、保险库、行情 | 对应 Models / Services | Contracts / Core / SQLite | 无 UI CRUD、Markdown 笔记、行情去重键；保险库秘密使用外部密钥 AES-GCM 保护 |
| 视频与远程站点 | 视频库、远程站点设置、解析服务 | Contracts / Core / Platform.Windows / SQLite | 视频与站点配置、yt-dlp 解析端口；不迁移 WebView 登录窗口 |
| TTS 与展示状态 | `TtsService`、角色动作编排 | Contracts / Core | 合成完成发布 `tts.audio_ready`；角色动作发布 `character.presentation` 给 Electron 内部 Live2D |
| Command / Query / Event | 原服务方法与运行时事件 | Contracts | 稳定 route catalog、强类型 handler 与事件 DTO |

## 当前 Command

- `chat.send`
- `character.update`
- `settings.save`
- `comfyui.generate`
- `download.start`
- `tts.speak`
- `asr.transcribe`
- `file.move`
- `file.delete`
- `media.launch`
- `agent.execute`
- `proactive.evaluate`
- `reminder.save`
- `notebook.save`
- `vault.save`
- `market.record`
- `video.list`
- `remote_media.resolve`
- `character.present`

## 当前 Query

- `chat.history`
- `character.list`
- `settings.get`
- `task.status`

## 当前 Event

- `chat.delta`
- `chat.completed`
- `task.progress`
- `task.completed`
- `task.failed`
- `download.progress`
- `settings.changed`
- `character.changed`
- `error.occurred`
- `agent.approval_requested`
- `reminder.due`
- `tts.audio_ready`
- `character.presentation`

## 明确不迁移的旧实现

以下内容不是未完成项，而是 UI/平台旧实现，按新架构明确淘汰或留给 Electron：

- 所有 WPF Window、XAML、Dispatcher、WebView2 页面和 `AgentUIService`。
- NAudio 播放队列、WPF 气泡和窗口内口型回调；播放与口型由 Electron renderer 实现。
- Live2DRenderer 旧独立进程、Named Pipe、重连和窗口控制；Live2D 直接位于 `apps/desktop/src/renderer/live2d`。
- 抖音 WebView 抓取窗口及其他把登录 UI 与解析逻辑混在一起的实现；登录由 Electron 壳处理。
- ViewerEX 生命周期与窗口控制。
- 旧数据库 40+ 张表的原样复制；新核心只保存跨 UI 后仍有意义的业务数据。

## 剩余 UI 耦合点

- `MainWindow.xaml.cs` 仍直接编排聊天、TTS、气泡、角色和主动行为。
- `MaidEventManager` / `AiProactiveManager` 持有窗口实例并直接更新 UI。
- `TtsService` 的旧音频播放和 UI 回调不迁移；新的合成完成事件已经拆出。
- `Live2DIntegrationService` 的业务状态改由通用角色展示事件表达；渲染与模型加载归 Electron。
- WebView resolver 把登录窗口、网络抓取和业务解析放在同一服务中。
- ViewModel 中仍存在部分会话/角色业务状态，需要后续逐项迁入 Core。

## Electron 接入阶段仍需处理

1. 选择 C# 宿主和 Electron 之间的承载/IPC 方式；不得改变现有 Contracts 语义。
2. 将 Event 转成可订阅传输，并定义断线重连后的事件补偿策略。
3. 迁移旧 SQLite 数据，验证字段、索引和时间格式兼容性。
4. 实现 Electron 的 TTS 播放队列、透明命中、拖动和 Live2D 口型，并用真实运行日志验收。
5. 在 Electron UI 实现文件删除、保险库明文、外部程序和 Agent 高风险能力的明确授权交互。
6. 将密钥与用户配置接入正式数据库配置覆盖层，不写入安装目录。
7. Electron 只实现 UI 与平台壳，不把业务重新写入 React。

仓库目录已经预留 `apps/desktop/src/main`、`preload`、`renderer` 和 `renderer/live2d`。Live2D
不是共享 package；在只有一个桌面应用消费它的前提下，直接合并到 renderer 更清晰。

## 构建验证

- `AIMaid.Contracts`：`net8.0`
- `AIMaid.Core`：`net8.0`
- `AIMaid.Infrastructure`：`net8.0`
- `AIMaid.Platform.Windows`：`net8.0-windows10.0.17763.0`
- 当前构建结果：0 warning，0 error。
