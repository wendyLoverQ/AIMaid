# AI_maid UI 原样迁移清单

唯一参考实现：`C:\Users\49213\Desktop\A\codex\AI_maid`。

| 用户入口 | 老项目 UI 源 | Electron 目标 | 当前状态 |
| --- | --- | --- | --- |
| 桌宠显示 | `MainWindow.xaml`、`DisplayModeManager.cs`、`PngSequencePlayer.cs` | `PetPage.tsx` | 迁移中；PNG/右键/拖动已接入，交互仍需逐项对照 |
| 桌宠右键菜单 | `ContextMenuWindow.xaml(.cs)` | `PetContextMenu` | 项目顺序、图标、模式条件显隐及动态版本号已复制；语音角色与好感度读取当前角色真实键，等级名称、循环顺序和气泡反馈已接 Core；当前等级当天缓存的清理并重生成仍待语音缓存生成服务迁移后闭环 |
| 状态 | `StatusWindow.cs` | `status` BrowserWindow | 角色、TTS、模型延迟、Live2D 真实渲染状态、CPU/GPU/内存、五个网络目标、腾讯云/AWS 健康与容量、Codex 主副额度和 Credits 均已接真实数据；0.2 秒、3 秒、1/5 分钟、60 秒刷新周期按老项目分别执行 |
| 工作台 | `WorkbenchWindow.cs` | `main` BrowserWindow | 3×3 九入口已复制 |
| 当前对话 | `MainWindow.CurrentConversation_OnClick`、桌宠气泡 | PetWindow 气泡 | 已按老链路读取当前会话最近 40 条并在桌宠气泡显示；存量音频只读取消息元数据中的既有缓存路径并依次回放，不重新合成；统一主音量和静音实时生效 |
| 外观设置 | `AppearanceSettingsWindow.xaml(.cs)`、`AppearanceService.cs`、`ThemeCatalog.cs` | `appearance` BrowserWindow | 只保留当前 ThemeCatalog 与基础外观、字体、布局项；默认值及全局基础色已校正为老项目 `neutral_soft_light`，选择项沿用老项目即改即存逻辑并由 Core 持久化，主题、内容亮度、字体、字号、圆角、密度、顶部样式和动画会应用到各窗口；已排除筛选、收藏、最近、历史别名、旧版主题及纯预览等废项 |
| 系统设置 | `SystemSettingsWindow.xaml(.cs)`、`UserConfigurationService.cs`、`TrayService.cs` | `settings` BrowserWindow | 搜索、八分类及旧项目现役设置卡结构已复制；显示模式、当前真实 Live2D 模型、图库目录及旧项目 5 秒至 10 分钟的八档轮播时间已接桌宠运行态；六组非模型配置已按老项目 `user_config:` 键读取、校验并保存；五套现役模型配置会合并老数据库覆盖并真实读取/保存，API Key 独立加密，新建模型、六条业务链模型和现役 Source Prompt 均已接 Core；其他运行设置和全局热键 Core 绑定待接 |
| BTC | `BitcoinMarketWindow.cs` | `bitcoin` BrowserWindow | 资产、搜索、周期、EMA、模式栏已复制；每个选中资产的图标/价格/涨跌/高低值、市场/资金费率/持仓量/盘口四指标及内嵌旧 WebView2 图表卡已补齐，看板模式会按老逻辑隐藏编辑区；三个真实子窗口入口已恢复，行情 Core 路由待接 |
| 计时 | `ToolWindow.xaml(.cs)`、`TimerEngine.cs`、`MainViewModel.cs`、`RecordService.cs` | `timer` BrowserWindow | 倒计时、正计时、暂停/继续、重置、数字颜色、透明模式、记录统计与右键删除交互已复制；计时记录读取、保存和删除已接 C# Core 持久化 |
| 视频库 | `VideoWindow.xaml(.cs)`、`video_library/*` | `video` BrowserWindow | 浏览、导入/扫描、元数据、收藏、备注、进度、专辑、标签、批量操作、删除记录和回收站删除均已接入持久化 C# Core；依赖检测返回真实工具状态；仍需用户实机验收外部播放器和大库滚动性能 |
| 远程视频中心 | `RemoteVideoCenterWindow.xaml(.cs)` | `remote-video` BrowserWindow | 单/批链接解析、清晰度、播放/缓存/下载、取消与记录、再次播放、有效设置和脱敏诊断均已接入 C# Core；复用受保护站点 Cookie；仍需用户使用真实 yt-dlp、PotPlayer 和有权限 Cookie 实机验收 |
| 提醒事项 | `ReminderWindow.cs`、`ReminderEditorWindow.cs` | `reminders` BrowserWindow | 老窗口标题栏动作顺序、提醒列表、编辑器独立日期/时间、重复、启用与 TTS 已复制并接通 Core CRUD/检查闭环 |
| 记事本 | `NotebookWindow.cs`、`NotebookWebViewControl.cs`、`notebook_web/*` | `NotebookPage.tsx` | 已改为 React 统一组件页面；列表、搜索、选择、富文本编辑、自动保存、新增、置顶、复制、删除和粘贴图片导入继续接 Core，正式路由不再加载旧 HTML iframe |
| 密码库 | `VaultWindow.cs` | `vault` BrowserWindow + 加密 Core | 左侧检索/类型筛选、真实条目卡、选中详情、四类动态表单、新增即落库、名称校验、保存、复制及原删除确认已复制并接通 AES-GCM Core；五类敏感字段变更历史、旧值恢复及恢复后的反向历史记录已接 Core；旧导出密钥迁入受保护文档，导出会按原逻辑查找 7z/7za/7zz、生成加密 `vault_backup.json` 并清理临时目录 |
| 快捷脚本 | `ChatCommandManagerWindow.cs`、`ChatCommandLauncherService.cs` | `scripts` BrowserWindow | 老窗口左列表、新增、选择、详情字段、程序/脚本选择、工作目录选择、原输入校验、保存状态和运行测试已复制；列表、保存、指令唯一性与真实进程启动已接 C# Core |
| 角色对话中心 | `VoiceConversationCenterWindow.xaml.cs`、`VoiceConversationWebViewControl.cs`、`voice_conversation/*` | `VoiceConversationPage.tsx` | 已改为 React 统一组件页面；角色选择、会话搜索/新建/选择/重命名/删除、历史加载、消息发送与持久化继续接 C# Core；`voice_conversation_center_speech` 开关、按角色首选音色播报及音频元数据回填继续生效，正式路由不再加载旧 HTML iframe |
| 语音角色管理 | `CharacterWindow.cs`、`CharacterEditorWindow.cs`、`character_role_list/*` | `characters`、`character-editor` React 页面 | 角色列表、预览、基础信息、删除确认、新增/编辑、头像导入和音色资产操作均使用统一 React 组件并接 Core；旧 `character_role_list` HTML 资源已删除 |
| 外部站点配置 | `RemoteSiteConfigWindow.cs` | `remote-site-config` BrowserWindow | 已从远程视频真实入口接入，站点列表、新建/选择、基础匹配、请求身份、抖音会话、Cookie、备注、保存和删除已复制；抖音会话诊断及 APP 专用会话清除已接，站点配置接 C# Core，Cookie 使用独立 AES-GCM 安全存储且不混入普通配置 JSON |
| 视频播放器 | `SimpleVideoPlayerWindow.cs`、`video_player/*` | `video-player` BrowserWindow | 旧原生 HTML5 播放器已复用；本地文件经主进程受控媒体协议读取，播放进度/完成状态回写 Core；具体容器与编码兼容性仍需用户实机验收 |
| 视频字幕 | `VideoSubtitleWindow.cs`、`SubtitleService.cs` | `video-subtitles` BrowserWindow + `SubtitleApplicationService` | 老项目文件列表、数量/空状态、选中行、添加字幕多选、递归导入、刷新、删除按钮及“我的字幕”确认框已原样复制；srt/ass/ssa/vtt 校验、重名自动编号、递归复制与目录边界删除已接通 C# Core，形成完整闭环 |
| 市场事件中心 | `CryptoMarketEventCenterWindow.cs` | `crypto-events` BrowserWindow | 入口、说明、刷新、状态与旧空状态已复制；有数据时的交易对/强平方向/时间/数量/成交价/名义价值事件卡模板已补齐；事件 Core 路由待接 |
| 加密行情服务 | `CryptoMarketProviderSettingsWindow.cs`、`CryptoMarketService.cs` | `crypto-provider` BrowserWindow | 入口、连接方式、地址、超时、健康状态和操作区已复制；原“请求超时必须是整数”校验、配置读取/保存、`/api/crypto-market/health` 检测、Provider/延迟/检测时间回写均已接 C# Core |
| 专业行情图表 | `CryptoProfessionalChartWindow.cs`、`crypto_web/*` | `crypto-chart` React 页面 | 已使用 React SVG K 线组件读取 `market.chart_snapshot` Core 快照，旧 `crypto_web` iframe 资源已删除 |
| 角色模板卡详情 | `TemplateCardDetailWindow.cs` | `template-card` BrowserWindow | 已从角色管理真实入口接入，状态、生成时间、迭代次数和真实只读 JSON 已复制；重新生成在有角色时可操作，继续迭代按模板 JSON 是否存在启用，并明确显示 Core 路由待接状态 |
| Agent 确认 | `AgentConfirmWindow.xaml(.cs)` | `agent-confirm` BrowserWindow | 480×420 固定窗口、能力名、说明、执行器、风险、参数及取消/继续区已复制；Agent 执行请求的异步对话绑定待接 |
| 输入浮层 | `PromptWindow.xaml(.cs)` | `chat` 透明 BrowserWindow | 已删除演示页，按旧 520×360 透明浮层、人物中心定位、失焦/Esc 关闭及 Enter/Ctrl/Shift 语义复制；提交后按老顺序先处理“-”快捷命令，再解析提醒，最后进入 Core 对话，并把结果送回桌宠气泡；Shift+Enter 已按当前角色音色真实 TTS 试听，普通回复遵守旧 `realtime_tts_enabled` 并保存音频路径供“当前对话”只回放缓存、不重新合成 |
| 托盘菜单 | `TrayMenuWindow.xaml(.cs)`、`TrayService.BuildMenu()` | Electron Tray + `tray-menu` React BrowserWindow | 托盘左/右键均弹 React 菜单，显示、位置回归、隐藏、退出已接 Electron 宿主；按当前确认需求增加 0–100 连续主音量滑动条和静音，统一控制 TTS 与音乐，0 自动静音、向上滑动自动恢复 |
| 音乐可视化 | `MusicVisualizerWindow.cs`、`MusicService.cs`、`AudioSampleCapture.cs`、`music_visualizer/index.html` | `MusicVisualizerPage.tsx` | React 页面继续接 QQ 搜索、播放/停止事件、FFT 音浪、桌宠跟随、主音量和静音；旧 `music_visualizer` HTML 入口已删除，纯 PNG 音浪素材继续保留 |
| 抖音登录 | `DouyinLoginWindow.cs` | `douyin-login` BrowserWindow | 老引导、专用浏览器、状态和底部动作已复制；使用 `persist:aimaid-douyin` 独立会话，保存时只落 Cookie 数量/关键字段元数据，不读系统浏览器也不记录 Cookie 内容 |
| 语音角色选择 | `VoiceRolePickerWindow.cs` | 不迁移 | 该窗口只被 `--voice-role-picker-preview` 开发预览参数构造，正式用户链路使用 `voice_conversation` 内置角色选择对话框；按“废项不迁移”规则排除 |

“已复制”必须同时满足：入口一致、结构和文案一致、原素材复用、业务动作接回 C# Core、构建通过、真实窗口可验收。仅有空窗口或占位页面不算完成。
