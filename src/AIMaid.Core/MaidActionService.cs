using System.Text;
using System.Text.Json;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class MaidActionService
{
    private readonly IAiProviderClient aiProvider;
    private readonly Action<string, Exception?> log;

    public MaidActionService(IAiProviderClient aiProvider, Action<string, Exception?>? log = null)
    {
        this.aiProvider = aiProvider;
        this.log = log ?? ((_, _) => { });
    }

    public async Task<IReadOnlyList<ProactiveActionDto>> BuildActionsAsync(
        string eventType,
        string roleId,
        ProactiveTriggerMatch trigger,
        ActivitySnapshot desktop,
        ProactiveBroadcastContext context,
        bool manualTest,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var values = new Dictionary<string, string>
            {
                ["eventType"] = eventType,
                ["eventPayloadJson"] = JsonSerializer.Serialize(new
                {
                    broadcastSelectedSourceKeys = context.SelectedSourceKeys,
                    manualTest
                }),
                ["maidStateJson"] = "{}",
                ["activeWindowJson"] = JsonSerializer.Serialize(desktop),
                ["broadcastCandidatesJson"] = JsonSerializer.Serialize(context.Candidates),
                ["recentBroadcastMessagesJson"] = JsonSerializer.Serialize(context.RecentMessages)
            };
            var raw = new StringBuilder();
            await foreach (var delta in aiProvider.StreamChatAsync(new AiChatRequest(
                               $"maid_ai_decision_{Guid.NewGuid():N}",
                               eventType,
                               roleId,
                               string.Empty,
                               [],
                               SourceKey: "maid_ai_decision",
                               TemplateValues: values,
                               RequireJsonResponse: true,
                               StreamResponse: false), cancellationToken))
                raw.Append(delta);
            var actions = ParseActions(raw.ToString(), context.SelectedSourceKeys, manualTest);
            if (actions.Count > 0) return actions;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            log("Maid AI decision failed; applying proactive rule actions.", exception);
        }
        return BuildRuleActions(trigger, context.SelectedSourceKeys, manualTest);
    }

    private static IReadOnlyList<ProactiveActionDto> ParseActions(string raw, string sourceKeys, bool manualTest)
    {
        var trimmed = raw.Trim();
        var start = trimmed.IndexOf('{');
        var end = trimmed.LastIndexOf('}');
        if (start >= 0 && end > start) trimmed = trimmed[start..(end + 1)];
        using var document = JsonDocument.Parse(trimmed);
        var root = document.RootElement;
        var respond = root.TryGetProperty("respond", out var respondElement) && respondElement.ValueKind == JsonValueKind.True;
        if (!respond) return [];
        var message = ReadString(root, "message");
        var speak = root.TryGetProperty("speak", out var speakElement) && speakElement.ValueKind == JsonValueKind.True;
        var showBubble = root.TryGetProperty("showBubble", out var bubbleElement)
            ? bubbleElement.ValueKind == JsonValueKind.True
            : respond;
        var actions = new List<ProactiveActionDto>();
        if (showBubble && !speak && !string.IsNullOrWhiteSpace(message))
            actions.Add(new ProactiveActionDto("show_message", new Dictionary<string, string> { ["text"] = message }));
        if (speak && !string.IsNullOrWhiteSpace(message))
        {
            var payload = new Dictionary<string, string>
            {
                ["trigger"] = ReadString(root, "voiceTrigger") is { Length: > 0 } trigger ? trigger : "random.daily_idle",
                ["text"] = message,
                ["voiceStyle"] = ReadString(root, "voiceStyle"),
                ["useRealtimeTts"] = "true",
                ["broadcastSourceKeys"] = string.IsNullOrWhiteSpace(ReadString(root, "broadcastSourceKeys"))
                    ? sourceKeys
                    : ReadString(root, "broadcastSourceKeys")
            };
            if (manualTest) payload["skipBroadcastDedupe"] = "true";
            actions.Add(new ProactiveActionDto("speak", payload));
        }
        var mood = ReadString(root, "moodChange");
        var delta = root.TryGetProperty("favorabilityDelta", out var deltaElement) && deltaElement.TryGetInt32(out var parsed)
            ? parsed
            : 0;
        if (!string.IsNullOrWhiteSpace(mood) || delta != 0)
        {
            var payload = new Dictionary<string, string> { ["favorabilityDelta"] = delta.ToString() };
            if (!string.IsNullOrWhiteSpace(mood)) payload["mood"] = mood;
            actions.Add(new ProactiveActionDto("change_state", payload));
        }
        return actions;
    }

    private static IReadOnlyList<ProactiveActionDto> BuildRuleActions(
        ProactiveTriggerMatch trigger,
        string sourceKeys,
        bool manualTest)
    {
        if (string.IsNullOrWhiteSpace(trigger.Text)) return [];
        var actions = new List<ProactiveActionDto>
        {
            new("show_message", new Dictionary<string, string> { ["text"] = trigger.Text })
        };
        if (trigger.AllowTts)
        {
            var payload = new Dictionary<string, string>
            {
                ["trigger"] = string.IsNullOrWhiteSpace(trigger.ActionTag) ? "random.daily_idle" : trigger.ActionTag,
                ["text"] = trigger.Text,
                ["broadcastSourceKeys"] = sourceKeys
            };
            if (manualTest) payload["skipBroadcastDedupe"] = "true";
            actions.Add(new ProactiveActionDto("speak", payload));
        }
        return actions;
    }

    private static string ReadString(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? string.Empty
            : string.Empty;
}
