# 并行任务 C：角色、模板卡与 Agent 确认闭环

## 任务目标

完成角色管理链路剩余业务，并把 Agent 高风险操作确认从 localStorage 演示改为真实异步执行闭环。布局、文案、校验和状态严格抄老项目。

## 项目位置

- 当前项目：`C:\Users\49213\Desktop\A\codex\AIMaid`
- 老项目（唯一依据）：`C:\Users\49213\Desktop\A\codex\AI_maid`
- 总分工：`C:\Users\49213\Desktop\A\codex\AIMaid\docs\并行改造总分工_三任务.md`

## 前端所有权

- `apps/desktop/src/renderer/pages/system/CharactersPage.tsx`
- `apps/desktop/src/renderer/pages/system/CharacterEditorPage.tsx`
- `apps/desktop/src/renderer/pages/system/TemplateCardPage.tsx`
- `apps/desktop/src/renderer/pages/system/AgentConfirmPage.tsx`
- 上述页面对应 CSS
- 角色对话页中仅“真实头像/当前角色联动”所需的最小修改

实际文件名若不同，以 `apps/desktop/src/renderer/pages/system/` 当前代码为准，不要新造第二套页面。

## 老项目依据

- `src/Views/CharacterWindow.cs`
- `src/Views/CharacterEditorWindow.cs`
- `src/Views/TemplateCardDetailWindow.cs`
- `src/Views/AgentConfirmWindow.xaml`
- `src/Views/AgentConfirmWindow.xaml.cs`
- `src/Resources/Web/character_role_list/`
- 角色卡生成、继续迭代、当前对象绑定、角色删除清理和 Agent 执行调用点

## 必须闭环

1. 当前对象绑定：角色编辑器按老项目加载、选择、保存和清除当前对象，切换当前角色后各入口读取一致。
2. 模板卡：真实加载状态、生成时间、迭代次数和 JSON；“重新生成”“继续迭代”走老项目真实模型链、Source Prompt、持久化和错误反馈。
3. 角色删除：同步清理老项目规定的角色卡、音色绑定、对象绑定和关联文档；不要删除共享音色源资产，除非老项目明确如此。
4. 角色对话中心的头像使用已迁移的真实 `AvatarPath`，缺失时沿用老项目占位规则。
5. Agent 确认：移除 `aimaid.agent-confirm-request/result` localStorage 通信；执行请求携带能力名、说明、执行器、风险和完整参数打开固定确认窗口。
6. 取消必须返回拒绝；继续必须把同一请求及 approval token 交回原 Agent 执行链，结果只能完成一次；窗口关闭按老项目取消处理。
7. 多个确认请求、超时、Core 重启或调用方取消时不能串单，也不能留下永久等待任务。
8. 能力列表、执行器和风险必须来自真实 Agent 注册信息，不在 React 中硬编码假数据。

## 共享文件规则

优先修改或新增：

- `src/AIMaid.Contracts/CharacterContracts.cs`
- 角色/模板/Agent 独立 contracts
- `src/AIMaid.Core/CharacterApplicationService.cs`
- `src/AIMaid.Core/CharacterAssetApplicationService.cs`
- 独立 TemplateCard/Agent application service
- Electron 主进程中独立的 Agent confirmation coordinator

`CoreProtocolHost.cs`、`Program.cs`、`business.ts`、`core.ts` 和 window manager 只允许最小追加。不要改 settings、pet、status、music、video 或 remote-video 页面。

## 验收

- 从角色列表进入编辑、保存对象绑定、打开模板卡、重新生成/继续迭代形成完整用户链路。
- 从真实 Agent 执行请求弹出确认窗，取消与继续分别驱动原调用方得到唯一结果。
- 页面不再出现“Core 路由待接”，Agent 页面不再读写 localStorage 请求结果。
- 数据关闭窗口重开后仍存在。
- `dotnet build AIMaid.sln -c Release` 和 `npm run typecheck` 通过。
- 完成后不打包、不发布，只报告修改和用户需实机验收项。

## 可直接粘贴给新对话

> 按 `C:\Users\49213\Desktop\A\codex\AIMaid\docs\并行任务C_角色模板Agent交接.md` 直接实施。严格抄老项目角色、模板卡和 Agent 确认完整链路；保留其他任务修改，不打包发布。
