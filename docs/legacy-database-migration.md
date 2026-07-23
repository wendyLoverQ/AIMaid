# 旧 AI_maid SQLite 迁移与清理

## 安全边界

迁移器以 SQLite `Mode=ReadOnly` 打开旧库，不会在旧库执行 `DROP TABLE`、`DROP COLUMN`、
`DELETE` 或结构升级。目标始终写到新的 `.partial-*` 文件，全部成功后才原子改名；目标文件或
报告已存在时直接停止，不覆盖。

迁移入口：`tools/AIMaid.LegacyMigration`。

## 新库物理结构

真实旧库有 50 张业务/辅助表。迁移后只保留 5 张物理表：

- `AppSettings`
- `ChatMessages`
- `VoiceRoleCards`
- `CoreBackgroundTasks`
- 当前关系存储实际使用的扩展业务表（由 `LegacyRelationalDocumentStore` 的 Domain 映射定义）。

`CoreDocuments` 仅作为历史迁移产物保留。普通 Core 启动不会删除它；若其中仍有数据，启动会
明确停止并要求完成兼容迁移，不会假装关系存储已经读取这些数据。

## 整表废弃

| 旧表 | 原因 |
|---|---|
| `AiConversations` | 已被当前 `ChatMessages` 和角色会话链取代 |
| `ChatCommandLaunchers` | 当前 9 条均为孤立记录，Agent 能力配置已是唯一入口 |
| `DbColumnComments` | 旧库自描述元数据，不是用户业务数据 |
| `DesktopContextSnapshots` | 高频短期桌面遥测和隐私数据，迁移后实时重建 |
| `RemoteDownloadTasks` | 当前全部为完成、失败或取消的瞬时任务，不能恢复 |
| `VoiceCacheDedupeLogs` | 缓存生成诊断日志 |
| `VoiceRoleAudioCaches` | 可重新生成的派生音频缓存索引 |
| `VoiceTriggerLogs` | 旧播放器执行日志，不参与业务状态 |

## 重点字段清理

- `NotebookNotes`：删除 `ContentXaml`、`ContentRich` 和旧 `ImagePathsJson`，迁移为 Markdown/
  纯文本及附件 ID。
- `VideoItems`：删除可推导的文件名/扩展名、短期 `ResolvedPlayUrl`、封面/预览缓存状态和重复文件时间；
  补回专辑、播放位置、完成状态、文件大小等核心字段。
- `VoiceRoleCards`：删除旧自增 ID，保留并补回角色卡摘要、Schema、模板生成状态、迭代次数和校验详情。
- `LlmCallLogs`：保留来源、模型、状态、耗时、response ID 和 token 审计；删除 Prompt 正文、请求正文、
  原始响应、重复响应正文、本机音频路径和 Endpoint 快照。
- `ProactiveBroadcastSourceSettings`：保留策略；删除上次快照、哈希、评分和播报缓存。
- `RemoteSiteConfigs`：Cookie 从普通字段移入加密文档，旧 Cookie 文件路径废弃。
- `VaultItems`：旧五类密文解密后合并为一个 JSON，再使用目标库密钥重新加密；公开元数据与秘密分离。
- `AppSettings`：删除 WPF 窗口坐标、旧独立 Live2D/ViewerEX 设置、初始化标记和派生 UI 状态；
  API Key 等敏感值移入 `protected_setting`，原设置值只保存引用标记。

## 使用方式

密钥通过进程环境变量传入，避免出现在命令行和迁移报告中：

```powershell
$env:AIMAID_TARGET_SECRET_KEY = '<32 字节随机密钥的 Base64>'
$env:AIMAID_LEGACY_VAULT_KEY = '<旧 App:Vault:EncryptionString>'

dotnet run --project tools/AIMaid.LegacyMigration/AIMaid.LegacyMigration.csproj -- `
  --source 'D:\old\ai_maid.db' `
  --destination 'D:\new\aimaid-core.db' `
  --report 'D:\new\aimaid-core.db.migration-report.json'
```

如果明确不迁移保险库秘密，可使用 `--skip-vault-secrets`；迁移报告会记录该事实。没有该显式参数且
旧库存在秘密时，缺少旧密钥会直接失败。

## 真实库验证结果

2026-07-21 使用当前约 221 MB 的旧库完成了两次只读演练：

- 识别 50 张表，未出现未审计表。
- 完整迁移 22,405 行业务数据；排除 68,876 行缓存、遥测、诊断、过期任务和废弃设置。
- 新库按当前 Domain 映射建立完整关系表，启动时只执行非破坏性的建表、补列和索引升级。
- `ChatMessages` 302 条、`VoiceRoleCards` 51 条、远程媒体索引 11,200 条均保留。
- 7 条保险库秘密、8 条保险库历史、5 条敏感设置和 7 条站点 Cookie 均重新加密。
- 新库中敏感 `AppSettings` 明文数量为 0（历史数据迁移仍以实际报告为准）。
- SQLite `PRAGMA integrity_check` 返回 `ok`。

旧 Agent 的 `db_query`、`http_api`、`internal_service`、`internal_ui`、`process_kill`、
`process_query`、`script`、`tcp_check`、`workflow` 配置已完整保留，但执行器仍需后续逐个接回；
迁移器不会把它们偷偷替换成别的执行方式。
