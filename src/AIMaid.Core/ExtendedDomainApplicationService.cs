using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Settings;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed class ExtendedDomainApplicationService :
    ICommandHandler<SaveNotebookNoteCommand, OperationResult>, ICommandHandler<DeleteNotebookNoteCommand, OperationResult>, IQueryHandler<ListNotebookNotesQuery, IReadOnlyList<NotebookNoteDto>>,
    ICommandHandler<SaveVoiceConversationCommand, OperationResult>, ICommandHandler<DeleteVoiceConversationCommand, OperationResult>, IQueryHandler<ListVoiceConversationsQuery, IReadOnlyList<VoiceConversationDto>>,
    ICommandHandler<SaveTimerRecordCommand, OperationResult>, ICommandHandler<DeleteTimerRecordCommand, OperationResult>, IQueryHandler<ListTimerRecordsQuery, IReadOnlyList<TimerRecordDto>>,
    ICommandHandler<SaveVaultItemCommand, OperationResult>, ICommandHandler<DeleteVaultItemCommand, OperationResult>, IQueryHandler<GetVaultItemQuery, OperationResult<VaultItemDetailDto>>, IQueryHandler<RevealVaultSecretQuery, OperationResult<VaultItemDetailDto>>, IQueryHandler<ListVaultItemsQuery, IReadOnlyList<VaultItemDto>>, IQueryHandler<ListVaultHistoriesQuery, IReadOnlyList<VaultHistoryDto>>, ICommandHandler<RestoreVaultHistoryCommand, OperationResult>,
    ICommandHandler<RecordMarketEventCommand, OperationResult>, IQueryHandler<ListMarketEventsQuery, IReadOnlyList<MarketEventDto>>,
    ICommandHandler<SaveRemoteSiteCommand, OperationResult>, ICommandHandler<DeleteRemoteSiteCommand, OperationResult>, IQueryHandler<GetRemoteSiteQuery, OperationResult<RemoteSiteDetailDto>>, IQueryHandler<ListRemoteSitesQuery, IReadOnlyList<RemoteSiteDto>>,
    ICommandHandler<SaveAppearanceConfigurationCommand, OperationResult>, IQueryHandler<GetAppearanceConfigurationQuery, AppearanceConfigurationDto>,
    IQueryHandler<ListModelConfigurationsQuery, IReadOnlyList<ModelConfigurationDto>>, ICommandHandler<SaveModelConfigurationsCommand, OperationResult>, ICommandHandler<AddModelConfigurationCommand, OperationResult>,
    IQueryHandler<ListLlmBusinessModelConfigsQuery, IReadOnlyList<LlmBusinessModelConfigDto>>, ICommandHandler<SaveLlmBusinessModelConfigsCommand, OperationResult>,
    IQueryHandler<ListLlmSourcePromptsQuery, IReadOnlyList<LlmSourcePromptDto>>, ICommandHandler<SaveLlmSourcePromptCommand, OperationResult>,
    ICommandHandler<ResolveRemoteMediaCommand, OperationResult<string>>
{
    private const string NotebookDomain = "notebook";
    private const string VoiceConversationDomain = "voice_conversation";
    private const string TimerRecordDomain = "timer_record";
    private const string VaultDomain = "vault";
    private const string VaultSecretDomain = "vault_secret";
    private const string VaultHistoryDomain = "vault_history";
    private const string VaultHistorySecretDomain = "vault_history_secret";
    private const string MarketDomain = "market_event";
    private const string RemoteSiteDomain = "remote_site";
    private const string RemoteSiteSecretDomain = "remote_site_secret";
    private const string AppearanceDomain = "appearance_configuration";
    private const string ModelConfigurationDomain = "model_configuration";
    private const string ModelConfigurationSecretDomain = "model_configuration_secret";
    private const string MaskedApiKey = "••••••••";
    private const string BusinessModelDomain = "llm_business_model";
    private const string SourcePromptDomain = "llm_source_prompt";
    private readonly IDomainDocumentStore store;
    private readonly ISecretProtector secrets;
    private readonly ISettingsStore settings;
    private readonly IRemoteMediaResolver mediaResolver;
    private readonly IEventPublisher events;

    public ExtendedDomainApplicationService(IDomainDocumentStore store, ISecretProtector secrets, ISettingsStore settings, IRemoteMediaResolver mediaResolver, IEventPublisher events)
    {
        this.store = store;
        this.secrets = secrets;
        this.settings = settings;
        this.mediaResolver = mediaResolver;
        this.events = events;
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

    public Task<OperationResult> HandleAsync(SaveVoiceConversationCommand command, CancellationToken cancellationToken = default)
    {
        var value = command.Conversation;
        if (string.IsNullOrWhiteSpace(value.ConversationId) || string.IsNullOrWhiteSpace(value.VoiceRoleId))
            return Task.FromResult(OperationResult.Failure("voice_conversation.invalid", "会话 ID 和角色不能为空。"));
        return SaveAsync(VoiceConversationDomain, value.ConversationId, value, value.UpdatedAt, cancellationToken);
    }
    public Task<OperationResult> HandleAsync(DeleteVoiceConversationCommand command, CancellationToken cancellationToken = default)
        => DeleteAsync(VoiceConversationDomain, command.ConversationId, cancellationToken);
    public async Task<IReadOnlyList<VoiceConversationDto>> HandleAsync(ListVoiceConversationsQuery query, CancellationToken cancellationToken = default)
    {
        var values = await ListAsync<VoiceConversationDto>(VoiceConversationDomain, cancellationToken);
        return values.Where(x => string.IsNullOrWhiteSpace(query.VoiceRoleId) || x.VoiceRoleId.Equals(query.VoiceRoleId, StringComparison.OrdinalIgnoreCase))
            .Where(x => string.IsNullOrWhiteSpace(query.Search) || x.Title.Contains(query.Search, StringComparison.OrdinalIgnoreCase) || x.Preview.Contains(query.Search, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(x => x.UpdatedAt).ToArray();
    }

    public Task<OperationResult> HandleAsync(SaveTimerRecordCommand command, CancellationToken cancellationToken = default)
        => command.Record.DurationSeconds < 0
            ? Task.FromResult(OperationResult.Failure("timer.invalid_duration", "计时时长不能为负数。"))
            : SaveAsync(TimerRecordDomain, command.Record.RecordId, command.Record, command.Record.SavedAt, cancellationToken);
    public Task<OperationResult> HandleAsync(DeleteTimerRecordCommand command, CancellationToken cancellationToken = default)
        => DeleteAsync(TimerRecordDomain, command.RecordId, cancellationToken);
    public async Task<IReadOnlyList<TimerRecordDto>> HandleAsync(ListTimerRecordsQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<TimerRecordDto>(TimerRecordDomain, cancellationToken)).OrderByDescending(x => x.SavedAt).ToArray();

    public async Task<AppearanceConfigurationDto> HandleAsync(GetAppearanceConfigurationQuery query, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(AppearanceDomain, "current", cancellationToken);
        return json is null ? DefaultAppearance() : Deserialize<AppearanceConfigurationDto>(json);
    }

    public Task<OperationResult> HandleAsync(SaveAppearanceConfigurationCommand command, CancellationToken cancellationToken = default)
    {
        var value = command.Configuration;
        string[] brightness = ["Soft", "Standard", "Clear"];
        string[] radius = ["Small", "Medium", "Large"];
        string[] density = ["Compact", "Standard", "Comfortable"];
        string[] header = ["None", "Subtle", "AccentStrip", "Filled"];
        if (string.IsNullOrWhiteSpace(value.ThemeId) || value.ThemeId.Length > 80 ||
            !brightness.Contains(value.ContentBrightness, StringComparer.OrdinalIgnoreCase) ||
            !radius.Contains(value.CornerRadiusStyle, StringComparer.OrdinalIgnoreCase) ||
            !density.Contains(value.Density, StringComparer.OrdinalIgnoreCase) ||
            !header.Contains(value.HeaderStyle, StringComparer.OrdinalIgnoreCase) ||
            value.FontScale is < 0.9 or > 1.2 || value.FontFamily is not ("" or "Microsoft YaHei UI"))
            return Task.FromResult(OperationResult.Failure("appearance.invalid", "外观设置字段无效。"));
        return SaveAsync(AppearanceDomain, "current", value, DateTimeOffset.Now, cancellationToken);
    }

    private static AppearanceConfigurationDto DefaultAppearance() =>
        new("neutral_soft", "Standard", "", 1.0, "Medium", "Standard", "Subtle", true);

    public async Task<IReadOnlyList<ModelConfigurationDto>> HandleAsync(ListModelConfigurationsQuery query, CancellationToken cancellationToken = default)
    {
        var values = DefaultModelConfigurations().ToDictionary(item => item.ModelKey, StringComparer.OrdinalIgnoreCase);
        var settingValues = await settings.GetManyAsync(null, cancellationToken);
        const string prefix = "user_config:App:Model:";
        foreach (var group in settingValues.Where(item => item.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                     .GroupBy(item => item.Key[prefix.Length..].Split(':', 2)[0], StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(group.Key)) continue;
            var fields = group.Where(item => item.Key[prefix.Length..].Contains(':'))
                .ToDictionary(item => item.Key[(prefix.Length + group.Key.Length + 1)..], item => item.Value, StringComparer.OrdinalIgnoreCase);
            values.TryGetValue(group.Key, out var current);
            var type = fields.GetValueOrDefault("Type") ?? current?.Type ?? "local";
            values[group.Key] = new ModelConfigurationDto(group.Key, type,
                fields.GetValueOrDefault("Endpoint") ?? current?.Endpoint ?? string.Empty,
                fields.GetValueOrDefault("Model") ?? current?.Model ?? group.Key,
                fields.GetValueOrDefault("ApiKey") ?? current?.ApiKey ?? string.Empty,
                ParseBoolean(fields.GetValueOrDefault("EnableWebSearch"), current?.EnableWebSearch ?? type.Equals("api", StringComparison.OrdinalIgnoreCase)),
                ParseBoolean(fields.GetValueOrDefault("Think"), current?.Think ?? false));
        }
        foreach (var saved in await ListAsync<ModelConfigurationDto>(ModelConfigurationDomain, cancellationToken)) values[saved.ModelKey] = saved;
        foreach (var key in values.Keys.ToArray())
        {
            var protectedApiKey = await store.GetAsync(ModelConfigurationSecretDomain, key, cancellationToken);
            var hasApiKey = protectedApiKey is not null || !string.IsNullOrEmpty(values[key].ApiKey);
            values[key] = values[key] with
            {
                ApiKey = query.IncludeSecrets
                    ? protectedApiKey is null ? values[key].ApiKey : secrets.Unprotect(protectedApiKey)
                    : hasApiKey ? MaskedApiKey : string.Empty
            };
        }
        return values.Values.OrderBy(item => item.ModelKey, StringComparer.CurrentCultureIgnoreCase).ToArray();
    }

    public async Task<OperationResult> HandleAsync(SaveModelConfigurationsCommand command, CancellationToken cancellationToken = default)
    {
        if (command.Configurations.Count == 0) return OperationResult.Failure("model.empty", "至少需要一项模型配置。");
        foreach (var configuration in command.Configurations)
        {
            var validation = ValidateModelConfiguration(configuration);
            if (validation is not null) return validation;
            var now = DateTimeOffset.Now;
            await store.UpsertAsync(ModelConfigurationDomain, configuration.ModelKey,
                JsonSerializer.Serialize(configuration with { ApiKey = string.Empty }), now, cancellationToken);
            if (configuration.Type.Equals("api", StringComparison.OrdinalIgnoreCase))
            {
                if (configuration.ApiKey == MaskedApiKey)
                {
                    // The renderer only receives this sentinel. Round-tripping it preserves the existing secret.
                }
                else if (configuration.ApiKey.Length == 0)
                    await store.DeleteAsync(ModelConfigurationSecretDomain, configuration.ModelKey, cancellationToken);
                else
                    await store.UpsertAsync(ModelConfigurationSecretDomain, configuration.ModelKey, secrets.Protect(configuration.ApiKey), now, cancellationToken);
            }
            else
                await store.DeleteAsync(ModelConfigurationSecretDomain, configuration.ModelKey, cancellationToken);
        }
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(AddModelConfigurationCommand command, CancellationToken cancellationToken = default)
    {
        var key = command.ModelKey.Trim();
        if (key.Length == 0 || key.Any(character => !(char.IsLetterOrDigit(character) || character is '-' or '_' or '.')))
            return OperationResult.Failure("model.invalid_key", "模型标识只能包含字母、数字、短横线、下划线和点。");
        if ((await HandleAsync(new ListModelConfigurationsQuery(), cancellationToken)).Any(item => item.ModelKey.Equals(key, StringComparison.OrdinalIgnoreCase)))
            return OperationResult.Failure("model.exists", $"模型配置“{key}”已经存在。");
        var type = command.Type.Equals("api", StringComparison.OrdinalIgnoreCase) ? "api" : "local";
        return await HandleAsync(new SaveModelConfigurationsCommand([new ModelConfigurationDto(key, type, string.Empty, key, string.Empty, type == "api", false)]), cancellationToken);
    }

    public async Task<IReadOnlyList<LlmBusinessModelConfigDto>> HandleAsync(ListLlmBusinessModelConfigsQuery query, CancellationToken cancellationToken = default)
    {
        var values = await ListAsync<LlmBusinessModelConfigDto>(BusinessModelDomain, cancellationToken);
        if (values.Count == 0)
        {
            values = DefaultBusinessModels();
            foreach (var value in values) await store.UpsertAsync(BusinessModelDomain, value.BusinessKey, JsonSerializer.Serialize(value), value.UpdatedAt, cancellationToken);
        }
        return values.Where(item => item.IsEnabled).OrderBy(item => item.CreatedAt).ToArray();
    }

    public async Task<OperationResult> HandleAsync(SaveLlmBusinessModelConfigsCommand command, CancellationToken cancellationToken = default)
    {
        var modelKeys = (await HandleAsync(new ListModelConfigurationsQuery(), cancellationToken)).Select(item => item.ModelKey).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var configuration in command.Configurations)
        {
            if (string.IsNullOrWhiteSpace(configuration.BusinessKey) || !modelKeys.Contains(configuration.ModelKey))
                return OperationResult.Failure("business_model.invalid", $"{configuration.DisplayName} 尚未选择有效模型。");
            var provider = configuration.ModelKey.Equals("Gemini", StringComparison.OrdinalIgnoreCase) ? "Gemini" : "Local";
            var value = configuration with { Provider = provider, UpdatedAt = DateTimeOffset.Now };
            await store.UpsertAsync(BusinessModelDomain, value.BusinessKey, JsonSerializer.Serialize(value), value.UpdatedAt, cancellationToken);
        }
        return OperationResult.Success();
    }

    public async Task<IReadOnlyList<LlmSourcePromptDto>> HandleAsync(ListLlmSourcePromptsQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<LlmSourcePromptDto>(SourcePromptDomain, cancellationToken)).Where(item => item.IsEnabled).OrderBy(item => item.SourceKey).ToArray();

    public Task<OperationResult> HandleAsync(SaveLlmSourcePromptCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Prompt.SourceKey)) return Task.FromResult(OperationResult.Failure("source_prompt.invalid", "Source Key 不能为空。"));
        if (!string.IsNullOrWhiteSpace(command.Prompt.OutputSchemaJson))
        {
            try { using var _ = JsonDocument.Parse(command.Prompt.OutputSchemaJson); }
            catch (JsonException) { return Task.FromResult(OperationResult.Failure("source_prompt.invalid_schema", "输出结构 JSON 无效。")); }
        }
        var value = command.Prompt with { UpdatedAt = DateTimeOffset.Now };
        return SaveAsync(SourcePromptDomain, value.SourceKey, value, value.UpdatedAt, cancellationToken);
    }

    private static OperationResult? ValidateModelConfiguration(ModelConfigurationDto value)
    {
        if (string.IsNullOrWhiteSpace(value.ModelKey) || string.IsNullOrWhiteSpace(value.Model)) return OperationResult.Failure("model.invalid", "模型标识和模型名称不能为空。");
        if (value.Type is not ("local" or "api")) return OperationResult.Failure("model.invalid_type", "模型类型只能是 local 或 api。");
        if (!string.IsNullOrWhiteSpace(value.Endpoint) && (!Uri.TryCreate(value.Endpoint, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)))
            return OperationResult.Failure("model.invalid_endpoint", $"模型“{value.ModelKey}”的服务地址无效。");
        return null;
    }

    private static bool ParseBoolean(string? value, bool fallback) => bool.TryParse(value, out var parsed) ? parsed : fallback;
    private static IReadOnlyList<ModelConfigurationDto> DefaultModelConfigurations() =>
    [
        new("qwen3-14b", "local", "http://localhost:11434", "qwen3-14b-uncensored-q4", "", false, false),
        new("qwen25-14b", "local", "http://localhost:11434", "qwen25-14b-abliterated-q4", "", false, false),
        new("qwen3-30b", "local", "http://localhost:11434", "qwen3-30b-a3b-abliterated-iq3m", "", false, false),
        new("OpenAI", "api", "", "gpt-4.1", "", true, false),
        new("Gemini", "api", "", "gemini-3.1-flash-lite", "", false, false)
    ];
    private static IReadOnlyList<LlmBusinessModelConfigDto> DefaultBusinessModels()
    {
        var now = DateTimeOffset.Now;
        return
        [
            new("chat_reply", "聊天回复", "用户实时聊天的完整业务链条", "Gemini", "Gemini", true, now, now),
            new("proactive_decision", "主动 AI 决策", "桌面事件分析与主动回复决策链条", "Gemini", "Gemini", true, now, now),
            new("reminder_speech", "提醒文案", "提醒事项到点后的播报文案链条", "Gemini", "Gemini", true, now, now),
            new("agent_planning", "Agent 决策", "Agent 能力规划与动作选择链条", "Gemini", "Gemini", true, now, now),
            new("lazy_voice_cache", "缓存语音文案", "固定触发语音缓存批量生成链条", "Gemini", "Gemini", true, now, now),
            new("character_card_expansion", "角色卡生成与迭代", "从原角色卡生成或基于当前角色卡继续迭代的业务链条", "Gemini", "Gemini", true, now, now)
        ];
    }

    public async Task<OperationResult> HandleAsync(SaveVaultItemCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Item.ItemId) || string.IsNullOrWhiteSpace(command.Item.Name))
            return OperationResult.Failure("vault.invalid", "保险库条目 ID 和名称不能为空。");
        if (command.PlainSecret is not null)
        {
            var previousProtected = await store.GetAsync(VaultSecretDomain, command.Item.ItemId, cancellationToken);
            if (previousProtected is not null)
                await SaveVaultHistoryAsync(command.Item.ItemId, secrets.Unprotect(previousProtected), command.PlainSecret, command.ChangeRemark, cancellationToken);
            await store.UpsertAsync(VaultSecretDomain, command.Item.ItemId, secrets.Protect(command.PlainSecret), DateTimeOffset.Now, cancellationToken);
        }
        var item = command.Item with { HasProtectedSecret = command.PlainSecret is not null || command.Item.HasProtectedSecret, UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(VaultDomain, item.ItemId, JsonSerializer.Serialize(item), item.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<OperationResult> HandleAsync(DeleteVaultItemCommand command, CancellationToken cancellationToken = default)
    {
        // TODO(UI): 删除保险库条目前必须展示名称和类型，并进行二次确认。
        await store.DeleteAsync(VaultSecretDomain, command.ItemId, cancellationToken);
        await store.DeleteAsync(VaultDomain, command.ItemId, cancellationToken);
        foreach (var history in await LoadVaultHistoryMetadataAsync(cancellationToken))
        {
            if (!history.ItemId.Equals(command.ItemId, StringComparison.Ordinal)) continue;
            await store.DeleteAsync(VaultHistorySecretDomain, history.HistoryId, cancellationToken);
            await store.DeleteAsync(VaultHistoryDomain, history.HistoryId, cancellationToken);
        }
        return OperationResult.Success();
    }
    public async Task<OperationResult<VaultItemDetailDto>> HandleAsync(GetVaultItemQuery query, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(VaultDomain, query.ItemId, cancellationToken);
        if (json is null) return OperationResult<VaultItemDetailDto>.Failure("vault.not_found", "保险库条目不存在。");
        var item = Deserialize<VaultItemDto>(json);
        return OperationResult<VaultItemDetailDto>.Success(new VaultItemDetailDto(item, null));
    }

    public async Task<OperationResult<VaultItemDetailDto>> HandleAsync(RevealVaultSecretQuery query, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(VaultDomain, query.ItemId, cancellationToken);
        if (json is null) return OperationResult<VaultItemDetailDto>.Failure("vault.not_found", "保险库条目不存在。");
        var item = Deserialize<VaultItemDto>(json);
        var protectedValue = await store.GetAsync(VaultSecretDomain, query.ItemId, cancellationToken);
        var secret = protectedValue is null ? null : secrets.Unprotect(protectedValue);
        return OperationResult<VaultItemDetailDto>.Success(new VaultItemDetailDto(item, secret));
    }
    public async Task<IReadOnlyList<VaultItemDto>> HandleAsync(ListVaultItemsQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<VaultItemDto>(VaultDomain, cancellationToken)).Where(x => query.ItemType is null || x.ItemType.Equals(query.ItemType, StringComparison.OrdinalIgnoreCase)).OrderBy(x => x.Name).ToArray();

    public async Task<IReadOnlyList<VaultHistoryDto>> HandleAsync(ListVaultHistoriesQuery query, CancellationToken cancellationToken = default)
    {
        var result = new List<VaultHistoryDto>();
        foreach (var metadata in await LoadVaultHistoryMetadataAsync(cancellationToken))
        {
            if (!metadata.ItemId.Equals(query.ItemId, StringComparison.Ordinal)) continue;
            result.Add(new VaultHistoryDto(metadata.HistoryId, metadata.ItemId, metadata.FieldName,
                metadata.ChangeRemark, metadata.CreatedAt));
        }
        return result.OrderByDescending(item => item.CreatedAt).ToArray();
    }

    public async Task<OperationResult> HandleAsync(RestoreVaultHistoryCommand command, CancellationToken cancellationToken = default)
    {
        var metadataJson = await store.GetAsync(VaultHistoryDomain, command.HistoryId, cancellationToken);
        var protectedHistory = await store.GetAsync(VaultHistorySecretDomain, command.HistoryId, cancellationToken);
        if (metadataJson is null || protectedHistory is null)
            return OperationResult.Failure("vault.history_not_found", "保险库历史记录不存在。");
        var metadata = Deserialize<VaultHistoryMetadata>(metadataJson);
        var itemJson = await store.GetAsync(VaultDomain, metadata.ItemId, cancellationToken);
        var protectedCurrent = await store.GetAsync(VaultSecretDomain, metadata.ItemId, cancellationToken);
        if (itemJson is null || protectedCurrent is null)
            return OperationResult.Failure("vault.not_found", "保险库条目不存在。");
        var historyValues = ParseSecretRecord(secrets.Unprotect(protectedHistory));
        var currentValues = ParseSecretRecord(secrets.Unprotect(protectedCurrent));
        currentValues[metadata.FieldName] = historyValues.GetValueOrDefault("OldValue") ?? string.Empty;
        var item = Deserialize<VaultItemDto>(itemJson);
        return await HandleAsync(new SaveVaultItemCommand(item, JsonSerializer.Serialize(currentValues), "Restore from history"), cancellationToken);
    }

    private async Task SaveVaultHistoryAsync(string itemId, string oldSecret, string newSecret, string? remark, CancellationToken cancellationToken)
    {
        var oldValues = ParseSecretRecord(oldSecret);
        var newValues = ParseSecretRecord(newSecret);
        foreach (var field in new[] { "Password", "ApiKey", "Secret", "PrivateKey", "Mnemonic" })
        {
            var oldValue = oldValues.GetValueOrDefault(field) ?? string.Empty;
            var newValue = newValues.GetValueOrDefault(field) ?? string.Empty;
            if (string.Equals(oldValue, newValue, StringComparison.Ordinal)) continue;
            var historyId = $"vault_history_{Guid.NewGuid():N}";
            var now = DateTimeOffset.Now;
            var metadata = new VaultHistoryMetadata(historyId, itemId, field, remark ?? string.Empty, now);
            var historySecret = JsonSerializer.Serialize(new Dictionary<string, string> { ["OldValue"] = oldValue, ["NewValue"] = newValue });
            await store.UpsertAsync(VaultHistoryDomain, historyId, JsonSerializer.Serialize(metadata), now, cancellationToken);
            await store.UpsertAsync(VaultHistorySecretDomain, historyId, secrets.Protect(historySecret), now, cancellationToken);
        }
    }

    private async Task<IReadOnlyList<VaultHistoryMetadata>> LoadVaultHistoryMetadataAsync(CancellationToken cancellationToken)
        => (await store.ListAsync(VaultHistoryDomain, cancellationToken)).Select(Deserialize<VaultHistoryMetadata>).ToArray();

    private static Dictionary<string, string> ParseSecretRecord(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new Dictionary<string, string>(StringComparer.Ordinal);
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("保险库秘密字段 JSON 无效。");
        return document.RootElement.EnumerateObject().ToDictionary(
            property => property.Name,
            property => property.Value.ValueKind == JsonValueKind.String ? property.Value.GetString() ?? string.Empty : string.Empty,
            StringComparer.Ordinal);
    }

    private sealed record VaultHistoryMetadata(string HistoryId, string ItemId, string FieldName, string ChangeRemark, DateTimeOffset CreatedAt);

    public Task<OperationResult> HandleAsync(RecordMarketEventCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(MarketDomain, string.IsNullOrWhiteSpace(command.MarketEvent.DedupeKey) ? command.MarketEvent.EventId : command.MarketEvent.DedupeKey,
            command.MarketEvent, command.MarketEvent.OccurredAt, cancellationToken);
    public async Task<IReadOnlyList<MarketEventDto>> HandleAsync(ListMarketEventsQuery query, CancellationToken cancellationToken = default)
        => (await ListAsync<MarketEventDto>(MarketDomain, cancellationToken)).Where(x => query.Symbol is null || x.Symbol.Equals(query.Symbol, StringComparison.OrdinalIgnoreCase)).OrderByDescending(x => x.OccurredAt).Take(Math.Clamp(query.Limit, 1, 1000)).ToArray();

    public async Task<OperationResult> HandleAsync(SaveRemoteSiteCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Site.SiteId) || string.IsNullOrWhiteSpace(command.Site.SiteName) || string.IsNullOrWhiteSpace(command.Site.DomainPattern))
            return OperationResult.Failure("remote_site.invalid", "站点名称和域名匹配不能为空。");
        bool hasProtectedCookie;
        if (command.PlainCookie is null)
        {
            hasProtectedCookie = await store.GetAsync(RemoteSiteSecretDomain, command.Site.SiteId, cancellationToken) is not null;
        }
        else if (command.PlainCookie.Length == 0)
        {
            await store.DeleteAsync(RemoteSiteSecretDomain, command.Site.SiteId, cancellationToken);
            hasProtectedCookie = false;
        }
        else
        {
            await store.UpsertAsync(RemoteSiteSecretDomain, command.Site.SiteId, secrets.Protect(command.PlainCookie), DateTimeOffset.Now, cancellationToken);
            hasProtectedCookie = true;
        }
        var site = command.Site with { HasProtectedCookie = hasProtectedCookie, UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(RemoteSiteDomain, site.SiteId, JsonSerializer.Serialize(site), site.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<OperationResult<RemoteSiteDetailDto>> HandleAsync(GetRemoteSiteQuery query, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(RemoteSiteDomain, query.SiteId, cancellationToken);
        if (json is null) return OperationResult<RemoteSiteDetailDto>.Failure("remote_site.not_found", "站点配置不存在。");
        var site = Deserialize<RemoteSiteDto>(json);
        return OperationResult<RemoteSiteDetailDto>.Success(new RemoteSiteDetailDto(site));
    }
    public async Task<OperationResult> HandleAsync(DeleteRemoteSiteCommand command, CancellationToken cancellationToken = default)
    {
        await store.DeleteAsync(RemoteSiteSecretDomain, command.SiteId, cancellationToken);
        await store.DeleteAsync(RemoteSiteDomain, command.SiteId, cancellationToken);
        return OperationResult.Success();
    }
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
    private static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");
}

public sealed class AgentApplicationService :
    ICommandHandler<SaveAgentCapabilityCommand, OperationResult>,
    ICommandHandler<ExecuteAgentCapabilityCommand, OperationResult<AgentToolCallDto>>,
    ICommandHandler<DecideAgentInputCommand, OperationResult<AgentDecisionDto>>,
    IQueryHandler<ListAgentCapabilitiesQuery, IReadOnlyList<AgentCapabilityDto>>
{
    private const string CapabilityDomain = "agent_capability";
    private const string ToolCallDomain = "agent_tool_call";
    private static long nextToolCallId = DateTimeOffset.UtcNow.Ticks;
    private readonly IDomainDocumentStore store;
    private readonly IReadOnlyDictionary<string, IAgentCapabilityExecutor> executors;
    private readonly IEventPublisher events;
    private readonly IAiProviderClient aiProvider;
    private readonly IChatStore chatStore;
    private readonly ISettingsStore settings;
    private readonly ICharacterStore characters;
    private readonly ConcurrentDictionary<string, (string Capability, string ArgsJson, DateTimeOffset ExpiresAt)> approvals = new();

    public AgentApplicationService(IDomainDocumentStore store, IEnumerable<IAgentCapabilityExecutor> executors, IEventPublisher events,
        IAiProviderClient aiProvider, IChatStore chatStore, ISettingsStore settings, ICharacterStore characters)
    {
        this.store = store;
        this.executors = executors.ToDictionary(x => x.ExecutorType, StringComparer.OrdinalIgnoreCase);
        this.events = events;
        this.aiProvider = aiProvider;
        this.chatStore = chatStore;
        this.settings = settings;
        this.characters = characters;
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
                capability.CapabilityName, capability.DisplayName, capability.RiskLevel, command.ArgsJson,
                capability.Description, capability.ExecutorType), cancellationToken);
            return OperationResult<AgentToolCallDto>.Failure("agent.approval_required", token);
        }
        if (!executors.TryGetValue(capability.ExecutorType, out var executor))
            return OperationResult<AgentToolCallDto>.Failure("agent.executor_missing", $"未注册执行器：{capability.ExecutorType}");

        var callId = $"legacy_tool_{Interlocked.Increment(ref nextToolCallId)}";
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

    public async Task<OperationResult<AgentDecisionDto>> HandleAsync(DecideAgentInputCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Content))
            return OperationResult<AgentDecisionDto>.Failure("agent.empty", "Agent 输入不能为空。");

        var conversationId = command.ConversationId;
        if (string.IsNullOrWhiteSpace(conversationId) && command.ContinueConversation)
            conversationId = (await settings.GetAsync("chat_history_current_conversation_id", cancellationToken))?.Value;
        if (string.IsNullOrWhiteSpace(conversationId)) conversationId = $"agent_{Guid.NewGuid():N}";
        if (command.SaveUserMessage)
            await settings.SetManyAsync(new Dictionary<string, string> { ["chat_history_current_conversation_id"] = conversationId }, cancellationToken);
        var characterId = command.CharacterId;
        if (string.IsNullOrWhiteSpace(characterId))
            characterId = (await settings.GetAsync("voice_current_role_id", cancellationToken))?.Value;
        if (string.IsNullOrWhiteSpace(characterId))
            return OperationResult<AgentDecisionDto>.Failure("agent.character_required", "尚未选择当前角色。");
        var character = await characters.GetAsync(characterId, cancellationToken);
        if (character is null || !character.IsEnabled)
            return OperationResult<AgentDecisionDto>.Failure("agent.character_not_found", "当前角色不存在或未启用。");

        if (command.SaveUserMessage)
            await chatStore.AppendAsync(new ChatMessageDto(0, conversationId, "user", command.Content, characterId,
                string.Empty, command.Source, string.Empty, DateTimeOffset.Now), cancellationToken);

        var recent = await chatStore.LoadRecentAsync(conversationId, 10, cancellationToken);
        var capabilities = await HandleAsync(new ListAgentCapabilitiesQuery(true), cancellationToken);
        if (command.ToolStep > 1 && TryCreateExplicitMusicCompletion(conversationId, command.Content, command.ToolResultJson, out var musicCompletion))
        {
            var messageId = await chatStore.AppendAsync(new ChatMessageDto(0, conversationId, "assistant", musicCompletion.Message,
                character.RoleId, string.Empty, command.Source, string.Empty, DateTimeOffset.Now), cancellationToken);
            return OperationResult<AgentDecisionDto>.Success(musicCompletion with { MessageId = messageId });
        }
        if (command.ToolStep == 1 && TryCreateExplicitMusicDecision(conversationId, command.Content, capabilities, out var explicitMusicDecision))
            return OperationResult<AgentDecisionDto>.Success(explicitMusicDecision);
        var values = new Dictionary<string, string>
        {
            ["roleId"] = character.RoleId,
            ["roleName"] = character.Name,
            ["capabilitiesJson"] = JsonSerializer.Serialize(capabilities.Select(item => new
            {
                capability = item.CapabilityName,
                displayName = item.DisplayName,
                description = item.Description,
                argsSchema = JsonSerializer.Deserialize<JsonElement>(item.ArgsSchemaJson),
                riskLevel = item.RiskLevel
            })),
            ["recentMessagesJson"] = JsonSerializer.Serialize(recent.Select(item => new { role = item.Role, content = item.Content })),
            ["userMessage"] = command.Content,
            ["toolResultJson"] = command.ToolResultJson,
            ["toolStep"] = Math.Max(1, command.ToolStep).ToString(),
            ["maxSteps"] = Math.Max(1, command.MaxSteps).ToString()
        };
        var raw = new StringBuilder();
        await foreach (var delta in aiProvider.StreamChatAsync(new AiChatRequest(
            conversationId, command.Content, character.RoleId, string.Empty, [],
            SourceKey: "agent_decision", TemplateValues: values, Temperature: 0.3, MaxTokens: 512, StreamResponse: false), cancellationToken))
            raw.Append(delta);

        AgentDecisionDto decision;
        try { decision = ParseDecision(conversationId, raw.ToString()); }
        catch (Exception ex) { return OperationResult<AgentDecisionDto>.Failure("agent.invalid_decision", $"Agent 决策格式无效：{ex.Message}"); }
        if (decision.Type is "final_response" or "final_answer" or "ask_user" or "ask_clarify" or "reject")
        {
            if (string.IsNullOrWhiteSpace(decision.Message))
                return OperationResult<AgentDecisionDto>.Failure("agent.empty_response", "Agent 返回了空回复。");
            var messageId = await chatStore.AppendAsync(new ChatMessageDto(0, conversationId, "assistant", decision.Message,
                character.RoleId, string.Empty, command.Source, string.Empty, DateTimeOffset.Now), cancellationToken);
            decision = decision with { MessageId = messageId };
        }
        return OperationResult<AgentDecisionDto>.Success(decision);
    }

    private static bool TryCreateExplicitMusicDecision(
        string conversationId,
        string content,
        IReadOnlyList<AgentCapabilityDto> capabilities,
        out AgentDecisionDto decision)
    {
        decision = default!;
        var capability = capabilities.FirstOrDefault(item =>
            item.CapabilityName.Equals("music.search", StringComparison.OrdinalIgnoreCase));
        if (capability is null) return false;
        if (!TryReadExplicitMusicSongName(content, out var songName)) return false;
        decision = new AgentDecisionDto(
            conversationId,
            "tool_call",
            string.Empty,
            "normal",
            capability.CapabilityName,
            JsonSerializer.Serialize(new { songName }),
            "用户明确要求播放指定歌曲",
            string.Empty,
            string.Empty,
            string.Empty);
        return true;
    }

    private static bool TryCreateExplicitMusicCompletion(
        string conversationId,
        string content,
        string? toolResultJson,
        out AgentDecisionDto decision)
    {
        decision = default!;
        if (!TryReadExplicitMusicSongName(content, out _) || string.IsNullOrWhiteSpace(toolResultJson)) return false;
        try
        {
            using var document = JsonDocument.Parse(toolResultJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("capabilityName", out var capability) ||
                !string.Equals(capability.GetString(), "music.search", StringComparison.OrdinalIgnoreCase) ||
                !root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object ||
                !result.TryGetProperty("status", out var status) || status.GetString() != "completed" ||
                !result.TryGetProperty("output", out var output)) return false;
            var message = output.GetString()?.Trim();
            if (string.IsNullOrWhiteSpace(message)) return false;
            decision = new AgentDecisionDto(conversationId, "final_response", message, "normal",
                string.Empty, "{}", "音乐工具执行完成", string.Empty, string.Empty, string.Empty);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryReadExplicitMusicSongName(string content, out string songName)
    {
        var text = content.Trim();
        foreach (var prefix in new[] { "播放", "放", "播", "听", "来一首", "来首" })
        {
            if (!text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            songName = text[prefix.Length..].Trim();
            if (songName.StartsWith("歌曲", StringComparison.Ordinal)) songName = songName[2..].Trim();
            else if (songName.StartsWith("音乐", StringComparison.Ordinal)) songName = songName[2..].Trim();
            return songName.Length > 0;
        }
        songName = string.Empty;
        return false;
    }

    private static AgentDecisionDto ParseDecision(string conversationId, string raw)
    {
        var trimmed = raw.Trim();
        var start = trimmed.IndexOf('{');
        var end = trimmed.LastIndexOf('}');
        if (start < 0 || end <= start) throw new InvalidDataException("响应中没有 JSON 对象。");
        using var document = JsonDocument.Parse(trimmed[start..(end + 1)]);
        var root = document.RootElement;
        string Read(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;
        var args = root.TryGetProperty("args", out var argsElement) && argsElement.ValueKind == JsonValueKind.Object ? argsElement.GetRawText() : "{}";
        return new AgentDecisionDto(conversationId, Read("type"), Read("message"), Read("voiceStyle"),
            Read("capability"), args, Read("reason"), Read("timeText"), Read("content"), Read("repeat"));
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
    private readonly ISettingsStore settingsStore;
    private readonly IEventPublisher events;
    public ProactiveApplicationService(IDomainDocumentStore store, ISettingsStore settingsStore, IEventPublisher events) { this.store = store; this.settingsStore = settingsStore; this.events = events; }

    public async Task<OperationResult> HandleAsync(SaveProactiveRuleCommand command, CancellationToken cancellationToken = default)
    {
        var rule = command.Rule with { UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(RuleDomain, rule.RuleId, JsonSerializer.Serialize(rule), rule.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }
    public async Task<OperationResult> HandleAsync(SaveDisturbanceSettingsCommand command, CancellationToken cancellationToken = default)
    {
        if (command.Settings.Mode is not ("normal" or "quiet" or "focus" or "game" or "sleep"))
            return OperationResult.Failure("disturbance.invalid_mode", "勿扰模式值无效。");
        if (!TimeOnly.TryParse(command.Settings.QuietHoursStart, out _) || !TimeOnly.TryParse(command.Settings.QuietHoursEnd, out _) || command.Settings.MaxProactivePerHour is < 0 or > 100)
            return OperationResult.Failure("disturbance.invalid", "勿扰时段或每小时主动次数无效。");
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
        var enabledText = (await settingsStore.GetAsync("ai_proactive_enabled", cancellationToken))?.Value;
        if (bool.TryParse(enabledText, out var enabled) && !enabled) return Decision(false, string.Empty, "proactive_disabled", 0, false, string.Empty);
        var settings = await HandleAsync(new GetDisturbanceSettingsQuery(), cancellationToken) ??
            new DisturbanceSettingsDto("normal", true, "01:00", "09:00", true, 3, DateTimeOffset.Now);
        if (settings.Mode.Equals("sleep", StringComparison.OrdinalIgnoreCase)) return Decision(false, string.Empty, "disturbance_sleep", 0, false, string.Empty);
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
            var allowTts = rule.AllowTts && !settings.Mode.Equals("quiet", StringComparison.OrdinalIgnoreCase);
            var result = new ProactiveDecisionDto(true, rule.RuleId, "matched", rule.Priority, allowTts, rule.ActionTag);
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
