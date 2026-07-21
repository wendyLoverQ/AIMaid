namespace AIMaid.Contracts.Domains;

public sealed record AgentCapabilityDto(
    string CapabilityName, string DisplayName, string Description, string ExecutorType,
    string ConfigJson, string ArgsSchemaJson, string ResultPolicy, string RiskLevel,
    bool RequireConfirm, bool Enabled, int SortOrder, DateTimeOffset UpdatedAt);

public sealed record AgentToolCallDto(
    string CallId, string ConversationId, string CapabilityName, string ArgsJson, string Status,
    int? ExitCode, string Output, string Error, bool ConfirmedByUser, bool RejectedByUser,
    DateTimeOffset CreatedAt, DateTimeOffset? FinishedAt, string? ParentCallId = null,
    string ExecutorType = "", string ResultPolicy = "", string DisplayResult = "", int DurationMs = 0);

public sealed record ListAgentCapabilitiesQuery(bool EnabledOnly = true) : IQuery<IReadOnlyList<AgentCapabilityDto>>;
public sealed record SaveAgentCapabilityCommand(AgentCapabilityDto Capability) : ICommand<OperationResult>;
public sealed record ExecuteAgentCapabilityCommand(string ConversationId, string CapabilityName, string ArgsJson, string? ApprovalToken = null)
    : ICommand<OperationResult<AgentToolCallDto>>;

public sealed record AgentApprovalRequestedEvent(
    string EventId, DateTimeOffset OccurredAt, string ApprovalToken, string CapabilityName,
    string DisplayName, string RiskLevel, string ArgsJson) : IBusinessEvent;
public sealed record AgentToolCallCompletedEvent(
    string EventId, DateTimeOffset OccurredAt, AgentToolCallDto ToolCall) : IBusinessEvent;

public sealed record ProactiveRuleDto(
    string RuleId, bool Enabled, string EventType, string ConditionJson, int Priority,
    int CooldownSeconds, string DisturbanceLevel, bool AllowTts, string ActionTag,
    string TextTemplatesJson, DateTimeOffset UpdatedAt);
public sealed record DisturbanceSettingsDto(
    string Mode, bool QuietHoursEnabled, string QuietHoursStart, string QuietHoursEnd,
    bool SuppressWhenFullscreen, int MaxProactivePerHour, DateTimeOffset UpdatedAt);
public sealed record ProactiveContextDto(string EventType, bool IsFullscreen, DateTimeOffset Now, IReadOnlyDictionary<string, string> Values);
public sealed record ProactiveDecisionDto(bool ShouldRespond, string RuleId, string Reason, int Priority, bool AllowTts, string ActionTag);
public sealed record EvaluateProactiveEventCommand(ProactiveContextDto Context) : ICommand<OperationResult<ProactiveDecisionDto>>;
public sealed record SaveProactiveRuleCommand(ProactiveRuleDto Rule) : ICommand<OperationResult>;
public sealed record ListProactiveRulesQuery : IQuery<IReadOnlyList<ProactiveRuleDto>>;
public sealed record SaveDisturbanceSettingsCommand(DisturbanceSettingsDto Settings) : ICommand<OperationResult>;
public sealed record GetDisturbanceSettingsQuery : IQuery<DisturbanceSettingsDto?>;
public sealed record ProactiveDecisionEvent(string EventId, DateTimeOffset OccurredAt, ProactiveDecisionDto Decision) : IBusinessEvent;

public sealed record ReminderDto(
    string ReminderId, string Title, string Message, DateTimeOffset DueAt, string Repeat,
    bool Enabled, bool AllowTts, DateTimeOffset? LastTriggeredAt, DateTimeOffset? NextDueAt,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record SaveReminderCommand(ReminderDto Reminder) : ICommand<OperationResult>;
public sealed record DeleteReminderCommand(string ReminderId) : ICommand<OperationResult>;
public sealed record ListRemindersQuery(bool EnabledOnly = false) : IQuery<IReadOnlyList<ReminderDto>>;
public sealed record ProcessDueRemindersCommand(DateTimeOffset Now) : ICommand<OperationResult<IReadOnlyList<ReminderDto>>>;
public sealed record ReminderDueEvent(string EventId, DateTimeOffset OccurredAt, ReminderDto Reminder) : IBusinessEvent;

public sealed record NotebookNoteDto(
    string NoteId, string Title, string ContentMarkdown, string ContentPlainText,
    IReadOnlyList<string> AttachmentIds, bool IsPinned, bool IsDeleted,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record SaveNotebookNoteCommand(NotebookNoteDto Note) : ICommand<OperationResult>;
public sealed record DeleteNotebookNoteCommand(string NoteId) : ICommand<OperationResult>;
public sealed record ListNotebookNotesQuery(bool IncludeDeleted = false) : IQuery<IReadOnlyList<NotebookNoteDto>>;

public sealed record VaultItemDto(
    string ItemId, string ItemType, string Name, string Category, string Account, string Url,
    string Platform, string PublicMetadataJson, bool HasProtectedSecret,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record SaveVaultItemCommand(VaultItemDto Item, string? PlainSecret) : ICommand<OperationResult>;
public sealed record GetVaultItemQuery(string ItemId, bool IncludeSecret = false) : IQuery<OperationResult<(VaultItemDto Item, string? Secret)>>;
public sealed record ListVaultItemsQuery(string? ItemType = null) : IQuery<IReadOnlyList<VaultItemDto>>;
public sealed record DeleteVaultItemCommand(string ItemId) : ICommand<OperationResult>;

public sealed record MarketEventDto(
    string EventId, string EventType, string Source, string Network, string Symbol,
    string Address, string TransactionHash, decimal? Amount, decimal? Price,
    string DedupeKey, string PayloadJson, DateTimeOffset OccurredAt);
public sealed record RecordMarketEventCommand(MarketEventDto MarketEvent) : ICommand<OperationResult>;
public sealed record ListMarketEventsQuery(string? Symbol = null, int Limit = 100) : IQuery<IReadOnlyList<MarketEventDto>>;

public sealed record VideoItemDto(
    string VideoId, string SourceType, string Title, string FilePath, string OriginalUrl,
    string CoverPath, string Tags, string SubtitlePath, bool IsFavorite,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? AlbumId = null,
    int DurationSeconds = 0, int LastPositionSeconds = 0, bool IsCompleted = false,
    long FileSize = 0, DateTimeOffset? LastPlayedAt = null, string Remark = "");
public sealed record RemoteSiteDto(
    string SiteId, string SiteName, string DomainPattern, string AdapterKey,
    string QualityPreference, bool IsEnabled, string SettingsJson, DateTimeOffset UpdatedAt);
public sealed record SaveVideoItemCommand(VideoItemDto Video) : ICommand<OperationResult>;
public sealed record ListVideosQuery(bool FavoritesOnly = false) : IQuery<IReadOnlyList<VideoItemDto>>;
public sealed record SaveRemoteSiteCommand(RemoteSiteDto Site) : ICommand<OperationResult>;
public sealed record ListRemoteSitesQuery(bool EnabledOnly = true) : IQuery<IReadOnlyList<RemoteSiteDto>>;
public sealed record ResolveRemoteMediaCommand(string Url, string? SiteId = null) : ICommand<OperationResult<string>>;

public sealed record TtsAudioReadyEvent(
    string EventId, DateTimeOffset OccurredAt, string RequestId, string AudioPath,
    string Text, string VoiceId, string Style) : IBusinessEvent;

public sealed record CharacterPresentationEvent(
    string EventId, DateTimeOffset OccurredAt, string RoleId, string Action,
    string Mood, IReadOnlyDictionary<string, string> Parameters) : IBusinessEvent;
