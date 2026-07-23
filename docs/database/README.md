# AIMaid 数据库报告

数据库报告工具只读取真实数据库，不调用 Core 初始化，也不执行任何写入。

生成 Schema 基线：

```powershell
.\scripts\update-database-report.ps1 schema
```

检查当前代码生成的 Schema 是否与已提交基线一致：

```powershell
.\scripts\update-database-report.ps1 schema -Check
```

生成真实数据库快照时必须明确提供绝对路径，或设置 `AIMAID_DATABASE_REPORT_SOURCE`：

```powershell
.\scripts\update-database-report.ps1 snapshot -DatabasePath "C:\path\aimaid-core.db"
```

真实快照只保留 `docs/database/current-snapshot/` 的最新内容；原始 `.db`、WAL 和 SHM 文件不属于报告。
Schema、映射或迁移目标结构变化后运行基线检查；普通 UI、Electron、TTS、ASR 和视频提交不运行数据库报告。
