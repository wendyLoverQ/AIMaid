using System.Text.Json;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed record ProactiveTriggerMatch(
    bool ShouldTrigger,
    string RuleId,
    string Text,
    bool AllowTts,
    string ActionTag,
    string Reason,
    int Priority);

public sealed class ProactiveTriggerService
{
    private readonly IDomainDocumentStore store;
    private readonly Random random = new();

    public ProactiveTriggerService(IDomainDocumentStore store)
    {
        this.store = store;
    }

    public async Task<ProactiveTriggerMatch> EvaluateAsync(
        string eventName,
        ActivitySnapshot desktop,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        var disturbance = await LoadDisturbanceAsync(cancellationToken);
        var rules = (await store.ListAsync("proactive_rule", cancellationToken))
            .Select(Deserialize<ProactiveRuleDto>)
            .Where(rule => rule.Enabled && rule.EventType.Equals(eventName, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(rule => rule.Priority)
            .ToArray();
        foreach (var rule in rules)
        {
            if (!MatchesCondition(rule, desktop, now)) continue;
            var state = await LoadStateAsync(rule.RuleId, cancellationToken);
            if (state.LastTriggeredAt is not null &&
                now - state.LastTriggeredAt < TimeSpan.FromSeconds(Math.Max(1, rule.CooldownSeconds)))
                continue;
            if (IsSuppressed(rule, disturbance, desktop, now)) continue;
            return new ProactiveTriggerMatch(
                true,
                rule.RuleId,
                PickTemplate(rule.TextTemplatesJson),
                rule.AllowTts && !disturbance.Mode.Equals("quiet", StringComparison.OrdinalIgnoreCase),
                rule.ActionTag,
                "matched",
                rule.Priority);
        }
        return new ProactiveTriggerMatch(false, string.Empty, string.Empty, false, "idle", "no_match", 0);
    }

    public async Task<bool> IsHourlyLimitReachedAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        var disturbance = await LoadDisturbanceAsync(cancellationToken);
        if (disturbance.MaxProactivePerHour < 0) return false;
        var hourly = await LoadHourlyAsync(now, cancellationToken);
        return hourly.Count >= disturbance.MaxProactivePerHour;
    }

    public async Task MarkTriggeredAsync(
        string ruleId,
        string result,
        DateTimeOffset triggeredAt,
        CancellationToken cancellationToken = default)
    {
        if (!string.IsNullOrWhiteSpace(ruleId))
        {
            var state = await LoadStateAsync(ruleId, cancellationToken);
            state = state with
            {
                LastTriggeredAt = triggeredAt,
                TriggerCount = state.TriggerCount + 1,
                LastResult = result,
                UpdatedAt = triggeredAt
            };
            await store.UpsertAsync("proactive_state", ruleId, JsonSerializer.Serialize(state), triggeredAt, cancellationToken);
        }
        var hourly = await LoadHourlyAsync(triggeredAt, cancellationToken);
        await store.UpsertAsync("proactive_state", "_hourly",
            JsonSerializer.Serialize(new ProactiveStateDocument(
                "_hourly",
                hourly.WindowStart,
                hourly.Count + 1,
                "hourly",
                triggeredAt)),
            triggeredAt,
            cancellationToken);
    }

    private async Task<DisturbanceSettingsDto> LoadDisturbanceAsync(CancellationToken cancellationToken)
    {
        var json = await store.GetAsync("disturbance_settings", "current", cancellationToken);
        return json is null
            ? new DisturbanceSettingsDto("normal", true, "01:00", "09:00", true, 3, DateTimeOffset.Now)
            : Deserialize<DisturbanceSettingsDto>(json);
    }

    private async Task<ProactiveStateDocument> LoadStateAsync(string ruleId, CancellationToken cancellationToken)
    {
        var json = await store.GetAsync("proactive_state", ruleId, cancellationToken);
        return json is null
            ? new ProactiveStateDocument(ruleId, null, 0, string.Empty, DateTimeOffset.Now)
            : Deserialize<ProactiveStateDocument>(json);
    }

    private async Task<HourlyStateDocument> LoadHourlyAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var json = await store.GetAsync("proactive_state", "_hourly", cancellationToken);
        var state = json is null ? null : Deserialize<ProactiveStateDocument>(json);
        return state?.LastTriggeredAt is null || now - state.LastTriggeredAt >= TimeSpan.FromHours(1) || now < state.LastTriggeredAt
            ? new HourlyStateDocument("_hourly", now, 0, now)
            : new HourlyStateDocument("_hourly", state.LastTriggeredAt.Value, state.TriggerCount, state.UpdatedAt);
    }

    private static bool MatchesCondition(ProactiveRuleDto rule, ActivitySnapshot desktop, DateTimeOffset now)
    {
        using var document = ParseOrEmpty(rule.ConditionJson);
        var root = document.RootElement;
        if (root.TryGetProperty("timeAfter", out var after) &&
            TimeSpan.TryParse(after.GetString(), out var afterTime) &&
            now.TimeOfDay < afterTime)
            return false;
        if (root.TryGetProperty("timeBefore", out var before) &&
            TimeSpan.TryParse(before.GetString(), out var beforeTime) &&
            now.TimeOfDay > beforeTime)
            return false;
        if (root.TryGetProperty("idleSeconds", out var idle) &&
            idle.TryGetInt32(out var idleSeconds) &&
            desktop.UserIdleTime.TotalSeconds < idleSeconds)
            return false;
        return rule.EventType switch
        {
            "coding_detected" => desktop.Scene == "coding",
            "game_detected" => desktop.Scene is "gaming" or "game",
            "fullscreen_detected" => desktop.IsFullscreen,
            _ => true
        };
    }

    private static bool IsSuppressed(
        ProactiveRuleDto rule,
        DisturbanceSettingsDto settings,
        ActivitySnapshot desktop,
        DateTimeOffset now)
    {
        if (settings.Mode.Equals("sleep", StringComparison.OrdinalIgnoreCase)) return true;
        if (settings.Mode.Equals("focus", StringComparison.OrdinalIgnoreCase) && rule.Priority < 5) return true;
        if ((settings.Mode.Equals("game", StringComparison.OrdinalIgnoreCase) || settings.SuppressWhenFullscreen) &&
            desktop.IsFullscreen && rule.Priority < 5)
            return true;
        return settings.QuietHoursEnabled &&
               TimeSpan.TryParse(settings.QuietHoursStart, out var start) &&
               TimeSpan.TryParse(settings.QuietHoursEnd, out var end) &&
               IsWithinQuietHours(now.TimeOfDay, start, end) &&
               rule.Priority < 5;
    }

    private static bool IsWithinQuietHours(TimeSpan now, TimeSpan start, TimeSpan end)
        => start <= end ? now >= start && now <= end : now >= start || now <= end;

    private string PickTemplate(string json)
    {
        using var document = ParseOrEmptyArray(json);
        var templates = document.RootElement.ValueKind == JsonValueKind.Array
            ? document.RootElement.EnumerateArray()
                .Where(value => value.ValueKind == JsonValueKind.String)
                .Select(value => value.GetString() ?? string.Empty)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToArray()
            : [];
        return templates.Length == 0 ? string.Empty : templates[random.Next(templates.Length)];
    }

    private static JsonDocument ParseOrEmpty(string json)
    {
        try { return JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json); }
        catch (JsonException) { return JsonDocument.Parse("{}"); }
    }
    private static JsonDocument ParseOrEmptyArray(string json)
    {
        try { return JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "[]" : json); }
        catch (JsonException) { return JsonDocument.Parse("[]"); }
    }
    private static T Deserialize<T>(string json)
        => JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
           ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");

    private sealed record ProactiveStateDocument(
        string RuleId,
        DateTimeOffset? LastTriggeredAt,
        int TriggerCount,
        string LastResult,
        DateTimeOffset UpdatedAt);
    private sealed record HourlyStateDocument(
        string RuleId,
        DateTimeOffset WindowStart,
        int Count,
        DateTimeOffset UpdatedAt);
}
