using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Settings;
using AIMaid.Contracts.Tasks;
using AIMaid.Core;
using Microsoft.Data.Sqlite;

namespace AIMaid.Infrastructure;

public sealed class SqliteCoreStore : IChatStore, IChatSearchStore, ISettingsStore, ICharacterStore, IBackgroundTaskStore, IDomainDocumentStore
{
    private readonly string connectionString;

    public SqliteCoreStore(CoreStorageOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.DatabasePath)) throw new ArgumentException("数据库路径不能为空。", nameof(options));
        if (!Path.IsPathFullyQualified(options.DatabasePath)) throw new ArgumentException("数据库路径必须是绝对路径。", nameof(options));
        var fullPath = Path.GetFullPath(options.DatabasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        connectionString = new SqliteConnectionStringBuilder { DataSource = fullPath, ForeignKeys = true }.ToString();
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS AppSettings (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Key TEXT NOT NULL UNIQUE,
                Value TEXT NOT NULL,
                UpdatedAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ChatMessages (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                ConversationId TEXT NOT NULL,
                Role TEXT NOT NULL,
                Content TEXT NOT NULL,
                CharacterId TEXT NOT NULL DEFAULT '',
                ModelName TEXT NOT NULL DEFAULT '',
                Source TEXT NOT NULL DEFAULT 'normal_chat',
                MetadataJson TEXT NOT NULL DEFAULT '',
                CreatedAt TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS IX_ChatMessages_ConversationId_Id ON ChatMessages(ConversationId, Id);
            CREATE TABLE IF NOT EXISTS VoiceRoleCards (
                RoleId TEXT PRIMARY KEY,
                Name TEXT NOT NULL DEFAULT '',
                VoiceName TEXT NOT NULL DEFAULT '',
                RoleTitle TEXT NOT NULL DEFAULT '',
                CardPath TEXT NOT NULL DEFAULT '',
                SourceCardJson TEXT NOT NULL DEFAULT '',
                TemplateCardJson TEXT NOT NULL DEFAULT '',
                CardSummary TEXT NOT NULL DEFAULT '',
                CardSchemaVersion TEXT NOT NULL DEFAULT '',
                TemplateCardSourceHash TEXT NOT NULL DEFAULT '',
                TemplateCardGenerationStatus TEXT NOT NULL DEFAULT '',
                TemplateCardGenerationMessage TEXT NOT NULL DEFAULT '',
                TemplateCardGeneratedAt TEXT NULL,
                TemplateCardLastAttemptAt TEXT NULL,
                TemplateCardIterationCount INTEGER NOT NULL DEFAULT 0,
                PreferredVoiceId TEXT NOT NULL DEFAULT '',
                ValidationStatus TEXT NOT NULL DEFAULT 'unknown',
                ValidationMessage TEXT NOT NULL DEFAULT '',
                LastValidatedAt TEXT NULL,
                AvatarPath TEXT NOT NULL DEFAULT '',
                IsEnabled INTEGER NOT NULL DEFAULT 1,
                UpdatedAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS CoreBackgroundTasks (
                TaskId TEXT PRIMARY KEY,
                TaskType TEXT NOT NULL,
                State INTEGER NOT NULL,
                Progress REAL NOT NULL,
                Message TEXT NOT NULL,
                ResultJson TEXT NOT NULL,
                Error TEXT NOT NULL,
                CreatedAt TEXT NOT NULL,
                UpdatedAt TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS IX_CoreBackgroundTasks_Type_UpdatedAt ON CoreBackgroundTasks(TaskType, UpdatedAt DESC);
            CREATE TABLE IF NOT EXISTS CoreDocuments (
                Domain TEXT NOT NULL,
                DocumentId TEXT NOT NULL,
                Json TEXT NOT NULL,
                UpdatedAt TEXT NOT NULL,
                PRIMARY KEY (Domain, DocumentId)
            );
            CREATE INDEX IF NOT EXISTS IX_CoreDocuments_Domain_UpdatedAt ON CoreDocuments(Domain, UpdatedAt DESC);
            """;
        await command.ExecuteNonQueryAsync(cancellationToken);
        await EnsureCharacterColumnsAsync(connection, cancellationToken);
        await NormalizeLegacyDocumentDatesAsync(connection, cancellationToken);
    }

    async Task<long> IChatStore.AppendAsync(ChatMessageDto message, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO ChatMessages (ConversationId, Role, Content, CharacterId, ModelName, Source, MetadataJson, CreatedAt)
            VALUES ($conversationId, $role, $content, $characterId, $modelName, $source, $metadataJson, $createdAt);
            SELECT last_insert_rowid();
            """;
        command.Parameters.AddWithValue("$conversationId", message.ConversationId);
        command.Parameters.AddWithValue("$role", message.Role);
        command.Parameters.AddWithValue("$content", message.Content);
        command.Parameters.AddWithValue("$characterId", message.CharacterId);
        command.Parameters.AddWithValue("$modelName", message.ModelName);
        command.Parameters.AddWithValue("$source", message.Source);
        command.Parameters.AddWithValue("$metadataJson", message.MetadataJson);
        command.Parameters.AddWithValue("$createdAt", Format(message.CreatedAt));
        return (long)(await command.ExecuteScalarAsync(cancellationToken) ?? 0L);
    }

    public async Task UpdateMetadataAsync(long messageId, string metadataJson, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE ChatMessages SET MetadataJson=$metadata WHERE Id=$id";
        command.Parameters.AddWithValue("$metadata", metadataJson ?? string.Empty);
        command.Parameters.AddWithValue("$id", messageId);
        await command.ExecuteNonQueryAsync(cancellationToken);
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
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO VoiceRoleCards (RoleId, Name, VoiceName, RoleTitle, CardPath, SourceCardJson, TemplateCardJson,
              CardSummary, CardSchemaVersion, TemplateCardSourceHash, TemplateCardGenerationStatus, TemplateCardGenerationMessage,
              TemplateCardGeneratedAt, TemplateCardLastAttemptAt, TemplateCardIterationCount, PreferredVoiceId,
              ValidationStatus, ValidationMessage, LastValidatedAt, AvatarPath, IsEnabled, UpdatedAt)
            VALUES ($roleId,$name,$voiceName,$roleTitle,$cardPath,$sourceCardJson,$templateCardJson,
              $cardSummary,$cardSchemaVersion,$templateCardSourceHash,$templateCardGenerationStatus,$templateCardGenerationMessage,
              $templateCardGeneratedAt,$templateCardLastAttemptAt,$templateCardIterationCount,$preferredVoiceId,
              $validationStatus,$validationMessage,$lastValidatedAt,$avatarPath,$isEnabled,$updatedAt)
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
        command.Parameters.AddWithValue("$sourceCardJson", character.SourceCardJson);
        command.Parameters.AddWithValue("$templateCardJson", character.TemplateCardJson);
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
        command.Parameters.AddWithValue("$updatedAt", Format(character.UpdatedAt));
        await command.ExecuteNonQueryAsync(cancellationToken);
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
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Json FROM CoreDocuments WHERE Domain=$domain AND DocumentId=$id";
        command.Parameters.AddWithValue("$domain", domain);
        command.Parameters.AddWithValue("$id", id);
        return await command.ExecuteScalarAsync(cancellationToken) as string;
    }

    async Task<IReadOnlyList<string>> IDomainDocumentStore.ListAsync(string domain, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Json FROM CoreDocuments WHERE Domain=$domain ORDER BY UpdatedAt DESC, DocumentId";
        command.Parameters.AddWithValue("$domain", domain);
        var result = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(reader.GetString(0));
        return result;
    }

    async Task<IReadOnlyList<string>> IDomainDocumentStore.ListIdsAsync(string domain, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT DocumentId FROM CoreDocuments WHERE Domain=$domain ORDER BY UpdatedAt DESC, DocumentId";
        command.Parameters.AddWithValue("$domain", domain);
        var result = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(reader.GetString(0));
        return result;
    }

    async Task IDomainDocumentStore.UpsertAsync(string domain, string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(domain) || string.IsNullOrWhiteSpace(id))
            throw new ArgumentException("文档域和 ID 不能为空。");
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO CoreDocuments (Domain, DocumentId, Json, UpdatedAt)
            VALUES ($domain, $id, $json, $updatedAt)
            ON CONFLICT(Domain, DocumentId) DO UPDATE SET Json=excluded.Json, UpdatedAt=excluded.UpdatedAt;
            """;
        command.Parameters.AddWithValue("$domain", domain);
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$json", json);
        command.Parameters.AddWithValue("$updatedAt", Format(updatedAt));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    async Task IDomainDocumentStore.DeleteAsync(string domain, string id, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM CoreDocuments WHERE Domain=$domain AND DocumentId=$id";
        command.Parameters.AddWithValue("$domain", domain);
        command.Parameters.AddWithValue("$id", id);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
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

    private static async Task NormalizeLegacyDocumentDatesAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        var repairs = new List<(string Domain, string DocumentId, string Json)>();
        await using (var select = connection.CreateCommand())
        {
            select.CommandText = "SELECT Domain, DocumentId, Json FROM CoreDocuments";
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var json = reader.GetString(2);
                JsonNode? node;
                try { node = JsonNode.Parse(json); }
                catch (JsonException) { continue; }
                if (node is null || !NormalizeDateProperties(node)) continue;
                repairs.Add((reader.GetString(0), reader.GetString(1), node.ToJsonString()));
            }
        }
        if (repairs.Count == 0) return;

        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        foreach (var repair in repairs)
        {
            await using var update = connection.CreateCommand();
            update.Transaction = (SqliteTransaction)transaction;
            update.CommandText = "UPDATE CoreDocuments SET Json=$json WHERE Domain=$domain AND DocumentId=$id";
            update.Parameters.AddWithValue("$json", repair.Json);
            update.Parameters.AddWithValue("$domain", repair.Domain);
            update.Parameters.AddWithValue("$id", repair.DocumentId);
            await update.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
    }

    private static bool NormalizeDateProperties(JsonNode node)
    {
        var changed = false;
        if (node is JsonObject jsonObject)
        {
            foreach (var property in jsonObject.ToArray())
            {
                if (property.Value is JsonValue value && property.Key.EndsWith("At", StringComparison.OrdinalIgnoreCase) &&
                    value.TryGetValue<string>(out var text) && TryNormalizeLegacyDate(text, out var normalized) &&
                    !string.Equals(text, normalized, StringComparison.Ordinal))
                {
                    jsonObject[property.Key] = normalized;
                    changed = true;
                }
                else if (property.Value is not null)
                {
                    changed |= NormalizeDateProperties(property.Value);
                }
            }
        }
        else if (node is JsonArray jsonArray)
        {
            foreach (var item in jsonArray)
                if (item is not null) changed |= NormalizeDateProperties(item);
        }
        return changed;
    }

    private static bool TryNormalizeLegacyDate(string value, out string normalized)
    {
        normalized = string.Empty;
        if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                DateTimeStyles.AllowWhiteSpaces | DateTimeStyles.AssumeLocal, out var parsed)) return false;
        normalized = Format(parsed);
        return true;
    }

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
    }
}
