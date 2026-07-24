using System.Collections.Concurrent;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class ProactiveRuntimeService : IAsyncDisposable
{
    public const string SourceDueEventType = "broadcast.sources_due";
    public const string SourceTestEventType = "broadcast.source_test";
    public const string SourceEventSource = "proactive_source_settings";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(60);
    private readonly IProactiveBroadcastContextService context;
    private readonly ProactiveTriggerService triggers;
    private readonly MaidActionService actions;
    private readonly IActivityProbe activity;
    private readonly ISettingsStore settings;
    private readonly ICharacterStore characters;
    private readonly IDomainDocumentStore documents;
    private readonly IEventPublisher events;
    private readonly Action<string, Exception?> log;
    private readonly ConcurrentDictionary<string, PendingExecution> pending = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource lifetime = new();
    private Task? loop;

    public ProactiveRuntimeService(
        IProactiveBroadcastContextService context,
        ProactiveTriggerService triggers,
        MaidActionService actions,
        IActivityProbe activity,
        ISettingsStore settings,
        ICharacterStore characters,
        IDomainDocumentStore documents,
        IEventPublisher events,
        Action<string, Exception?>? log = null)
    {
        this.context = context;
        this.triggers = triggers;
        this.actions = actions;
        this.activity = activity;
        this.settings = settings;
        this.characters = characters;
        this.documents = documents;
        this.events = events;
        this.log = log ?? ((_, _) => { });
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (loop is not null) return;
        await context.InitializeDefaultsAsync(cancellationToken);
        loop = RunAsync(lifetime.Token);
    }

    public Task<IReadOnlyList<ProactiveSourceDto>> ListSourcesAsync(CancellationToken cancellationToken = default)
        => context.ListAsync(cancellationToken);

    public Task<OperationResult<ProactiveSourceDto>> UpdateSourceAsync(
        string sourceKey,
        bool? enabled,
        int? cooldownMinutes,
        CancellationToken cancellationToken = default)
        => context.UpdateAsync(sourceKey, enabled, cooldownMinutes, cancellationToken);

    public async Task<OperationResult> TestSourceAsync(string sourceKey, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sourceKey))
            return OperationResult.Failure("proactive.source_required", "请选择具体数据源进行测试。");
        var started = await TriggerAsync(sourceKey, manualTest: true, cancellationToken);
        return started
            ? OperationResult.Success()
            : OperationResult.Failure("proactive.source_empty", "这个数据源暂时没有可播报内容。");
    }

    public async Task<OperationResult> CompleteAsync(
        CompleteProactiveExecutionCommand command,
        CancellationToken cancellationToken = default)
    {
        if (!pending.TryGetValue(command.ExecutionId, out var execution))
            return OperationResult.Failure("proactive.execution_not_found", "主动行为执行不存在或已经完成。");
        var completedAt = command.CompletedAt == default ? DateTimeOffset.Now : command.CompletedAt;
        var result = string.IsNullOrWhiteSpace(command.Error)
            ? command.Result
            : $"{command.Result}: {command.Error}";
        await context.CompleteTriggerLogAsync(
            execution.TriggerLogId,
            command.Responded,
            command.Spoke,
            command.Message,
            command.VoiceTrigger,
            command.AudioPath,
            result,
            cancellationToken);
        if (command.Responded)
        {
            await triggers.MarkTriggeredAsync(execution.RuleId, result, completedAt, cancellationToken);
            if (!execution.ManualTest && !string.IsNullOrWhiteSpace(command.Message))
                await context.TryMarkBroadcastResultAsync(execution.SourceKeys, command.Message, cancellationToken);
        }
        pending.TryRemove(command.ExecutionId, out _);
        await events.PublishAsync(new ProactiveExecutionCompletedEvent(
            EventIdentity.NewId(),
            completedAt,
            command.ExecutionId,
            command.Responded,
            command.Spoke,
            command.Message,
            command.Result,
            command.Error), cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> ApplyStateAsync(
        string? mood,
        int favorabilityDelta,
        CancellationToken cancellationToken = default)
    {
        var roleId = (await settings.GetAsync("voice_current_role_id", cancellationToken))?.Value?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(roleId))
            return OperationResult.Failure("proactive.role_missing", "当前角色不存在，无法修改角色状态。");
        var json = await documents.GetAsync("maid_state", roleId, cancellationToken);
        MaidStateDocument state;
        if (json is null)
        {
            var character = await characters.GetAsync(roleId, cancellationToken);
            var now = DateTimeOffset.Now;
            state = new MaidStateDocument(
                roleId,
                character?.Name ?? $"{roleId}女仆",
                "normal",
                50,
                0,
                0,
                true,
                null,
                now,
                now);
        }
        else
        {
            state = Deserialize<MaidStateDocument>(json);
        }
        var updated = state with
        {
            Mood = string.IsNullOrWhiteSpace(mood) ? state.Mood : mood,
            Favorability = Math.Clamp(state.Favorability + favorabilityDelta, 0, 100),
            UpdatedAt = DateTimeOffset.Now
        };
        await documents.UpsertAsync("maid_state", roleId, JsonSerializer.Serialize(updated), updated.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(PollInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                try
                {
                    await TriggerAsync(null, manualTest: false, cancellationToken);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    log("Proactive runtime poll failed.", exception);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task<bool> TriggerAsync(
        string? sourceKey,
        bool manualTest,
        CancellationToken cancellationToken)
    {
        if (!manualTest && !await IsEnabledAsync(cancellationToken)) return false;
        if (!manualTest && await triggers.IsHourlyLimitReachedAsync(DateTimeOffset.Now, cancellationToken)) return false;
        var desktop = await activity.CaptureAsync(cancellationToken);
        var roleId = (await settings.GetAsync("voice_current_role_id", cancellationToken))?.Value?.Trim() ?? string.Empty;
        var character = string.IsNullOrWhiteSpace(roleId) ? null : await characters.GetAsync(roleId, cancellationToken);
        var currentImage = (await settings.GetAsync("pet_current_image", cancellationToken))?.Value ?? string.Empty;
        var broadcast = manualTest
            ? await context.CollectSingleAsync(sourceKey ?? string.Empty, desktop, currentImage, roleId, cancellationToken)
            : await context.CollectDueAsync(desktop, currentImage, roleId, cancellationToken);
        if (broadcast.Candidates.Count == 0) return false;
        var eventType = manualTest ? SourceTestEventType : SourceDueEventType;
        var trigger = await triggers.EvaluateAsync(eventType, desktop, DateTimeOffset.Now, cancellationToken);
        if (!trigger.ShouldTrigger && eventType is SourceDueEventType or SourceTestEventType)
            trigger = new ProactiveTriggerMatch(
                true,
                string.Empty,
                string.Empty,
                true,
                "idle",
                "broadcast_candidates",
                manualTest ? 5 : 3);
        if (!trigger.ShouldTrigger) return false;
        var built = await actions.BuildActionsAsync(eventType, roleId, trigger, desktop, broadcast, manualTest, cancellationToken);
        if (built.Count == 0) return false;
        var message = built.Select(action => action.Payload.GetValueOrDefault("text"))
            .FirstOrDefault(text => !string.IsNullOrWhiteSpace(text)) ?? string.Empty;
        if (!manualTest && !string.IsNullOrWhiteSpace(message) &&
            await context.IsDuplicateBroadcastAsync(broadcast.SelectedSourceKeys, message, cancellationToken))
            return false;
        var eventId = EventIdentity.NewId();
        var payload = BuildPayload(broadcast, manualTest, sourceKey);
        var triggerLogId = await context.CreateTriggerLogAsync(
            eventId,
            eventType,
            SourceEventSource,
            roleId,
            character?.Name ?? string.Empty,
            character?.PreferredVoiceId ?? string.Empty,
            (await settings.GetAsync("ai_proactive_provider", cancellationToken))?.Value ?? string.Empty,
            desktop,
            broadcast,
            payload,
            trigger.Reason,
            cancellationToken);
        var executionId = EventIdentity.NewId();
        var execution = new PendingExecution(
            executionId,
            triggerLogId,
            trigger.RuleId,
            broadcast.SelectedSourceKeys,
            manualTest);
        if (!pending.TryAdd(executionId, execution))
            throw new InvalidOperationException("主动行为执行 ID 冲突。");
        await events.PublishAsync(new ProactiveExecutionRequestedEvent(
            eventId,
            DateTimeOffset.Now,
            executionId,
            triggerLogId,
            trigger.RuleId,
            manualTest,
            built), cancellationToken);
        return true;
    }

    private async Task<bool> IsEnabledAsync(CancellationToken cancellationToken)
    {
        var value = (await settings.GetAsync("ai_proactive_enabled", cancellationToken))?.Value;
        return !bool.TryParse(value, out var enabled) || enabled;
    }

    private static IReadOnlyDictionary<string, string> BuildPayload(
        ProactiveBroadcastContext context,
        bool manualTest,
        string? sourceKey)
        => new Dictionary<string, string>
        {
            ["broadcastCandidatesJson"] = JsonSerializer.Serialize(context.Candidates),
            ["broadcastSelectedSourceKeys"] = context.SelectedSourceKeys,
            ["broadcastCandidatesText"] = string.Join("\n", context.Candidates.Select(candidate =>
                $"- {candidate.DisplayName}(变化{candidate.ChangeScore}/综合{candidate.Score}): {candidate.Reason}；{candidate.Snapshot}")),
            ["broadcastRecentMessagesJson"] = JsonSerializer.Serialize(context.RecentMessages),
            ["manualTest"] = manualTest ? "true" : "false",
            ["testSourceKey"] = sourceKey ?? string.Empty
        };

    private static T Deserialize<T>(string json)
        => JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
           ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (loop is not null)
        {
            try { await loop; }
            catch (OperationCanceledException) { }
        }
        lifetime.Dispose();
    }

    private sealed record PendingExecution(
        string ExecutionId,
        string TriggerLogId,
        string RuleId,
        string SourceKeys,
        bool ManualTest);
    private sealed record MaidStateDocument(
        string MaidId,
        string Name,
        string Mood,
        int Favorability,
        int CompanionshipSeconds,
        int InteractionCount,
        bool IsCurrent,
        DateTimeOffset? LastInteractionTime,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);
}
