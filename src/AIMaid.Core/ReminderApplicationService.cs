using System.Collections.Concurrent;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class ReminderApplicationService :
    IQueryHandler<ListRemindersQuery, IReadOnlyList<ReminderDto>>,
    ICommandHandler<SaveReminderCommand, OperationResult<ReminderDto>>,
    ICommandHandler<SetReminderEnabledCommand, OperationResult<ReminderDto>>,
    ICommandHandler<SetReminderAllowTtsCommand, OperationResult<ReminderDto>>,
    ICommandHandler<DeleteReminderCommand, OperationResult>,
    ICommandHandler<ProcessDueRemindersCommand, OperationResult<IReadOnlyList<ReminderDto>>>,
    ICommandHandler<CompleteReminderDeliveryCommand, OperationResult>
{
    private const string Domain = "reminder";
    private const string HistoryDomain = "reminder_history";
    private readonly IDomainDocumentStore store;
    private readonly IEventPublisher events;
    private readonly ReminderVoiceCacheService voiceCache;
    private readonly ConcurrentDictionary<string, PendingDelivery> pending = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim historyGate = new(1, 1);

    public ReminderApplicationService(
        IDomainDocumentStore store,
        IEventPublisher events,
        ReminderVoiceCacheService voiceCache)
    {
        this.store = store;
        this.events = events;
        this.voiceCache = voiceCache;
    }

    public async Task<IReadOnlyList<ReminderDto>> HandleAsync(ListRemindersQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync(cancellationToken))
            .Where(item => !query.EnabledOnly || item.Enabled)
            .OrderByDescending(item => item.Enabled)
            .ThenBy(item => item.NextDueAt ?? item.DueAt)
            .ToArray();

    public async Task<OperationResult<ReminderDto>> HandleAsync(SaveReminderCommand command, CancellationToken cancellationToken = default)
    {
        var now = DateTimeOffset.Now;
        var existing = string.IsNullOrWhiteSpace(command.ReminderId) ? null : await GetAsync(command.ReminderId, cancellationToken);
        if (!string.IsNullOrWhiteSpace(command.ReminderId) && existing is null)
            return OperationResult<ReminderDto>.Failure("reminder.not_found", "提醒不存在。");

        var title = string.IsNullOrWhiteSpace(command.Title) ? "提醒" : command.Title.Trim();
        var message = string.IsNullOrWhiteSpace(command.Message) ? title : command.Message.Trim();
        var repeat = NormalizeRepeat(command.Repeat);
        var enabled = command.Enabled;
        var reminder = new ReminderDto(
            existing?.ReminderId ?? CreateId(now), title, message, command.DueAt, repeat,
            enabled, command.AllowTts, existing?.LastTriggeredAt,
            enabled ? NormalizeNextDue(command.DueAt, repeat, now) : null,
            existing?.CreatedAt ?? now, now);
        await SaveAsync(reminder, cancellationToken);
        _ = voiceCache.PrepareAsync(reminder, CancellationToken.None);
        return OperationResult<ReminderDto>.Success(reminder);
    }

    public async Task<OperationResult<ReminderDto>> HandleAsync(SetReminderEnabledCommand command, CancellationToken cancellationToken = default)
    {
        var reminder = await GetAsync(command.ReminderId, cancellationToken);
        if (reminder is null) return OperationResult<ReminderDto>.Failure("reminder.not_found", "提醒不存在。");
        var now = DateTimeOffset.Now;
        var updated = reminder with {
            Enabled = command.Enabled,
            NextDueAt = command.Enabled ? NormalizeNextDue(reminder.NextDueAt ?? reminder.DueAt, reminder.Repeat, now) : null,
            UpdatedAt = now
        };
        await SaveAsync(updated, cancellationToken);
        return OperationResult<ReminderDto>.Success(updated);
    }

    public async Task<OperationResult<ReminderDto>> HandleAsync(SetReminderAllowTtsCommand command, CancellationToken cancellationToken = default)
    {
        var reminder = await GetAsync(command.ReminderId, cancellationToken);
        if (reminder is null) return OperationResult<ReminderDto>.Failure("reminder.not_found", "提醒不存在。");
        var updated = reminder with { AllowTts = command.AllowTts, UpdatedAt = DateTimeOffset.Now };
        await SaveAsync(updated, cancellationToken);
        return OperationResult<ReminderDto>.Success(updated);
    }

    public async Task<OperationResult> HandleAsync(DeleteReminderCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.ReminderId)) return OperationResult.Success();
        await store.DeleteAsync(Domain, command.ReminderId, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult<IReadOnlyList<ReminderDto>>> HandleAsync(ProcessDueRemindersCommand command, CancellationToken cancellationToken = default)
    {
        var requestedIds = command.ReminderIds is { Count: > 0 }
            ? command.ReminderIds.ToHashSet(StringComparer.Ordinal)
            : null;
        var due = (await HandleAsync(new ListRemindersQuery(true), cancellationToken))
            .Where(item => (item.NextDueAt ?? item.DueAt) <= command.Now &&
                (requestedIds is null || requestedIds.Contains(item.ReminderId))).Take(5).ToArray();
        var emitted = new List<ReminderDto>(due.Length);
        foreach (var reminder in due)
        {
            PendingDelivery delivery;
            if (!pending.TryGetValue(reminder.ReminderId, out delivery!))
            {
                var generated = await voiceCache.EnsureAsync(reminder, cancellationToken);
                var generatedReminder = reminder with
                {
                    Message = generated.Text,
                    VoiceStyle = generated.VoiceStyle,
                    AllowTts = reminder.AllowTts && generated.TtsAllowed
                };
                delivery = new PendingDelivery(
                    EventIdentity.NewId(),
                    generatedReminder,
                    generated.AudioPath,
                    command.Now);
                if (!pending.TryAdd(reminder.ReminderId, delivery))
                    delivery = pending[reminder.ReminderId];
            }
            var eventReminder = delivery.Reminder;
            emitted.Add(eventReminder);
            await events.PublishAsync(new ReminderDeliveryRequestedEvent(
                EventIdentity.NewId(),
                command.Now,
                delivery.DeliveryId,
                eventReminder,
                command.NotificationShown,
                delivery.CachedAudioPath), cancellationToken);
        }
        return OperationResult<IReadOnlyList<ReminderDto>>.Success(emitted);
    }

    public async Task<OperationResult> HandleAsync(
        CompleteReminderDeliveryCommand command,
        CancellationToken cancellationToken = default)
    {
        if (!pending.TryGetValue(command.ReminderId, out var delivery) ||
            !delivery.DeliveryId.Equals(command.DeliveryId, StringComparison.Ordinal))
            return OperationResult.Failure("reminder.delivery_not_found", "提醒交付不存在或已经完成。");
        var reminder = await GetAsync(command.ReminderId, cancellationToken);
        if (reminder is null)
            return OperationResult.Failure("reminder.not_found", "提醒不存在。");

        var completedAt = command.CompletedAt == default ? DateTimeOffset.Now : command.CompletedAt;
        DateTimeOffset? nextDueAt = reminder.Repeat.Equals("daily", StringComparison.OrdinalIgnoreCase)
            ? NormalizeNextDue((reminder.NextDueAt ?? reminder.DueAt).AddDays(1), "daily", completedAt)
            : null;
        var updated = reminder with
        {
            LastTriggeredAt = completedAt,
            NextDueAt = nextDueAt,
            Enabled = nextDueAt.HasValue,
            UpdatedAt = completedAt
        };
        await SaveAsync(updated, cancellationToken);
        var result = string.IsNullOrWhiteSpace(command.Error)
            ? command.Result
            : $"{command.Result}: {command.Error}";
        await AppendHistoryAsync(new ReminderHistoryDocument(
            string.Empty,
            reminder.ReminderId,
            completedAt,
            result,
            command.TtsPlayed), cancellationToken);
        pending.TryRemove(command.ReminderId, out _);
        await events.PublishAsync(new ReminderDeliveryCompletedEvent(
            EventIdentity.NewId(),
            completedAt,
            command.DeliveryId,
            command.ReminderId,
            command.NotificationShown,
            command.BubbleShown,
            command.TtsRequested,
            command.TtsPlayed,
            command.Result,
            command.Error), cancellationToken);
        return OperationResult.Success();
    }

    private async Task<IReadOnlyList<ReminderDto>> ListAsync(CancellationToken cancellationToken)
        => (await store.ListAsync(Domain, cancellationToken)).Select(Deserialize).ToArray();
    private async Task<ReminderDto?> GetAsync(string id, CancellationToken cancellationToken)
    {
        var json = await store.GetAsync(Domain, id, cancellationToken);
        return json is null ? null : Deserialize(json);
    }
    private Task SaveAsync(ReminderDto reminder, CancellationToken cancellationToken)
        => store.UpsertAsync(Domain, reminder.ReminderId, JsonSerializer.Serialize(reminder), reminder.UpdatedAt, cancellationToken);
    private async Task AppendHistoryAsync(ReminderHistoryDocument history, CancellationToken cancellationToken)
    {
        await historyGate.WaitAsync(cancellationToken);
        try
        {
            var ids = await store.ListIdsAsync(HistoryDomain, cancellationToken);
            var next = ids.Select(id =>
                    long.TryParse(id["legacy_reminder_log_".Length..], out var value) ? value : 0)
                .DefaultIfEmpty()
                .Max() + 1;
            var historyId = $"legacy_reminder_log_{next}";
            await store.UpsertAsync(
                HistoryDomain,
                historyId,
                JsonSerializer.Serialize(history with { HistoryId = historyId }),
                history.TriggeredAt,
                cancellationToken);
        }
        finally
        {
            historyGate.Release();
        }
    }
    private static ReminderDto Deserialize(string json)
        => JsonSerializer.Deserialize<ReminderDto>(json) ?? throw new InvalidDataException("ReminderDto JSON 无效。");
    private static string NormalizeRepeat(string? value)
        => value?.Trim().ToLowerInvariant() is "daily" or "每天" ? "daily" : "none";
    private static DateTimeOffset NormalizeNextDue(DateTimeOffset dueAt, string repeat, DateTimeOffset now)
    {
        if (dueAt > now || repeat == "none") return dueAt;
        while (dueAt <= now) dueAt = dueAt.AddDays(1);
        return dueAt;
    }
    private static string CreateId(DateTimeOffset now)
        => $"rem_{now:yyyyMMddHHmmss}_{Guid.NewGuid():N}"[..28];

    private sealed record PendingDelivery(
        string DeliveryId,
        ReminderDto Reminder,
        string CachedAudioPath,
        DateTimeOffset RequestedAt);
    private sealed record ReminderHistoryDocument(
        string HistoryId,
        string ReminderId,
        DateTimeOffset TriggeredAt,
        string Result,
        bool PlayedTts);
}
