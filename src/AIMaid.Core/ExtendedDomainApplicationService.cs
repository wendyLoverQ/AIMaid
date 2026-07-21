using System.Collections.Concurrent;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class ExtendedDomainApplicationService :
    ICommandHandler<SaveReminderCommand, OperationResult>, ICommandHandler<DeleteReminderCommand, OperationResult>,
    ICommandHandler<ProcessDueRemindersCommand, OperationResult<IReadOnlyList<ReminderDto>>>, IQueryHandler<ListRemindersQuery, IReadOnlyList<ReminderDto>>,
    ICommandHandler<SaveNotebookNoteCommand, OperationResult>, ICommandHandler<DeleteNotebookNoteCommand, OperationResult>, IQueryHandler<ListNotebookNotesQuery, IReadOnlyList<NotebookNoteDto>>,
    ICommandHandler<SaveVaultItemCommand, OperationResult>, ICommandHandler<DeleteVaultItemCommand, OperationResult>, IQueryHandler<GetVaultItemQuery, OperationResult<(VaultItemDto Item, string? Secret)>>, IQueryHandler<ListVaultItemsQuery, IReadOnlyList<VaultItemDto>>,
    ICommandHandler<RecordMarketEventCommand, OperationResult>, IQueryHandler<ListMarketEventsQuery, IReadOnlyList<MarketEventDto>>,
    ICommandHandler<SaveVideoItemCommand, OperationResult>, IQueryHandler<ListVideosQuery, IReadOnlyList<VideoItemDto>>,
    ICommandHandler<SaveRemoteSiteCommand, OperationResult>, IQueryHandler<ListRemoteSitesQuery, IReadOnlyList<RemoteSiteDto>>,
    ICommandHandler<ResolveRemoteMediaCommand, OperationResult<string>>
{
    private const string ReminderDomain = "reminder";
    private const string NotebookDomain = "notebook";
    private const string VaultDomain = "vault";
    private const string VaultSecretDomain = "vault_secret";
    private const string MarketDomain = "market_event";
    private const string VideoDomain = "video";
    private const string RemoteSiteDomain = "remote_site";
    private readonly IDomainDocumentStore store;
    private readonly ISecretProtector secrets;
    private readonly IRemoteMediaResolver mediaResolver;
    private readonly IEventPublisher events;

    public ExtendedDomainApplicationService(IDomainDocumentStore store, ISecretProtector secrets, IRemoteMediaResolver mediaResolver, IEventPublisher events)
    {
        this.store = store;
        this.secrets = secrets;
        this.mediaResolver = mediaResolver;
        this.events = events;
    }

    public Task<OperationResult> HandleAsync(SaveReminderCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(ReminderDomain, command.Reminder.ReminderId, command.Reminder, command.Reminder.UpdatedAt, cancellationToken);
    public Task<OperationResult> HandleAsync(DeleteReminderCommand command, CancellationToken cancellationToken = default)
        => DeleteAsync(ReminderDomain, command.ReminderId, cancellationToken);
    public async Task<IReadOnlyList<ReminderDto>> HandleAsync(ListRemindersQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<ReminderDto>(ReminderDomain, cancellationToken)).Where(x => !query.EnabledOnly || x.Enabled).OrderBy(x => x.DueAt).ToArray();
    public async Task<OperationResult<IReadOnlyList<ReminderDto>>> HandleAsync(ProcessDueRemindersCommand command, CancellationToken cancellationToken = default)
    {
        var due = (await HandleAsync(new ListRemindersQuery(true), cancellationToken))
            .Where(x => (x.NextDueAt ?? x.DueAt) <= command.Now).ToArray();
        foreach (var reminder in due)
        {
            var next = NextOccurrence(reminder.Repeat, command.Now);
            var updated = reminder with
            {
                Enabled = next.HasValue,
                LastTriggeredAt = command.Now,
                NextDueAt = next,
                UpdatedAt = command.Now
            };
            await store.UpsertAsync(ReminderDomain, reminder.ReminderId, JsonSerializer.Serialize(updated), command.Now, cancellationToken);
            await events.PublishAsync(new ReminderDueEvent(EventIdentity.NewId(), command.Now, updated), cancellationToken);
            // TODO(UI): Electron 根据提醒事件显示通知/弹窗并决定是否播放 TTS；核心不直接操作系统通知。
        }
        return OperationResult<IReadOnlyList<ReminderDto>>.Success(due);
    }

    public Task<OperationResult> HandleAsync(SaveNotebookNoteCommand command, CancellationToken cancellationToken = default)
    {
        if (command.Note.ContentMarkdown.Contains("<FlowDocument", StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(OperationResult.Failure("notebook.xaml_forbidden", "核心笔记不接受 XAML 内容。"));
        return SaveAsync(NotebookDomain, command.Note.NoteId, command.Note, command.Note.UpdatedAt, cancellationToken);
    }
    public Task<OperationResult> HandleAsync(DeleteNotebookNoteCommand command, CancellationToken cancellationToken = default)
        => DeleteAsync(NotebookDomain, command.NoteId, cancellationToken);
    public async Task<IReadOnlyList<NotebookNoteDto>> HandleAsync(ListNotebookNotesQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<NotebookNoteDto>(NotebookDomain, cancellationToken)).Where(x => query.IncludeDeleted || !x.IsDeleted).OrderByDescending(x => x.IsPinned).ThenByDescending(x => x.UpdatedAt).ToArray();

    public async Task<OperationResult> HandleAsync(SaveVaultItemCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Item.ItemId) || string.IsNullOrWhiteSpace(command.Item.Name))
            return OperationResult.Failure("vault.invalid", "保险库条目 ID 和名称不能为空。");
        if (command.PlainSecret is not null)
            await store.UpsertAsync(VaultSecretDomain, command.Item.ItemId, secrets.Protect(command.PlainSecret), DateTimeOffset.Now, cancellationToken);
        var item = command.Item with { HasProtectedSecret = command.PlainSecret is not null || command.Item.HasProtectedSecret, UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(VaultDomain, item.ItemId, JsonSerializer.Serialize(item), item.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<OperationResult> HandleAsync(DeleteVaultItemCommand command, CancellationToken cancellationToken = default)
    {
        // TODO(UI): 删除保险库条目前必须展示名称和类型，并进行二次确认。
        await store.DeleteAsync(VaultSecretDomain, command.ItemId, cancellationToken);
        await store.DeleteAsync(VaultDomain, command.ItemId, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<OperationResult<(VaultItemDto Item, string? Secret)>> HandleAsync(GetVaultItemQuery query, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(VaultDomain, query.ItemId, cancellationToken);
        if (json is null) return OperationResult<(VaultItemDto, string?)>.Failure("vault.not_found", "保险库条目不存在。");
        var item = Deserialize<VaultItemDto>(json);
        string? secret = null;
        if (query.IncludeSecret)
        {
            // TODO(UI): 查看明文秘密前要求重新验证用户身份；核心只响应已授权 Query。
            var protectedValue = await store.GetAsync(VaultSecretDomain, query.ItemId, cancellationToken);
            if (protectedValue is not null) secret = secrets.Unprotect(protectedValue);
        }
        return OperationResult<(VaultItemDto, string?)>.Success((item, secret));
    }
    public async Task<IReadOnlyList<VaultItemDto>> HandleAsync(ListVaultItemsQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<VaultItemDto>(VaultDomain, cancellationToken)).Where(x => query.ItemType is null || x.ItemType.Equals(query.ItemType, StringComparison.OrdinalIgnoreCase)).OrderBy(x => x.Name).ToArray();

    public Task<OperationResult> HandleAsync(RecordMarketEventCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(MarketDomain, string.IsNullOrWhiteSpace(command.MarketEvent.DedupeKey) ? command.MarketEvent.EventId : command.MarketEvent.DedupeKey,
            command.MarketEvent, command.MarketEvent.OccurredAt, cancellationToken);
    public async Task<IReadOnlyList<MarketEventDto>> HandleAsync(ListMarketEventsQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<MarketEventDto>(MarketDomain, cancellationToken)).Where(x => query.Symbol is null || x.Symbol.Equals(query.Symbol, StringComparison.OrdinalIgnoreCase)).OrderByDescending(x => x.OccurredAt).Take(Math.Clamp(query.Limit, 1, 1000)).ToArray();

    public Task<OperationResult> HandleAsync(SaveVideoItemCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(VideoDomain, command.Video.VideoId, command.Video, command.Video.UpdatedAt, cancellationToken);
    public async Task<IReadOnlyList<VideoItemDto>> HandleAsync(ListVideosQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(x => !query.FavoritesOnly || x.IsFavorite).OrderByDescending(x => x.UpdatedAt).ToArray();
    public Task<OperationResult> HandleAsync(SaveRemoteSiteCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(RemoteSiteDomain, command.Site.SiteId, command.Site, command.Site.UpdatedAt, cancellationToken);
    public async Task<IReadOnlyList<RemoteSiteDto>> HandleAsync(ListRemoteSitesQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<RemoteSiteDto>(RemoteSiteDomain, cancellationToken)).Where(x => !query.EnabledOnly || x.IsEnabled).OrderBy(x => x.SiteName).ToArray();
    public async Task<OperationResult<string>> HandleAsync(ResolveRemoteMediaCommand command, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(command.Url, UriKind.Absolute, out _)) return OperationResult<string>.Failure("remote_media.invalid_url", "媒体地址无效。");
        RemoteSiteDto? site = null;
        if (!string.IsNullOrWhiteSpace(command.SiteId))
        {
            var json = await store.GetAsync(RemoteSiteDomain, command.SiteId, cancellationToken);
            if (json is not null) site = Deserialize<RemoteSiteDto>(json);
        }
        // TODO(UI): 需要登录的站点由 Electron 展示认证流程；核心解析器不创建 WebView 登录窗口。
        return OperationResult<string>.Success(await mediaResolver.ResolveAsync(command.Url, site, cancellationToken));
    }

    private async Task<OperationResult> SaveAsync<T>(string domain, string id, T value, DateTimeOffset updatedAt, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(id)) return OperationResult.Failure($"{domain}.invalid_id", "业务 ID 不能为空。");
        await store.UpsertAsync(domain, id, JsonSerializer.Serialize(value), updatedAt, cancellationToken);
        return OperationResult.Success();
    }
    private async Task<OperationResult> DeleteAsync(string domain, string id, CancellationToken cancellationToken)
    {
        await store.DeleteAsync(domain, id, cancellationToken);
        return OperationResult.Success();
    }
    private async Task<IReadOnlyList<T>> ListAsync<T>(string domain, CancellationToken cancellationToken)
        => (await store.ListAsync(domain, cancellationToken)).Select(Deserialize<T>).ToArray();
    private static DateTimeOffset? NextOccurrence(string repeat, DateTimeOffset now) => repeat.Trim().ToLowerInvariant() switch
    {
        "hourly" => now.AddHours(1),
        "daily" => now.AddDays(1),
        "weekly" => now.AddDays(7),
        "none" or "" => null,
        _ => throw new InvalidDataException($"不支持的提醒重复规则：{repeat}")
    };
    private static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");
}

public sealed class AgentApplicationService :
    ICommandHandler<SaveAgentCapabilityCommand, OperationResult>,
    ICommandHandler<ExecuteAgentCapabilityCommand, OperationResult<AgentToolCallDto>>,
    IQueryHandler<ListAgentCapabilitiesQuery, IReadOnlyList<AgentCapabilityDto>>
{
    private const string CapabilityDomain = "agent_capability";
    private const string ToolCallDomain = "agent_tool_call";
    private readonly IDomainDocumentStore store;
    private readonly IReadOnlyDictionary<string, IAgentCapabilityExecutor> executors;
    private readonly IEventPublisher events;
    private readonly ConcurrentDictionary<string, (string Capability, string ArgsJson, DateTimeOffset ExpiresAt)> approvals = new();

    public AgentApplicationService(IDomainDocumentStore store, IEnumerable<IAgentCapabilityExecutor> executors, IEventPublisher events)
    {
        this.store = store;
        this.executors = executors.ToDictionary(x => x.ExecutorType, StringComparer.OrdinalIgnoreCase);
        this.events = events;
    }

    public async Task<OperationResult> HandleAsync(SaveAgentCapabilityCommand command, CancellationToken cancellationToken = default)
    {
        var item = command.Capability with { UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(CapabilityDomain, item.CapabilityName, JsonSerializer.Serialize(item), item.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<IReadOnlyList<AgentCapabilityDto>> HandleAsync(ListAgentCapabilitiesQuery query, CancellationToken cancellationToken = default)
        => (await store.ListAsync(CapabilityDomain, cancellationToken)).Select(Deserialize<AgentCapabilityDto>)
            .Where(x => !query.EnabledOnly || x.Enabled).OrderBy(x => x.SortOrder).ToArray();

    public async Task<OperationResult<AgentToolCallDto>> HandleAsync(ExecuteAgentCapabilityCommand command, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(CapabilityDomain, command.CapabilityName, cancellationToken);
        if (json is null) return OperationResult<AgentToolCallDto>.Failure("agent.capability_not_found", "Agent 能力不存在。");
        var capability = Deserialize<AgentCapabilityDto>(json);
        if (!capability.Enabled) return OperationResult<AgentToolCallDto>.Failure("agent.capability_disabled", "Agent 能力已停用。");
        var requiresApproval = capability.RequireConfirm ||
            capability.ExecutorType.Equals("external_program", StringComparison.OrdinalIgnoreCase) ||
            capability.RiskLevel.Equals("high", StringComparison.OrdinalIgnoreCase) ||
            capability.RiskLevel.Equals("critical", StringComparison.OrdinalIgnoreCase);
        if (requiresApproval && !ConsumeApproval(command, capability))
        {
            var token = Guid.NewGuid().ToString("N");
            approvals[token] = (capability.CapabilityName, command.ArgsJson, DateTimeOffset.Now.AddMinutes(2));
            // TODO(UI): 展示能力名称、风险级别和完整参数；用户确认后用同一命令携带 ApprovalToken 重试。
            await events.PublishAsync(new AgentApprovalRequestedEvent(EventIdentity.NewId(), DateTimeOffset.Now, token,
                capability.CapabilityName, capability.DisplayName, capability.RiskLevel, command.ArgsJson), cancellationToken);
            return OperationResult<AgentToolCallDto>.Failure("agent.approval_required", token);
        }
        if (!executors.TryGetValue(capability.ExecutorType, out var executor))
            return OperationResult<AgentToolCallDto>.Failure("agent.executor_missing", $"未注册执行器：{capability.ExecutorType}");

        var callId = $"tool_{Guid.NewGuid():N}";
        var created = DateTimeOffset.Now;
        AgentExecutionResult execution;
        try { execution = await executor.ExecuteAsync(capability, command.ArgsJson, cancellationToken); }
        catch (Exception ex) { execution = new(null, string.Empty, ex.Message); }
        var toolCall = new AgentToolCallDto(callId, command.ConversationId, capability.CapabilityName, command.ArgsJson,
            string.IsNullOrEmpty(execution.Error) ? "completed" : "failed", execution.ExitCode, execution.Output, execution.Error,
            requiresApproval, false, created, DateTimeOffset.Now);
        await store.UpsertAsync(ToolCallDomain, callId, JsonSerializer.Serialize(toolCall), DateTimeOffset.Now, cancellationToken);
        await events.PublishAsync(new AgentToolCallCompletedEvent(EventIdentity.NewId(), DateTimeOffset.Now, toolCall), cancellationToken);
        return OperationResult<AgentToolCallDto>.Success(toolCall);
    }

    private bool ConsumeApproval(ExecuteAgentCapabilityCommand command, AgentCapabilityDto capability)
    {
        if (string.IsNullOrWhiteSpace(command.ApprovalToken) || !approvals.TryRemove(command.ApprovalToken, out var approval)) return false;
        return approval.ExpiresAt >= DateTimeOffset.Now && approval.Capability == capability.CapabilityName && approval.ArgsJson == command.ArgsJson;
    }
    private static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");
}

public sealed class ProactiveApplicationService :
    ICommandHandler<SaveProactiveRuleCommand, OperationResult>,
    ICommandHandler<SaveDisturbanceSettingsCommand, OperationResult>,
    ICommandHandler<EvaluateProactiveEventCommand, OperationResult<ProactiveDecisionDto>>,
    IQueryHandler<ListProactiveRulesQuery, IReadOnlyList<ProactiveRuleDto>>,
    IQueryHandler<GetDisturbanceSettingsQuery, DisturbanceSettingsDto?>
{
    private const string RuleDomain = "proactive_rule";
    private const string SettingsDomain = "disturbance_settings";
    private const string StateDomain = "proactive_state";
    private readonly IDomainDocumentStore store;
    private readonly IEventPublisher events;
    public ProactiveApplicationService(IDomainDocumentStore store, IEventPublisher events) { this.store = store; this.events = events; }

    public async Task<OperationResult> HandleAsync(SaveProactiveRuleCommand command, CancellationToken cancellationToken = default)
    {
        var rule = command.Rule with { UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(RuleDomain, rule.RuleId, JsonSerializer.Serialize(rule), rule.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<OperationResult> HandleAsync(SaveDisturbanceSettingsCommand command, CancellationToken cancellationToken = default)
    {
        var settings = command.Settings with { UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(SettingsDomain, "current", JsonSerializer.Serialize(settings), settings.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<IReadOnlyList<ProactiveRuleDto>> HandleAsync(ListProactiveRulesQuery query, CancellationToken cancellationToken = default)
        => (await store.ListAsync(RuleDomain, cancellationToken)).Select(Deserialize<ProactiveRuleDto>).OrderByDescending(x => x.Priority).ToArray();
    public async Task<DisturbanceSettingsDto?> HandleAsync(GetDisturbanceSettingsQuery query, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(SettingsDomain, "current", cancellationToken);
        return json is null ? null : Deserialize<DisturbanceSettingsDto>(json);
    }
    public async Task<OperationResult<ProactiveDecisionDto>> HandleAsync(EvaluateProactiveEventCommand command, CancellationToken cancellationToken = default)
    {
        var settings = await HandleAsync(new GetDisturbanceSettingsQuery(), cancellationToken) ??
            new DisturbanceSettingsDto("normal", true, "01:00", "09:00", true, 3, DateTimeOffset.Now);
        if (settings.Mode.Equals("silent", StringComparison.OrdinalIgnoreCase)) return Decision(false, string.Empty, "disturbance_silent", 0, false, string.Empty);
        if (settings.SuppressWhenFullscreen && command.Context.IsFullscreen) return Decision(false, string.Empty, "fullscreen", 0, false, string.Empty);
        if (settings.QuietHoursEnabled && IsQuietHour(command.Context.Now, settings)) return Decision(false, string.Empty, "quiet_hours", 0, false, string.Empty);
        var hourlyState = await LoadHourlyStateAsync(command.Context.Now, cancellationToken);
        if (settings.MaxProactivePerHour >= 0 && hourlyState.Count >= settings.MaxProactivePerHour)
            return Decision(false, string.Empty, "hourly_limit", 0, false, string.Empty);
        var rules = (await HandleAsync(new ListProactiveRulesQuery(), cancellationToken))
            .Where(x => x.Enabled && x.EventType == command.Context.EventType && MatchesCondition(x.ConditionJson, command.Context.Values));
        foreach (var rule in rules)
        {
            var stateJson = await store.GetAsync(StateDomain, rule.RuleId, cancellationToken);
            var last = stateJson is null ? (DateTimeOffset?)null : JsonSerializer.Deserialize<DateTimeOffset?>(stateJson);
            if (last.HasValue && command.Context.Now - last.Value < TimeSpan.FromSeconds(rule.CooldownSeconds)) continue;
            await store.UpsertAsync(StateDomain, rule.RuleId, JsonSerializer.Serialize(command.Context.Now), command.Context.Now, cancellationToken);
            await store.UpsertAsync(StateDomain, "_hourly", JsonSerializer.Serialize(hourlyState with { Count = hourlyState.Count + 1 }), command.Context.Now, cancellationToken);
            var result = new ProactiveDecisionDto(true, rule.RuleId, "matched", rule.Priority, rule.AllowTts, rule.ActionTag);
            await events.PublishAsync(new ProactiveDecisionEvent(EventIdentity.NewId(), DateTimeOffset.Now, result), cancellationToken);
            return OperationResult<ProactiveDecisionDto>.Success(result);
        }
        return Decision(false, string.Empty, "no_rule", 0, false, string.Empty);
    }
    private static OperationResult<ProactiveDecisionDto> Decision(bool respond, string rule, string reason, int priority, bool tts, string action)
        => OperationResult<ProactiveDecisionDto>.Success(new(respond, rule, reason, priority, tts, action));
    private static bool IsQuietHour(DateTimeOffset now, DisturbanceSettingsDto settings)
    {
        if (!TimeOnly.TryParse(settings.QuietHoursStart, out var start) || !TimeOnly.TryParse(settings.QuietHoursEnd, out var end)) return false;
        var current = TimeOnly.FromDateTime(now.LocalDateTime);
        return start <= end ? current >= start && current < end : current >= start || current < end;
    }
    private async Task<HourlyState> LoadHourlyStateAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var json = await store.GetAsync(StateDomain, "_hourly", cancellationToken);
        var state = json is null ? null : JsonSerializer.Deserialize<HourlyState>(json);
        return state is null || now - state.WindowStart >= TimeSpan.FromHours(1) || now < state.WindowStart
            ? new HourlyState(now, 0)
            : state;
    }
    private static bool MatchesCondition(string conditionJson, IReadOnlyDictionary<string, string> values)
    {
        if (string.IsNullOrWhiteSpace(conditionJson) || conditionJson == "{}") return true;
        var expected = JsonSerializer.Deserialize<Dictionary<string, string>>(conditionJson)
            ?? throw new InvalidDataException("主动规则条件必须是字符串键值 JSON 对象。");
        return expected.All(pair => values.TryGetValue(pair.Key, out var actual) &&
            string.Equals(actual, pair.Value, StringComparison.OrdinalIgnoreCase));
    }
    private sealed record HourlyState(DateTimeOffset WindowStart, int Count);
    private static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");
}
