using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Tasks;
using AIMaid.Core;
using AIMaid.Infrastructure;
using Microsoft.Data.Sqlite;

var options = Options.Parse(args);
var verifier = new RelationalVerifier();
var report = await verifier.VerifyAsync(options);
Directory.CreateDirectory(Path.GetDirectoryName(options.ReportPath)!);
await File.WriteAllTextAsync(options.ReportPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(new
{
    report.TableCount,
    report.SourceRows,
    report.MissingRows,
    report.ChangedRows,
    report.ExtraRows,
    report.CrudPassed,
    report.CrudFailed,
    report.CorePathPassed,
    report.CorePathFailed,
    report.IntegrityCheck,
    options.ReportPath
}));
return report.MissingRows == 0 && report.CrudFailed == 0 && report.CorePathFailed == 0 && report.IntegrityCheck == "ok" ? 0 : 1;

internal sealed record Options(string SourcePath, string TargetPath, string ReportPath)
{
    public static Options Parse(string[] args)
    {
        string Required(string name)
        {
            var index = Array.FindIndex(args, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (index < 0 || index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1]))
                throw new ArgumentException($"缺少参数 {name}。");
            return Path.GetFullPath(args[index + 1]);
        }
        var source = Required("--source");
        var target = Required("--target");
        var report = Required("--report");
        if (!File.Exists(source)) throw new FileNotFoundException("旧数据库不存在。", source);
        if (!File.Exists(target)) throw new FileNotFoundException("当前数据库不存在。", target);
        return new(source, target, report);
    }
}

internal sealed class RelationalVerifier
{
    public async Task<VerificationReport> VerifyAsync(Options options, CancellationToken cancellationToken = default)
    {
        await using var source = await OpenAsync(options.SourcePath, true, cancellationToken);
        await using var target = await OpenAsync(options.TargetPath, true, cancellationToken);
        var sourceTables = await ReadTablesAsync(source, cancellationToken);
        var targetTables = await ReadTablesAsync(target, cancellationToken);
        var results = new List<TableVerification>();
        foreach (var table in sourceTables)
        {
            if (!targetTables.Contains(table, StringComparer.OrdinalIgnoreCase))
            {
                var rows = await CountAsync(source, table, cancellationToken);
                results.Add(new(table, rows, 0, rows, 0, 0, false, "missing_table", "当前库缺少旧表。", [], [], []));
                continue;
            }
            results.Add(await CompareTableAsync(source, target, table, cancellationToken));
        }
        var targetOnly = targetTables.Except(sourceTables, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();
        foreach (var table in targetOnly)
        {
            var rows = await CountAsync(target, table, cancellationToken);
            results.Add(new(table, 0, rows, 0, 0, rows, false, "pending", "当前库新增表。", [], [], []));
        }

        var snapshotPath = options.ReportPath + $".crud-{Guid.NewGuid():N}.db";
        IReadOnlyList<CorePathVerification> corePaths = [];
        try
        {
            await CreateSnapshotAsync(options.TargetPath, snapshotPath, cancellationToken);
            {
                await using var snapshot = await OpenAsync(snapshotPath, false, cancellationToken);
                await SetForeignKeysAsync(snapshot, false, cancellationToken);
                for (var index = 0; index < results.Count; index++)
                {
                    var crud = await VerifyCrudAsync(snapshot, results[index].Table, cancellationToken);
                    results[index] = results[index] with { CrudPassed = crud.Passed, CrudStage = crud.Stage, CrudMessage = crud.Message };
                }
            }
            corePaths = await VerifyCorePathsAsync(snapshotPath, cancellationToken);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            TryDelete(snapshotPath);
            TryDelete(snapshotPath + "-wal");
            TryDelete(snapshotPath + "-shm");
        }

        var integrity = await ScalarTextAsync(target, "PRAGMA integrity_check", cancellationToken);
        return new(options.SourcePath, options.TargetPath, DateTimeOffset.Now, results.Count,
            results.Sum(x => x.SourceRows), results.Sum(x => x.MissingRows), results.Sum(x => x.ChangedRows),
            results.Sum(x => x.ExtraRows), results.Count(x => x.CrudPassed), results.Count(x => !x.CrudPassed),
            corePaths.Count(x => x.Passed), corePaths.Count(x => !x.Passed), integrity, targetOnly, results, corePaths);
    }

    private static async Task<IReadOnlyList<CorePathVerification>> VerifyCorePathsAsync(string snapshotPath, CancellationToken cancellationToken)
    {
        var store = new SqliteCoreStore(new CoreStorageOptions(snapshotPath));
        await store.InitializeAsync(cancellationToken);
        var documents = (IDomainDocumentStore)store;
        var results = new List<CorePathVerification>();
        foreach (var pair in SqliteCoreStore.RelationalDomainTables.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var ids = await documents.ListIdsAsync(pair.Key, cancellationToken);
                var rows = await documents.ListAsync(pair.Key, cancellationToken);
                if (ids.Count != rows.Count)
                    throw new InvalidOperationException($"ListIds={ids.Count}，List={rows.Count}。 ");
                if (ids.Count > 0)
                {
                    var original = await documents.GetAsync(pair.Key, ids[0], cancellationToken)
                        ?? throw new InvalidOperationException("按 ID 读取返回空。 ");
                    JsonNodeGuard(original);
                    await documents.UpsertAsync(pair.Key, ids[0], original, DateTimeOffset.Now, cancellationToken);
                    JsonNodeGuard(await documents.GetAsync(pair.Key, ids[0], cancellationToken)
                        ?? throw new InvalidOperationException("原值回写后读取返回空。 "));
                }
                else
                {
                    var fixtureId = FixtureId(pair.Key);
                    await documents.UpsertAsync(pair.Key, fixtureId, "{}", DateTimeOffset.Now, cancellationToken);
                    JsonNodeGuard(await documents.GetAsync(pair.Key, fixtureId, cancellationToken)
                        ?? throw new InvalidOperationException("空表测试写入后读取返回空。 "));
                    await documents.DeleteAsync(pair.Key, fixtureId, cancellationToken);
                    if (await documents.GetAsync(pair.Key, fixtureId, cancellationToken) is not null)
                        throw new InvalidOperationException("空表测试删除后仍可读取。 ");
                }
                results.Add(new(pair.Key, pair.Value, true, ids.Count, "Core List/ListIds/Get/Upsert 通过；空表另验证 Create/Delete。"));
            }
            catch (Exception exception)
            {
                results.Add(new(pair.Key, pair.Value, false, -1, exception.GetBaseException().Message));
            }
        }

        results.Add(await VerifySettingsPathAsync(store, cancellationToken));
        results.Add(await VerifyChatPathAsync(store, cancellationToken));
        results.Add(await VerifyCharacterPathAsync(store, cancellationToken));
        results.Add(await VerifyBackgroundTaskPathAsync(store, cancellationToken));
        return results;
    }

    private static async Task<CorePathVerification> VerifySettingsPathAsync(SqliteCoreStore store, CancellationToken cancellationToken)
    {
        const string key = "crud_verify:setting";
        try
        {
            var settings = (ISettingsStore)store;
            await settings.SetManyAsync(new Dictionary<string, string> { [key] = "created" }, cancellationToken);
            if ((await settings.GetAsync(key, cancellationToken))?.Value != "created") throw new InvalidOperationException("create/get 失败。 ");
            await settings.SetManyAsync(new Dictionary<string, string> { [key] = "updated" }, cancellationToken);
            if ((await settings.GetManyAsync([key], cancellationToken)).Single().Value != "updated") throw new InvalidOperationException("update/list 失败。 ");
            return new("typed:settings", "AppSettings", true, 1, "Core typed create/get/update/list 通过。 ");
        }
        catch (Exception exception) { return new("typed:settings", "AppSettings", false, -1, exception.GetBaseException().Message); }
    }

    private static async Task<CorePathVerification> VerifyChatPathAsync(SqliteCoreStore store, CancellationToken cancellationToken)
    {
        var conversationId = "crud_verify_" + Guid.NewGuid().ToString("N");
        try
        {
            var chat = (IChatStore)store;
            var id = await chat.AppendAsync(new(0, conversationId, "user", "created", "", "", "normal_chat", "{}", DateTimeOffset.Now), cancellationToken);
            await chat.UpdateMetadataAsync(id, "{\"updated\":true}", cancellationToken);
            var row = (await chat.LoadRecentAsync(conversationId, 10, cancellationToken)).Single();
            if (row.Id != id || !row.MetadataJson.Contains("updated", StringComparison.Ordinal)) throw new InvalidOperationException("read/update 失败。 ");
            await chat.DeleteConversationAsync(conversationId, cancellationToken);
            if ((await chat.LoadRecentAsync(conversationId, 10, cancellationToken)).Count != 0) throw new InvalidOperationException("delete 失败。 ");
            return new("typed:chat", "ChatMessages", true, 1, "Core typed create/get/update/delete 通过。 ");
        }
        catch (Exception exception) { return new("typed:chat", "ChatMessages", false, -1, exception.GetBaseException().Message); }
    }

    private static async Task<CorePathVerification> VerifyCharacterPathAsync(SqliteCoreStore store, CancellationToken cancellationToken)
    {
        var id = "crud_verify_" + Guid.NewGuid().ToString("N");
        try
        {
            var characters = (ICharacterStore)store;
            var created = new CharacterDto(id, "created", "", "", "", "{}", "{}", "", "valid", true, DateTimeOffset.Now);
            await characters.UpsertAsync(created, cancellationToken);
            if ((await characters.GetAsync(id, cancellationToken))?.Name != "created") throw new InvalidOperationException("create/get 失败。 ");
            await characters.UpsertAsync(created with { Name = "updated" }, cancellationToken);
            if ((await characters.ListAsync(false, cancellationToken)).Single(x => x.RoleId == id).Name != "updated") throw new InvalidOperationException("update/list 失败。 ");
            await characters.DeleteAsync(id, cancellationToken);
            if (await characters.GetAsync(id, cancellationToken) is not null) throw new InvalidOperationException("delete 失败。 ");
            return new("typed:character", "VoiceRoleCards", true, 1, "Core typed create/get/update/list/delete 通过。 ");
        }
        catch (Exception exception) { return new("typed:character", "VoiceRoleCards", false, -1, exception.GetBaseException().Message); }
    }

    private static async Task<CorePathVerification> VerifyBackgroundTaskPathAsync(SqliteCoreStore store, CancellationToken cancellationToken)
    {
        var id = "crud_verify_" + Guid.NewGuid().ToString("N");
        try
        {
            var tasks = (IBackgroundTaskStore)store;
            var created = new BackgroundTaskDto(id, "verify", BackgroundTaskState.Queued, 0, "created", "{}", "", DateTimeOffset.Now, DateTimeOffset.Now);
            await tasks.UpsertAsync(created, cancellationToken);
            if ((await tasks.GetAsync(id, cancellationToken))?.Message != "created") throw new InvalidOperationException("create/get 失败。 ");
            await tasks.UpsertAsync(created with { State = BackgroundTaskState.Completed, Message = "updated", Progress = 1 }, cancellationToken);
            if ((await tasks.ListAsync("verify", 10, cancellationToken)).Single(x => x.TaskId == id).Message != "updated") throw new InvalidOperationException("update/list 失败。 ");
            return new("typed:background_task", "CoreBackgroundTasks", true, 1, "Core typed create/get/update/list 通过。 ");
        }
        catch (Exception exception) { return new("typed:background_task", "CoreBackgroundTasks", false, -1, exception.GetBaseException().Message); }
    }

    private static string FixtureId(string domain) => domain switch
    {
        "notebook_attachment" => "crud_fixture_attachment",
        "video_play_history" => "legacy_video_play_2147480000",
        "voice_role_audio_cache" => "legacy_voice_cache_2147480000",
        _ => "crud_verify_" + Guid.NewGuid().ToString("N")
    };

    private static void JsonNodeGuard(string json)
    {
        using var _ = JsonDocument.Parse(json);
    }

    private static async Task<TableVerification> CompareTableAsync(SqliteConnection source, SqliteConnection target, string table, CancellationToken cancellationToken)
    {
        var sourceColumns = await ReadColumnsAsync(source, table, cancellationToken);
        var targetColumns = await ReadColumnsAsync(target, table, cancellationToken);
        var commonColumns = sourceColumns.Select(x => x.Name).Where(name => targetColumns.Any(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase))).ToArray();
        var keys = sourceColumns.Where(x => x.PrimaryKeyOrder > 0).OrderBy(x => x.PrimaryKeyOrder).Select(x => x.Name).ToArray();
        if (keys.Length == 0) keys = ["rowid"];
        var sourceRows = await ReadSignaturesAsync(source, table, keys, commonColumns, cancellationToken);
        var targetRows = await ReadSignaturesAsync(target, table, keys, commonColumns, cancellationToken);
        var missingKeys = sourceRows.Keys.Where(key => !targetRows.ContainsKey(key)).ToArray();
        var changedKeys = sourceRows.Where(pair => targetRows.TryGetValue(pair.Key, out var hash) && !hash.SequenceEqual(pair.Value)).Select(pair => pair.Key).ToArray();
        var extraKeys = targetRows.Keys.Where(key => !sourceRows.ContainsKey(key)).ToArray();
        return new(table, sourceRows.Count, targetRows.Count, missingKeys.Length, changedKeys.Length, extraKeys.Length, false, "pending", "", missingKeys, changedKeys, extraKeys);
    }

    private static async Task<Dictionary<string, byte[]>> ReadSignaturesAsync(SqliteConnection connection, string table, string[] keys, string[] columns, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        var selections = keys.Concat(columns).Distinct(StringComparer.OrdinalIgnoreCase).Select(Q);
        command.CommandText = $"SELECT {string.Join(',', selections)} FROM {Q(table)}";
        var result = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var key = string.Join("\u001f", keys.Select(name => StableValue(reader[reader.GetOrdinal(name)])));
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (var column in columns)
            {
                var bytes = Encoding.UTF8.GetBytes(column + "=" + StableValue(reader[reader.GetOrdinal(column)]) + "\u001e");
                hash.AppendData(bytes);
            }
            result[key] = hash.GetHashAndReset();
        }
        return result;
    }

    private static async Task<CrudResult> VerifyCrudAsync(SqliteConnection connection, string table, CancellationToken cancellationToken)
    {
        var columns = await ReadColumnsAsync(connection, table, cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using var read = connection.CreateCommand();
            read.Transaction = transaction;
            read.CommandText = $"SELECT rowid,* FROM {Q(table)} LIMIT 1";
            await using var reader = await read.ExecuteReaderAsync(cancellationToken);
            object[] values;
            long? rowId = null;
            if (await reader.ReadAsync(cancellationToken))
            {
                rowId = Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
                values = new object[columns.Count];
                for (var index = 0; index < columns.Count; index++) values[index] = reader.GetValue(index + 1);
            }
            else values = BuildSyntheticValues(columns);
            await reader.DisposeAsync();

            if (rowId is null)
            {
                await using var create = BuildInsert(connection, transaction, table, columns, values, omitAutoIntegerPrimaryKey: true);
                if (await create.ExecuteNonQueryAsync(cancellationToken) != 1) throw new InvalidOperationException("create 未写入一行。");
                await using var identity = connection.CreateCommand();
                identity.Transaction = transaction;
                identity.CommandText = "SELECT last_insert_rowid()";
                rowId = Convert.ToInt64(await identity.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
            }

            var mutable = columns.FirstOrDefault(column => column.PrimaryKeyOrder == 0) ?? columns[0];
            await using (var update = connection.CreateCommand())
            {
                update.Transaction = transaction;
                update.CommandText = $"UPDATE {Q(table)} SET {Q(mutable.Name)}={Q(mutable.Name)} WHERE rowid=$rowid";
                update.Parameters.AddWithValue("$rowid", rowId.Value);
                if (await update.ExecuteNonQueryAsync(cancellationToken) != 1) throw new InvalidOperationException("update 未命中一行。");
            }

            if (values.Length == columns.Count && await CountAsync(connection, table, transaction, cancellationToken) > 0)
            {
                await using var delete = connection.CreateCommand();
                delete.Transaction = transaction;
                delete.CommandText = $"DELETE FROM {Q(table)} WHERE rowid=$rowid";
                delete.Parameters.AddWithValue("$rowid", rowId.Value);
                if (await delete.ExecuteNonQueryAsync(cancellationToken) != 1) throw new InvalidOperationException("delete 未删除一行。");
                await using var recreate = BuildInsert(connection, transaction, table, columns, values, omitAutoIntegerPrimaryKey: false);
                if (await recreate.ExecuteNonQueryAsync(cancellationToken) != 1) throw new InvalidOperationException("recreate 未恢复一行。");
            }
            await transaction.RollbackAsync(cancellationToken);
            return new(true, "complete", "读取、写入、删除、恢复均通过；事务已回滚。");
        }
        catch (Exception exception)
        {
            await transaction.RollbackAsync(CancellationToken.None);
            return new(false, "failed", exception.Message);
        }
    }

    private static SqliteCommand BuildInsert(SqliteConnection connection, SqliteTransaction transaction, string table, IReadOnlyList<ColumnInfo> columns, object[] values, bool omitAutoIntegerPrimaryKey)
    {
        var included = columns.Select((column, index) => (column, index))
            .Where(x => !(omitAutoIntegerPrimaryKey && x.column.PrimaryKeyOrder > 0 && x.column.Type.Contains("INT", StringComparison.OrdinalIgnoreCase))).ToArray();
        var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"INSERT INTO {Q(table)} ({string.Join(',', included.Select(x => Q(x.column.Name)))}) VALUES ({string.Join(',', included.Select((_, index) => "$v" + index))})";
        for (var index = 0; index < included.Length; index++) command.Parameters.AddWithValue("$v" + index, values[included[index].index] ?? DBNull.Value);
        return command;
    }

    private static object[] BuildSyntheticValues(IReadOnlyList<ColumnInfo> columns)
    {
        var marker = "crud_verify_" + Guid.NewGuid().ToString("N");
        return columns.Select(column =>
        {
            if (column.PrimaryKeyOrder > 0 && column.Type.Contains("INT", StringComparison.OrdinalIgnoreCase)) return (object)0L;
            if (!column.NotNull) return DBNull.Value;
            if (column.Name.EndsWith("At", StringComparison.OrdinalIgnoreCase)) return DateTimeOffset.Now.ToString("O", CultureInfo.InvariantCulture);
            if (column.Type.Contains("INT", StringComparison.OrdinalIgnoreCase)) return 0L;
            if (column.Type.Contains("REAL", StringComparison.OrdinalIgnoreCase) || column.Type.Contains("FLOA", StringComparison.OrdinalIgnoreCase) || column.Type.Contains("DOUB", StringComparison.OrdinalIgnoreCase)) return 0d;
            if (column.Name.Contains("Json", StringComparison.OrdinalIgnoreCase)) return "{}";
            return marker;
        }).ToArray();
    }

    private static async Task CreateSnapshotAsync(string sourcePath, string destinationPath, CancellationToken cancellationToken)
    {
        await using var source = await OpenAsync(sourcePath, true, cancellationToken);
        await using var destination = await OpenAsync(destinationPath, false, cancellationToken);
        source.BackupDatabase(destination);
    }

    private static async Task<SqliteConnection> OpenAsync(string path, bool readOnly, CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate, Pooling = false }.ToString());
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<List<string>> ReadTablesAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        var result = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(reader.GetString(0));
        return result;
    }

    private static async Task<List<ColumnInfo>> ReadColumnsAsync(SqliteConnection connection, string table, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({Q(table)})";
        var result = new List<ColumnInfo>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(new(reader.GetString(1), reader.GetString(2), reader.GetInt64(3) != 0, reader.GetInt32(5)));
        return result;
    }

    private static async Task<long> CountAsync(SqliteConnection connection, string table, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {Q(table)}";
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
    }

    private static async Task<long> CountAsync(SqliteConnection connection, string table, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = $"SELECT COUNT(*) FROM {Q(table)}";
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
    }

    private static async Task<string> ScalarTextAsync(SqliteConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand(); command.CommandText = sql;
        return Convert.ToString(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private static async Task SetForeignKeysAsync(SqliteConnection connection, bool enabled, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand(); command.CommandText = $"PRAGMA foreign_keys={(enabled ? 1 : 0)}";
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static string StableValue(object value) => value switch
    {
        DBNull => "null", byte[] bytes => "blob:" + Convert.ToBase64String(bytes),
        IFormattable formattable => value.GetType().Name + ":" + formattable.ToString(null, CultureInfo.InvariantCulture),
        _ => value.GetType().Name + ":" + value
    };
    private static string Q(string value) => '"' + value.Replace("\"", "\"\"") + '"';
    private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
}

internal sealed record ColumnInfo(string Name, string Type, bool NotNull, int PrimaryKeyOrder);
internal sealed record CrudResult(bool Passed, string Stage, string Message);
internal sealed record CorePathVerification(string Domain, string Table, bool Passed, int RowCount, string Message);
internal sealed record TableVerification(string Table, long SourceRows, long TargetRows, long MissingRows, long ChangedRows, long ExtraRows, bool CrudPassed, string CrudStage, string CrudMessage, IReadOnlyList<string> MissingKeys, IReadOnlyList<string> ChangedKeys, IReadOnlyList<string> ExtraKeys);
internal sealed record VerificationReport(string SourcePath, string TargetPath, DateTimeOffset VerifiedAt, int TableCount, long SourceRows, long MissingRows, long ChangedRows, long ExtraRows, int CrudPassed, int CrudFailed, int CorePathPassed, int CorePathFailed, string IntegrityCheck, IReadOnlyList<string> TargetOnlyTables, IReadOnlyList<TableVerification> Tables, IReadOnlyList<CorePathVerification> CorePaths);
