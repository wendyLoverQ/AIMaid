# 项目开发规则

本文件是项目级开发约束。执行任何代码修改前，必须先阅读并遵守本文件。除非任务明确要求，不要绕开这些规则。

## 一、总体原则

1. 不要把项目当成临时 Demo 处理。新增功能、修复问题、重做页面时，都按可长期维护的正式项目标准执行。
2. 不要为了快速通过而写一次性补丁。优先保持结构清晰、职责明确、可复用、可回滚。
3. 不要扩大任务范围。当前任务要求修改什么，就只修改相关内容；不要顺手重构无关模块。
4. 不要把“能跑”当作唯一目标。功能、结构、交互、可维护性和一致性都要考虑。
5. 修改前先理解现有结构，优先复用项目已有的服务、基类、样式、组件和配置，不要重复造一套。
6. 难以抉择，不懂的问题，必须要联网查询
7. 严格禁止兜底降级。
8.每次改动都要提交代码发布到github
 ## 二、版本号规则

1. 版本号采用 CalVer + 累计发布次数：`YYYY.M.D.DailyIndex.TotalCount`，共五段。示例：`2026.7.16.1.666` 表示 2026 年 7 月 16 日当天第 1 次发布，项目至今累计发布 666 次。
2. 日期以 `Asia/Shanghai` 时区为准，避免跨日发布时版本号与本地认知不一致。
3. 五段语义：
   - 第一段 `YYYY`：发布年份（如 `2026`）。
   - 第二段 `M`：发布月份，不补零（如 `7`、`12`）。
   - 第三段 `D`：发布日期，不补零（如 `16`、`3`）。
   - 第四段 `DailyIndex`：当天第几次发布，从 `1` 开始；同日再次发布 `+1`，跨日重置为 `1`。
   - 第五段 `TotalCount`：项目累计发布次数，从 `1` 开始单调递增，永不重置。
4. 字段映射（因 CLR 限制，`AssemblyVersion` / `FileVersion` 只支持四段整数；`VersionPrefix` 受 NuGet SemVer 限制不使用）：
   - `InformationalVersion`：完整五段 `YYYY.M.D.DailyIndex.TotalCount`（如 `2026.7.16.1.666`），用于 UI 显示与日志。
   - `AssemblyVersion` / `FileVersion`：四段 `YYYY.M.D.TotalCount`（如 `2026.7.16.666`），第四段为累计发布次数，保证版本号单调递增。
5. 版本号字段统一写在 `TimerMaidWpf.csproj` 顶层 `PropertyGroup` 中，禁止在业务代码、配置文件或脚本里硬编码版本字符串。
6. 每次发布必须同时更新 `InformationalVersion`、`AssemblyVersion`、`FileVersion` 三个字段，且保持语义一致（`TotalCount` 必须三处同步）。
7. `DailyIndex` 当天首次发布 = `1`，同日再次发布 `+1`，跨日重置为 `1`。
8. `TotalCount` 每次发布 `+1`，跨日不重置，永久单调递增；修改时必须确认与上一次发布的 `TotalCount` 严格递增。
9. UI 显示版本号统一读取 `Assembly.GetEntryAssembly()` 的 `AssemblyInformationalVersionAttribute`，代码需去除 SDK 自动追加的 SourceLink commit hash 后缀（`+<sha>`），只显示 `+` 之前的部分。
10. 版本号变更只能通过修改 `csproj` 实现；不允许在运行时改写、覆盖或动态生成版本号。
11. 发布脚本（`scripts/build/publish_release.ps1`）暂不自动计算版本号，由发布者手工修改 `csproj` 后再执行发布。
12. 修改版本号后必须按项目已有方式构建验证，确保 `AssemblyVersion` / `FileVersion` / `InformationalVersion` 三个字段正确写入程序集。
13. 版本号属于元数据变更，不得顺手修改业务逻辑、UI 交互或数据结构。

## 六、数据库报告

1. 修改 Schema、数据库映射或迁移目标结构后，必须运行 Schema 基线检查。
2. 普通 UI 或业务提交不运行数据库报告；真实数据库快照只在主人明确要求时更新。
3. 原始数据库禁止提交；报告差异必须真实处理，不得直接覆盖基线掩盖问题。
