using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIMaid.Core;
using AIMaid.Infrastructure;
using Microsoft.Data.Sqlite;

var options = ReportOptions.Parse(args);
try
{
    if (options.Mode == "schema")
    {
        var path = Path.Combine(Path.GetTempPath(), $"aimaid-schema-{Guid.NewGuid():N}.db");
        try
        {
            var store = new SqliteCoreStore(new CoreStorageOptions(path));
            await store.InitializeAsync();
            var schemaOutput = options.Check ? Path.Combine(Path.GetTempPath(), $"aimaid-schema-report-{Guid.NewGuid():N}") : options.OutputDirectory;
            try
            {
                await ReportGenerator.GenerateAsync(path, schemaOutput, null, false);
                if (options.Check)
                {
                    var differences = ReportGenerator.CompareDirectories(options.OutputDirectory, schemaOutput, ["schema.sql", "tables.json", "columns.json", "indexes.json", "foreign-keys.json", "triggers.json", "views.json", "domain-table-mappings.json", "schema-validation.json", "schema-fingerprint.txt"]);
                    if (differences.Count > 0) throw new InvalidOperationException($"Schema 基线不一致：{string.Join(", ", differences)}");
                }
                else
                    ReportGenerator.RemoveSnapshotOnlyFiles(schemaOutput);
            }
            finally { if (options.Check && Directory.Exists(schemaOutput)) Directory.Delete(schemaOutput, true); }
        }
        finally
        {
            PathHelpers.DeleteDatabaseFiles(path);
        }
    }
    else
    {
        if (string.IsNullOrWhiteSpace(options.DatabasePath)) throw new ArgumentException("snapshot 模式必须提供 --database 或 AIMAID_DATABASE_REPORT_SOURCE。\n示例：update-database-report.ps1 snapshot -DatabasePath C:\\path\\aimaid-core.db");
        var baseline = options.BaselineDirectory ?? Path.Combine(PathHelpers.FindRepositoryRoot(), "docs", "database", "schema-baseline");
        await ReportGenerator.GenerateAsync(options.DatabasePath, options.OutputDirectory, baseline, options.FullIntegrityCheck);
    }
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"数据库报告失败：{ex.GetBaseException().Message}");
    return 1;
}

static class PathHelpers
{
    public static void DeleteDatabaseFiles(string path) { foreach (var file in new[] { path, path + "-wal", path + "-shm" }) try { if (File.Exists(file)) File.Delete(file); } catch { } }
    public static string FindRepositoryRoot() => Directory.GetParent(AppContext.BaseDirectory)!.Parent!.Parent!.Parent!.Parent!.Parent!.FullName;
}

internal sealed record ReportOptions(string Mode, string OutputDirectory, string? DatabasePath, string? BaselineDirectory, bool FullIntegrityCheck, bool Check)
{
    public static ReportOptions Parse(string[] args)
    {
        if (args.Length == 0 || args[0] is not ("schema" or "snapshot")) throw new ArgumentException("用法：schema [-OutputDirectory path] [-Check]；snapshot -DatabasePath path [-FullIntegrityCheck] [-OutputDirectory path]");
        var mode = args[0];
        string? Value(string name)
        {
            var i = Array.FindIndex(args, a => a.Equals(name, StringComparison.OrdinalIgnoreCase));
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
        var output = Value("-OutputDirectory") ?? Path.Combine(PathHelpers.FindRepositoryRoot(), "docs", "database", mode == "schema" ? "schema-baseline" : "current-snapshot");
        var database = Value("-DatabasePath") ?? Environment.GetEnvironmentVariable("AIMAID_DATABASE_REPORT_SOURCE");
        return new(mode, Path.GetFullPath(output), string.IsNullOrWhiteSpace(database) ? null : Path.GetFullPath(database), Value("-BaselineDirectory"), args.Any(a => a.Equals("-FullIntegrityCheck", StringComparison.OrdinalIgnoreCase)), args.Any(a => a.Equals("-Check", StringComparison.OrdinalIgnoreCase)));
    }
}

internal static class ReportGenerator
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly string[] ReportFiles = ["schema.sql", "tables.json", "columns.json", "indexes.json", "foreign-keys.json", "triggers.json", "views.json", "domain-table-mappings.json", "schema-validation.json", "schema-fingerprint.txt", "database-summary.json", "row-counts.json", "column-profile.json", "data-consistency.json", "schema-drift.json", "quick-check.txt", "foreign-key-check.json", "safe-samples.json"];

    public static async Task GenerateAsync(string path, string output, string? baseline, bool fullIntegrity)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("数据库文件不存在。", path);
        Directory.CreateDirectory(output);
        await using var connection = await OpenReadOnlyAsync(path);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync();
        var schema = await ReadSchemaAsync(connection, transaction);
        var tables = schema.Tables.Where(x => !x.StartsWith("sqlite_", StringComparison.OrdinalIgnoreCase)).ToArray();
        var schemaSql = string.Join(Environment.NewLine, schema.Sql.OrderBy(x => x.Type, StringComparer.OrdinalIgnoreCase).ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase).Select(x => $"-- {x.Type}: {x.Name}\n{x.Definition};")) + Environment.NewLine;
        await WriteTextAsync(output, "schema.sql", schemaSql);
        await WriteJsonAsync(output, "tables.json", tables.Select(x => new { name = x, internalTable = x.StartsWith("sqlite_", StringComparison.OrdinalIgnoreCase) }).OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase));
        await WriteJsonAsync(output, "columns.json", await ReadColumnsAsync(connection, transaction, tables));
        await WriteJsonAsync(output, "indexes.json", schema.Indexes);
        await WriteJsonAsync(output, "foreign-keys.json", await ReadForeignKeysAsync(connection, transaction, tables));
        await WriteJsonAsync(output, "triggers.json", schema.Sql.Where(x => x.Type.Equals("trigger", StringComparison.OrdinalIgnoreCase)));
        await WriteJsonAsync(output, "views.json", schema.Sql.Where(x => x.Type.Equals("view", StringComparison.OrdinalIgnoreCase)));
        await WriteJsonAsync(output, "domain-table-mappings.json", SqliteCoreStore.RelationalDomainTables.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase));
        await WriteJsonAsync(output, "schema-validation.json", ValidateSchema(connection, transaction, tables));
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(schemaSql))).ToLowerInvariant();
        await WriteTextAsync(output, "schema-fingerprint.txt", fingerprint + Environment.NewLine);

        var counts = await ReadRowCountsAsync(connection, transaction, tables);
        await WriteJsonAsync(output, "row-counts.json", counts);
        await WriteJsonAsync(output, "column-profile.json", await ReadProfilesAsync(connection, transaction, tables));
        await WriteJsonAsync(output, "safe-samples.json", await ReadSafeSamplesAsync(connection, transaction, tables));
        await WriteJsonAsync(output, "data-consistency.json", await ReadConsistencyAsync(connection, transaction, tables));
        await WriteJsonAsync(output, "foreign-key-check.json", await ReadRowsAsync(connection, transaction, "PRAGMA foreign_key_check"));
        var quick = await ScalarTextAsync(connection, transaction, "PRAGMA quick_check");
        await WriteTextAsync(output, "quick-check.txt", quick + Environment.NewLine);
        if (fullIntegrity) await WriteTextAsync(output, "integrity-check.txt", await ScalarTextAsync(connection, transaction, "PRAGMA integrity_check") + Environment.NewLine);
        await WriteJsonAsync(output, "database-summary.json", await ReadSummaryAsync(connection, transaction, path, tables, counts, fingerprint));
        await WriteJsonAsync(output, "schema-drift.json", await ReadDriftAsync(output, baseline, schema, tables));
        await transaction.CommitAsync();
        if (new ReportOptions("", output, null, null, false, false).Check) { }
    }

    public static IReadOnlyList<string> CompareDirectories(string expected, string actual, IReadOnlyList<string> files)
        => files.Where(file => !File.Exists(Path.Combine(expected, file)) || !File.Exists(Path.Combine(actual, file)) || !SHA256.HashData(File.ReadAllBytes(Path.Combine(expected, file))).SequenceEqual(SHA256.HashData(File.ReadAllBytes(Path.Combine(actual, file))))).ToArray();

    public static void RemoveSnapshotOnlyFiles(string output)
    { foreach (var file in new[] { "database-summary.json", "row-counts.json", "column-profile.json", "data-consistency.json", "schema-drift.json", "quick-check.txt", "foreign-key-check.json", "safe-samples.json" }) { var path = Path.Combine(output, file); if (File.Exists(path)) File.Delete(path); } }

    private static async Task<SqliteConnection> OpenReadOnlyAsync(string path)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Cache = SqliteCacheMode.Private, ForeignKeys = true }.ToString());
        await connection.OpenAsync();
        return connection;
    }

    private static async Task<SchemaData> ReadSchemaAsync(SqliteConnection c, SqliteTransaction t)
    {
        var sql = new List<SqlObject>(); var indexes = new List<object>();
        await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "SELECT type,name,tbl_name,COALESCE(sql,'') FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name";
        await using var r = await cmd.ExecuteReaderAsync(); var tables = new List<string>();
        while (await r.ReadAsync())
        {
            var item = new SqlObject(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3)); sql.Add(item);
            if (item.Type == "table") tables.Add(item.Name);
            if (item.Type == "index" && !item.Name.StartsWith("sqlite_", StringComparison.OrdinalIgnoreCase)) indexes.Add(new { name = item.Name, table = item.Table, sql = item.Definition });
        }
        return new(tables, sql, indexes);
    }

    private static async Task<IReadOnlyList<object>> ReadColumnsAsync(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    {
        var result = new List<object>();
        foreach (var table in tables)
        {
            await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = $"PRAGMA table_info({Q(table)})";
            await using var r = await cmd.ExecuteReaderAsync(); while (await r.ReadAsync()) result.Add(new { table, name = r.GetString(1), type = r.GetString(2), notNull = r.GetInt64(3) != 0, defaultValue = r.IsDBNull(4) ? null : r.GetValue(4)?.ToString(), primaryKeyOrder = r.GetInt64(5) });
        }
        return result;
    }

    private static async Task<IReadOnlyList<object>> ReadForeignKeysAsync(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    {
        var result = new List<object>(); foreach (var table in tables) { await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = $"PRAGMA foreign_key_list({Q(table)})"; await using var r = await cmd.ExecuteReaderAsync(); while (await r.ReadAsync()) result.Add(new { table, id = r.GetValue(0), seq = r.GetValue(1), referencedTable = r.GetValue(2), from = r.GetValue(3), to = r.GetValue(4), onUpdate = r.GetValue(5), onDelete = r.GetValue(6) }); } return result;
    }

    private static async Task<Dictionary<string, long>> ReadRowCountsAsync(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    { var result = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase); foreach (var table in tables) result[table] = Convert.ToInt64(await ScalarAsync(c, t, $"SELECT COUNT(*) FROM {Q(table)}"), CultureInfo.InvariantCulture); return result.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase).ToDictionary(x => x.Key, x => x.Value, StringComparer.OrdinalIgnoreCase); }

    private static async Task<IReadOnlyList<object>> ReadProfilesAsync(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    {
        var result = new List<object>();
        foreach (var table in tables)
        {
            var columns = await ReadTableColumnsAsync(c, t, table);
            foreach (var column in columns)
            {
                var q = Q(column.Name); var textExpr = $"CAST({q} AS TEXT)";
                result.Add(new { table, column = column.Name, nullCount = await CountAsync(c, t, $"SELECT COUNT(*) FROM {Q(table)} WHERE {q} IS NULL"), nonNullCount = await CountAsync(c, t, $"SELECT COUNT(*) FROM {Q(table)} WHERE {q} IS NOT NULL"), distinctCount = await CountAsync(c, t, $"SELECT COUNT(DISTINCT {q}) FROM {Q(table)}"), emptyStringCount = await CountAsync(c, t, $"SELECT COUNT(*) FROM {Q(table)} WHERE {q} = ''"), min = IsNumeric(column.Type) || IsTemporal(column.Name, column.Type) ? await ScalarStringAsync(c, t, $"SELECT MIN({q}) FROM {Q(table)}") : null, max = IsNumeric(column.Type) || IsTemporal(column.Name, column.Type) ? await ScalarStringAsync(c, t, $"SELECT MAX({q}) FROM {Q(table)}") : null, textMinLength = await ScalarAsync(c, t, $"SELECT COALESCE(MIN(LENGTH({textExpr})),0) FROM {Q(table)}"), textMaxLength = await ScalarAsync(c, t, $"SELECT COALESCE(MAX(LENGTH({textExpr})),0) FROM {Q(table)}"), textAverageLength = await ScalarAsync(c, t, $"SELECT COALESCE(AVG(LENGTH({textExpr})),0) FROM {Q(table)}"), overlongTextCount = await CountAsync(c, t, $"SELECT COUNT(*) FROM {Q(table)} WHERE LENGTH({textExpr}) > 4096") });
            }
        }
        return result;
    }

    private static async Task<IReadOnlyList<object>> ReadSafeSamplesAsync(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    { var result = new List<object>(); foreach (var table in tables) { var columns = await ReadTableColumnsAsync(c, t, table); await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = $"SELECT * FROM {Q(table)} LIMIT 5"; await using var r = await cmd.ExecuteReaderAsync(); while (await r.ReadAsync()) { var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase); for (var i = 0; i < r.FieldCount; i++) row[r.GetName(i)] = SafeValue(table, columns.FirstOrDefault(x => x.Name.Equals(r.GetName(i), StringComparison.OrdinalIgnoreCase))?.Type, r.IsDBNull(i) ? null : r.GetValue(i), r.GetName(i)); result.Add(new { table, values = row.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase).ToDictionary(x => x.Key, x => x.Value) }); } } return result; }

    private static async Task<IReadOnlyList<object>> ReadConsistencyAsync(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    { var result = new List<object>(); foreach (var table in tables) { var columns = await ReadTableColumnsAsync(c, t, table); foreach (var key in columns.Where(x => x.Name.Equals("Id", StringComparison.OrdinalIgnoreCase) || x.Name.EndsWith("Id", StringComparison.OrdinalIgnoreCase) || x.Name.Equals("Key", StringComparison.OrdinalIgnoreCase))) { var nulls = await CountAsync(c, t, $"SELECT COUNT(*) FROM {Q(table)} WHERE {Q(key.Name)} IS NULL OR CAST({Q(key.Name)} AS TEXT)=''" ); var duplicates = await CountAsync(c, t, $"SELECT COUNT(*) FROM (SELECT {Q(key.Name)} FROM {Q(table)} GROUP BY {Q(key.Name)} HAVING COUNT(*)>1)"); if (nulls > 0 || duplicates > 0) result.Add(new { kind = "key_integrity", table, column = key.Name, nullOrEmpty = nulls, duplicateGroups = duplicates }); } } return result; }

    private static async Task<object> ReadSummaryAsync(SqliteConnection c, SqliteTransaction t, string path, IReadOnlyList<string> tables, IReadOnlyDictionary<string, long> counts, string fingerprint)
    { var file = new FileInfo(path); return new { fileSize = file.Length, fileName = file.Name, pageSize = await ScalarAsync(c, t, "PRAGMA page_size"), pageCount = await ScalarAsync(c, t, "PRAGMA page_count"), freelistCount = await ScalarAsync(c, t, "PRAGMA freelist_count"), journalMode = await ScalarStringAsync(c, t, "PRAGMA journal_mode"), userVersion = await ScalarAsync(c, t, "PRAGMA user_version"), applicationId = await ScalarAsync(c, t, "PRAGMA application_id"), sqliteVersion = await ScalarStringAsync(c, t, "SELECT sqlite_version()"), tableCount = tables.Count, indexCount = await CountAsync(c, t, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"), totalRows = counts.Values.Sum(), schemaFingerprint = fingerprint }; }

    private static object ValidateSchema(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> tables)
    { var missing = SqliteCoreStore.RelationalDomainTables.Where(x => !tables.Contains(x.Value, StringComparer.OrdinalIgnoreCase)).Select(x => new { domain = x.Key, table = x.Value }).OrderBy(x => x.domain, StringComparer.OrdinalIgnoreCase).ToArray(); return new { valid = missing.Length == 0, missingTables = missing }; }

    private static async Task<object> ReadDriftAsync(string output, string? baseline, SchemaData schema, IReadOnlyList<string> tables)
    {
        if (string.IsNullOrWhiteSpace(baseline) || !Directory.Exists(baseline)) return new { baselineAvailable = false, missingTables = Array.Empty<string>(), extraTables = Array.Empty<string>(), missingColumns = Array.Empty<string>(), extraColumns = Array.Empty<string>(), missingIndexes = Array.Empty<string>(), extraIndexes = Array.Empty<string>(), note = "未提供 Schema 基线。" };
        var baselineTables = await ReadJsonNamesAsync(Path.Combine(baseline, "tables.json"));
        var currentColumns = await ReadJsonPairsAsync(Path.Combine(output, "columns.json"), "table", "name");
        var baselineColumns = await ReadJsonPairsAsync(Path.Combine(baseline, "columns.json"), "table", "name");
        var currentIndexes = await ReadJsonNamesAsync(Path.Combine(output, "indexes.json"));
        var baselineIndexes = await ReadJsonNamesAsync(Path.Combine(baseline, "indexes.json"));
        return new { baselineAvailable = true, missingTables = baselineTables.Except(tables, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase), extraTables = tables.Except(baselineTables, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase), missingColumns = baselineColumns.Except(currentColumns, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase), extraColumns = currentColumns.Except(baselineColumns, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase), missingIndexes = baselineIndexes.Except(currentIndexes, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase), extraIndexes = currentIndexes.Except(baselineIndexes, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase), typeOrConstraintDifferences = Array.Empty<object>() };
    }

    private static async Task<List<string>> ReadJsonNamesAsync(string path) { if (!File.Exists(path)) return []; using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(path)); return doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().Select(x => x.TryGetProperty("name", out var value) ? value.GetString() ?? "" : "").Where(x => x.Length > 0).ToList() : []; }
    private static async Task<List<string>> ReadJsonPairsAsync(string path, string first, string second) { if (!File.Exists(path)) return []; using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(path)); return doc.RootElement.EnumerateArray().Select(x => $"{x.GetProperty(first).GetString()}\u001f{x.GetProperty(second).GetString()}").ToList(); }
    private static async Task<List<TableColumn>> ReadTableColumnsAsync(SqliteConnection c, SqliteTransaction t, string table) { await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = $"PRAGMA table_info({Q(table)})"; await using var r = await cmd.ExecuteReaderAsync(); var result = new List<TableColumn>(); while (await r.ReadAsync()) result.Add(new(r.GetString(1), r.GetString(2))); return result; }
    private static async Task<IReadOnlyList<object>> ReadRowsAsync(SqliteConnection c, SqliteTransaction t, string sql) { await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = sql; await using var r = await cmd.ExecuteReaderAsync(); var result = new List<object>(); while (await r.ReadAsync()) { var row = new Dictionary<string, object?>(); for (var i = 0; i < r.FieldCount; i++) row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i); result.Add(row); } return result; }
    private static async Task<long> CountAsync(SqliteConnection c, SqliteTransaction t, string sql) => Convert.ToInt64(await ScalarAsync(c, t, sql), CultureInfo.InvariantCulture);
    private static async Task<object?> ScalarAsync(SqliteConnection c, SqliteTransaction t, string sql) { await using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = sql; return await cmd.ExecuteScalarAsync(); }
    private static async Task<string> ScalarTextAsync(SqliteConnection c, SqliteTransaction t, string sql) => Convert.ToString(await ScalarAsync(c, t, sql), CultureInfo.InvariantCulture) ?? "";
    private static async Task<string?> ScalarStringAsync(SqliteConnection c, SqliteTransaction t, string sql) { var value = await ScalarAsync(c, t, sql); return value is null or DBNull ? null : Convert.ToString(value, CultureInfo.InvariantCulture); }
    private static async Task WriteJsonAsync<T>(string output, string name, T value) => await File.WriteAllTextAsync(Path.Combine(output, name), JsonSerializer.Serialize(value, JsonOptions) + Environment.NewLine, new UTF8Encoding(false));
    private static async Task WriteTextAsync(string output, string name, string value) => await File.WriteAllTextAsync(Path.Combine(output, name), value, new UTF8Encoding(false));
    private static string Q(string value) => "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    private static bool IsNumeric(string type) => type.Contains("INT", StringComparison.OrdinalIgnoreCase) || type.Contains("REAL", StringComparison.OrdinalIgnoreCase) || type.Contains("NUM", StringComparison.OrdinalIgnoreCase);
    private static bool IsTemporal(string name, string type) => name.EndsWith("At", StringComparison.OrdinalIgnoreCase) || name.Contains("Date", StringComparison.OrdinalIgnoreCase) || name.Contains("Time", StringComparison.OrdinalIgnoreCase);
    private static object? SafeValue(string table, string? type, object? value, string column) { if (value is null or DBNull) return null; if (value is byte[] bytes) return new { redacted = true, length = bytes.Length, sha256 = Convert.ToHexString(SHA256.HashData(bytes))[..12].ToLowerInvariant() }; if (IsSensitive(table, column) || value is string && !IsSafeText(column)) { var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""; return new { redacted = true, empty = text.Length == 0, length = text.Length, sha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..12].ToLowerInvariant() }; } return value; }
    private static bool IsSensitive(string table, string column) { var value = (table + "." + column).ToLowerInvariant(); return new[] { "password", "secret", "apikey", "api_key", "token", "cookie", "privatekey", "mnemonic", "authorization", "prompt", "response", "content", "markdown", "xaml", "json", "encrypted" }.Any(value.Contains); }
    private static bool IsSafeText(string column) => new[] { "id", "key", "name", "title", "type", "status", "mode", "role", "source", "provider", "model", "tag", "symbol", "domainpattern" }.Any(x => column.Contains(x, StringComparison.OrdinalIgnoreCase));
    private static string FindRepositoryRoot() => Directory.GetParent(AppContext.BaseDirectory)!.Parent!.Parent!.Parent!.Parent!.FullName;
    private sealed record SchemaData(IReadOnlyList<string> Tables, IReadOnlyList<SqlObject> Sql, IReadOnlyList<object> Indexes);
    private sealed record SqlObject(string Type, string Name, string Table, string Definition);
    private sealed record TableColumn(string Name, string Type);
}
