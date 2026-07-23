using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using AIMaid.Core;
using Microsoft.Data.Sqlite;

namespace AIMaid.Infrastructure;

/// <summary>
/// Compatibility boundary between the current Core contracts and the original AI_maid
/// relational schema. Business data stays in its original table; this adapter only
/// translates a relational row to the JSON payload expected by existing Core services.
/// </summary>
internal sealed class LegacyRelationalDocumentStore
{
    private readonly string connectionString;
    private readonly ISecretProtector? secrets;

    private static readonly IReadOnlyDictionary<string, DomainMap> Maps = BuildMaps();
    internal static IReadOnlyDictionary<string, string> DomainTables { get; } = Maps.ToDictionary(pair => pair.Key, pair => pair.Value.Table, StringComparer.OrdinalIgnoreCase);

    public LegacyRelationalDocumentStore(string connectionString, ISecretProtector? secrets)
    {
        this.connectionString = connectionString;
        this.secrets = secrets;
    }

    public async Task<string?> GetAsync(string domain, string id, CancellationToken cancellationToken)
    {
        if (TryGetSettingDomain(domain, out var settingKind))
            return await GetProtectedSettingAsync(settingKind, id, cancellationToken);
        if (domain.Equals("appearance_configuration", StringComparison.OrdinalIgnoreCase))
            return await GetAppearanceAsync(cancellationToken);
        if (domain.Equals("model_configuration", StringComparison.OrdinalIgnoreCase))
            return await GetModelConfigurationAsync(id, cancellationToken);

        var map = GetMap(domain);
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT * FROM {Q(map.Table)} WHERE {BuildIdPredicate(map, id, command)} LIMIT 1";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? await ReadJsonAsync(connection, reader, map, cancellationToken) : null;
    }

    public async Task<IReadOnlyList<string>> ListAsync(string domain, CancellationToken cancellationToken)
    {
        if (TryGetSettingDomain(domain, out _) || domain.Equals("appearance_configuration", StringComparison.OrdinalIgnoreCase))
        {
            var value = await GetAsync(domain, "current", cancellationToken);
            return value is null ? [] : [value];
        }
        if (domain.Equals("model_configuration", StringComparison.OrdinalIgnoreCase))
            return await ListModelConfigurationsAsync(cancellationToken);

        var map = GetMap(domain);
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT * FROM {Q(map.Table)} ORDER BY {Q(map.OrderColumn ?? map.KeyColumn)}";
        var result = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            result.Add(await ReadJsonAsync(connection, reader, map, cancellationToken));
        return result;
    }

    public async Task<IReadOnlyList<string>> ListIdsAsync(string domain, CancellationToken cancellationToken)
    {
        if (TryGetSettingDomain(domain, out _) || domain.Equals("appearance_configuration", StringComparison.OrdinalIgnoreCase))
            return ["current"];
        if (domain.Equals("model_configuration", StringComparison.OrdinalIgnoreCase))
            return (await ReadSettingsAsync("user_config:App:Model:", cancellationToken))
                .Select(x => x.Key["user_config:App:Model:".Length..].Split(':', 2)[0])
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

        var map = GetMap(domain);
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {Q(map.KeyColumn)} FROM {Q(map.Table)} ORDER BY {Q(map.OrderColumn ?? map.KeyColumn)}";
        var result = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add(ToDocumentId(map, reader.GetValue(0)));
        return result;
    }

    public async Task UpsertAsync(string domain, string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(domain) || string.IsNullOrWhiteSpace(id))
            throw new ArgumentException("业务域和 ID 不能为空。");
        if (TryGetSettingDomain(domain, out var settingKind))
        {
            await SaveProtectedSettingAsync(settingKind, id, json, updatedAt, cancellationToken);
            return;
        }
        if (domain.Equals("appearance_configuration", StringComparison.OrdinalIgnoreCase))
        {
            await SaveAppearanceAsync(json, updatedAt, cancellationToken);
            return;
        }
        if (domain.Equals("model_configuration", StringComparison.OrdinalIgnoreCase))
        {
            await SaveModelConfigurationAsync(id, json, updatedAt, cancellationToken);
            return;
        }

        var map = GetMap(domain);
        var document = JsonNode.Parse(json)?.AsObject() ?? throw new InvalidDataException($"{domain}/{id} 不是 JSON 对象。");
        await using var connection = await OpenAsync(cancellationToken);
        var columns = await ReadColumnsAsync(connection, map.Table, cancellationToken);
        var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in document)
        {
            var column = map.WriteAliases.TryGetValue(property.Key, out var alias) ? alias : property.Key;
            if (!columns.ContainsKey(column) || column.Equals(map.KeyColumn, StringComparison.OrdinalIgnoreCase)) continue;
            values[column] = map.Domain is "remote_video_download" or "remote_video_play" &&
                             column.Equals("VideoItemId", StringComparison.OrdinalIgnoreCase) &&
                             property.Value is JsonValue itemValue && itemValue.TryGetValue<string>(out var itemId)
                ? ParsePrefixedLong(itemId, "legacy_remote_video_")
                : ToDbValue(property.Value, map.BooleanColumns.Contains(column));
        }
        if (columns.ContainsKey("UpdatedAt")) values["UpdatedAt"] = Format(updatedAt);

        var existingKey = ParseDocumentId(map, id);
        var exists = await ExistsAsync(connection, map, existingKey, cancellationToken);
        if (exists)
        {
            if (values.Count == 0) return;
            await using var update = connection.CreateCommand();
            var assignments = new List<string>();
            var index = 0;
            foreach (var (column, value) in values)
            {
                var parameter = $"$v{index++}";
                assignments.Add($"{Q(column)}={parameter}");
                update.Parameters.AddWithValue(parameter, value ?? DBNull.Value);
            }
            update.CommandText = $"UPDATE {Q(map.Table)} SET {string.Join(',', assignments)} WHERE {BuildKeyPredicate(map, existingKey, update)}";
            await update.ExecuteNonQueryAsync(cancellationToken);
            return;
        }

        if (map.IdMode == IdMode.Direct)
            values[map.KeyColumn] = existingKey;
        else if (map.IdMode == IdMode.Singleton)
            values[map.KeyColumn] = map.SingletonKey;
        else if (existingKey is long numericKey)
            values[map.KeyColumn] = numericKey;

        await FillRequiredDefaultsAsync(connection, map.Table, values, updatedAt, cancellationToken);
        await using var insert = connection.CreateCommand();
        var names = values.Keys.ToArray();
        var parameters = names.Select((_, index) => $"$v{index}").ToArray();
        for (var index = 0; index < names.Length; index++)
            insert.Parameters.AddWithValue(parameters[index], values[names[index]] ?? DBNull.Value);
        insert.CommandText = $"INSERT INTO {Q(map.Table)} ({string.Join(',', names.Select(Q))}) VALUES ({string.Join(',', parameters)})";
        await insert.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task DeleteAsync(string domain, string id, CancellationToken cancellationToken)
    {
        if (TryGetSettingDomain(domain, out var settingKind))
        {
            await DeleteProtectedSettingAsync(settingKind, id, cancellationToken);
            return;
        }
        if (domain.Equals("appearance_configuration", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var key in AppearanceKeys.Values) await DeleteSettingAsync(key, cancellationToken);
            return;
        }
        if (domain.Equals("model_configuration", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var field in ModelFields) await DeleteSettingAsync(ModelSettingKey(id, field), cancellationToken);
            return;
        }

        var map = GetMap(domain);
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"DELETE FROM {Q(map.Table)} WHERE {BuildIdPredicate(map, id, command)}";
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    internal async Task ApplyAsync(SqliteConnection connection, SqliteTransaction transaction, IReadOnlyList<AtomicMutation> mutations, CancellationToken cancellationToken)
    {
        foreach (var mutation in mutations)
        {
            if (mutation.Name.Equals("appearance_configuration", StringComparison.OrdinalIgnoreCase))
            {
                var document = JsonNode.Parse(mutation.Json ?? "{}")?.AsObject() ?? throw new InvalidDataException("外观配置 JSON 无效。");
                foreach (var pair in new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["ThemeId"] = "appearance_theme_id", ["ContentBrightness"] = "appearance_content_brightness", ["FontFamily"] = "appearance_font_family", ["FontScale"] = "appearance_font_scale", ["CornerRadiusStyle"] = "appearance_corner_radius_style", ["Density"] = "appearance_density", ["HeaderStyle"] = "appearance_header_style", ["AnimationsEnabled"] = "appearance_animations_enabled"
                })
                    if (document[pair.Key] is not null) await ApplySettingMutationAsync(connection, transaction, pair.Value, document[pair.Key]!.ToJsonString().Trim('"'), mutation, cancellationToken);
                continue;
            }
            if (mutation.Name.Equals("model_configuration", StringComparison.OrdinalIgnoreCase))
            {
                var document = JsonNode.Parse(mutation.Json ?? "{}")?.AsObject() ?? throw new InvalidDataException("模型配置 JSON 无效。");
                foreach (var field in new[] { "Type", "Endpoint", "Model", "ApiKey", "EnableWebSearch", "Think" })
                    if (document[field] is not null) await ApplySettingMutationAsync(connection, transaction, $"user_config:App:Model:{mutation.Id}:{field}", document[field]!.ToJsonString().Trim('"'), mutation, cancellationToken);
                continue;
            }
            if (mutation.Name.Equals("model_configuration_secret", StringComparison.OrdinalIgnoreCase))
            {
                await ApplySettingMutationAsync(connection, transaction, mutation.Id, mutation.Kind == AtomicMutationKind.DeleteDomain ? null : RequireSecrets().Unprotect(mutation.Json ?? string.Empty), mutation, cancellationToken);
                continue;
            }
            if (mutation.Name.Equals("remote_site_secret", StringComparison.OrdinalIgnoreCase))
            {
                await using var cookie = connection.CreateCommand(); cookie.Transaction = transaction;
                cookie.CommandText = mutation.Kind == AtomicMutationKind.DeleteDomain
                    ? "UPDATE RemoteSiteConfigs SET CookieContent='' WHERE Id=$id"
                    : "UPDATE RemoteSiteConfigs SET CookieContent=$value WHERE Id=$id";
                cookie.Parameters.AddWithValue("$id", ParsePrefixedLong(mutation.Id, "legacy_site_"));
                if (mutation.Kind != AtomicMutationKind.DeleteDomain) cookie.Parameters.AddWithValue("$value", RequireSecrets().Unprotect(mutation.Json ?? string.Empty));
                var affected = await cookie.ExecuteNonQueryAsync(cancellationToken);
                if (mutation.RequireExisting && affected == 0) throw new InvalidOperationException($"远程站点不存在：{mutation.Id}。");
                continue;
            }
            if (mutation.Name.Equals("vault_secret", StringComparison.OrdinalIgnoreCase) || mutation.Name.Equals("vault_history_secret", StringComparison.OrdinalIgnoreCase))
            {
                await ApplyVaultSecretMutationAsync(connection, transaction, mutation, cancellationToken);
                continue;
            }
            if (mutation.Kind is AtomicMutationKind.UpsertSetting or AtomicMutationKind.DeleteSetting)
            {
                await using var command = connection.CreateCommand(); command.Transaction = transaction;
                command.CommandText = mutation.Kind == AtomicMutationKind.UpsertSetting
                    ? "INSERT INTO AppSettings(Key,Value,UpdatedAt) VALUES($key,$value,$updated) ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value,UpdatedAt=excluded.UpdatedAt"
                    : "DELETE FROM AppSettings WHERE Key=$key";
                command.Parameters.AddWithValue("$key", mutation.Id);
                if (mutation.Kind == AtomicMutationKind.UpsertSetting)
                {
                    command.Parameters.AddWithValue("$value", mutation.Json ?? string.Empty);
                    command.Parameters.AddWithValue("$updated", Format(mutation.UpdatedAt ?? DateTimeOffset.Now));
                }
                var affected = await command.ExecuteNonQueryAsync(cancellationToken);
                if (mutation.RequireExisting && affected == 0) throw new InvalidOperationException($"目标设置不存在：{mutation.Id}。");
                continue;
            }

            var map = GetMap(mutation.Name);
            var key = ParseDocumentId(map, mutation.Id);
            await using var command2 = connection.CreateCommand(); command2.Transaction = transaction;
            command2.CommandText = mutation.Kind == AtomicMutationKind.DeleteDomain
                ? $"DELETE FROM {Q(map.Table)} WHERE {BuildKeyPredicate(map, key, command2)}"
                : $"SELECT 1 FROM {Q(map.Table)} WHERE {BuildKeyPredicate(map, key, command2)} LIMIT 1";
            if (mutation.Kind == AtomicMutationKind.DeleteDomain)
            {
                var affected = await command2.ExecuteNonQueryAsync(cancellationToken);
                if (mutation.RequireExisting && affected == 0 && !mutation.IdempotentDelete) throw new InvalidOperationException($"目标文档不存在：{mutation.Name}/{mutation.Id}。");
                continue;
            }
            if (mutation.Json is null) throw new ArgumentException($"原子 Upsert 缺少 JSON：{mutation.Name}/{mutation.Id}。");
            if (await command2.ExecuteScalarAsync(cancellationToken) is not null)
            {
                await using var update = connection.CreateCommand(); update.Transaction = transaction;
                var document = JsonNode.Parse(mutation.Json)?.AsObject() ?? throw new InvalidDataException("业务文档不是 JSON 对象。");
                var columns = await ReadColumnsAsync(connection, map.Table, cancellationToken, transaction);
                var assignments = new List<string>(); var index = 0;
                foreach (var property in document)
                {
                    var column = map.WriteAliases.GetValueOrDefault(property.Key, property.Key);
                    if (!columns.ContainsKey(column) || column.Equals(map.KeyColumn, StringComparison.OrdinalIgnoreCase)) continue;
                    var parameter = "$v" + index++; assignments.Add($"{Q(column)}={parameter}"); update.Parameters.AddWithValue(parameter, ToDbValue(property.Value, map.BooleanColumns.Contains(column)) ?? DBNull.Value);
                }
                if (columns.ContainsKey("UpdatedAt")) { assignments.Add("UpdatedAt=$updated"); update.Parameters.AddWithValue("$updated", Format(mutation.UpdatedAt ?? DateTimeOffset.Now)); }
                if (assignments.Count == 0) continue;
                update.CommandText = $"UPDATE {Q(map.Table)} SET {string.Join(',', assignments)} WHERE {BuildKeyPredicate(map, key, update)}";
                await update.ExecuteNonQueryAsync(cancellationToken);
            }
            else
            {
                var document = JsonNode.Parse(mutation.Json)?.AsObject() ?? throw new InvalidDataException("业务文档不是 JSON 对象。");
                var columns = await ReadColumnsAsync(connection, map.Table, cancellationToken, transaction);
                var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (var property in document)
                {
                    var column = map.WriteAliases.GetValueOrDefault(property.Key, property.Key);
                    if (!columns.ContainsKey(column) || column.Equals(map.KeyColumn, StringComparison.OrdinalIgnoreCase)) continue;
                    values[column] = ToDbValue(property.Value, map.BooleanColumns.Contains(column));
                }
                if (map.IdMode == IdMode.Direct) values[map.KeyColumn] = key;
                else if (map.IdMode == IdMode.Singleton) values[map.KeyColumn] = map.SingletonKey;
                else if (key is long numericKey) values[map.KeyColumn] = numericKey;
                await FillRequiredDefaultsAsync(connection, map.Table, values, mutation.UpdatedAt ?? DateTimeOffset.Now, cancellationToken, transaction);
                await using var insert = connection.CreateCommand(); insert.Transaction = transaction;
                var names = values.Keys.ToArray(); var parameters = names.Select((_, i) => "$v" + i).ToArray();
                for (var i = 0; i < names.Length; i++) insert.Parameters.AddWithValue(parameters[i], values[names[i]] ?? DBNull.Value);
                insert.CommandText = $"INSERT INTO {Q(map.Table)} ({string.Join(',', names.Select(Q))}) VALUES ({string.Join(',', parameters)})";
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }
        }
    }

    private async Task ApplySettingMutationAsync(SqliteConnection connection, SqliteTransaction transaction, string key, string? value, AtomicMutation mutation, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = value is null ? "DELETE FROM AppSettings WHERE Key=$key" : "INSERT INTO AppSettings(Key,Value,UpdatedAt) VALUES($key,$value,$updated) ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value,UpdatedAt=excluded.UpdatedAt";
        command.Parameters.AddWithValue("$key", key);
        if (value is not null) { command.Parameters.AddWithValue("$value", value); command.Parameters.AddWithValue("$updated", Format(mutation.UpdatedAt ?? DateTimeOffset.Now)); }
        var affected = await command.ExecuteNonQueryAsync(cancellationToken);
        if (mutation.RequireExisting && affected == 0) throw new InvalidOperationException($"目标设置不存在：{key}。");
    }

    private async Task ApplyVaultSecretMutationAsync(SqliteConnection connection, SqliteTransaction transaction, AtomicMutation mutation, CancellationToken cancellationToken)
    {
        var isHistory = mutation.Name.Equals("vault_history_secret", StringComparison.OrdinalIgnoreCase);
        var id = ParsePrefixedLong(mutation.Id, isHistory ? "legacy_vault_history_" : "legacy_vault_");
        var values = mutation.Kind == AtomicMutationKind.DeleteDomain ? new JsonObject() : JsonNode.Parse(RequireSecrets().Unprotect(mutation.Json ?? string.Empty))?.AsObject() ?? throw new InvalidDataException("保险库密文 JSON 无效。");
        await using var command = connection.CreateCommand(); command.Transaction = transaction;
        if (isHistory)
        {
            command.CommandText = "UPDATE VaultItemHistories SET OldValueEncrypted=$old,NewValueEncrypted=$new WHERE Id=$id";
            command.Parameters.AddWithValue("$old", values["OldValue"]?.GetValue<string>() ?? string.Empty); command.Parameters.AddWithValue("$new", values["NewValue"]?.GetValue<string>() ?? string.Empty);
        }
        else
        {
            command.CommandText = "UPDATE VaultItems SET PasswordEncrypted=$password,ApiKeyEncrypted=$apiKey,SecretEncrypted=$secret,PrivateKeyEncrypted=$privateKey,MnemonicEncrypted=$mnemonic WHERE Id=$id";
            foreach (var name in new[] { "password", "apiKey", "secret", "privateKey", "mnemonic" }) command.Parameters.AddWithValue("$" + name, values[name.Equals("apiKey", StringComparison.Ordinal) ? "ApiKey" : char.ToUpperInvariant(name[0]) + name[1..]]?.GetValue<string>() ?? string.Empty);
        }
        command.Parameters.AddWithValue("$id", id);
        var affected = await command.ExecuteNonQueryAsync(cancellationToken);
        if (mutation.RequireExisting && affected == 0) throw new InvalidOperationException($"保险库密文目标不存在：{mutation.Id}。");
    }

    private async Task<string> ReadJsonAsync(SqliteConnection connection, SqliteDataReader reader, DomainMap map, CancellationToken cancellationToken)
    {
        var row = new JsonObject();
        for (var ordinal = 0; ordinal < reader.FieldCount; ordinal++)
        {
            var column = reader.GetName(ordinal);
            if (map.DroppedColumns.Contains(column)) continue;
            var property = map.ReadAliases.TryGetValue(column, out var alias) ? alias : column;
            row[property] = ReadJsonValue(reader, ordinal, map.BooleanColumns.Contains(column), column);
        }
        var documentId = ToDocumentId(map, reader[map.KeyColumn]);
        if (!string.IsNullOrWhiteSpace(map.IdProperty)) row[map.IdProperty] = documentId;

        if (map.Domain == "notebook")
        {
            var plain = row["ContentPlainText"]?.GetValue<string>() ?? string.Empty;
            var rich = row["ContentRich"]?.GetValue<string>() ?? string.Empty;
            row["ContentMarkdown"] = string.IsNullOrWhiteSpace(plain) ? rich : plain;
            var attachmentIds = new JsonArray();
            await using var attachment = connection.CreateCommand();
            attachment.CommandText = "SELECT Id FROM NotebookAttachments WHERE NoteId=$id AND IsDeleted=0 ORDER BY CreatedAt";
            attachment.Parameters.AddWithValue("$id", row["NoteId"]?.GetValue<string>() ?? string.Empty);
            await using var attachmentReader = await attachment.ExecuteReaderAsync(cancellationToken);
            while (await attachmentReader.ReadAsync(cancellationToken)) attachmentIds.Add(attachmentReader.GetString(0));
            row["AttachmentIds"] = attachmentIds;
        }
        else if (map.Domain == "video" && row["AlbumId"] is JsonValue albumValue && albumValue.TryGetValue<long>(out var albumId))
            row["AlbumId"] = $"legacy_album_{albumId}";
        else if (map.Domain is "remote_video_download" or "remote_video_play" &&
                 row["ItemId"] is JsonValue itemValue && itemValue.TryGetValue<long>(out var itemId))
            row["ItemId"] = $"legacy_remote_video_{itemId}";
        else if (map.Domain == "agent_tool_call")
        {
            var stderr = row["Stderr"]?.GetValue<string>() ?? string.Empty;
            var error = row["Error"]?.GetValue<string>() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(error)) row["Error"] = stderr;
            row.Remove("Stderr");
        }
        else if (map.Domain == "remote_site")
        {
            var settings = new JsonObject
            {
                ["UserAgent"] = row["UserAgent"]?.DeepClone(), ["Referer"] = row["Referer"]?.DeepClone(),
                ["SupportedActions"] = row["SupportedActions"]?.DeepClone(), ["DefaultPlayAction"] = row["DefaultPlayAction"]?.DeepClone(),
                ["DownloadRootOverride"] = row["DownloadRootOverride"]?.DeepClone(), ["Remark"] = row["Remark"]?.DeepClone()
            };
            row["SettingsJson"] = settings.ToJsonString();
            row["HasProtectedCookie"] = !string.IsNullOrWhiteSpace(row["CookieContent"]?.GetValue<string>());
        }
        else if (map.Domain == "vault")
        {
            var metadata = new JsonObject
            {
                ["ChainType"] = row["ChainType"]?.DeepClone(), ["WalletAddress"] = row["WalletAddress"]?.DeepClone(),
                ["ServerAddress"] = row["ServerAddress"]?.DeepClone(), ["ServerPort"] = row["ServerPort"]?.DeepClone(),
                ["Remark"] = row["Remark"]?.DeepClone()
            };
            row["PublicMetadataJson"] = metadata.ToJsonString();
            row["HasProtectedSecret"] = VaultSecretColumns.Any(column => !string.IsNullOrWhiteSpace(row[column]?.GetValue<string>()));
        }

        foreach (var property in map.RemoveAfterTransform) row.Remove(property);
        return row.ToJsonString();
    }

    private async Task<string?> GetProtectedSettingAsync(SettingDomain kind, string id, CancellationToken cancellationToken)
    {
        string? value = kind switch
        {
            SettingDomain.ModelSecret or SettingDomain.ProtectedSetting => await GetSettingAsync(id, cancellationToken),
            SettingDomain.RemoteSiteSecret => await GetColumnByMappedIdAsync("RemoteSiteConfigs", "Id", id, "legacy_site_", "CookieContent", cancellationToken),
            SettingDomain.VaultSecret => await ReadLegacyVaultSecretAsync(id, cancellationToken),
            SettingDomain.VaultHistorySecret => await ReadLegacyVaultHistorySecretAsync(id, cancellationToken),
            _ => null
        };
        return value is null ? null : RequireSecrets().Protect(value);
    }

    private async Task SaveProtectedSettingAsync(SettingDomain kind, string id, string protectedValue, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        var plain = RequireSecrets().Unprotect(protectedValue);
        switch (kind)
        {
            case SettingDomain.ModelSecret:
            case SettingDomain.ProtectedSetting:
                await SaveSettingAsync(id, plain, updatedAt, cancellationToken);
                break;
            case SettingDomain.RemoteSiteSecret:
                await UpdateColumnByMappedIdAsync("RemoteSiteConfigs", "Id", id, "legacy_site_", "CookieContent", plain, cancellationToken);
                break;
            default:
                throw new NotSupportedException($"旧保险库密文必须通过旧保险库仓储写入：{kind}。");
        }
    }

    private async Task DeleteProtectedSettingAsync(SettingDomain kind, string id, CancellationToken cancellationToken)
    {
        if (kind is SettingDomain.ModelSecret or SettingDomain.ProtectedSetting) await DeleteSettingAsync(id, cancellationToken);
        else if (kind == SettingDomain.RemoteSiteSecret)
            await UpdateColumnByMappedIdAsync("RemoteSiteConfigs", "Id", id, "legacy_site_", "CookieContent", string.Empty, cancellationToken);
        else throw new NotSupportedException($"旧保险库密文必须通过旧保险库仓储删除：{kind}。");
    }

    private async Task<string?> ReadLegacyVaultSecretAsync(string id, CancellationToken cancellationToken)
    {
        var key = ParsePrefixedLong(id, "legacy_vault_");
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT PasswordEncrypted,ApiKeyEncrypted,SecretEncrypted,PrivateKeyEncrypted,MnemonicEncrypted FROM VaultItems WHERE Id=$id";
        command.Parameters.AddWithValue("$id", key);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var result = new JsonObject();
        for (var i = 0; i < VaultSecretColumns.Length; i++)
            if (!reader.IsDBNull(i) && !string.IsNullOrWhiteSpace(reader.GetString(i))) result[VaultSecretNames[i]] = reader.GetString(i);
        return result.Count == 0 ? null : result.ToJsonString();
    }

    private async Task<string?> ReadLegacyVaultHistorySecretAsync(string id, CancellationToken cancellationToken)
    {
        var key = ParsePrefixedLong(id, "legacy_vault_history_");
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT OldValueEncrypted,NewValueEncrypted FROM VaultItemHistories WHERE Id=$id";
        command.Parameters.AddWithValue("$id", key);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new JsonObject { ["OldValue"] = reader.GetString(0), ["NewValue"] = reader.GetString(1) }.ToJsonString();
    }

    private static readonly IReadOnlyDictionary<string, string> AppearanceKeys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["ThemeId"] = "appearance_theme_id", ["ContentBrightness"] = "appearance_content_brightness",
        ["FontFamily"] = "appearance_font_family", ["FontScale"] = "appearance_font_scale",
        ["CornerRadiusStyle"] = "appearance_corner_radius_style", ["Density"] = "appearance_density",
        ["HeaderStyle"] = "appearance_header_style", ["AnimationsEnabled"] = "appearance_animations_enabled"
    };
    private static readonly string[] ModelFields = ["Type", "Endpoint", "Model", "ApiKey", "EnableWebSearch", "Think"];
    private static readonly string[] VaultSecretColumns = ["PasswordEncrypted", "ApiKeyEncrypted", "SecretEncrypted", "PrivateKeyEncrypted", "MnemonicEncrypted"];
    private static readonly string[] VaultSecretNames = ["Password", "ApiKey", "Secret", "PrivateKey", "Mnemonic"];

    private async Task<string> GetAppearanceAsync(CancellationToken cancellationToken)
    {
        var defaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["ThemeId"]="neutral_soft", ["ContentBrightness"]="Standard", ["FontFamily"]="", ["FontScale"]="1",
            ["CornerRadiusStyle"]="Medium", ["Density"]="Standard", ["HeaderStyle"]="Subtle", ["AnimationsEnabled"]="true"
        };
        var result = new JsonObject();
        foreach (var (property, key) in AppearanceKeys)
        {
            var value = await GetSettingAsync(key, cancellationToken) ?? defaults[property];
            result[property] = property == "FontScale" ? double.Parse(value, CultureInfo.InvariantCulture) :
                property == "AnimationsEnabled" ? bool.Parse(value) : value;
        }
        return result.ToJsonString();
    }

    private async Task SaveAppearanceAsync(string json, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        var document = JsonNode.Parse(json)?.AsObject() ?? throw new InvalidDataException("外观配置不是 JSON 对象。");
        foreach (var (property, key) in AppearanceKeys)
            if (document[property] is not null) await SaveSettingAsync(key, document[property]!.ToJsonString().Trim('"'), updatedAt, cancellationToken);
    }

    private async Task<IReadOnlyList<string>> ListModelConfigurationsAsync(CancellationToken cancellationToken)
    {
        var settings = await ReadSettingsAsync("user_config:App:Model:", cancellationToken);
        var ids = settings.Select(x => x.Key["user_config:App:Model:".Length..].Split(':', 2)[0]).Distinct(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var id in ids)
        {
            var json = await GetModelConfigurationAsync(id, cancellationToken);
            if (json is not null) result.Add(json);
        }
        return result;
    }

    private async Task<string?> GetModelConfigurationAsync(string id, CancellationToken cancellationToken)
    {
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var field in ModelFields)
        {
            var value = await GetSettingAsync(ModelSettingKey(id, field), cancellationToken);
            if (value is not null) fields[field] = value;
        }
        if (fields.Count == 0) return null;
        return new JsonObject
        {
            ["ModelKey"] = id, ["Type"] = fields.GetValueOrDefault("Type", "local"),
            ["Endpoint"] = fields.GetValueOrDefault("Endpoint", ""), ["Model"] = fields.GetValueOrDefault("Model", id), ["ApiKey"] = fields.GetValueOrDefault("ApiKey", ""),
            ["EnableWebSearch"] = bool.TryParse(fields.GetValueOrDefault("EnableWebSearch"), out var web) && web,
            ["Think"] = bool.TryParse(fields.GetValueOrDefault("Think"), out var think) && think
        }.ToJsonString();
    }

    private async Task SaveModelConfigurationAsync(string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        var document = JsonNode.Parse(json)?.AsObject() ?? throw new InvalidDataException("模型配置不是 JSON 对象。");
        foreach (var field in ModelFields)
            if (document[field] is not null) await SaveSettingAsync(ModelSettingKey(id, field), document[field]!.ToJsonString().Trim('"'), updatedAt, cancellationToken);
    }

    private static string ModelSettingKey(string id, string field) => $"user_config:App:Model:{id}:{field}";

    private async Task<string?> GetSettingAsync(string key, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Value FROM AppSettings WHERE Key=$key";
        command.Parameters.AddWithValue("$key", key);
        return await command.ExecuteScalarAsync(cancellationToken) as string;
    }

    private async Task<IReadOnlyList<(string Key, string Value)>> ReadSettingsAsync(string prefix, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Key,Value FROM AppSettings WHERE Key LIKE $prefix ORDER BY Key";
        command.Parameters.AddWithValue("$prefix", prefix + "%");
        var result = new List<(string, string)>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) result.Add((reader.GetString(0), reader.GetString(1)));
        return result;
    }

    private async Task SaveSettingAsync(string key, string value, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO AppSettings(Key,Value,UpdatedAt) VALUES($key,$value,$updated) ON CONFLICT(Key) DO UPDATE SET Value=excluded.Value,UpdatedAt=excluded.UpdatedAt";
        command.Parameters.AddWithValue("$key", key); command.Parameters.AddWithValue("$value", value); command.Parameters.AddWithValue("$updated", Format(updatedAt));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task DeleteSettingAsync(string key, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM AppSettings WHERE Key=$key"; command.Parameters.AddWithValue("$key", key);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<string?> GetColumnByMappedIdAsync(string table, string keyColumn, string id, string prefix, string valueColumn, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {Q(valueColumn)} FROM {Q(table)} WHERE {Q(keyColumn)}=$id";
        command.Parameters.AddWithValue("$id", ParsePrefixedLong(id, prefix));
        return await command.ExecuteScalarAsync(cancellationToken) as string;
    }

    private async Task UpdateColumnByMappedIdAsync(string table, string keyColumn, string id, string prefix, string valueColumn, string value, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"UPDATE {Q(table)} SET {Q(valueColumn)}=$value WHERE {Q(keyColumn)}=$id";
        command.Parameters.AddWithValue("$value", value); command.Parameters.AddWithValue("$id", ParsePrefixedLong(id, prefix));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static bool TryGetSettingDomain(string domain, out SettingDomain kind)
    {
        kind = domain.ToLowerInvariant() switch
        {
            "model_configuration_secret" => SettingDomain.ModelSecret,
            "protected_setting" => SettingDomain.ProtectedSetting,
            "remote_site_secret" => SettingDomain.RemoteSiteSecret,
            "vault_secret" => SettingDomain.VaultSecret,
            "vault_history_secret" => SettingDomain.VaultHistorySecret,
            _ => SettingDomain.None
        };
        return kind != SettingDomain.None;
    }

    private static DomainMap GetMap(string domain) => Maps.TryGetValue(domain, out var map)
        ? map : throw new NotSupportedException($"旧关系数据库尚未定义业务域映射：{domain}。");

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static string BuildIdPredicate(DomainMap map, string id, SqliteCommand command)
        => BuildKeyPredicate(map, ParseDocumentId(map, id), command);

    private static string BuildKeyPredicate(DomainMap map, object key, SqliteCommand command)
    {
        command.Parameters.AddWithValue("$id", key);
        return $"{Q(map.KeyColumn)}=$id";
    }

    private static object ParseDocumentId(DomainMap map, string id) => map.IdMode switch
    {
        IdMode.Direct => id,
        IdMode.PrefixedInteger => ParsePrefixedLong(id, map.IdPrefix),
        IdMode.Singleton => map.SingletonKey,
        _ => id
    };

    private static string ToDocumentId(DomainMap map, object value) => map.IdMode switch
    {
        IdMode.Direct => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
        IdMode.PrefixedInteger => map.IdPrefix + Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture),
        IdMode.Singleton => "current",
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty
    };

    private static long ParsePrefixedLong(string id, string prefix)
    {
        var value = id.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? id[prefix.Length..] : id;
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed : throw new InvalidDataException($"旧表 ID 格式无效：{id}，要求 {prefix}<number>。");
    }

    private static async Task<bool> ExistsAsync(SqliteConnection connection, DomainMap map, object key, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT 1 FROM {Q(map.Table)} WHERE {BuildKeyPredicate(map, key, command)} LIMIT 1";
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private static async Task<Dictionary<string, ColumnInfo>> ReadColumnsAsync(SqliteConnection connection, string table, CancellationToken cancellationToken, SqliteTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = $"PRAGMA table_info({Q(table)})";
        var result = new Dictionary<string, ColumnInfo>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            result[reader.GetString(1)] = new ColumnInfo(reader.GetString(1), reader.GetString(2), reader.GetInt64(3) != 0, reader.IsDBNull(4) ? null : reader.GetValue(4), reader.GetInt64(5) != 0);
        return result;
    }

    private static async Task FillRequiredDefaultsAsync(SqliteConnection connection, string table, IDictionary<string, object?> values, DateTimeOffset updatedAt, CancellationToken cancellationToken, SqliteTransaction? transaction = null)
    {
        var columns = await ReadColumnsAsync(connection, table, cancellationToken, transaction);
        foreach (var column in columns.Values)
        {
            if (values.ContainsKey(column.Name) || column.PrimaryKey || !column.NotNull || column.DefaultValue is not null) continue;
            values[column.Name] = column.Name.EndsWith("At", StringComparison.OrdinalIgnoreCase) ? Format(updatedAt) :
                column.Type.Contains("INT", StringComparison.OrdinalIgnoreCase) || column.Type.Contains("REAL", StringComparison.OrdinalIgnoreCase) ? 0 : string.Empty;
        }
    }

    private static JsonNode? ReadJsonValue(SqliteDataReader reader, int ordinal, bool boolean, string column)
    {
        if (reader.IsDBNull(ordinal)) return null;
        if (boolean) return JsonValue.Create(Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture) != 0);
        if (column.EndsWith("At", StringComparison.OrdinalIgnoreCase))
        {
            var dateText = Convert.ToString(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
            if (DateTimeOffset.TryParse(dateText, CultureInfo.InvariantCulture,
                    DateTimeStyles.AllowWhiteSpaces | DateTimeStyles.AssumeLocal, out var parsedDate))
                return JsonValue.Create(Format(parsedDate));
        }
        return reader.GetValue(ordinal) switch
        {
            long value => JsonValue.Create(value), double value => JsonValue.Create(value), string value => JsonValue.Create(value),
            byte[] value => JsonValue.Create(Convert.ToBase64String(value)), _ => JsonValue.Create(Convert.ToString(reader.GetValue(ordinal), CultureInfo.InvariantCulture))
        };
    }

    private static object? ToDbValue(JsonNode? node, bool boolean)
    {
        if (node is null) return null;
        if (boolean && node is JsonValue boolValue && boolValue.TryGetValue<bool>(out var parsedBool)) return parsedBool ? 1 : 0;
        if (node is JsonValue value)
        {
            if (value.TryGetValue<string>(out var text)) return text;
            if (value.TryGetValue<long>(out var integer)) return integer;
            if (value.TryGetValue<double>(out var number)) return number;
            if (value.TryGetValue<bool>(out var flag)) return flag ? 1 : 0;
        }
        return node.ToJsonString();
    }

    private ISecretProtector RequireSecrets() => secrets ?? throw new InvalidOperationException("旧关系库秘密字段需要 Core 密钥服务。");
    private static string Q(string identifier) => '"' + identifier.Replace("\"", "\"\"") + '"';
    private static string Format(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);

    private static IReadOnlyDictionary<string, DomainMap> BuildMaps()
    {
        var maps = new[]
        {
            M("action_tag","ActionTagDefinitions","Tag",b:["IsEnabled"],drop:["Id"]),
            M("ai_conversation","AiConversations","Provider",b:[],drop:["Id"]),
            M("app_runtime_state","AppRuntimeStates","Id",IdMode.Singleton,singleton:1,b:[],drop:["Id"]),
            M("chat_command_launcher","ChatCommandLaunchers","Id",IdMode.PrefixedInteger,"legacy_launcher_","LauncherId",b:["Enabled"],drop:["Id"]),
            M("db_column_comment","DbColumnComments","Id",IdMode.PrefixedInteger,"legacy_db_column_","CommentId",b:[],drop:["Id"]),
            M("desktop_context_snapshot","DesktopContextSnapshots","Id",IdMode.PrefixedInteger,"legacy_desktop_context_","SnapshotId",b:[],drop:["Id"]),
            M("voice_asset","VoiceAssets","VoiceId",b:["IsEnabled"],drop:["Id"]),
            M("voice_role","VoiceRoles","RoleId",b:["IsEnabled"],drop:["Id","AvatarPath"]),
            M("voice_role_voice","VoiceRoleVoices","Id",IdMode.PrefixedInteger,"legacy_role_voice_",b:["IsDefault","IsEnabled"],drop:["Id"]),
            M("voice_role_binding","VoiceRoleBindings","Id",IdMode.PrefixedInteger,"legacy_voice_binding_",b:[],drop:["Id"]),
            M("voice_role_audio_cache","VoiceRoleAudioCaches","Id",IdMode.PrefixedInteger,"legacy_voice_cache_",b:["IsEnabled"],drop:["Id"]),
            M("voice_cache_generation","VoiceCacheGenerations","GenerationId",b:[],drop:[]),
            M("voice_conversation","VoiceConversations","ConversationId",b:[],drop:["Id"]),
            M("notebook","NotebookNotes","NoteId",b:["IsPinned","IsDeleted"],drop:["Id","ContentXaml","ImagePathsJson"],remove:["ContentRich"]),
            M("notebook_attachment","NotebookAttachments","Id",b:["IsDeleted"]),
            M("timer_record","TimerRecords","RecordId",idProperty:"RecordId",b:[],drop:["Id","DisplayText"]),
            M("reminder","Reminders","ReminderId",b:["Enabled","AllowTts"],drop:["Id"]),
            M("reminder_history","ReminderLogs","Id",IdMode.PrefixedInteger,"legacy_reminder_log_","HistoryId",b:["PlayedTts"],drop:["Id"]),
            M("agent_capability","AgentCapabilities","CapabilityName",b:["RequireConfirm","Enabled"],drop:["Id","ChatCommandLauncherId","CreatedAt"]),
            M("agent_tool_call","AgentToolCalls","Id",IdMode.PrefixedInteger,"legacy_tool_","CallId",["ConfirmedByUser","RejectedByUser"],["Id"],
                new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"Stdout","Output"},{"ErrorMessage","Error"},{"ParentToolCallId","ParentCallId"}},
                new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"Output","Stdout"},{"Error","ErrorMessage"},{"ParentCallId","ParentToolCallId"}}),
            M("proactive_rule","ProactiveTriggerRules","RuleId",b:["Enabled","AllowTts"],drop:["Id","Source","CreatedAt"],
                read:new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"Event","EventType"}},write:new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"EventType","Event"}}),
            M("disturbance_settings","DisturbanceSettings","Id",IdMode.Singleton,singleton:1,b:["QuietHoursEnabled","SuppressWhenFullscreen"],drop:["Id"]),
            M("proactive_state","ProactiveTriggerStates","RuleId",b:[],drop:["Id"]),
            M("llm_business_model","LlmBusinessModelConfigs","BusinessKey",b:["IsEnabled"],drop:["Id"]),
            M("llm_source_prompt","LlmSourcePrompts","SourceKey",b:["IsEnabled"],drop:["Id"]),
            M("llm_chat_conversation","LlmChatConversations","ConversationId",b:["IsActive"],drop:["Id"]),
            M("llm_chat_message","LlmChatMessages","MessageId",b:[],drop:["Id"]),
            M("llm_provider_selection","LlmProviderSelections","Id",IdMode.Singleton,singleton:1,b:[],drop:["Id"]),
            M("llm_call_audit","LlmCallLogs","Id",IdMode.PrefixedInteger,"legacy_llm_call_",b:[],drop:["Id"]),
            M("maid_state","MaidStates","MaidId",b:["IsCurrent"],drop:["Id","ImagePath"]),
            M("market_event","CryptoMarketEvents","DedupeKey",idProperty:"EventId",b:[],drop:["Id","CreatedAt"]),
            M("market_provider","CryptoMarketProviderConfigurations","Id",IdMode.PrefixedInteger,"provider_","ProviderId",b:["IsEnabled"],drop:["Id"]),
            M("market_watchlist","CryptoMarketWatchlistItems","Symbol",b:["IsEnabled"],drop:["Id"]),
            M("video","VideoItems","Id",IdMode.PrefixedInteger,"legacy_video_","VideoId",["IsFavorite","IsCompleted"],["Id","FileName","BaseName","Extension","ResolvedPlayUrl","CoverStatus","PreviewStatus","PreviewIndexPath","PreviewGeneratedAt","PreviewError","SubtitleFolderId","FileModifiedAt","LastWriteTime"]),
            M("video_album","VideoAlbums","Id",IdMode.PrefixedInteger,"legacy_album_","AlbumId",b:[],drop:["Id"]),
            M("video_tag","VideoTagDefinitions","Name",b:[],drop:["Id"]),
            M("video_play_history","VideoPlaybackHistories","Id",IdMode.PrefixedInteger,"legacy_video_play_","HistoryId",b:[],drop:["Id"]),
            M("video_subtitle","VideoSubtitleBindings","Id",IdMode.PrefixedInteger,"legacy_subtitle_","BindingId",b:[],drop:["Id"]),
            M("remote_site","RemoteSiteConfigs","Id",IdMode.PrefixedInteger,"legacy_site_","SiteId",["IsEnabled"],["Id","CreatedAt"],remove:["UserAgent","Referer","SupportedActions","DefaultPlayAction","DownloadRootOverride","Remark","CookieFilePath","CookieContent","CookieContentFormat","CookieUpdatedAt","CookieRemark"]),
            M("remote_video_item","RemoteVideoItems","Id",IdMode.PrefixedInteger,"legacy_remote_video_","ItemId",b:[],drop:["Id"],
                read: new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["AuthorName"] = "Author", ["Duration"] = "DurationSeconds",
                    ["CoverUrl"] = "ThumbnailUrl", ["PublishTime"] = "PublishedAt"
                }),
            M("remote_video_download","RemoteDownloadTasks","TaskId",IdMode.PrefixedInteger,"legacy_remote_download_","TaskId",b:[],drop:[],
                read: new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["VideoItemId"] = "ItemId", ["AuthorName"] = "Author", ["QualityPreference"] = "Quality",
                    ["SpeedText"] = "Speed", ["EtaText"] = "Eta"
                }),
            M("remote_video_play","RemotePlayHistories","Id",IdMode.PrefixedInteger,"legacy_remote_play_","HistoryId",b:[],drop:["Id"],
                read: new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["VideoItemId"] = "ItemId", ["AuthorName"] = "Author", ["PlayAction"] = "Action"
                }),
            M("remote_video_settings","RemoteVideoSettings","Id",IdMode.Singleton,singleton:1,b:["DownloadThumbnail","DownloadInfoJson","DownloadSubtitles","DownloadDanmaku","OverwriteExisting","AutoImportToVideoLibrary"],drop:["Id"]),
            M("vault","VaultItems","Id",IdMode.PrefixedInteger,"legacy_vault_","ItemId",b:[],drop:["Id"],remove:["ChainType","WalletAddress","ServerAddress","ServerPort","Remark","PasswordEncrypted","ApiKeyEncrypted","SecretEncrypted","PrivateKeyEncrypted","MnemonicEncrypted"]),
            M("vault_history","VaultItemHistories","Id",IdMode.PrefixedInteger,"legacy_vault_history_","HistoryId",b:[],drop:["Id"],
                read:new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"ItemId","LegacyItemId"}},remove:["OldValueEncrypted","NewValueEncrypted","LegacyItemId"]),
            M("proactive_source","ProactiveBroadcastSourceSettings","SourceKey",b:["Enabled"],drop:["Id"]),
            M("proactive_audit","ProactiveBroadcastTriggerLogs","EventId",b:["Responded","Spoke"],drop:["Id"]),
            M("user_profile","UserProfiles","Id",IdMode.Singleton,singleton:1,b:[],drop:["Id"]),
            M("voice_cache_dedupe","VoiceCacheDedupeLogs","Id",IdMode.PrefixedInteger,"legacy_voice_cache_dedupe_","LogId",b:[],drop:["Id"]),
            M("voice_trigger_log","VoiceTriggerLogs","Id",IdMode.PrefixedInteger,"legacy_voice_trigger_","LogId",b:["Played"],drop:["Id"])
        };
        return maps.ToDictionary(x => x.Domain, StringComparer.OrdinalIgnoreCase);
    }

    private static DomainMap M(string domain, string table, string key, IdMode mode=IdMode.Direct, string prefix="", string idProperty="",
        string[]? b=null, string[]? drop=null, IReadOnlyDictionary<string,string>? read=null, IReadOnlyDictionary<string,string>? write=null,
        string[]? remove=null, object? singleton=null, string? order=null) => new(domain, table, key, mode, prefix, idProperty,
        new HashSet<string>(b ?? [],StringComparer.OrdinalIgnoreCase), new HashSet<string>(drop ?? [],StringComparer.OrdinalIgnoreCase),
        read ?? new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase), write ?? new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(remove ?? [],StringComparer.OrdinalIgnoreCase), singleton ?? 1, order);

    private sealed record DomainMap(string Domain, string Table, string KeyColumn, IdMode IdMode, string IdPrefix, string IdProperty,
        IReadOnlySet<string> BooleanColumns, IReadOnlySet<string> DroppedColumns, IReadOnlyDictionary<string,string> ReadAliases,
        IReadOnlyDictionary<string,string> WriteAliases, IReadOnlySet<string> RemoveAfterTransform, object SingletonKey, string? OrderColumn);
    private sealed record ColumnInfo(string Name, string Type, bool NotNull, object? DefaultValue, bool PrimaryKey);
    private enum IdMode { Direct, PrefixedInteger, Singleton }
    private enum SettingDomain { None, ModelSecret, ProtectedSetting, RemoteSiteSecret, VaultSecret, VaultHistorySecret }
}
