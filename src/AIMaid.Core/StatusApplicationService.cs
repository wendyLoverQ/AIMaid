using AIMaid.Contracts.Status;
using System.Globalization;
using System.Text.Json;

namespace AIMaid.Core;

public interface IStatusPlatform
{
    Task<SystemResourceSnapshotDto> GetResourcesAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyList<NetworkProbeDto>> GetNetworkAsync(string? proxyAddress, CancellationToken cancellationToken = default);
}

public sealed class StatusApplicationService(
    IStatusPlatform platform,
    ISettingsStore settings,
    ICharacterStore characters,
    IDomainDocumentStore documents,
    PetVoiceMenuApplicationService petVoiceMenu)
{
    private const string ProxySettingKey = "user_config:App:Proxy:Address";
    private const string CachePeriodSettingKey = "user_config:App:VoiceCache:LazyCachePeriodHours";
    private const int VoiceCachePlanCount = 12;

    public Task<SystemResourceSnapshotDto> GetResourcesAsync(CancellationToken cancellationToken = default)
        => platform.GetResourcesAsync(cancellationToken);

    public async Task<IReadOnlyList<NetworkProbeDto>> GetNetworkAsync(CancellationToken cancellationToken = default)
    {
        var proxyAddress = (await settings.GetAsync(ProxySettingKey, cancellationToken))?.Value;
        return await platform.GetNetworkAsync(proxyAddress, cancellationToken);
    }

    public async Task<StatusRoleStateDto> GetRoleStateAsync(CancellationToken cancellationToken = default)
    {
        var voice = await petVoiceMenu.GetAsync(cancellationToken);
        var character = voice.RoleId.Length == 0 ? null : await characters.GetAsync(voice.RoleId, cancellationToken);
        using var maid = await FindMaidStateAsync(voice.RoleId, cancellationToken);
        var maidRoot = maid?.RootElement;
        var cacheCompleted = voice.RoleId.Length == 0
            ? VoiceCachePlanCount
            : await CountCompletedVoiceCacheAsync(voice.RoleId, voice.IntimacyLevel, cancellationToken);
        return new StatusRoleStateDto(
            voice.RoleId,
            voice.RoleName,
            character?.VoiceName ?? character?.PreferredVoiceId ?? string.Empty,
            voice.IntimacyLevel,
            voice.IntimacyLabel,
            VoiceCachePlanCount,
            cacheCompleted,
            maid is not null,
            maidRoot is null ? string.Empty : FormatMood(maidRoot.Value),
            maidRoot is null ? 0 : ReadInt(maidRoot.Value, "Favorability", "favorability"),
            maidRoot is null ? string.Empty : FormatCompanionship(ReadInt(maidRoot.Value, "CompanionshipSeconds", "companionshipSeconds")),
            maidRoot is null ? 0 : ReadInt(maidRoot.Value, "InteractionCount", "interactionCount"),
            maidRoot is null ? string.Empty : FormatLastInteraction(maidRoot.Value));
    }

    public async Task<LlmLatencySnapshotDto> GetLlmLatenciesAsync(
        string chatModel,
        string cacheModel,
        string proactiveModel,
        CancellationToken cancellationToken = default)
    {
        var rows = (await documents.ListAsync("llm_call_audit", cancellationToken)).Select(ParseLlmAudit).ToArray();
        return new LlmLatencySnapshotDto(
            LatestLatency(rows, "online_chat", chatModel),
            LatestLatency(rows, "lazy_voice_lines", cacheModel),
            LatestLatency(rows, "maid_ai_decision", proactiveModel));
    }

    private async Task<JsonDocument?> FindMaidStateAsync(string roleId, CancellationToken cancellationToken)
    {
        if (roleId.Length == 0) return null;
        var direct = await documents.GetAsync("maid_state", roleId, cancellationToken);
        if (direct is not null) return JsonDocument.Parse(direct);
        foreach (var json in await documents.ListAsync("maid_state", cancellationToken))
        {
            var document = JsonDocument.Parse(json);
            if (string.Equals(ReadString(document.RootElement, "MaidId", "maidId"), roleId, StringComparison.OrdinalIgnoreCase)) return document;
            document.Dispose();
        }
        return null;
    }

    private async Task<int> CountCompletedVoiceCacheAsync(string roleId, int intimacyLevel, CancellationToken cancellationToken)
    {
        var periodText = (await settings.GetAsync(CachePeriodSettingKey, cancellationToken))?.Value;
        var period = int.TryParse(periodText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) && parsed is 1 or 2 or 4 or 8 or 16 ? parsed : 1;
        var cacheKey = BuildLazyCacheKey(DateTime.Now, period);
        var slots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var json in await documents.ListAsync("voice_role_audio_cache", cancellationToken))
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!string.Equals(ReadString(root, "RoleId", "roleId"), roleId, StringComparison.OrdinalIgnoreCase) ||
                ReadInt(root, "IntimacyLevel", "intimacyLevel") != intimacyLevel ||
                !string.Equals(ReadString(root, "CacheKey", "cacheKey"), cacheKey, StringComparison.OrdinalIgnoreCase)) continue;
            var audioPath = ReadString(root, "AudioPath", "audioPath");
            if (audioPath.Length == 0 || !File.Exists(audioPath)) continue;
            slots.Add($"{ReadString(root, "TriggerId", "triggerId")}|{ReadString(root, "BodyPart", "bodyPart")}");
        }
        return Math.Min(VoiceCachePlanCount, slots.Count);
    }

    private static string BuildLazyCacheKey(DateTime now, int periodHours)
    {
        var epoch = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Local);
        var hours = (long)Math.Floor((now - epoch).TotalHours);
        return epoch.AddHours(hours / periodHours * periodHours).ToString("yyyyMMddHH", CultureInfo.InvariantCulture);
    }

    private static string FormatMood(JsonElement root) => ReadString(root, "Mood", "mood") switch
    {
        "happy" => "开心",
        "lonely" => "被冷落",
        "angry" => "不满",
        "sleeping" => "休息",
        _ => "普通"
    };

    private static string FormatCompanionship(int seconds)
    {
        var value = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return value.TotalHours >= 1 ? $"{(int)value.TotalHours}小时{value.Minutes}分钟" : $"{value.Minutes}分钟{value.Seconds}秒";
    }

    private static string FormatLastInteraction(JsonElement root)
    {
        var raw = ReadString(root, "LastInteractionTime", "lastInteractionTime");
        return DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var value)
            ? value.LocalDateTime.ToString("MM/dd HH:mm", CultureInfo.InvariantCulture)
            : "暂无";
    }

    private static string ReadString(JsonElement root, string first, string second)
        => root.TryGetProperty(first, out var value) || root.TryGetProperty(second, out value) ? value.ToString() : string.Empty;

    private static int ReadInt(JsonElement root, string first, string second)
        => (root.TryGetProperty(first, out var value) || root.TryGetProperty(second, out value)) && value.TryGetInt32(out var result) ? result : 0;

    private static LlmAuditRow ParseLlmAudit(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var createdText = ReadString(root, "CreatedAt", "createdAt");
        _ = DateTimeOffset.TryParse(createdText, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var createdAt);
        return new LlmAuditRow(
            ReadString(root, "Source", "source"),
            ReadString(root, "Model", "model"),
            ReadString(root, "Error", "error"),
            ReadInt(root, "DurationMs", "durationMs"),
            createdAt);
    }

    private static int? LatestLatency(IEnumerable<LlmAuditRow> rows, string source, string model)
        => rows.Where(row => row.Source == source && row.DurationMs > 0 && row.Error.Length == 0 &&
                            (model.Length == 0 || row.Model == model))
            .OrderByDescending(row => row.CreatedAt).Select(row => (int?)row.DurationMs).FirstOrDefault();

    private sealed record LlmAuditRow(string Source, string Model, string Error, int DurationMs, DateTimeOffset CreatedAt);
}
