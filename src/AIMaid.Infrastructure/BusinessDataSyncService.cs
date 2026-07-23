using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using AIMaid.Core;
using Microsoft.Data.Sqlite;

namespace AIMaid.Infrastructure;

public interface IBusinessDataChangeSink
{
    Task CaptureRowAsync(
        string table,
        string lookupColumn,
        object lookupValue,
        string operation,
        CancellationToken cancellationToken = default);
}

public sealed class BusinessDataSyncService : IBusinessDataChangeSink, IAsyncDisposable
{
    private static readonly HashSet<string> AllowedTables = new(StringComparer.OrdinalIgnoreCase)
    {
        "TimerRecords","AppSettings","AiConversations","MaidStates","VoiceTriggerLogs","VoiceRoles",
        "VoiceRoleVoices","VoiceAssets","VoiceRoleAudioCaches","VoiceRoleBindings","VoiceRoleCards",
        "ProactiveTriggerRules","ProactiveTriggerStates","DisturbanceSettings","UserProfiles","AppRuntimeStates",
        "Reminders","ReminderLogs","ChatCommandLaunchers","NotebookNotes","NotebookAttachments","ActionTagDefinitions",
        "DesktopContextSnapshots","ProactiveBroadcastSourceSettings","ProactiveBroadcastTriggerLogs","LlmCallLogs",
        "DbColumnComments","LlmChatConversations","LlmChatMessages","LlmSourcePrompts","LlmBusinessModelConfigs",
        "VoiceCacheDedupeLogs","LlmProviderSelections",
        "ChatMessages","VoiceConversations","AgentCapabilities","AgentToolCalls","VaultItems","VaultItemHistories",
        "VideoItems","VideoAlbums","VideoTagDefinitions","RemoteSiteConfigs","VideoPlaybackHistories","VideoSubtitleBindings",
        "RemoteVideoItems","RemoteDownloadTasks","RemotePlayHistories","RemoteVideoSettings"
    };

    private readonly BusinessDataSyncOptions options;
    private readonly ApplicationPaths paths;
    private readonly string connectionString;
    private readonly HttpClient http;
    private readonly Action<string, Exception?> log;
    private readonly ConcurrentDictionary<string, TableMetadata> tableMetadata = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<QueueItem> queue = [];
    private readonly object queueLock = new();
    private readonly Channel<bool> wake = Channel.CreateBounded<bool>(1);
    private readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web);
    private CancellationTokenSource? cancellation;
    private Task? worker;
    private volatile bool avatarsSynced;

    private string QueuePath => paths.Data("data-sync-queue.json");
    private string InvalidQueueReportPath => paths.Log("data-sync-invalid-ids.json");

    public BusinessDataSyncService(
        BusinessDataSyncOptions options,
        ApplicationPaths paths,
        string databasePath,
        Action<string, Exception?> log)
    {
        this.options = options;
        this.paths = paths;
        this.log = log;
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false
        }.ToString();
        http = new HttpClient(CreateDirectHandler(), disposeHandler: true);
    }

    internal static HttpClientHandler CreateDirectHandler() => new() { UseProxy = false };

    internal static string ResolveAvatarPath(string resourceRoot, string avatarPath)
    {
        if (string.IsNullOrWhiteSpace(avatarPath)) return string.Empty;
        var trimmed = avatarPath.Trim();
        if (Path.IsPathFullyQualified(trimmed)) return Path.GetFullPath(trimmed);
        var direct = Path.GetFullPath(Path.Combine(resourceRoot, trimmed));
        if (File.Exists(direct)) return direct;
        return Path.GetFullPath(Path.Combine(resourceRoot, "Assets", trimmed));
    }

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (!options.Enabled)
        {
            log("Business data sync is disabled by configuration", null);
            return Task.CompletedTask;
        }

        LoadQueue();
        cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        worker = RunAsync(cancellation.Token);
        wake.Writer.TryWrite(true);
        return Task.CompletedTask;
    }

    public async Task CaptureRowAsync(
        string table,
        string lookupColumn,
        object lookupValue,
        string operation,
        CancellationToken cancellationToken = default)
    {
        if (!options.Enabled || !AllowedTables.Contains(table)) return;
        if (string.Equals(table, "AppSettings", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(lookupColumn, "Key", StringComparison.OrdinalIgnoreCase) &&
            Convert.ToString(lookupValue, CultureInfo.InvariantCulture)?.StartsWith(
                "user_config:", StringComparison.OrdinalIgnoreCase) == true)
            return;

        await using var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        var metadata = await GetTableMetadataAsync(connection, table, cancellationToken);
        if (!metadata.Columns.Contains(lookupColumn) || metadata.PrimaryKeys.Count == 0)
            throw new InvalidOperationException($"同步表 {table} 缺少查询列或主键。");

        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT * FROM {Quote(table)} WHERE {Quote(lookupColumn)}=$value LIMIT 1";
        command.Parameters.AddWithValue("$value", lookupValue);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return;

        var payload = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        for (var ordinal = 0; ordinal < reader.FieldCount; ordinal++)
            payload[reader.GetName(ordinal)] = Normalize(reader.IsDBNull(ordinal) ? null : reader.GetValue(ordinal));
        payload["UserId"] = options.UserId;

        var primaryKey = string.Join("|", metadata.PrimaryKeys.Select(key =>
            Convert.ToString(payload.GetValueOrDefault(key), CultureInfo.InvariantCulture)));
        if (string.IsNullOrWhiteSpace(primaryKey)) return;
        var item = new QueueItem(
            $"{table}:{primaryKey}",
            table,
            operation,
            payload,
            DateTimeOffset.UtcNow);

        lock (queueLock)
        {
            queue.RemoveAll(existing => existing.Key == item.Key);
            queue.Add(item);
        }
        if (table is "VoiceRoles" or "VoiceRoleCards") avatarsSynced = false;
        wake.Writer.TryWrite(true);
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var failures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await wake.Reader.ReadAsync(cancellationToken);
                await PersistQueueAsync(cancellationToken);
                while (true)
                {
                    QueueItem[] batch;
                    lock (queueLock)
                        batch = queue.Take(Math.Clamp(options.BatchSize, 1, 200)).ToArray();
                    if (batch.Length == 0) break;

                    var body = new
                    {
                        deviceId = options.DeviceId,
                        records = batch.Select(item => new
                        {
                            table = item.Table,
                            operation = item.Operation,
                            updatedAt = item.QueuedAt,
                            payload = item.Payload
                        })
                    };
                    using var response = await http.PostAsync(
                        new Uri(options.ServerUrl, "/api/sync/business-batch"),
                        new StringContent(JsonSerializer.Serialize(body, json), Encoding.UTF8, "application/json"),
                        cancellationToken);
                    response.EnsureSuccessStatusCode();
                    lock (queueLock)
                        foreach (var sent in batch)
                            queue.RemoveAll(item => item.Key == sent.Key && item.QueuedAt <= sent.QueuedAt);
                    await PersistQueueAsync(cancellationToken);
                    failures = 0;
                }

                if (!avatarsSynced)
                {
                    await SyncRoleAvatarsAsync(cancellationToken);
                    avatarsSynced = true;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                failures++;
                log("Business data sync failed; local queue will retry", exception);
                await Task.Delay(
                    TimeSpan.FromSeconds(Math.Min(300, 5 * Math.Pow(2, Math.Min(failures, 6)))),
                    cancellationToken);
                wake.Writer.TryWrite(true);
            }
        }
    }

    private async Task SyncRoleAvatarsAsync(CancellationToken cancellationToken)
    {
        var avatars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        foreach (var table in new[] { "VoiceRoles", "VoiceRoleCards" })
        {
            if (!await TableExistsAsync(connection, table, cancellationToken)) continue;
            await using var command = connection.CreateCommand();
            command.CommandText = $"SELECT RoleId,AvatarPath FROM {Quote(table)} WHERE IsEnabled=1 AND TRIM(AvatarPath)<>''";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var roleId = reader.GetString(0);
                var path = ResolveAvatarPath(paths.ResourceRoot, reader.GetString(1));
                if (roleId.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-') &&
                    File.Exists(path))
                    avatars[roleId] = path;
            }
        }

        var saved = 0;
        foreach (var avatar in avatars)
        {
            await using var stream = File.OpenRead(avatar.Value);
            using var file = new StreamContent(stream);
            file.Headers.ContentType = new MediaTypeHeaderValue(Path.GetExtension(avatar.Value).ToLowerInvariant() switch
            {
                ".png" => "image/png",
                ".webp" => "image/webp",
                _ => "image/jpeg"
            });
            using var form = new MultipartFormDataContent();
            form.Add(file, "file", Path.GetFileName(avatar.Value));
            using var response = await http.PostAsync(
                new Uri(options.ServerUrl, "/api/sync/role-avatar/" + Uri.EscapeDataString(avatar.Key)),
                form,
                cancellationToken);
            response.EnsureSuccessStatusCode();
            saved++;
        }
        log($"Role avatar sync completed: requestCount={avatars.Count}, affectedRows={saved}", null);
    }

    private void LoadQueue()
    {
        try
        {
            if (!File.Exists(QueuePath)) return;
            var loaded = JsonSerializer.Deserialize<List<QueueItem>>(File.ReadAllText(QueuePath), json) ?? [];
            var invalid = loaded.Where(HasTemporaryKey).ToArray();
            if (invalid.Length > 0)
            {
                File.WriteAllText(InvalidQueueReportPath, JsonSerializer.Serialize(invalid, json));
                log($"Quarantined {invalid.Length} sync records captured with temporary database ids", null);
            }
            lock (queueLock) queue.AddRange(loaded.Where(item => !HasTemporaryKey(item)));
        }
        catch (Exception exception)
        {
            log("Unable to load business data sync queue", exception);
        }
    }

    private async Task PersistQueueAsync(CancellationToken cancellationToken)
    {
        QueueItem[] snapshot;
        lock (queueLock) snapshot = queue.ToArray();
        var temp = QueuePath + ".tmp";
        await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(snapshot, json), cancellationToken);
        File.Move(temp, QueuePath, true);
    }

    private async Task<TableMetadata> GetTableMetadataAsync(
        SqliteConnection connection,
        string table,
        CancellationToken cancellationToken)
    {
        if (tableMetadata.TryGetValue(table, out var cached)) return cached;
        var columns = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var keys = new SortedDictionary<int, string>();
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({Quote(table)})";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var name = reader.GetString(1);
            columns.Add(name);
            var keyOrder = reader.GetInt32(5);
            if (keyOrder > 0) keys[keyOrder] = name;
        }
        var metadata = new TableMetadata(columns, keys.Values.ToArray());
        tableMetadata[table] = metadata;
        return metadata;
    }

    private static async Task<bool> TableExistsAsync(
        SqliteConnection connection,
        string table,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$table LIMIT 1";
        command.Parameters.AddWithValue("$table", table);
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private static object? Normalize(object? value) => value is byte[] bytes
        ? Convert.ToBase64String(bytes)
        : value;

    private static bool HasTemporaryKey(QueueItem item) => item.Payload.Any(pair =>
        (string.Equals(pair.Key, "Id", StringComparison.OrdinalIgnoreCase) ||
         string.Equals(pair.Key, "TaskId", StringComparison.OrdinalIgnoreCase)) &&
        IsNegativeInteger(pair.Value));

    private static bool IsNegativeInteger(object? value) => value switch
    {
        sbyte number => number < 0,
        short number => number < 0,
        int number => number < 0,
        long number => number < 0,
        JsonElement { ValueKind: JsonValueKind.Number } element when element.TryGetInt64(out var number) => number < 0,
        _ => false
    };

    private static string Quote(string identifier) => '"' + identifier.Replace("\"", "\"\"") + '"';

    public async ValueTask DisposeAsync()
    {
        if (cancellation is not null)
        {
            cancellation.Cancel();
            if (worker is not null)
            {
                try
                {
                    await worker;
                }
                catch (OperationCanceledException)
                {
                }
            }
            await PersistQueueAsync(CancellationToken.None);
            cancellation.Dispose();
        }
        http.Dispose();
    }

    private sealed record TableMetadata(IReadOnlySet<string> Columns, IReadOnlyList<string> PrimaryKeys);
    private sealed record QueueItem(
        string Key,
        string Table,
        string Operation,
        Dictionary<string, object?> Payload,
        DateTimeOffset QueuedAt);
}
