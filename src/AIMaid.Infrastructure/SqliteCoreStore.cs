using System.Globalization;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Settings;
using AIMaid.Contracts.Tasks;
using AIMaid.Contracts;
using AIMaid.Core;
using Microsoft.Data.Sqlite;

namespace AIMaid.Infrastructure;

public sealed class SqliteCoreStore : IChatStore, IChatSearchStore, ISettingsStore, ICharacterStore, IBackgroundTaskStore, IDomainDocumentStore, ILlmCallAuditStore, IAtomicStore, ILegacyRelationalStore
{
    public static IReadOnlyDictionary<string, string> RelationalDomainTables => LegacyRelationalDocumentStore.DomainTables;
    private readonly string connectionString;
    private readonly LegacyRelationalDocumentStore documents;
    private readonly IBusinessDataChangeSink? dataSync;

    public SqliteCoreStore(
        CoreStorageOptions options,
        ISecretProtector? secretProtector = null,
        IBusinessDataChangeSink? dataSync = null)
    {
        if (string.IsNullOrWhiteSpace(options.DatabasePath)) throw new ArgumentException("数据库路径不能为空。", nameof(options));
        if (!Path.IsPathFullyQualified(options.DatabasePath)) throw new ArgumentException("数据库路径必须是绝对路径。", nameof(options));
        var fullPath = Path.GetFullPath(options.DatabasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        connectionString = new SqliteConnectionStringBuilder { DataSource = fullPath, ForeignKeys = true }.ToString();
        this.dataSync = dataSync;
        documents = new LegacyRelationalDocumentStore(connectionString, secretProtector, dataSync);
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA journal_mode=WAL;";
        await pragma.ExecuteNonQueryAsync(cancellationToken);
        await SchemaBootstrapper.ApplyAsync(connection, cancellationToken);
    }

    public Task<string> UpsertGeneratedAsync(string domain, string? id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken = default)
        => documents.UpsertGeneratedAsync(domain, id, json, updatedAt, cancellationToken);
    public Task<LegacyVaultReadModel?> GetVaultAsync(string itemId, CancellationToken cancellationToken = default)
        => documents.GetVaultAsync(itemId, cancellationToken);
    public Task<IReadOnlyList<LegacyVaultHistoryReadModel>> ListVaultHistoriesAsync(string itemId, CancellationToken cancellationToken = default)
        => documents.ListVaultHistoriesAsync(itemId, cancellationToken);
    public Task<string> SaveVaultAsync(VaultItemDto item, IReadOnlyDictionary<string, string>? secrets, string? changeRemark, CancellationToken cancellationToken = default)
        => documents.SaveVaultAsync(item, secrets, changeRemark, cancellationToken);
    public Task DeleteVaultAsync(string itemId, CancellationToken cancellationToken = default)
        => documents.DeleteVaultAsync(itemId, cancellationToken);
    public Task RestoreVaultHistoryAsync(string historyId, CancellationToken cancellationToken = default)
        => documents.RestoreVaultHistoryAsync(historyId, cancellationToken);
    public Task<NotebookAttachmentRecord> AddNotebookAttachmentAsync(NotebookAttachmentRecord attachment, CancellationToken cancellationToken = default)
        => documents.AddNotebookAttachmentAsync(attachment, cancellationToken);
    public Task SaveNotebookNoteAsync(NotebookNoteDto note, CancellationToken cancellationToken = default)
        => documents.SaveNotebookNoteAsync(note, cancellationToken);
    public Task DeleteNotebookNoteAsync(string noteId, CancellationToken cancellationToken = default)
        => documents.DeleteNotebookNoteAsync(noteId, cancellationToken);
    public Task<IReadOnlyList<VoiceConversationDto>> ListVoiceConversationsAsync(string? voiceRoleId, string? search, CancellationToken cancellationToken = default)
        => documents.ListVoiceConversationsAsync(voiceRoleId, search, cancellationToken);
    public Task DeleteVoiceConversationAsync(string conversationId, CancellationToken cancellationToken = default)
        => documents.DeleteVoiceConversationAsync(conversationId, cancellationToken);

    async Task IAtomicStore.ApplyAsync(IReadOnlyList<AtomicMutation> mutations, CancellationToken cancellationToken)
    {
        if (mutations.Count == 0) return;
        await using var connection = await OpenAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await documents.ApplyAsync(connection, transaction, mutations, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
        await documents.CaptureAppliedMutationsAsync(mutations, CancellationToken.None);
    }

    async Task<long> IChatStore.AppendAsync(ChatMessageDto message, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO ChatMessages (ConversationId, Role, Content, CharacterId, ModelName, Source, MetadataJson, CreatedAt)
            VALUES ($conversationId, $role, $content, $characterId, $modelName, $source, $metadataJson, $createdAt);
            UPDATE VoiceConversations SET UpdatedAt=$createdAt WHERE ConversationId=$conversationId;
            SELECT last_insert_rowid();
            """;
        command.Parameters.AddWithValue("$conversationId", message.ConversationId);
        command.Parameters.AddWithValue("$role", message.Role);
        command.Parameters.AddWithValue("$content", message.Content);
        command.Parameters.AddWithValue("$characterId", message.CharacterId);
        command.Parameters.AddWithValue("$modelName", message.ModelName);
        command.Parameters.AddWithValue("$source", message.Source);
        command.Parameters.AddWithValue("$metadataJson", JsonTextCanonicalizer.NormalizeOptionalObjectOrArray(
            message.MetadataJson, "ChatMessages.MetadataJson", decodeLiteralUnicodeEscapes: true));
        command.Parameters.AddWithValue("$createdAt", Format(message.CreatedAt));
        var id = (long)(await command.ExecuteScalarAsync(cancellationToken) ?? 0L);
        if (dataSync is not null)
            await dataSync.CaptureRowAsync("ChatMessages", "Id", id, "insert", CancellationToken.None);
        return id;
    }

    public async Task<bool> UpdateMetadataAsync(long messageId, string metadataJson, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE ChatMessages SET MetadataJson=$metadata WHERE Id=$id";
        command.Parameters.AddWithValue("$metadata", JsonTextCanonicalizer.NormalizeOptionalObjectOrArray(
            metadataJson, "ChatMessages.MetadataJson", decodeLiteralUnicodeEscapes: true));
        command.Parameters.AddWithValue("$id", messageId);
        var updated = await command.ExecuteNonQueryAsync(cancellationToken) == 1;
        if (updated && dataSync is not null)
            await dataSync.CaptureRowAsync("ChatMessages", "Id", messageId, "update", CancellationToken.None);
        return updated;
    }

    public async Task<IReadOnlyList<ChatMessageDto>> LoadRecentAsync(string conversationId, int limit, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT Id, ConversationId, Role, Content, CharacterId, ModelName, Source, MetadataJson, CreatedAt
            FROM (SELECT * FROM ChatMessages WHERE ConversationId=$conversationId ORDER BY Id DESC LIMIT $limit)
            ORDER BY Id;
            """;
        command.Parameters.AddWithValue("$conversationId", conversationId);
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 500));
        var result = new List<ChatMessageDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            result.Add(new ChatMessageDto(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7), Parse(reader.GetString(8))));
        return result;
    }

    public async Task DeleteConversationAsync(string conversationId, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM ChatMessages WHERE ConversationId=$conversationId";
        command.Parameters.AddWithValue("$conversationId", conversationId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task DeleteByCharacterAsync(string characterId, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM ChatMessages WHERE CharacterId=$characterId";
        command.Parameters.AddWithValue("$characterId", characterId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ChatMessageDto>> SearchUserMessagesAsync(string keyword, int limit, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT Id, ConversationId, Role, Content, CharacterId, ModelName, Source, MetadataJson, CreatedAt
            FROM ChatMessages
            WHERE Role='user' AND Content LIKE $keyword ESCAPE '\\'
              AND Source IN ('normal_chat','agent_chat','prompt_chat')
            ORDER BY CreatedAt DESC, Id DESC LIMIT $limit;
            """;
        var escaped = keyword.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal);
        command.Parameters.AddWithValue("$keyword", $"%{escaped}%");
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 20));
        var result = new List<ChatMessageDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            result.Add(new ChatMessageDto(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7), Parse(reader.GetString(8))));
        return result;
    }

    async Task<SettingDto?> ISettingsStore.GetAsync(string key, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Key, Value, UpdatedAt FROM AppSettings WHERE Key=$key";
        command.Parameters.AddWithValue("$key", key);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new SettingDto(reader.GetString(0), reader.GetString(1), Parse(reader.GetString(2)))
            : null;
    }

    public async Task<IReadOnlyList<SettingDto>> GetManyAsync(IReadOnlyList<string>? keys, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        if (keys is { Count: > 0 })
        {
            var names = keys.Select((_, index) => $"$key{index}").ToArray();
            command.CommandText = $"SELECT Key, Value, UpdatedAt FROM AppSettings WHERE Key IN ({string.Join(',', names)}) ORDER BY Key";
            for (var index = 0; index < keys.Count; index++) command.Parameters.AddWithValue(names[index], keys[index]);
        }
        else command.CommandText = "SELECT Key, Value, UpdatedAt FROM AppSettings ORDER BY Key";
        var result = new List<SettingDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(new(reader.GetString(0), reader.GetString(1), Parse(reader.GetString(2))));
        return result;
    }

    public async Task SetManyAsync(IReadOnlyDictionary<string, string> values, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (dataSync is not null)
        {
            foreach (var key in values.Keys)
                if (await RowExistsAsync(connection, "AppSettings", "Key", key, cancellationToken))
                    existing.Add(key);
        }
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        foreach (var (key, value) in values)
        {
            await using var command = connection.CreateCommand();
            command.Transaction = (SqliteTransaction)transaction;
            command.CommandText = """
                INSERT INTO AppSettings (Key, Value, UpdatedAt) VALUES ($key, $value, $updatedAt)
                ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value, UpdatedAt=excluded.UpdatedAt;
                """;
            command.Parameters.AddWithValue("$key", key);
            command.Parameters.AddWithValue("$value", value);
            command.Parameters.AddWithValue("$updatedAt", Format(DateTimeOffset.Now));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
        if (dataSync is not null)
            foreach (var key in values.Keys)
                await dataSync.CaptureRowAsync(
                    "AppSettings",
                    "Key",
                    key,
                    existing.Contains(key) ? "update" : "insert",
                    CancellationToken.None);
    }

    async Task<CharacterDto?> ICharacterStore.GetAsync(string roleId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = CharacterSelectSql + " WHERE RoleId=$roleId";
        command.Parameters.AddWithValue("$roleId", roleId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadCharacter(reader) : null;
    }

    public async Task<IReadOnlyList<CharacterDto>> ListAsync(bool enabledOnly, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = CharacterSelectSql + " WHERE $enabledOnly=0 OR IsEnabled=1 ORDER BY Name, RoleId";
        command.Parameters.AddWithValue("$enabledOnly", enabledOnly ? 1 : 0);
        var result = new List<CharacterDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(ReadCharacter(reader));
        return result;
    }

    public async Task UpsertAsync(CharacterDto character, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        var exists = dataSync is not null &&
                     await RowExistsAsync(connection, "VoiceRoleCards", "RoleId", character.RoleId, cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO VoiceRoleCards (RoleId, Name, VoiceName, RoleTitle, CardPath, SourceCardJson, TemplateCardJson,
              CardSummary, CardSchemaVersion, TemplateCardSourceHash, TemplateCardGenerationStatus, TemplateCardGenerationMessage,
              TemplateCardGeneratedAt, TemplateCardLastAttemptAt, TemplateCardIterationCount, PreferredVoiceId,
              ValidationStatus, ValidationMessage, LastValidatedAt, AvatarPath, IsEnabled, CreatedAt, UpdatedAt)
            VALUES ($roleId,$name,$voiceName,$roleTitle,$cardPath,$sourceCardJson,$templateCardJson,
              $cardSummary,$cardSchemaVersion,$templateCardSourceHash,$templateCardGenerationStatus,$templateCardGenerationMessage,
              $templateCardGeneratedAt,$templateCardLastAttemptAt,$templateCardIterationCount,$preferredVoiceId,
              $validationStatus,$validationMessage,$lastValidatedAt,$avatarPath,$isEnabled,$createdAt,$updatedAt)
            ON CONFLICT(RoleId) DO UPDATE SET Name=excluded.Name, VoiceName=excluded.VoiceName, RoleTitle=excluded.RoleTitle,
              CardPath=excluded.CardPath, SourceCardJson=excluded.SourceCardJson, TemplateCardJson=excluded.TemplateCardJson,
              CardSummary=excluded.CardSummary, CardSchemaVersion=excluded.CardSchemaVersion,
              TemplateCardSourceHash=excluded.TemplateCardSourceHash,
              TemplateCardGenerationStatus=excluded.TemplateCardGenerationStatus,
              TemplateCardGenerationMessage=excluded.TemplateCardGenerationMessage,
              TemplateCardGeneratedAt=excluded.TemplateCardGeneratedAt,
              TemplateCardLastAttemptAt=excluded.TemplateCardLastAttemptAt,
              TemplateCardIterationCount=excluded.TemplateCardIterationCount,
              PreferredVoiceId=excluded.PreferredVoiceId, ValidationStatus=excluded.ValidationStatus,
              ValidationMessage=excluded.ValidationMessage, LastValidatedAt=excluded.LastValidatedAt, AvatarPath=excluded.AvatarPath,
              IsEnabled=excluded.IsEnabled, UpdatedAt=excluded.UpdatedAt;
            """;
        command.Parameters.AddWithValue("$roleId", character.RoleId);
        command.Parameters.AddWithValue("$name", character.Name);
        command.Parameters.AddWithValue("$voiceName", character.VoiceName);
        command.Parameters.AddWithValue("$roleTitle", character.RoleTitle);
        command.Parameters.AddWithValue("$cardPath", character.CardPath);
        var sourceCardJson = string.IsNullOrWhiteSpace(character.SourceCardJson) ? string.Empty : JsonTextCanonicalizer.NormalizeObject(
            character.SourceCardJson, "VoiceRoleCards.SourceCardJson", decodeLiteralUnicodeEscapes: true);
        var templateCardJson = string.IsNullOrWhiteSpace(character.TemplateCardJson) ? string.Empty : JsonTextCanonicalizer.NormalizeObject(
            character.TemplateCardJson, "VoiceRoleCards.TemplateCardJson", decodeLiteralUnicodeEscapes: true);
        command.Parameters.AddWithValue("$sourceCardJson", sourceCardJson);
        command.Parameters.AddWithValue("$templateCardJson", templateCardJson);
        command.Parameters.AddWithValue("$cardSummary", character.CardSummary);
        command.Parameters.AddWithValue("$cardSchemaVersion", character.CardSchemaVersion);
        command.Parameters.AddWithValue("$templateCardSourceHash", character.TemplateCardSourceHash);
        command.Parameters.AddWithValue("$templateCardGenerationStatus", character.TemplateCardGenerationStatus);
        command.Parameters.AddWithValue("$templateCardGenerationMessage", character.TemplateCardGenerationMessage);
        command.Parameters.AddWithValue("$templateCardGeneratedAt", DbValue(character.TemplateCardGeneratedAt));
        command.Parameters.AddWithValue("$templateCardLastAttemptAt", DbValue(character.TemplateCardLastAttemptAt));
        command.Parameters.AddWithValue("$templateCardIterationCount", character.TemplateCardIterationCount);
        command.Parameters.AddWithValue("$preferredVoiceId", character.PreferredVoiceId);
        command.Parameters.AddWithValue("$validationStatus", character.ValidationStatus);
        command.Parameters.AddWithValue("$validationMessage", character.ValidationMessage);
        command.Parameters.AddWithValue("$lastValidatedAt", DbValue(character.LastValidatedAt));
        command.Parameters.AddWithValue("$avatarPath", character.AvatarPath);
        command.Parameters.AddWithValue("$isEnabled", character.IsEnabled ? 1 : 0);
        command.Parameters.AddWithValue("$createdAt", Format(character.UpdatedAt));
        command.Parameters.AddWithValue("$updatedAt", Format(character.UpdatedAt));
        await command.ExecuteNonQueryAsync(cancellationToken);
        if (dataSync is not null)
            await dataSync.CaptureRowAsync(
                "VoiceRoleCards",
                "RoleId",
                character.RoleId,
                exists ? "update" : "insert",
                CancellationToken.None);
    }

    public async Task DeleteAsync(string roleId, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM VoiceRoleCards WHERE RoleId=$roleId";
        command.Parameters.AddWithValue("$roleId", roleId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    async Task<BackgroundTaskDto?> IBackgroundTaskStore.GetAsync(string taskId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT TaskId,TaskType,State,Progress,Message,ResultJson,Error,CreatedAt,UpdatedAt FROM CoreBackgroundTasks WHERE TaskId=$taskId";
        command.Parameters.AddWithValue("$taskId", taskId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadTask(reader) : null;
    }

    public async Task<IReadOnlyList<BackgroundTaskDto>> ListAsync(string? taskType, int limit, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT TaskId,TaskType,State,Progress,Message,ResultJson,Error,CreatedAt,UpdatedAt FROM CoreBackgroundTasks WHERE $type='' OR TaskType=$type ORDER BY UpdatedAt DESC LIMIT $limit";
        command.Parameters.AddWithValue("$type", taskType ?? string.Empty);
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 500));
        var result = new List<BackgroundTaskDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(ReadTask(reader));
        return result;
    }

    public async Task UpsertAsync(BackgroundTaskDto task, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO CoreBackgroundTasks (TaskId,TaskType,State,Progress,Message,ResultJson,Error,CreatedAt,UpdatedAt)
            VALUES ($id,$type,$state,$progress,$message,$result,$error,$created,$updated)
            ON CONFLICT(TaskId) DO UPDATE SET State=excluded.State,Progress=excluded.Progress,Message=excluded.Message,
              ResultJson=excluded.ResultJson,Error=excluded.Error,UpdatedAt=excluded.UpdatedAt;
            """;
        command.Parameters.AddWithValue("$id", task.TaskId);
        command.Parameters.AddWithValue("$type", task.TaskType);
        command.Parameters.AddWithValue("$state", (int)task.State);
        command.Parameters.AddWithValue("$progress", task.Progress);
        command.Parameters.AddWithValue("$message", task.Message);
        command.Parameters.AddWithValue("$result", task.ResultJson);
        command.Parameters.AddWithValue("$error", task.Error);
        command.Parameters.AddWithValue("$created", Format(task.CreatedAt));
        command.Parameters.AddWithValue("$updated", Format(task.UpdatedAt));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    async Task<string?> IDomainDocumentStore.GetAsync(string domain, string id, CancellationToken cancellationToken)
        => await documents.GetAsync(domain, id, cancellationToken);

    async Task<IReadOnlyList<string>> IDomainDocumentStore.ListAsync(string domain, CancellationToken cancellationToken)
        => await documents.ListAsync(domain, cancellationToken);

    async Task<IReadOnlyList<string>> IDomainDocumentStore.ListIdsAsync(string domain, CancellationToken cancellationToken)
        => await documents.ListIdsAsync(domain, cancellationToken);

    async Task IDomainDocumentStore.UpsertAsync(string domain, string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken)
        => await documents.UpsertAsync(domain, id, json, updatedAt, cancellationToken);

    async Task IDomainDocumentStore.DeleteAsync(string domain, string id, CancellationToken cancellationToken)
        => await documents.DeleteAsync(domain, id, cancellationToken);

    async Task<long> ILlmCallAuditStore.InsertAsync(LlmCallAuditRecord record, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO LlmCallLogs (CreatedAt, ConversationId, CorrelationId, Source, Provider, Model, Endpoint,
                RequestUrl, SystemPrompt, UserPrompt, RequestJson, ResponseStatusCode, ResponseId, PreviousResponseId,
                RawResponseJson, ResponseText, ParsedResponseJson, AudioPath, VoiceId, Error, DurationMs, UpdatedAt,
                PromptTokens, CompletionTokens, TotalTokens)
            VALUES ($createdAt, $conversationId, $correlationId, $source, $provider, $model, $endpoint,
                $requestUrl, $systemPrompt, $userPrompt, $requestJson, 0, '', '',
                '', '', '', '', '', '', 0, $updatedAt,
                0, 0, 0);
            SELECT last_insert_rowid();
            """;
        command.Parameters.AddWithValue("$createdAt", Format(record.CreatedAt));
        command.Parameters.AddWithValue("$conversationId", record.ConversationId);
        command.Parameters.AddWithValue("$correlationId", record.ConversationId);
        command.Parameters.AddWithValue("$source", record.Source);
        command.Parameters.AddWithValue("$provider", record.Provider);
        command.Parameters.AddWithValue("$model", record.Model);
        command.Parameters.AddWithValue("$endpoint", record.Endpoint);
        command.Parameters.AddWithValue("$requestUrl", record.RequestUrl);
        command.Parameters.AddWithValue("$systemPrompt", record.SystemPrompt);
        command.Parameters.AddWithValue("$userPrompt", record.UserPrompt);
        command.Parameters.AddWithValue("$requestJson", JsonTextCanonicalizer.NormalizeAuditObject(record.RequestJson, "LlmCallLogs.RequestJson"));
        command.Parameters.AddWithValue("$updatedAt", Format(record.UpdatedAt));
        var result = await command.ExecuteScalarAsync(cancellationToken);
        var id = (long)result!;
        if (dataSync is not null)
            await dataSync.CaptureRowAsync("LlmCallLogs", "Id", id, "insert", CancellationToken.None);
        return id;
    }

    async Task ILlmCallAuditStore.UpdateAsync(long id, LlmCallAuditCompletion completion, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE LlmCallLogs SET
                ResponseStatusCode = $statusCode, ResponseId = $responseId, ResponseText = $responseText,
                RawResponseJson = $rawResponse, Error = $error, DurationMs = $durationMs,
                PromptTokens = $promptTokens, CompletionTokens = $completionTokens, TotalTokens = $totalTokens,
                CompletedAt = $completedAt, UpdatedAt = $updatedAt
            WHERE rowid = $id;
            """;
        command.Parameters.AddWithValue("$statusCode", completion.ResponseStatusCode);
        command.Parameters.AddWithValue("$responseId", completion.ResponseId);
        command.Parameters.AddWithValue("$responseText", completion.ResponseText);
        command.Parameters.AddWithValue("$rawResponse", string.IsNullOrWhiteSpace(completion.RawResponseJson) ? string.Empty :
            JsonTextCanonicalizer.NormalizeAuditObjectOrArray(completion.RawResponseJson, "LlmCallLogs.RawResponseJson", decodeLiteralUnicodeEscapes: true));
        command.Parameters.AddWithValue("$error", completion.Error);
        command.Parameters.AddWithValue("$durationMs", completion.DurationMs);
        command.Parameters.AddWithValue("$promptTokens", completion.PromptTokens);
        command.Parameters.AddWithValue("$completionTokens", completion.CompletionTokens);
        command.Parameters.AddWithValue("$totalTokens", completion.TotalTokens);
        command.Parameters.AddWithValue("$completedAt", Format(completion.CompletedAt));
        command.Parameters.AddWithValue("$updatedAt", Format(DateTimeOffset.Now));
        command.Parameters.AddWithValue("$id", id);
        await command.ExecuteNonQueryAsync(cancellationToken);
        if (dataSync is not null)
            await dataSync.CaptureRowAsync("LlmCallLogs", "Id", id, "update", CancellationToken.None);
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA encoding = 'UTF-8';";
        await pragma.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    private static async Task<bool> RowExistsAsync(
        SqliteConnection connection,
        string table,
        string keyColumn,
        object key,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT 1 FROM \"{table}\" WHERE \"{keyColumn}\"=$key LIMIT 1";
        command.Parameters.AddWithValue("$key", key);
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private const string CharacterSelectSql = """
        SELECT RoleId,Name,VoiceName,RoleTitle,CardPath,SourceCardJson,TemplateCardJson,PreferredVoiceId,ValidationStatus,
          IsEnabled,UpdatedAt,CardSummary,CardSchemaVersion,TemplateCardSourceHash,TemplateCardGenerationStatus,
          TemplateCardGenerationMessage,TemplateCardGeneratedAt,TemplateCardLastAttemptAt,TemplateCardIterationCount,
          ValidationMessage,LastValidatedAt,AvatarPath FROM VoiceRoleCards
        """;
    private static CharacterDto ReadCharacter(SqliteDataReader reader) => new(reader.GetString(0), reader.GetString(1), reader.GetString(2),
        reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7), reader.GetString(8),
        reader.GetInt64(9) != 0, Parse(reader.GetString(10)), reader.GetString(11), reader.GetString(12), reader.GetString(13),
        reader.GetString(14), reader.GetString(15), ParseNullable(reader, 16), ParseNullable(reader, 17), reader.GetInt32(18),
        reader.GetString(19), ParseNullable(reader, 20), reader.GetString(21));
    private static BackgroundTaskDto ReadTask(SqliteDataReader reader) => new(reader.GetString(0), reader.GetString(1),
        (BackgroundTaskState)reader.GetInt32(2), reader.GetDouble(3), reader.GetString(4), reader.GetString(5), reader.GetString(6),
        Parse(reader.GetString(7)), Parse(reader.GetString(8)));
    private static string Format(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);
    private static DateTimeOffset Parse(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    private static DateTimeOffset? ParseNullable(SqliteDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : Parse(reader.GetString(ordinal));
    private static object DbValue(DateTimeOffset? value) => value.HasValue ? Format(value.Value) : DBNull.Value;

    private static async Task EnsureCharacterColumnsAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        var columns = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["CardSummary"] = "TEXT NOT NULL DEFAULT ''", ["CardSchemaVersion"] = "TEXT NOT NULL DEFAULT ''",
            ["TemplateCardSourceHash"] = "TEXT NOT NULL DEFAULT ''", ["TemplateCardGenerationStatus"] = "TEXT NOT NULL DEFAULT ''",
            ["TemplateCardGenerationMessage"] = "TEXT NOT NULL DEFAULT ''", ["TemplateCardGeneratedAt"] = "TEXT NULL",
            ["TemplateCardLastAttemptAt"] = "TEXT NULL", ["TemplateCardIterationCount"] = "INTEGER NOT NULL DEFAULT 0",
            ["ValidationMessage"] = "TEXT NOT NULL DEFAULT ''", ["LastValidatedAt"] = "TEXT NULL", ["AvatarPath"] = "TEXT NOT NULL DEFAULT ''"
        };
        var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        await using (var info = connection.CreateCommand())
        {
            info.CommandText = "PRAGMA table_info(VoiceRoleCards)";
            await using var reader = await info.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken)) existing.Add(reader.GetString(1));
        }
        foreach (var (name, definition) in columns.Where(x => !existing.Contains(x.Key)))
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = $"ALTER TABLE VoiceRoleCards ADD COLUMN {name} {definition}";
            await alter.ExecuteNonQueryAsync(cancellationToken);
        }
        await using var backfill = connection.CreateCommand();
        backfill.CommandText = """
            UPDATE VoiceRoleCards
            SET AvatarPath=COALESCE((SELECT AvatarPath FROM VoiceRoles WHERE VoiceRoles.RoleId=VoiceRoleCards.RoleId LIMIT 1),'')
            WHERE COALESCE(AvatarPath,'')='';
            """;
        await backfill.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task EnsureTimerRecordColumnsAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        var hasRecordId = false;
        await using (var info = connection.CreateCommand())
        {
            info.CommandText = "PRAGMA table_info(TimerRecords)";
            await using var reader = await info.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
                if (reader.GetString(1).Equals("RecordId", StringComparison.OrdinalIgnoreCase)) hasRecordId = true;
        }
        if (!hasRecordId)
        {
            await using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE TimerRecords ADD COLUMN RecordId TEXT NULL";
            await alter.ExecuteNonQueryAsync(cancellationToken);
        }
        await using var backfill = connection.CreateCommand();
        backfill.CommandText = "UPDATE TimerRecords SET RecordId='legacy_timer_' || Id WHERE COALESCE(RecordId,'')=''";
        await backfill.ExecuteNonQueryAsync(cancellationToken);
        await using var index = connection.CreateCommand();
        index.CommandText = "CREATE UNIQUE INDEX IF NOT EXISTS IX_TimerRecords_RecordId ON TimerRecords(RecordId)";
        await index.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task EnsureAppSettingsColumnsAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        var hasUpdatedAt = false;
        await using (var info = connection.CreateCommand())
        {
            info.CommandText = "PRAGMA table_info(AppSettings)";
            await using var reader = await info.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
                if (reader.GetString(1).Equals("UpdatedAt", StringComparison.OrdinalIgnoreCase)) hasUpdatedAt = true;
        }
        if (hasUpdatedAt) return;
        await using var alter = connection.CreateCommand();
        alter.CommandText = "ALTER TABLE AppSettings ADD COLUMN UpdatedAt TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00'";
        await alter.ExecuteNonQueryAsync(cancellationToken);
    }
}
