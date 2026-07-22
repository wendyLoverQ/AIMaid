# 并行任务 B：系统设置与真实运行消费者

## 任务目标

把系统设置页面中仍未绑定的现役配置完整抄回 C# Core，并让保存后的配置真正驱动运行时。只做老项目当前仍使用的设置，废弃项不要迁移。

## 项目位置

- 当前项目：`C:\Users\49213\Desktop\A\codex\AIMaid`
- 老项目（唯一依据）：`C:\Users\49213\Desktop\A\codex\AI_maid`
- 总分工：`C:\Users\49213\Desktop\A\codex\AIMaid\docs\并行改造总分工_三任务.md`

## 前端所有权

- `apps/desktop/src/renderer/pages/settings/SettingsPage.tsx`
- `apps/desktop/src/renderer/pages/settings/settings-page.css`
- `apps/desktop/src/renderer/pages/settings/user-configuration-fields.ts`

可按需新增 `apps/desktop/src/renderer/pages/settings/` 内文件。不要改 pet、status、music、character、template-card 或 agent-confirm 页面。

## 老项目依据

- `src/Views/SystemSettingsWindow.xaml`
- `src/Views/SystemSettingsWindow.xaml.cs`
- `src/Services/UserConfigurationService.cs`
- `src/Services/TrayService.cs`
- 全局热键、开机启动、气泡、实时 TTS、决策、免打扰、模板诊断等设置实际消费者
- 模型启动与业务模型选择相关 service/initializer

必须先从老窗口的加载、保存、校验和调用点反查每个配置；不能只根据设置卡标题猜行为。

## 必须闭环

1. 逐项识别页面上仍是 React 本地状态或只有持久化、没有消费者的设置。
2. 语言、开机启动、气泡主题、实时 TTS、缓存周期、主动决策、免打扰、模板诊断和全局热键等，只迁移老项目当前确实使用的项。
3. 保存使用老项目现有 `user_config:` 键、默认值、范围校验、立即生效/重启生效语义和反馈文案。
4. 开机启动与全局热键必须接 Electron/Windows 平台能力，不能只写数据库。
5. 已保存的模型配置、业务模型映射和 Source Prompt 必须真正被聊天、主动决策、提醒语音、Agent 规划、懒加载语音缓存和角色卡扩展消费者读取；不能停留在设置 UI。
6. 自定义音色调用必须沿用老项目音色资产中的 `meta.json`、`prompt.txt`、`prompt.wav` 协议，不得只发送一个虚构的 voice id。
7. 不增加深色/浅色主题，不恢复废弃外观项，不新增“通用”配置替代原配置。

## 共享文件规则

可以窄范围追加：

- `src/AIMaid.Contracts/`
- `src/AIMaid.Core/SettingsApplicationService.cs`
- `src/AIMaid.CoreHost/Runtime/CoreProtocolHost.cs`
- `src/AIMaid.CoreHost/Program.cs`
- `apps/desktop/src/shared/business.ts`
- `apps/desktop/src/shared/core.ts`
- Electron 主进程中与开机启动/全局热键直接相关的独立文件

优先新建独立 service，不要重写 `ExtendedDomainApplicationService.cs` 或 `CoreProtocolHost.cs`。共享文件只做最小构造注入和 route 追加。

## 验收

- 页面重新打开后值来自 Core 持久化。
- 保存后真实消费者行为发生变化；需要重启的项明确按老项目提示。
- 不再有仍可点击但只更新本地状态的正式设置。
- `dotnet build AIMaid.sln -c Release` 和 `npm run typecheck` 通过。
- 完成后只报告修改文件和需用户实机验证的 OS/外部服务依赖，不打包、不发布。

## 可直接粘贴给新对话

> 按 `C:\Users\49213\Desktop\A\codex\AIMaid\docs\并行任务B_系统设置运行态交接.md` 直接实施。严格反查并抄老项目现役设置及真实消费者，不新增设置，不恢复废项；保留其他任务修改，不打包发布。
