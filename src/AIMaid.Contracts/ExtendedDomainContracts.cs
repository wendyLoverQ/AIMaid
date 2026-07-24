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

public sealed record AgentDecisionDto(
    string ConversationId, string Type, string Message, string VoiceStyle,
    string Capability, string ArgsJson, string Reason, string TimeText, string Content,
    string Repeat, long MessageId = 0);

public sealed record DecideAgentInputCommand(
    string Content, string? ConversationId = null, string? CharacterId = null,
    bool SaveUserMessage = true, string ToolResultJson = "{}",
    int ToolStep = 1, int MaxSteps = 4, string Source = "normal_chat", bool ContinueConversation = false)
    : ICommand<OperationResult<AgentDecisionDto>>;

public sealed record AgentApprovalRequestedEvent(
    string EventId, DateTimeOffset OccurredAt, string ApprovalToken, string CapabilityName,
    string DisplayName, string RiskLevel, string ArgsJson, string Description = "", string ExecutorType = "") : IBusinessEvent;
public sealed record AgentToolCallCompletedEvent(
    string EventId, DateTimeOffset OccurredAt, AgentToolCallDto ToolCall) : IBusinessEvent;
public sealed record AgentUiActionRequestedEvent(
    string EventId, DateTimeOffset OccurredAt, string Action, string Target) : IBusinessEvent;

public sealed record ProactiveRuleDto(
    string RuleId, bool Enabled, string EventType, string ConditionJson, int Priority,
    int CooldownSeconds, string DisturbanceLevel, bool AllowTts, string ActionTag,
    string TextTemplatesJson, DateTimeOffset UpdatedAt);
public sealed record DisturbanceSettingsDto(
    string Mode, bool QuietHoursEnabled, string QuietHoursStart, string QuietHoursEnd,
    bool SuppressWhenFullscreen, int MaxProactivePerHour, DateTimeOffset UpdatedAt);
public sealed record ProactiveContextDto(string EventType, bool IsFullscreen, DateTimeOffset Now, IReadOnlyDictionary<string, string> Values);
public sealed record ProactiveDecisionDto(
    bool ShouldRespond, string RuleId, string Reason, int Priority, bool AllowTts, string ActionTag,
    string Message = "", string VoiceStyle = "", bool ShowBubble = false,
    string MoodChange = "", int FavorabilityDelta = 0, string BroadcastSourceKeys = "");
public sealed record EvaluateProactiveEventCommand(ProactiveContextDto Context) : ICommand<OperationResult<ProactiveDecisionDto>>;
public sealed record SaveProactiveRuleCommand(ProactiveRuleDto Rule) : ICommand<OperationResult>;
public sealed record ListProactiveRulesQuery : IQuery<IReadOnlyList<ProactiveRuleDto>>;
public sealed record SaveDisturbanceSettingsCommand(DisturbanceSettingsDto Settings) : ICommand<OperationResult>;
public sealed record GetDisturbanceSettingsQuery : IQuery<DisturbanceSettingsDto?>;
public sealed record ProactiveDecisionEvent(string EventId, DateTimeOffset OccurredAt, ProactiveDecisionDto Decision) : IBusinessEvent;
public sealed record ProactiveSourceDto(
    string SourceKey, string DisplayName, bool Enabled, int Priority, int FrequencyMinutes,
    int CooldownMinutes, int MaxItems, string ParameterJson, int MinScore,
    DateTimeOffset? LastCollectedAt, string LastSnapshot, string LastSnapshotHash,
    int LastScore, string LastSelectReason, DateTimeOffset? LastBroadcastAt,
    string LastBroadcastMessage, string LastBroadcastMessageHash, DateTimeOffset UpdatedAt,
    bool IsConfigured = true, bool IsImplemented = true, string StatusText = "可用");
public sealed record ListProactiveSourcesQuery : IQuery<IReadOnlyList<ProactiveSourceDto>>;
public sealed record UpdateProactiveSourceCommand(
    string SourceKey, bool? Enabled = null, int? CooldownMinutes = null)
    : ICommand<OperationResult<ProactiveSourceDto>>;
public sealed record TestProactiveSourceCommand(string SourceKey) : ICommand<OperationResult>;
public sealed record ProactiveActionDto(string Type, IReadOnlyDictionary<string, string> Payload);
public sealed record ProactiveExecutionRequestedEvent(
    string EventId, DateTimeOffset OccurredAt, string ExecutionId, string TriggerLogId,
    string RuleId, bool ManualTest, IReadOnlyList<ProactiveActionDto> Actions) : IBusinessEvent;
public sealed record CompleteProactiveExecutionCommand(
    string ExecutionId, bool Responded, bool Spoke, string Message, string VoiceTrigger,
    string AudioPath, string Result, string Error, DateTimeOffset CompletedAt)
    : ICommand<OperationResult>;
public sealed record ProactiveExecutionCompletedEvent(
    string EventId, DateTimeOffset OccurredAt, string ExecutionId, bool Responded,
    bool Spoke, string Message, string Result, string Error) : IBusinessEvent;

public sealed record ReminderDto(
    string ReminderId, string Title, string Message, DateTimeOffset DueAt, string Repeat,
    bool Enabled, bool AllowTts, DateTimeOffset? LastTriggeredAt, DateTimeOffset? NextDueAt,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string VoiceStyle = "");
public sealed record SaveReminderCommand(
    string? ReminderId, string Title, string Message, DateTimeOffset DueAt,
    string Repeat, bool Enabled, bool AllowTts) : ICommand<OperationResult<ReminderDto>>;
public sealed record SetReminderEnabledCommand(string ReminderId, bool Enabled) : ICommand<OperationResult<ReminderDto>>;
public sealed record SetReminderAllowTtsCommand(string ReminderId, bool AllowTts) : ICommand<OperationResult<ReminderDto>>;
public sealed record DeleteReminderCommand(string ReminderId) : ICommand<OperationResult>;
public sealed record ListRemindersQuery(bool EnabledOnly = false) : IQuery<IReadOnlyList<ReminderDto>>;
public sealed record ProcessDueRemindersCommand(
    DateTimeOffset Now, IReadOnlyList<string>? ReminderIds = null, bool NotificationShown = false)
    : ICommand<OperationResult<IReadOnlyList<ReminderDto>>>;
public sealed record CompleteReminderDeliveryCommand(
    string DeliveryId, string ReminderId, bool NotificationShown, bool BubbleShown,
    bool TtsRequested, bool TtsPlayed, string Result, string Error, DateTimeOffset CompletedAt)
    : ICommand<OperationResult>;
public sealed record ReminderDeliveryRequestedEvent(
    string EventId, DateTimeOffset OccurredAt, string DeliveryId, ReminderDto Reminder,
    bool NotificationShown, string CachedAudioPath) : IBusinessEvent;
public sealed record ReminderDeliveryCompletedEvent(
    string EventId, DateTimeOffset OccurredAt, string DeliveryId, string ReminderId,
    bool NotificationShown, bool BubbleShown, bool TtsRequested, bool TtsPlayed,
    string Result, string Error) : IBusinessEvent;

public sealed record NotebookNoteDto(
    string NoteId, string Title, string ContentMarkdown, string ContentPlainText,
    IReadOnlyList<string> AttachmentIds, bool IsPinned, bool IsDeleted,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record SaveNotebookNoteCommand(NotebookNoteDto Note) : ICommand<OperationResult>;
public sealed record SaveNotebookAttachmentCommand(
    string Id, string NoteId, string OriginalName, string StoredPath, string MimeType,
    long SizeBytes, int? Width, int? Height, string Sha256, DateTimeOffset CreatedAt)
    : ICommand<OperationResult>;
public sealed record DeleteNotebookNoteCommand(string NoteId) : ICommand<OperationResult>;
public sealed record ListNotebookNotesQuery(bool IncludeDeleted = false) : IQuery<IReadOnlyList<NotebookNoteDto>>;

public sealed record VoiceConversationDto(
    string ConversationId, string VoiceRoleId, string Title, string Preview,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record SaveVoiceConversationCommand(VoiceConversationDto Conversation) : ICommand<OperationResult>;
public sealed record DeleteVoiceConversationCommand(string ConversationId) : ICommand<OperationResult>;
public sealed record ListVoiceConversationsQuery(string? VoiceRoleId = null, string? Search = null) : IQuery<IReadOnlyList<VoiceConversationDto>>;

public sealed record ChatCommandLauncherDto(
    string LauncherId, string CommandText, string DisplayName, string ExePath,
    string Arguments, string WorkingDirectory, bool Enabled, DateTimeOffset UpdatedAt);
public sealed record SaveChatCommandLauncherCommand(ChatCommandLauncherDto Launcher) : ICommand<OperationResult<ChatCommandLauncherDto>>;
public sealed record ListChatCommandLaunchersQuery : IQuery<IReadOnlyList<ChatCommandLauncherDto>>;
public sealed record RunChatCommandLauncherCommand(string LauncherId) : ICommand<OperationResult<string>>;

public sealed record TimerRecordDto(string RecordId, DateTimeOffset SavedAt, int DurationSeconds);
public sealed record SaveTimerRecordCommand(TimerRecordDto Record) : ICommand<OperationResult>;
public sealed record DeleteTimerRecordCommand(string RecordId) : ICommand<OperationResult>;
public sealed record ListTimerRecordsQuery : IQuery<IReadOnlyList<TimerRecordDto>>;

public sealed record CryptoProviderConfigurationDto(bool IsEnabled, string ServiceUrl, int TimeoutSeconds, string LastHealthStatus, long? LastHealthLatencyMs, DateTimeOffset? LastCheckedAt);

public sealed record AppearanceConfigurationDto(
    string ThemeId, string ContentBrightness, string FontFamily, double FontScale,
    string CornerRadiusStyle, string Density, string HeaderStyle, bool AnimationsEnabled);
public sealed record GetAppearanceConfigurationQuery : IQuery<AppearanceConfigurationDto>;
public sealed record SaveAppearanceConfigurationCommand(AppearanceConfigurationDto Configuration) : ICommand<OperationResult>;

public sealed record VaultItemDto(
    string ItemId, string ItemType, string Name, string Category, string Account, string Url,
    string Platform, string PublicMetadataJson, bool HasProtectedSecret,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record VaultItemDetailDto(VaultItemDto Item, string? Secret);
public sealed record SaveVaultItemCommand(VaultItemDto Item, string? PlainSecret, string? ChangeRemark = null) : ICommand<OperationResult<string>>;
public sealed record GetVaultItemQuery(string ItemId) : IQuery<OperationResult<VaultItemDetailDto>>;
public sealed record RevealVaultSecretQuery(string ItemId) : IQuery<OperationResult<VaultItemDetailDto>>;
public sealed record ListVaultItemsQuery(string? ItemType = null) : IQuery<IReadOnlyList<VaultItemDto>>;
public sealed record DeleteVaultItemCommand(string ItemId) : ICommand<OperationResult>;
public sealed record VaultHistoryDto(
    string HistoryId, string ItemId, string FieldName, string ChangeRemark, DateTimeOffset CreatedAt);
public sealed record ListVaultHistoriesQuery(string ItemId) : IQuery<IReadOnlyList<VaultHistoryDto>>;
public sealed record RestoreVaultHistoryCommand(string HistoryId) : ICommand<OperationResult>;

public sealed record ModelConfigurationDto(
    string ModelKey, string Type, string Endpoint, string Model, string ApiKey,
    bool EnableWebSearch, bool Think);
public sealed record ListModelConfigurationsQuery(bool IncludeSecrets = false) : IQuery<IReadOnlyList<ModelConfigurationDto>>;
public sealed record SaveModelConfigurationsCommand(IReadOnlyList<ModelConfigurationDto> Configurations) : ICommand<OperationResult>;
public sealed record AddModelConfigurationCommand(string ModelKey, string Type) : ICommand<OperationResult>;
public sealed record LlmBusinessModelConfigDto(
    string BusinessKey, string DisplayName, string Description, string Provider,
    string ModelKey, bool IsEnabled, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record ListLlmBusinessModelConfigsQuery : IQuery<IReadOnlyList<LlmBusinessModelConfigDto>>;
public sealed record SaveLlmBusinessModelConfigsCommand(IReadOnlyList<LlmBusinessModelConfigDto> Configurations) : ICommand<OperationResult>;
public sealed record LlmSourcePromptDto(
    string SourceKey, string Purpose, string SystemPromptTemplate, string UserPromptTemplate,
    string OutputSchemaJson, bool IsEnabled, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record ListLlmSourcePromptsQuery : IQuery<IReadOnlyList<LlmSourcePromptDto>>;
public sealed record SaveLlmSourcePromptCommand(LlmSourcePromptDto Prompt) : ICommand<OperationResult>;

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
    long FileSize = 0, DateTimeOffset? LastPlayedAt = null, string Remark = "",
    string CoverStatus = "Pending", bool IsFileMissing = false);
public sealed record VideoAlbumDto(
    string AlbumId, string Name, string Description, string CoverPath, int SortOrder,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record VideoLibrarySnapshotDto(
    IReadOnlyList<VideoItemDto> Items, IReadOnlyList<VideoAlbumDto> Albums, IReadOnlyList<string> Tags);
public sealed record VideoImportFileResultDto(
    string Status, VideoItemDto Item, string? CoverError = null);
public sealed record VideoImportResultDto(
    int ImportedCount, IReadOnlyList<VideoItemDto> Items,
    int UpdatedCount = 0, int ExistingCount = 0, int FailedCount = 0, int CoverFailedCount = 0);
public sealed record VideoDependencyStatusDto(
    string PotPlayerBridgePath, bool PotPlayerBridgeAvailable,
    string PotPlayerPath, bool PotPlayerAvailable,
    string PlaylistPath, bool PlaylistAvailable,
    string FfmpegPath, bool FfmpegAvailable,
    string FfprobePath, bool FfprobeAvailable,
    string YtDlpPath, bool YtDlpAvailable);
public sealed record RemoteSiteDto(
    string SiteId, string SiteName, string DomainPattern, string AdapterKey,
    string QualityPreference, bool IsEnabled, string SettingsJson, DateTimeOffset UpdatedAt, bool HasProtectedCookie = false);
public sealed record RemoteSiteDetailDto(RemoteSiteDto Site);
public sealed record SaveVideoItemCommand(VideoItemDto Video) : ICommand<OperationResult>;
public sealed record ListVideosQuery(bool FavoritesOnly = false) : IQuery<VideoLibrarySnapshotDto>;
public sealed record ImportVideoFileCommand(string FilePath, string? AlbumId = null) : ICommand<OperationResult<VideoImportFileResultDto>>;
public sealed record ImportVideoFolderCommand(string FolderPath, bool Recursive, string? AlbumId = null) : ICommand<OperationResult<VideoImportResultDto>>;
public sealed record RefreshVideoMetadataCommand(IReadOnlyList<string> VideoIds) : ICommand<OperationResult<VideoImportResultDto>>;
public sealed record ToggleVideoFavoriteCommand(string VideoId) : ICommand<OperationResult>;
public sealed record SetVideoDisplayNameCommand(string VideoId, string DisplayName) : ICommand<OperationResult>;
public sealed record SetVideoRemarkCommand(string VideoId, string Remark) : ICommand<OperationResult>;
public sealed record UpdateVideoProgressCommand(string VideoId, int PositionSeconds, int DurationSeconds) : ICommand<OperationResult>;
public sealed record CreateVideoAlbumCommand(string Name, string Description = "") : ICommand<OperationResult<VideoAlbumDto>>;
public sealed record RenameVideoAlbumCommand(string AlbumId, string Name) : ICommand<OperationResult>;
public sealed record DeleteVideoAlbumCommand(string AlbumId) : ICommand<OperationResult>;
public sealed record MoveVideosToAlbumCommand(IReadOnlyList<string> VideoIds, string? AlbumId) : ICommand<OperationResult>;
public sealed record CreateVideoTagCommand(string Tag) : ICommand<OperationResult>;
public sealed record RenameVideoTagCommand(string OldTag, string NewTag) : ICommand<OperationResult>;
public sealed record DeleteVideoTagCommand(string Tag) : ICommand<OperationResult>;
public sealed record SetVideoTagsCommand(IReadOnlyList<string> VideoIds, string Tags, string Mode = "replace") : ICommand<OperationResult>;
public sealed record RemoveVideoRecordsCommand(IReadOnlyList<string> VideoIds) : ICommand<OperationResult>;
public sealed record DeleteVideoLocalFilesCommand(IReadOnlyList<string> VideoIds) : ICommand<OperationResult>;
public sealed record PlayVideosCommand(IReadOnlyList<string> VideoIds, string StartVideoId) : ICommand<OperationResult<int>>;
public sealed record GetVideoDependenciesQuery : IQuery<VideoDependencyStatusDto>;
public sealed record SubtitleItemDto(string Name, string Path);
public sealed record ListSubtitlesQuery : IQuery<IReadOnlyList<SubtitleItemDto>>;
public sealed record ImportSubtitleCommand(string SourcePath) : ICommand<OperationResult<SubtitleItemDto>>;
public sealed record ImportSubtitleFolderCommand(string FolderPath) : ICommand<OperationResult<int>>;
public sealed record DeleteSubtitleCommand(string Path) : ICommand<OperationResult>;
public sealed record SaveRemoteSiteCommand(RemoteSiteDto Site, string? PlainCookie = null) : ICommand<OperationResult<string>>;
public sealed record GetRemoteSiteQuery(string SiteId) : IQuery<OperationResult<RemoteSiteDetailDto>>;
public sealed record DeleteRemoteSiteCommand(string SiteId) : ICommand<OperationResult>;
public sealed record ListRemoteSitesQuery(bool EnabledOnly = true) : IQuery<IReadOnlyList<RemoteSiteDto>>;
public sealed record ResolveRemoteMediaCommand(string Url, string? SiteId = null) : ICommand<OperationResult<string>>;

public sealed record RemoteVideoFormatDto(
    string FormatId, string Selector, string DisplayName, int? Width, int? Height,
    double? Fps, bool HasVideo, bool HasAudio, long? FileSize);
public sealed record RemoteVideoResolvedItemDto(
    string ItemId, string OriginalUrl, string Title, string Author, string SiteName,
    string VideoId, int DurationSeconds, string ThumbnailUrl, DateTimeOffset? PublishedAt,
    bool IsLive, string DownloadStatus, IReadOnlyList<RemoteVideoFormatDto> Formats);
public sealed record RemoteVideoResolveResultDto(
    IReadOnlyList<RemoteVideoResolvedItemDto> Items, string DiagnosticSummary);
public sealed record RemoteVideoThumbnailDto(string MimeType, string Base64Data);
public sealed record RemoteVideoDownloadDto(
    string TaskId, string ItemId, string OriginalUrl, string Title, string Author,
    string SiteName, string OutputPath, string Quality, string Status, double Progress,
    string Speed, string Eta, string ErrorMessage, long FileSize, DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt, string ThumbnailUrl = "");
public sealed record RemoteVideoPlayHistoryDto(
    string HistoryId, string? ItemId, string OriginalUrl, string Title, string Author,
    string SiteName, string Action, string CachePath, DateTimeOffset PlayedAt, string ThumbnailUrl = "");
public sealed record RemoteVideoSettingsDto(
    string DownloadRoot, string CacheRoot, string FileNameTemplate,
    string DefaultQualityPreference, bool DownloadThumbnail, bool DownloadInfoJson,
    bool DownloadSubtitles, bool OverwriteExisting, bool AutoImportToVideoLibrary,
    int MaxConcurrentDownloads, string YtDlpPath, string FfmpegPath,
    string PotPlayerPath, DateTimeOffset UpdatedAt);
public sealed record RemoteVideoDiagnosticsDto(
    DateTimeOffset CheckedAt, string YtDlpPath, bool YtDlpExists,
    string FfmpegPath, bool FfmpegExists, string PotPlayerPath, bool PotPlayerExists,
    string DownloadRoot, bool DownloadRootWritable, int ActiveDownloads,
    string LastOperation, string LastStatus, string LastMessage);

public sealed record TtsAudioReadyEvent(
    string EventId, DateTimeOffset OccurredAt, string RequestId, string AudioPath,
    string Text, string VoiceId, string Style) : IBusinessEvent;

public sealed record CharacterPresentationEvent(
    string EventId, DateTimeOffset OccurredAt, string RoleId, string Action,
    string Mood, IReadOnlyDictionary<string, string> Parameters) : IBusinessEvent;
