using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using AIMaid.Infrastructure;
using Microsoft.Data.Sqlite;

namespace AIMaid.LegacyMigration;

public sealed class LegacyDatabaseMigrator
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };

    private static readonly IReadOnlyDictionary<string, string> DroppedTables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["AiConversations"] = "旧版 Provider 单行会话，已被 ChatMessages/LlmChatMessages 取代。",
        ["DbColumnComments"] = "旧 SQLite 自描述元数据，不属于用户业务数据。",
        ["DesktopContextSnapshots"] = "短期桌面遥测与隐私数据，迁移后由实时 ActivityProbe 重新采集。",
        ["RemoteDownloadTasks"] = "全部为 Completed/Failed/Cancelled 的瞬时任务状态，不可恢复执行。",
        ["VoiceCacheDedupeLogs"] = "语音缓存生成诊断日志，可重新生成。",
        ["VoiceRoleAudioCaches"] = "派生音频缓存索引，可从角色、音色和素材重新生成。",
        ["VoiceTriggerLogs"] = "旧播放执行日志，不参与新核心业务状态。"
    };

    private static readonly IReadOnlyDictionary<string, DocumentPolicy> DocumentPolicies = BuildDocumentPolicies();

    public async Task<MigrationReport> MigrateAsync(MigrationOptions options, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(options.SourcePath)) throw new FileNotFoundException("旧数据库不存在。", options.SourcePath);
        if (File.Exists(options.DestinationPath)) throw new IOException("目标数据库已存在；迁移器拒绝覆盖。请提供新的目标路径。");
        if (File.Exists(options.ReportPath)) throw new IOException("迁移报告已存在；迁移器拒绝覆盖。");

        var partialPath = options.DestinationPath + $".partial-{Guid.NewGuid():N}";
        Directory.CreateDirectory(Path.GetDirectoryName(options.DestinationPath)!);
        Directory.CreateDirectory(Path.GetDirectoryName(options.ReportPath)!);
        var startedAt = DateTimeOffset.Now;
        var tableResults = new List<TableMigrationResult>();
        var warnings = new List<string>();
        long migratedRows = 0;
        long droppedRows = 0;

        try
        {
            await using var source = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = options.SourcePath,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false
            }.ToString());
            await source.OpenAsync(cancellationToken);
            await using var sourceTransaction = source.BeginTransaction(deferred: true);
            var sourceTables = await GetSourceTablesAsync(source, sourceTransaction, cancellationToken);
            ValidateTableCoverage(sourceTables);
            await ValidateVaultRequirementsAsync(source, sourceTransaction, options, cancellationToken);

            var targetStore = new SqliteCoreStore(new CoreStorageOptions(partialPath));
            await targetStore.InitializeAsync(cancellationToken);
            await using var target = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = partialPath, Pooling = false }.ToString());
            await target.OpenAsync(cancellationToken);
            await using var targetTransaction = (SqliteTransaction)await target.BeginTransactionAsync(cancellationToken);
            var protector = new AesGcmSecretProtector(new SecretProtectionOptions(options.TargetSecretKeyBase64));

            foreach (var table in sourceTables.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var sourceRows = await CountAsync(source, sourceTransaction, table, cancellationToken);
                TableMigrationResult result;
                if (DroppedTables.TryGetValue(table, out var reason))
                {
                    result = new(table, sourceRows, "dropped", null, 0, [], reason);
                    droppedRows += sourceRows;
                }
                else
                {
                    result = table switch
                    {
                        "AppSettings" => await MigrateSettingsAsync(source, sourceTransaction, target, targetTransaction, protector, sourceRows, cancellationToken),
                        "ChatMessages" => await MigrateChatAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "ChatCommandLaunchers" => await MigrateChatCommandLaunchersAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "VoiceRoleCards" => await MigrateCharactersAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "AgentCapabilities" => await MigrateAgentCapabilitiesAsync(source, sourceTransaction, target, targetTransaction, sourceRows, warnings, cancellationToken),
                        "AgentToolCalls" => await MigrateAgentToolCallsAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "DisturbanceSettings" => await MigrateDisturbanceSettingsAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "Reminders" => await MigrateRemindersAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "NotebookNotes" => await MigrateNotebookNotesAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "VaultItems" => await MigrateVaultItemsAsync(source, sourceTransaction, target, targetTransaction, protector, options, sourceRows, warnings, cancellationToken),
                        "VaultItemHistories" => await MigrateVaultHistoryAsync(source, sourceTransaction, target, targetTransaction, protector, options, sourceRows, cancellationToken),
                        "CryptoMarketEvents" => await MigrateMarketEventsAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "VideoItems" => await MigrateVideosAsync(source, sourceTransaction, target, targetTransaction, sourceRows, cancellationToken),
                        "RemoteSiteConfigs" => await MigrateRemoteSitesAsync(source, sourceTransaction, target, targetTransaction, protector, sourceRows, cancellationToken),
                        _ => await MigrateDocumentTableAsync(source, sourceTransaction, target, targetTransaction, DocumentPolicies[table], sourceRows, cancellationToken)
                    };
                    migratedRows += result.MigratedRows;
                    droppedRows += result.SourceRows - result.MigratedRows;
                }
                tableResults.Add(result);
            }

            await targetTransaction.CommitAsync(cancellationToken);
            await sourceTransaction.CommitAsync(cancellationToken);
            var completedAt = DateTimeOffset.Now;
            var report = new MigrationReport(options.SourcePath, options.DestinationPath, startedAt, completedAt,
                sourceTables.Count, migratedRows, droppedRows, tableResults, warnings);
            await InsertDocumentAsync(target, null, "_migration", "legacy_ai_maid", JsonSerializer.Serialize(report, JsonOptions), completedAt, cancellationToken);
            await using (var checkpoint = target.CreateCommand())
            {
                checkpoint.CommandText = "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;";
                await checkpoint.ExecuteNonQueryAsync(cancellationToken);
            }
            await target.CloseAsync();
            SqliteConnection.ClearAllPools();
            File.Move(partialPath, options.DestinationPath, false);
            await File.WriteAllTextAsync(options.ReportPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }), cancellationToken);
            return report;
        }
        catch
        {
            TryDelete(partialPath);
            TryDelete(partialPath + "-wal");
            TryDelete(partialPath + "-shm");
            throw;
        }
    }

    private static async Task<TableMigrationResult> MigrateSettingsAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, AesGcmSecretProtector protector, long sourceRows, CancellationToken cancellationToken)
    {
        var migrated = 0L;
        await using var command = source.CreateCommand();
        command.Transaction = sourceTx;
        command.CommandText = "SELECT Key,Value FROM AppSettings ORDER BY Key";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var key = Text(reader, "Key");
            var value = Text(reader, "Value");
            if (IsDeprecatedSetting(key)) continue;
            if (IsSensitiveSetting(key))
            {
                await InsertDocumentAsync(target, targetTx, "protected_setting", key, protector.Protect(value), DateTimeOffset.Now, cancellationToken);
                value = $"@protected:{key}";
            }
            await ExecuteAsync(target, targetTx, """
                INSERT INTO AppSettings(Key,Value,UpdatedAt) VALUES($key,$value,$updated)
                ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value,UpdatedAt=excluded.UpdatedAt
                """, cancellationToken, ("$key", key), ("$value", value), ("$updated", NowText()));
            migrated++;
        }
        return new("AppSettings", sourceRows, "filtered", "AppSettings + protected_setting", migrated, ["Id"],
            "移除 WPF 窗口坐标、旧 Live2D 独立进程、ViewerEX、初始化标记和派生 UI 状态；API Key 转入加密文档。");
    }

    private static async Task<TableMigrationResult> MigrateChatAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command = SourceCommand(source, sourceTx, "SELECT ConversationId,Role,Content,CharacterId,ModelName,Source,MetadataJson,CreatedAt FROM ChatMessages ORDER BY Id");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        long count = 0;
        while (await reader.ReadAsync(cancellationToken))
        {
            await ExecuteAsync(target, targetTx, """
                INSERT INTO ChatMessages(ConversationId,Role,Content,CharacterId,ModelName,Source,MetadataJson,CreatedAt)
                VALUES($conversation,$role,$content,$character,$model,$source,$metadata,$created)
                """, cancellationToken, ("$conversation", Text(reader,"ConversationId")), ("$role", Text(reader,"Role")),
                ("$content", Text(reader,"Content")), ("$character", Text(reader,"CharacterId")), ("$model", Text(reader,"ModelName")),
                ("$source", Text(reader,"Source")), ("$metadata", Text(reader,"MetadataJson")), ("$created", DateText(reader,"CreatedAt")));
            count++;
        }
        return new("ChatMessages", sourceRows, "migrated", "ChatMessages", count, ["Id"], "保留当前主聊天链路；自增主键在新库重建。");
    }

    private static async Task<TableMigrationResult> MigrateChatCommandLaunchersAsync(
        SqliteConnection source, SqliteTransaction sourceTx, SqliteConnection target, SqliteTransaction targetTx,
        long sourceRows, CancellationToken cancellationToken)
    {
        await using var command = SourceCommand(source, sourceTx, "SELECT * FROM ChatCommandLaunchers ORDER BY Id");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        long count = 0;
        while (await reader.ReadAsync(cancellationToken))
        {
            var id = $"legacy_launcher_{Integer64(reader, "Id")}";
            var updatedAt = ReadDate(reader, "UpdatedAt");
            var launcher = new JsonObject
            {
                ["LauncherId"] = id,
                ["CommandText"] = Text(reader, "CommandText"),
                ["DisplayName"] = Text(reader, "DisplayName"),
                ["ExePath"] = Text(reader, "ExePath"),
                ["Arguments"] = Text(reader, "Arguments"),
                ["WorkingDirectory"] = Text(reader, "WorkingDirectory"),
                ["Enabled"] = Boolean(reader, "Enabled"),
                ["UpdatedAt"] = updatedAt.ToString("O", CultureInfo.InvariantCulture)
            };
            await InsertDocumentAsync(target, targetTx, "chat_command_launcher", id, launcher.ToJsonString(), updatedAt, cancellationToken);
            count++;
        }
        return new("ChatCommandLaunchers", sourceRows, "migrated", "CoreDocuments/chat_command_launcher", count,
            ["Id"], "保留用户配置的聊天快捷指令及其启动目标。");
    }

    private static async Task<TableMigrationResult> MigrateCharactersAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command = SourceCommand(source, sourceTx, "SELECT c.*, COALESCE(r.AvatarPath,'') AS MigratedAvatarPath FROM VoiceRoleCards c LEFT JOIN VoiceRoles r ON r.RoleId=c.RoleId ORDER BY c.RoleId");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        long count = 0;
        while (await reader.ReadAsync(cancellationToken))
        {
            await ExecuteAsync(target, targetTx, """
                INSERT INTO VoiceRoleCards(RoleId,Name,VoiceName,RoleTitle,CardPath,SourceCardJson,TemplateCardJson,CardSummary,
                  CardSchemaVersion,TemplateCardSourceHash,TemplateCardGenerationStatus,TemplateCardGenerationMessage,
                  TemplateCardGeneratedAt,TemplateCardLastAttemptAt,TemplateCardIterationCount,PreferredVoiceId,
                  ValidationStatus,ValidationMessage,LastValidatedAt,AvatarPath,IsEnabled,UpdatedAt)
                VALUES($role,$name,$voice,$title,$path,$source,$template,$summary,$schema,$hash,$generationStatus,
                  $generationMessage,$generated,$attempt,$iterations,$preferred,$validation,$validationMessage,$validated,$avatar,$enabled,$updated)
                """, cancellationToken,
                ("$role",Text(reader,"RoleId")),("$name",Text(reader,"Name")),("$voice",Text(reader,"VoiceName")),
                ("$title",Text(reader,"RoleTitle")),("$path",Text(reader,"CardPath")),("$source",Text(reader,"SourceCardJson")),
                ("$template",Text(reader,"TemplateCardJson")),("$summary",Text(reader,"CardSummary")),("$schema",Text(reader,"CardSchemaVersion")),
                ("$hash",Text(reader,"TemplateCardSourceHash")),("$generationStatus",Text(reader,"TemplateCardGenerationStatus")),
                ("$generationMessage",Text(reader,"TemplateCardGenerationMessage")),("$generated",DbDate(reader,"TemplateCardGeneratedAt")),
                ("$attempt",DbDate(reader,"TemplateCardLastAttemptAt")),("$iterations",Integer(reader,"TemplateCardIterationCount")),
                ("$preferred",Text(reader,"PreferredVoiceId")),("$validation",Text(reader,"ValidationStatus")),
                ("$validationMessage",Text(reader,"ValidationMessage")),("$validated",DbDate(reader,"LastValidatedAt")),
                ("$avatar",NormalizeLegacyAvatarPath(Text(reader,"RoleId"),Text(reader,"MigratedAvatarPath"))),
                ("$enabled",Boolean(reader,"IsEnabled") ? 1 : 0),("$updated",DateText(reader,"UpdatedAt")));
            count++;
        }
        return new("VoiceRoleCards", sourceRows, "migrated", "VoiceRoleCards", count,
            ["Id","CreatedAt"], "补回模板生成状态、迭代次数、校验消息等先前遗漏的核心字段。");
    }

    private static string NormalizeLegacyAvatarPath(string roleId, string avatarPath)
    {
        var normalized = avatarPath.Replace('\\', '/').Trim();
        return roleId.Equals("sixian", StringComparison.OrdinalIgnoreCase) &&
               normalized.Equals("Assets/characters/sixian_1.jpg", StringComparison.OrdinalIgnoreCase)
            ? "Assets/characters/sixian.jpg"
            : avatarPath;
    }

    private static async Task<TableMigrationResult> MigrateAgentCapabilitiesAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, List<string> warnings, CancellationToken cancellationToken)
    {
        var executors = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        await using var command = SourceCommand(source, sourceTx, "SELECT * FROM AgentCapabilities ORDER BY SortOrder,Id");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        long count = 0;
        while (await reader.ReadAsync(cancellationToken))
        {
            var executor = Text(reader,"ExecutorType"); executors.Add(executor);
            var dto = new JsonObject
            {
                ["CapabilityName"] = Text(reader,"CapabilityName"), ["DisplayName"] = Text(reader,"DisplayName"),
                ["Description"] = Text(reader,"Description"), ["ExecutorType"] = executor,
                ["ConfigJson"] = Text(reader,"ConfigJson"), ["ArgsSchemaJson"] = Text(reader,"ArgsSchemaJson"),
                ["ResultPolicy"] = Text(reader,"ResultPolicy"), ["RiskLevel"] = Text(reader,"RiskLevel"),
                ["RequireConfirm"] = Boolean(reader,"RequireConfirm"), ["Enabled"] = Boolean(reader,"Enabled"),
                ["SortOrder"] = Integer(reader,"SortOrder"), ["UpdatedAt"] = DateText(reader,"UpdatedAt")
            };
            await InsertDocumentAsync(target,targetTx,"agent_capability",Text(reader,"CapabilityName"),dto.ToJsonString(),ReadDate(reader,"UpdatedAt"),cancellationToken);
            count++;
        }
        warnings.Add($"旧 Agent 执行器需逐个接回：{string.Join(", ", executors.Order())}。配置已保留，不做静默替换。");
        return new("AgentCapabilities",sourceRows,"migrated","CoreDocuments/agent_capability",count,["Id","ChatCommandLauncherId","CreatedAt"],"保留能力和审批语义；孤立 ChatCommandLauncher 外键废弃。");
    }

    private static async Task<TableMigrationResult> MigrateAgentToolCallsAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command = SourceCommand(source,sourceTx,"SELECT * FROM AgentToolCalls ORDER BY Id");
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        long count=0;
        while(await reader.ReadAsync(cancellationToken))
        {
            var id=$"legacy_tool_{Integer64(reader,"Id")}";
            var dto=new JsonObject {
                ["CallId"]=id,["ConversationId"]=Text(reader,"ConversationId"),["CapabilityName"]=Text(reader,"CapabilityName"),
                ["ArgsJson"]=Text(reader,"ArgsJson"),["Status"]=Text(reader,"Status"),["ExitCode"]=NullableInteger(reader,"ExitCode"),
                ["Output"]=Text(reader,"Stdout"),["Error"]=FirstNonEmpty(Text(reader,"ErrorMessage"),Text(reader,"Stderr")),
                ["ConfirmedByUser"]=Boolean(reader,"ConfirmedByUser"),["RejectedByUser"]=Boolean(reader,"RejectedByUser"),
                ["CreatedAt"]=DateText(reader,"CreatedAt"),["FinishedAt"]=NullableDateNode(reader,"FinishedAt"),
                ["ParentCallId"]=reader["ParentToolCallId"] is DBNull?null:$"legacy_tool_{Integer64(reader,"ParentToolCallId")}",
                ["ExecutorType"]=Text(reader,"ExecutorType"),["ResultPolicy"]=Text(reader,"ResultPolicy"),
                ["DisplayResult"]=Text(reader,"DisplayResult"),["DurationMs"]=Integer(reader,"DurationMs") };
            await InsertDocumentAsync(target,targetTx,"agent_tool_call",id,dto.ToJsonString(),ReadDate(reader,"CreatedAt"),cancellationToken); count++;
        }
        return new("AgentToolCalls",sourceRows,"migrated","CoreDocuments/agent_tool_call",count,["Id","StartedAt","Stderr"],"父调用、执行器、结果策略和耗时已补回 DTO；stderr 合并到错误字段。");
    }

    private static async Task<TableMigrationResult> MigrateDisturbanceSettingsAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM DisturbanceSettings ORDER BY Id DESC LIMIT 1");
        await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        if(await reader.ReadAsync(cancellationToken)) { var dto=new JsonObject { ["Mode"]=Text(reader,"Mode"),["QuietHoursEnabled"]=Boolean(reader,"QuietHoursEnabled"),["QuietHoursStart"]=Text(reader,"QuietHoursStart"),["QuietHoursEnd"]=Text(reader,"QuietHoursEnd"),["SuppressWhenFullscreen"]=Boolean(reader,"SuppressWhenFullscreen"),["MaxProactivePerHour"]=Integer(reader,"MaxProactivePerHour"),["UpdatedAt"]=DateText(reader,"UpdatedAt")}; await InsertDocumentAsync(target,targetTx,"disturbance_settings","current",dto.ToJsonString(),ReadDate(reader,"UpdatedAt"),cancellationToken); count=1; }
        return new("DisturbanceSettings",sourceRows,"migrated","CoreDocuments/disturbance_settings",count,["Id"],"单例配置归一为固定 ID current。");
    }

    private static async Task<TableMigrationResult> MigrateRemindersAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM Reminders ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken)) { var dto=RowJson(reader,new HashSet<string>(["Id"],StringComparer.OrdinalIgnoreCase),new HashSet<string>(["Enabled","AllowTts"],StringComparer.OrdinalIgnoreCase)); await InsertDocumentAsync(target,targetTx,"reminder",Text(reader,"ReminderId"),dto,ReadDate(reader,"UpdatedAt"),cancellationToken); count++; }
        return new("Reminders",sourceRows,"migrated","CoreDocuments/reminder",count,["Id"],"保留调度、重复和最后触发状态。");
    }

    private static async Task<TableMigrationResult> MigrateNotebookNotesAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM NotebookNotes ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken))
        {
            var noteId=Text(reader,"NoteId"); var attachments=await ReadAttachmentIdsAsync(source,sourceTx,noteId,cancellationToken);
            var plain=Text(reader,"ContentPlainText"); if(string.IsNullOrWhiteSpace(plain)) plain=Text(reader,"ContentRich");
            var dto=new JsonObject { ["NoteId"]=noteId,["Title"]=Text(reader,"Title"),["ContentMarkdown"]=plain,["ContentPlainText"]=Text(reader,"ContentPlainText"),["AttachmentIds"]=new JsonArray(attachments.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()),["IsPinned"]=Boolean(reader,"IsPinned"),["IsDeleted"]=Boolean(reader,"IsDeleted"),["CreatedAt"]=DateText(reader,"CreatedAt"),["UpdatedAt"]=DateText(reader,"UpdatedAt")};
            await InsertDocumentAsync(target,targetTx,"notebook",noteId,dto.ToJsonString(),ReadDate(reader,"UpdatedAt"),cancellationToken); count++;
        }
        return new("NotebookNotes",sourceRows,"transformed","CoreDocuments/notebook",count,["Id","ContentXaml","ContentRich","ImagePathsJson"],"去除 WPF/XAML 富文本，只保留可跨平台的纯文本/Markdown 和附件 ID。");
    }

    private static async Task<TableMigrationResult> MigrateVaultItemsAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, AesGcmSecretProtector protector, MigrationOptions options,
        long sourceRows, List<string> warnings, CancellationToken cancellationToken)
    {
        var decryptor=options.SkipVaultSecrets?null:new LegacyVaultDecryptor(options.LegacyVaultKey!);
        if (!options.SkipVaultSecrets && !string.IsNullOrWhiteSpace(options.LegacyVaultKey))
            await InsertDocumentAsync(target, targetTx, "protected_setting", "vault_export_password", protector.Protect(options.LegacyVaultKey), DateTimeOffset.Now, cancellationToken);
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM VaultItems ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken))
        {
            var itemId=$"legacy_vault_{Integer64(reader,"Id")}"; var secret=new JsonObject();
            if(decryptor is not null) foreach(var pair in new[]{("Password","PasswordEncrypted"),("ApiKey","ApiKeyEncrypted"),("Secret","SecretEncrypted"),("PrivateKey","PrivateKeyEncrypted"),("Mnemonic","MnemonicEncrypted")}) { var encrypted=Text(reader,pair.Item2); if(!string.IsNullOrWhiteSpace(encrypted)) secret[pair.Item1]=decryptor.Decrypt(encrypted); }
            var metadata=new JsonObject { ["ChainType"]=Text(reader,"ChainType"),["WalletAddress"]=Text(reader,"WalletAddress"),["ServerAddress"]=Text(reader,"ServerAddress"),["ServerPort"]=Text(reader,"ServerPort"),["Remark"]=Text(reader,"Remark") };
            var hasSecret=secret.Count>0;
            var dto=new JsonObject { ["ItemId"]=itemId,["ItemType"]=Text(reader,"ItemType"),["Name"]=Text(reader,"Name"),["Category"]=Text(reader,"Category"),["Account"]=Text(reader,"Account"),["Url"]=Text(reader,"Url"),["Platform"]=Text(reader,"Platform"),["PublicMetadataJson"]=metadata.ToJsonString(),["HasProtectedSecret"]=hasSecret,["CreatedAt"]=DateText(reader,"CreatedAt"),["UpdatedAt"]=DateText(reader,"UpdatedAt") };
            await InsertDocumentAsync(target,targetTx,"vault",itemId,dto.ToJsonString(),ReadDate(reader,"UpdatedAt"),cancellationToken);
            if(hasSecret) await InsertDocumentAsync(target,targetTx,"vault_secret",itemId,protector.Protect(secret.ToJsonString()),ReadDate(reader,"UpdatedAt"),cancellationToken);
            count++;
        }
        if(options.SkipVaultSecrets) warnings.Add("显式使用了 --skip-vault-secrets：保险库公开字段已迁移，7 条含秘密的记录未迁移秘密值。");
        return new("VaultItems",sourceRows,options.SkipVaultSecrets?"partial":"transformed","CoreDocuments/vault + vault_secret",count,["Id","PasswordEncrypted","ApiKeyEncrypted","SecretEncrypted","PrivateKeyEncrypted","MnemonicEncrypted"],"旧密文解密后使用目标库随机密钥重新加密；五个秘密字段合并为一个受保护 JSON。");
    }

    private static async Task<TableMigrationResult> MigrateVaultHistoryAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, AesGcmSecretProtector protector, MigrationOptions options,
        long sourceRows, CancellationToken cancellationToken)
    {
        if(options.SkipVaultSecrets) return new("VaultItemHistories",sourceRows,"dropped",null,0,["OldValueEncrypted","NewValueEncrypted"],"显式跳过旧保险库秘密时，历史秘密也不迁移。");
        var decryptor=new LegacyVaultDecryptor(options.LegacyVaultKey!); await using var command=SourceCommand(source,sourceTx,"SELECT * FROM VaultItemHistories ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken)) { var id=$"legacy_vault_history_{Integer64(reader,"Id")}"; var metadata=new JsonObject { ["HistoryId"]=id,["ItemId"]=$"legacy_vault_{Integer64(reader,"ItemId")}",["FieldName"]=Text(reader,"FieldName"),["ChangeRemark"]=Text(reader,"ChangeRemark"),["CreatedAt"]=DateText(reader,"CreatedAt") }; var secret=new JsonObject { ["OldValue"]=decryptor.Decrypt(Text(reader,"OldValueEncrypted")),["NewValue"]=decryptor.Decrypt(Text(reader,"NewValueEncrypted")) }; await InsertDocumentAsync(target,targetTx,"vault_history",id,metadata.ToJsonString(),ReadDate(reader,"CreatedAt"),cancellationToken); await InsertDocumentAsync(target,targetTx,"vault_history_secret",id,protector.Protect(secret.ToJsonString()),ReadDate(reader,"CreatedAt"),cancellationToken); count++; }
        return new("VaultItemHistories",sourceRows,"transformed","CoreDocuments/vault_history + vault_history_secret",count,["Id","OldValueEncrypted","NewValueEncrypted"],"历史元数据与重新加密的历史秘密分开保存。");
    }

    private static async Task<TableMigrationResult> MigrateMarketEventsAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM CryptoMarketEvents ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken)) { var id=string.IsNullOrWhiteSpace(Text(reader,"DedupeKey"))?$"legacy_market_{Integer64(reader,"Id")}":Text(reader,"DedupeKey"); var dto=RowJson(reader,new HashSet<string>(["Id","CreatedAt"],StringComparer.OrdinalIgnoreCase),new HashSet<string>(StringComparer.OrdinalIgnoreCase)); await InsertDocumentAsync(target,targetTx,"market_event",id,dto,ReadDate(reader,"OccurredAt"),cancellationToken); count++; }
        return new("CryptoMarketEvents",sourceRows,"migrated","CoreDocuments/market_event",count,["Id","CreatedAt"],"使用 DedupeKey 作为稳定 ID，空键回退到旧主键。");
    }

    private static async Task<TableMigrationResult> MigrateVideosAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM VideoItems ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken)) { var id=$"legacy_video_{Integer64(reader,"Id")}"; var dto=new JsonObject { ["VideoId"]=id,["SourceType"]=Text(reader,"SourceType"),["Title"]=Text(reader,"Title"),["FilePath"]=Text(reader,"FilePath"),["OriginalUrl"]=Text(reader,"OriginalUrl"),["CoverPath"]=Text(reader,"CoverPath"),["Tags"]=Text(reader,"Tags"),["SubtitlePath"]=Text(reader,"SubtitlePath"),["IsFavorite"]=Boolean(reader,"IsFavorite"),["CreatedAt"]=DateText(reader,"CreatedAt"),["UpdatedAt"]=DateText(reader,"UpdatedAt"),["AlbumId"]=reader["AlbumId"] is DBNull?null:$"legacy_album_{Integer64(reader,"AlbumId")}",["DurationSeconds"]=Integer(reader,"DurationSeconds"),["LastPositionSeconds"]=Integer(reader,"LastPositionSeconds"),["IsCompleted"]=Boolean(reader,"IsCompleted"),["FileSize"]=Integer64(reader,"FileSize"),["LastPlayedAt"]=NullableDateNode(reader,"LastPlayedAt"),["Remark"]=Text(reader,"Remark") }; await InsertDocumentAsync(target,targetTx,"video",id,dto.ToJsonString(),ReadDate(reader,"UpdatedAt"),cancellationToken); count++; }
        return new("VideoItems",sourceRows,"transformed","CoreDocuments/video",count,["Id","FileName","BaseName","Extension","ResolvedPlayUrl","CoverStatus","PreviewStatus","PreviewIndexPath","PreviewGeneratedAt","PreviewError","SubtitleFolderId","FileModifiedAt","LastWriteTime"],"去除可从文件重新计算的字段、短期解析 URL 和预览缓存状态；保留播放进度、收藏、专辑和文件大小。");
    }

    private static async Task<TableMigrationResult> MigrateRemoteSitesAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, AesGcmSecretProtector protector, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,"SELECT * FROM RemoteSiteConfigs ORDER BY Id"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken)) { var id=$"legacy_site_{Integer64(reader,"Id")}"; var settings=new JsonObject { ["UserAgent"]=Text(reader,"UserAgent"),["Referer"]=Text(reader,"Referer"),["SupportedActions"]=Text(reader,"SupportedActions"),["DefaultPlayAction"]=Text(reader,"DefaultPlayAction"),["DownloadRootOverride"]=Text(reader,"DownloadRootOverride"),["Remark"]=Text(reader,"Remark") }; var dto=new JsonObject { ["SiteId"]=id,["SiteName"]=Text(reader,"SiteName"),["DomainPattern"]=Text(reader,"DomainPattern"),["AdapterKey"]=Text(reader,"AdapterKey"),["QualityPreference"]=Text(reader,"QualityPreference"),["IsEnabled"]=Boolean(reader,"IsEnabled"),["SettingsJson"]=settings.ToJsonString(),["UpdatedAt"]=DateText(reader,"UpdatedAt") }; await InsertDocumentAsync(target,targetTx,"remote_site",id,dto.ToJsonString(),ReadDate(reader,"UpdatedAt"),cancellationToken); var cookie=Text(reader,"CookieContent"); if(!string.IsNullOrWhiteSpace(cookie)) await InsertDocumentAsync(target,targetTx,"remote_site_secret",id,protector.Protect(cookie),ReadDate(reader,"UpdatedAt"),cancellationToken); count++; }
        return new("RemoteSiteConfigs",sourceRows,"transformed","CoreDocuments/remote_site + remote_site_secret",count,["Id","CookieFilePath","CookieContent","CookieContentFormat","CookieUpdatedAt","CookieRemark","CreatedAt"],"站点设置保留；Cookie 从普通字段移入加密文档，旧 Cookie 文件路径废弃。");
    }

    private static async Task<TableMigrationResult> MigrateDocumentTableAsync(SqliteConnection source, SqliteTransaction sourceTx,
        SqliteConnection target, SqliteTransaction targetTx, DocumentPolicy policy, long sourceRows, CancellationToken cancellationToken)
    {
        await using var command=SourceCommand(source,sourceTx,$"SELECT * FROM \"{policy.Table}\""); await using var reader=await command.ExecuteReaderAsync(cancellationToken); long count=0;
        while(await reader.ReadAsync(cancellationToken)) { var id=policy.IdPrefix+Text(reader,policy.IdColumn); var json=RowJson(reader,policy.DroppedFields,policy.BooleanFields); var updated=ReadBestDate(reader); await InsertDocumentAsync(target,targetTx,policy.Domain,id,json,updated,cancellationToken); count++; }
        return new(policy.Table,sourceRows,"migrated",$"CoreDocuments/{policy.Domain}",count,policy.DroppedFields.Order().ToArray(),policy.Reason);
    }

    private static IReadOnlyDictionary<string, DocumentPolicy> BuildDocumentPolicies()
    {
        static HashSet<string> S(params string[] values)=>new(values,StringComparer.OrdinalIgnoreCase);
        var list=new[] {
            new DocumentPolicy("ActionTagDefinitions","action_tag","Tag","",S("Id","ResourcePath"),S("IsEnabled"),"动作资源路径属于 Electron renderer，核心只保留动作语义。"),
            new DocumentPolicy("AppRuntimeStates","app_runtime_state","Id","current_",S("TtsStatus","OllamaStatus","LastLlmLatencyMs","LastTtsLatencyMs","AgentStateJson","LastProactiveTriggerId"),S(),"去除瞬时服务状态和延迟指标，保留最后角色/模型/语音与交互时间。"),
            new DocumentPolicy("CryptoMarketProviderConfigurations","market_provider","Id","provider_",S("LastHealthStatus","LastHealthLatencyMs","LastCheckedAt"),S("IsEnabled"),"健康检查结果是瞬时状态，不迁移。"),
            new DocumentPolicy("CryptoMarketWatchlistItems","market_watchlist","Symbol","",S("Id"),S("IsEnabled"),"保留自选市场配置。"),
            new DocumentPolicy("LlmBusinessModelConfigs","llm_business_model","BusinessKey","",S("Id"),S("IsEnabled"),"保留业务到模型的选择配置。"),
            new DocumentPolicy("LlmCallLogs","llm_call_audit","Id","legacy_llm_call_",S("Id","Endpoint","RequestUrl","SystemPrompt","UserPrompt","RequestJson","RawResponseJson","ResponseText","ParsedResponseJson","AudioPath","VoiceId"),S(),"只保留请求审计摘要、状态、耗时和 token；删除重复正文、Prompt、原始响应与本机路径。"),
            new DocumentPolicy("LlmChatConversations","llm_chat_conversation","ConversationId","",S("Id"),S("IsActive"),"保留角色会话摘要和 response 链。"),
            new DocumentPolicy("LlmChatMessages","llm_chat_message","MessageId","",S("Id"),S(),"与主 ChatMessages 分域保存，避免 156 条相同正文被重复显示。"),
            new DocumentPolicy("LlmProviderSelections","llm_provider_selection","Id","current_",S(),S(),"保留模型提供方选择。"),
            new DocumentPolicy("LlmSourcePrompts","llm_source_prompt","SourceKey","",S("Id"),S("IsEnabled"),"保留业务 Prompt 与输出 Schema。"),
            new DocumentPolicy("MaidStates","maid_state","MaidId","",S("Id","ImagePath"),S("IsCurrent"),"保留好感度、陪伴时长与当前角色；旧图片绝对路径交给 renderer 重新绑定。"),
            new DocumentPolicy("NotebookAttachments","notebook_attachment","Id","",S(),S("IsDeleted"),"保留附件元数据；文件本身不属于数据库迁移。"),
            new DocumentPolicy("ProactiveBroadcastSourceSettings","proactive_source","SourceKey","",S("Id","LastSnapshot","LastSnapshotHash","LastScore","LastSelectReason","LastBroadcastMessage","LastBroadcastMessageHash","LastCollectedAt","LastBroadcastAt"),S("Enabled"),"保留采集策略，删除快照、哈希、评分和上次播报缓存。"),
            new DocumentPolicy("ProactiveBroadcastTriggerLogs","proactive_audit","EventId","",S("Id","WindowTitle","CandidatesJson","PayloadJson","Message","AudioPath","UpdatedAt"),S("Responded","Spoke"),"保留触发审计摘要，删除窗口标题、候选正文、消息正文和音频路径。"),
            new DocumentPolicy("ReminderLogs","reminder_history","Id","legacy_reminder_log_",S("Id"),S("PlayedTts"),"保留提醒触发历史。"),
            new DocumentPolicy("RemotePlayHistories","remote_play_history","Id","legacy_remote_play_",S("Id","CachePath","CoverUrl"),S(),"保留播放历史，删除缓存路径和远程封面缓存。"),
            new DocumentPolicy("RemoteVideoItems","remote_video","Id","legacy_remote_video_",S("Id","CoverPath","LastResolvedAt","DownloadStatus"),S(),"保留远程媒体索引，删除本地封面缓存与短期解析状态。"),
            new DocumentPolicy("RemoteVideoSettings","remote_video_settings","Id","current_",S("Id","CacheRoot","CacheRetentionHours","CacheMaxSizeGb"),S("DownloadThumbnail","DownloadInfoJson","DownloadSubtitles","DownloadDanmaku","OverwriteExisting","AutoImportToVideoLibrary"),"保留下载策略，缓存目录和清理阈值由新壳重新配置。"),
            new DocumentPolicy("TimerRecords","timer_record","Id","legacy_timer_",S("Id","DisplayText"),S(),"DisplayText 可由 DurationSeconds 生成，不再持久化。"),
            new DocumentPolicy("UserProfiles","user_profile","Id","current_",S("Id"),S(),"保留用户偏好。"),
            new DocumentPolicy("VideoAlbums","video_album","Id","legacy_album_",S("Id","CoverPath"),S(),"保留专辑结构；封面缓存路径不迁移。"),
            new DocumentPolicy("VideoPlaybackHistories","video_play_history","Id","legacy_video_play_",S("Id"),S(),"保留非空播放历史。"),
            new DocumentPolicy("VideoSubtitleBindings","video_subtitle","Id","legacy_subtitle_",S("Id"),S(),"保留字幕绑定。"),
            new DocumentPolicy("VideoTagDefinitions","video_tag","Name","",S("Id"),S(),"保留标签词典。"),
            new DocumentPolicy("VoiceAssets","voice_asset","VoiceId","",S("Id"),S("IsEnabled"),"保留音色定义与可配置素材目录。"),
            new DocumentPolicy("VoiceConversations","voice_conversation","ConversationId","",S(),S(),"保留语音会话索引。"),
            new DocumentPolicy("VoiceRoleBindings","voice_role_binding","Id","legacy_voice_binding_",S("Id"),S(),"保留角色目标绑定。"),
            new DocumentPolicy("VoiceRoles","voice_role","RoleId","",S("Id","AvatarPath"),S("IsEnabled"),"角色卡为内容主表；此表保留排序/启停，头像路径由 renderer 重绑。"),
            new DocumentPolicy("VoiceRoleVoices","voice_role_voice","Id","legacy_role_voice_",S("Id"),S("IsDefault","IsEnabled"),"保留角色与音色、风格绑定。")
        };
        return list.ToDictionary(x=>x.Table,StringComparer.OrdinalIgnoreCase);
    }

    private static void ValidateTableCoverage(IReadOnlySet<string> tables)
    {
        var special=new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "AppSettings","ChatMessages","ChatCommandLaunchers","VoiceRoleCards","AgentCapabilities","AgentToolCalls","DisturbanceSettings","Reminders","NotebookNotes","VaultItems","VaultItemHistories","CryptoMarketEvents","VideoItems","RemoteSiteConfigs" };
        var covered=new HashSet<string>(DroppedTables.Keys,StringComparer.OrdinalIgnoreCase); covered.UnionWith(DocumentPolicies.Keys); covered.UnionWith(special);
        var unknown=tables.Where(x=>!covered.Contains(x)).Order().ToArray();
        if(unknown.Length>0) throw new InvalidDataException($"旧库出现未审计表，迁移已停止：{string.Join(", ",unknown)}");
    }

    private static async Task ValidateVaultRequirementsAsync(SqliteConnection source, SqliteTransaction transaction, MigrationOptions options, CancellationToken cancellationToken)
    {
        if(options.SkipVaultSecrets) return;
        var secretRows=await ScalarLongAsync(source,transaction,"SELECT COUNT(*) FROM VaultItems WHERE COALESCE(PasswordEncrypted,'')<>'' OR COALESCE(ApiKeyEncrypted,'')<>'' OR COALESCE(SecretEncrypted,'')<>'' OR COALESCE(PrivateKeyEncrypted,'')<>'' OR COALESCE(MnemonicEncrypted,'')<>''",cancellationToken);
        if(secretRows>0 && string.IsNullOrWhiteSpace(options.LegacyVaultKey)) throw new InvalidOperationException($"旧库有 {secretRows} 条包含秘密的保险库记录。请通过 AIMAID_LEGACY_VAULT_KEY 注入旧密钥，或显式使用 --skip-vault-secrets。");
    }

    private static bool IsDeprecatedSetting(string key)
    {
        var lower=key.ToLowerInvariant();
        if(lower is "database_initializer_completed" or "viewerex_websocket_address" or "voice_role_schema_version" or "scheduled_voice_last_period" or "digit_color_index" or "launcher_scale" or "bubble_offset_x" or "bubble_offset_y" or "image_offset_x" or "image_offset_y") return true;
        if(lower.StartsWith("carousel_",StringComparison.Ordinal) || lower.StartsWith("user_config:app:live2d:",StringComparison.Ordinal)) return true;
        return lower.EndsWith("_windowstate",StringComparison.Ordinal) || lower.Contains("_window_left",StringComparison.Ordinal) || lower.Contains("_window_top",StringComparison.Ordinal) || lower.Contains("_window_width",StringComparison.Ordinal) || lower.Contains("_window_height",StringComparison.Ordinal) || lower is "window_left" or "window_top" or "tool_window_left" or "tool_window_top" or "bitcoin_market_left" or "bitcoin_market_top";
    }
    private static bool IsSensitiveSetting(string key) { var lower=key.ToLowerInvariant(); return lower.Contains("apikey",StringComparison.Ordinal) || lower.Contains("password",StringComparison.Ordinal) || lower.Contains("secret",StringComparison.Ordinal) || lower.Contains("token",StringComparison.Ordinal); }

    private static async Task<IReadOnlySet<string>> GetSourceTablesAsync(SqliteConnection source, SqliteTransaction transaction, CancellationToken cancellationToken)
    { var result=new HashSet<string>(StringComparer.OrdinalIgnoreCase); await using var command=SourceCommand(source,transaction,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"); await using var reader=await command.ExecuteReaderAsync(cancellationToken); while(await reader.ReadAsync(cancellationToken)) result.Add(reader.GetString(0)); return result; }
    private static Task<long> CountAsync(SqliteConnection source, SqliteTransaction transaction, string table, CancellationToken cancellationToken)=>ScalarLongAsync(source,transaction,$"SELECT COUNT(*) FROM \"{table}\"",cancellationToken);
    private static async Task<long> ScalarLongAsync(SqliteConnection connection, SqliteTransaction transaction, string sql, CancellationToken cancellationToken) { await using var command=SourceCommand(connection,transaction,sql); return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken),CultureInfo.InvariantCulture); }
    private static SqliteCommand SourceCommand(SqliteConnection connection, SqliteTransaction transaction, string sql) { var command=connection.CreateCommand(); command.Transaction=transaction; command.CommandText=sql; return command; }

    private static async Task ExecuteAsync(SqliteConnection connection, SqliteTransaction? transaction, string sql, CancellationToken cancellationToken, params (string Name,object? Value)[] parameters)
    { await using var command=connection.CreateCommand(); command.Transaction=transaction; command.CommandText=sql; foreach(var (name,value) in parameters) command.Parameters.AddWithValue(name,value??DBNull.Value); await command.ExecuteNonQueryAsync(cancellationToken); }
    private static Task InsertDocumentAsync(SqliteConnection connection, SqliteTransaction? transaction, string domain, string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken)=>ExecuteAsync(connection,transaction,"""INSERT INTO CoreDocuments(Domain,DocumentId,Json,UpdatedAt) VALUES($domain,$id,$json,$updated) ON CONFLICT(Domain,DocumentId) DO UPDATE SET Json=excluded.Json,UpdatedAt=excluded.UpdatedAt""",cancellationToken,("$domain",domain),("$id",id),("$json",json),("$updated",updatedAt.ToString("O",CultureInfo.InvariantCulture)));

    private static string RowJson(SqliteDataReader reader,IReadOnlySet<string> dropped,IReadOnlySet<string> booleans)
    { var node=new JsonObject(); for(var i=0;i<reader.FieldCount;i++){ var name=reader.GetName(i); if(dropped.Contains(name)) continue; if(reader.IsDBNull(i)){node[name]=null;continue;} if(booleans.Contains(name)){node[name]=Convert.ToInt64(reader.GetValue(i),CultureInfo.InvariantCulture)!=0;continue;} if(name.EndsWith("At",StringComparison.OrdinalIgnoreCase)){node[name]=DateText(reader,name);continue;} var value=reader.GetValue(i); node[name]=value switch { long l=>JsonValue.Create(l),double d=>JsonValue.Create(d),float f=>JsonValue.Create(f),int n=>JsonValue.Create(n),decimal m=>JsonValue.Create(m),_=>JsonValue.Create(Convert.ToString(value,CultureInfo.InvariantCulture))}; } return node.ToJsonString(); }
    private static async Task<string[]> ReadAttachmentIdsAsync(SqliteConnection source,SqliteTransaction transaction,string noteId,CancellationToken cancellationToken) { var result=new List<string>(); await using var command=SourceCommand(source,transaction,"SELECT Id FROM NotebookAttachments WHERE NoteId=$id AND IsDeleted=0 ORDER BY CreatedAt"); command.Parameters.AddWithValue("$id",noteId); await using var reader=await command.ExecuteReaderAsync(cancellationToken); while(await reader.ReadAsync(cancellationToken)) result.Add(reader.GetString(0)); return result.ToArray(); }

    private static string Text(SqliteDataReader reader,string name)=>reader[name] is DBNull?string.Empty:Convert.ToString(reader[name],CultureInfo.InvariantCulture)??string.Empty;
    private static int Integer(SqliteDataReader reader,string name)=>reader[name] is DBNull?0:Convert.ToInt32(reader[name],CultureInfo.InvariantCulture);
    private static long Integer64(SqliteDataReader reader,string name)=>reader[name] is DBNull?0:Convert.ToInt64(reader[name],CultureInfo.InvariantCulture);
    private static JsonNode? NullableInteger(SqliteDataReader reader,string name)=>reader[name] is DBNull?null:JsonValue.Create(Convert.ToInt32(reader[name],CultureInfo.InvariantCulture));
    private static bool Boolean(SqliteDataReader reader,string name)=>reader[name] is not DBNull && Convert.ToInt64(reader[name],CultureInfo.InvariantCulture)!=0;
    private static DateTimeOffset ReadDate(SqliteDataReader reader,string name)=>ParseDate(Text(reader,name));
    private static DateTimeOffset ReadBestDate(SqliteDataReader reader) { foreach(var name in new[]{"UpdatedAt","CreatedAt","OccurredAt","SavedAt","TriggeredAt","PlayedAt"}) if(HasColumn(reader,name)&&reader[name] is not DBNull) return ReadDate(reader,name); return DateTimeOffset.Now; }
    private static string DateText(SqliteDataReader reader,string name)=>ReadDate(reader,name).ToString("O",CultureInfo.InvariantCulture);
    private static object DbDate(SqliteDataReader reader,string name)=>reader[name] is DBNull?DBNull.Value:DateText(reader,name);
    private static JsonNode? NullableDateNode(SqliteDataReader reader,string name)=>reader[name] is DBNull?null:JsonValue.Create(DateText(reader,name));
    private static DateTimeOffset ParseDate(string value) { if(DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.AssumeLocal,out var parsed)) return parsed; throw new InvalidDataException($"无法解析旧库时间：{value}"); }
    private static bool HasColumn(SqliteDataReader reader,string name) { for(var i=0;i<reader.FieldCount;i++) if(string.Equals(reader.GetName(i),name,StringComparison.OrdinalIgnoreCase)) return true; return false; }
    private static string NowText()=>DateTimeOffset.Now.ToString("O",CultureInfo.InvariantCulture);
    private static string FirstNonEmpty(string first,string second)=>string.IsNullOrWhiteSpace(first)?second:first;
    private static void TryDelete(string path) { try { if(File.Exists(path)) File.Delete(path); } catch { } }

    private sealed record DocumentPolicy(string Table,string Domain,string IdColumn,string IdPrefix,HashSet<string> DroppedFields,HashSet<string> BooleanFields,string Reason);
}
