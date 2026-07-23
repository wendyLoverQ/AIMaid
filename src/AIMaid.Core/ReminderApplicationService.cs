using System.Text;
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
    ICommandHandler<ProcessDueRemindersCommand, OperationResult<IReadOnlyList<ReminderDto>>>
{
    private const string Domain = "reminder";
    private readonly IDomainDocumentStore store;
    private readonly IEventPublisher events;
    private readonly IAiProviderClient aiProvider;

    public ReminderApplicationService(IDomainDocumentStore store, IEventPublisher events, IAiProviderClient aiProvider)
    {
        this.store = store;
        this.events = events;
        this.aiProvider = aiProvider;
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
            var generated = reminder.AllowTts
                ? await GenerateReminderLineAsync(reminder, cancellationToken)
                : (reminder.Message, reminder.VoiceStyle);
            DateTimeOffset? next = reminder.Repeat == "daily"
                ? NormalizeNextDue((reminder.NextDueAt ?? reminder.DueAt).AddDays(1), "daily", command.Now)
                : null;
            var updated = reminder with { Enabled = next.HasValue, LastTriggeredAt = command.Now, NextDueAt = next, UpdatedAt = command.Now };
            await SaveAsync(updated, cancellationToken);
            var eventReminder = updated with { Message = generated.Item1, VoiceStyle = generated.Item2 };
            emitted.Add(eventReminder);
            await events.PublishAsync(new ReminderDueEvent(EventIdentity.NewId(), command.Now, eventReminder), cancellationToken);
        }
        return OperationResult<IReadOnlyList<ReminderDto>>.Success(emitted);
    }

    private async Task<(string Message, string VoiceStyle)> GenerateReminderLineAsync(
        ReminderDto reminder,
        CancellationToken cancellationToken)
    {
        var values = new Dictionary<string, string>
        {
            ["reminderId"] = reminder.ReminderId,
            ["reminderTitle"] = reminder.Title,
            ["reminderContent"] = reminder.Message,
            ["dueTime"] = (reminder.NextDueAt ?? reminder.DueAt).ToString("yyyy-MM-dd HH:mm:ss"),
            ["repeatRule"] = reminder.Repeat,
            ["urgency"] = "normal",
            ["userOriginalText"] = reminder.Message
        };
        var raw = new StringBuilder();
        await foreach (var delta in aiProvider.StreamChatAsync(new AiChatRequest(
                           $"reminder_line_{reminder.ReminderId}_{Guid.NewGuid():N}",
                           reminder.Message,
                           string.Empty,
                           string.Empty,
                           [],
                           SourceKey: "reminder_line_generation",
                           TemplateValues: values,
                           StreamResponse: false), cancellationToken))
            raw.Append(delta);
        using var document = JsonDocument.Parse(raw.ToString().Trim());
        if (document.RootElement.ValueKind != JsonValueKind.Object ||
            !document.RootElement.TryGetProperty("message", out var message) ||
            message.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(message.GetString()))
            throw new InvalidDataException("reminder_line_generation 返回内容缺少非空 message。");
        var voiceStyle = document.RootElement.TryGetProperty("voiceStyle", out var style) &&
                         style.ValueKind == JsonValueKind.String
            ? style.GetString()?.Trim() ?? string.Empty
            : string.Empty;
        return (message.GetString()!.Trim(), voiceStyle);
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
}
