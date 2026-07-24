using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AIMaid.Contracts.Status;

namespace AIMaid.CoreHost.Runtime;

public sealed class CodexQuotaApplicationService
{
    private const int MaxSessionFiles = 30;
    private const int MaxTailBytes = 4 * 1024 * 1024;
    private static readonly TimeSpan StaleThreshold = TimeSpan.FromHours(2);
    private readonly string sessionsDirectory;
    private readonly string authFilePath;

    public CodexQuotaApplicationService()
    {
        var configured = Environment.GetEnvironmentVariable("CODEX_HOME");
        var codexHome = !string.IsNullOrWhiteSpace(configured)
            ? Path.GetFullPath(Environment.ExpandEnvironmentVariables(configured))
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        sessionsDirectory = Path.Combine(codexHome, "sessions");
        authFilePath = Path.Combine(codexHome, "auth.json");
    }

    public Task<CodexQuotaSnapshotDto> GetAsync(CancellationToken cancellationToken = default)
        => Task.Run(ReadSnapshot, cancellationToken);

    private CodexQuotaSnapshotDto ReadSnapshot()
    {
        var account = ReadCurrentAccount();
        if (!account.LoggedIn) return Empty(false, string.Empty, "未登录");
        if (!Directory.Exists(sessionsDirectory)) return Empty(true, account.DisplayName, "未找到 sessions 目录，请先使用 Codex 进行对话");

        TokenCountEvent? latestEvent = null;
        foreach (var file in new DirectoryInfo(sessionsDirectory).GetFiles("*.jsonl", SearchOption.AllDirectories)
                     .OrderByDescending(file => file.LastWriteTimeUtc).Take(MaxSessionFiles))
        {
            var candidate = FindLatestTokenCountEvent(file);
            if (candidate?.Payload?.RateLimits is null) continue;
            if (latestEvent is null || candidate.Timestamp > latestEvent.Timestamp) latestEvent = candidate;
            if (latestEvent.Timestamp is { } timestamp && DateTimeOffset.UtcNow - timestamp < TimeSpan.FromMinutes(5)) break;
        }

        if (latestEvent?.Payload?.RateLimits is null)
            return Empty(true, account.DisplayName, "未找到额度数据，请使用 Codex 进行一次对话后重试");

        var limits = latestEvent.Payload.RateLimits;
        var error = latestEvent.Timestamp is { } updated && DateTimeOffset.UtcNow - updated > StaleThreshold
            ? $"额度数据已过期 ({(int)(DateTimeOffset.UtcNow - updated).TotalHours}h前)，请进行一次 Codex 对话以刷新"
            : null;
        return new CodexQuotaSnapshotDto(
            true,
            account.DisplayName,
            limits.PlanType ?? "unknown",
            latestEvent.Timestamp?.LocalDateTime.ToString("HH:mm") ?? string.Empty,
            ToWindow(limits.Primary),
            ToWindow(limits.Secondary),
            FormatCredits(limits.Credits),
            error);
    }

    private static CodexQuotaSnapshotDto Empty(bool loggedIn, string account, string error)
        => new(loggedIn, account, "unknown", string.Empty, null, null, null, error);

    private static CodexQuotaWindowDto? ToWindow(RateLimitWindow? window)
    {
        if (window is null) return null;
        var reset = window.ResetsAt > 0 ? DateTimeOffset.FromUnixTimeSeconds(window.ResetsAt).LocalDateTime.ToString("MM/dd HH:mm") : string.Empty;
        return new CodexQuotaWindowDto(FormatQuotaWindow(window.WindowMinutes), Math.Clamp(100 - window.UsedPercent, 0, 100), reset);
    }

    private static string? FormatCredits(CreditInfo? credits)
    {
        if (credits is null || credits.HasCredits == false) return null;
        if (credits.Unlimited) return "unlimited";
        return credits.Balance?.ToString("F0");
    }

    private static string FormatQuotaWindow(int minutes) => minutes switch
    {
        300 => "5小时",
        1440 => "每日",
        10080 => "每周",
        > 0 when minutes % 1440 == 0 => $"{minutes / 1440}天",
        > 0 when minutes % 60 == 0 => $"{minutes / 60}小时",
        > 0 => $"{minutes}分钟",
        _ => "额度"
    };

    private static TokenCountEvent? FindLatestTokenCountEvent(FileInfo file)
    {
        try
        {
            var lines = ReadTailLines(file.FullName);
            for (var index = lines.Count - 1; index >= 0; index--)
            {
                if (!lines[index].Contains("\"token_count\"", StringComparison.Ordinal)) continue;
                var value = JsonSerializer.Deserialize<TokenCountEvent>(lines[index]);
                if (value?.Payload?.Type == "token_count" && value.Payload.RateLimits is not null) return value;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
        return null;
    }

    private static IReadOnlyList<string> ReadTailLines(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var offset = Math.Max(0, stream.Length - MaxTailBytes);
        stream.Seek(offset, SeekOrigin.Begin);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: offset == 0);
        if (offset > 0) _ = reader.ReadLine();
        var lines = new List<string>();
        while (reader.ReadLine() is { } line) lines.Add(line);
        return lines;
    }

    private AccountIdentity ReadCurrentAccount()
    {
        if (!File.Exists(authFilePath)) return new AccountIdentity(false, string.Empty);
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(authFilePath));
            var root = document.RootElement;
            if (!root.TryGetProperty("tokens", out var tokens) || tokens.ValueKind != JsonValueKind.Object) return new AccountIdentity(false, string.Empty);
            var hasAccount = tokens.TryGetProperty("account_id", out var accountId) && accountId.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(accountId.GetString());
            var idToken = tokens.TryGetProperty("id_token", out var token) && token.ValueKind == JsonValueKind.String ? token.GetString() : null;
            return new AccountIdentity(hasAccount || !string.IsNullOrWhiteSpace(idToken), ReadDisplayNameFromIdToken(idToken));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return new AccountIdentity(false, string.Empty);
        }
    }

    private static string ReadDisplayNameFromIdToken(string? idToken)
    {
        if (string.IsNullOrWhiteSpace(idToken)) return "当前用户";
        try
        {
            var parts = idToken.Split('.');
            if (parts.Length < 2) return "当前用户";
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
            var root = document.RootElement;
            if (root.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(name.GetString())) return name.GetString()!;
            if (root.TryGetProperty("email", out var email) && email.ValueKind == JsonValueKind.String) return MaskEmail(email.GetString());
        }
        catch (Exception exception) when (exception is FormatException or JsonException)
        {
            return "当前用户";
        }
        return "当前用户";
    }

    private static string MaskEmail(string? email)
    {
        if (string.IsNullOrWhiteSpace(email)) return "当前用户";
        var separator = email.IndexOf('@');
        if (separator <= 0) return "当前用户";
        var prefix = email[..separator];
        var visiblePrefix = prefix.Length <= 2 ? prefix[..1] : prefix[..2];
        return $"{visiblePrefix}***{email[separator..]}";
    }

    private sealed record AccountIdentity(bool LoggedIn, string DisplayName);
    private sealed class TokenCountEvent
    {
        [JsonPropertyName("timestamp")] public DateTimeOffset? Timestamp { get; set; }
        [JsonPropertyName("payload")] public TokenCountPayload? Payload { get; set; }
    }
    private sealed class TokenCountPayload
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("rate_limits")] public RateLimits? RateLimits { get; set; }
    }
    private sealed class RateLimits
    {
        [JsonPropertyName("primary")] public RateLimitWindow? Primary { get; set; }
        [JsonPropertyName("secondary")] public RateLimitWindow? Secondary { get; set; }
        [JsonPropertyName("credits")] public CreditInfo? Credits { get; set; }
        [JsonPropertyName("plan_type")] public string? PlanType { get; set; }
    }
    private sealed class RateLimitWindow
    {
        [JsonPropertyName("used_percent")] public double UsedPercent { get; set; }
        [JsonPropertyName("window_minutes")] public int WindowMinutes { get; set; }
        [JsonPropertyName("resets_at")] public long ResetsAt { get; set; }
    }
    private sealed class CreditInfo
    {
        [JsonPropertyName("has_credits")] public bool? HasCredits { get; set; }
        [JsonPropertyName("unlimited")] public bool Unlimited { get; set; }
        [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)]
        [JsonPropertyName("balance")] public double? Balance { get; set; }
    }
}
