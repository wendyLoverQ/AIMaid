-- index: IX_AppSettings_Key
CREATE UNIQUE INDEX IX_AppSettings_Key ON AppSettings(Key);
-- index: IX_ChatMessages_ConversationId_Id
CREATE INDEX IX_ChatMessages_ConversationId_Id ON ChatMessages(ConversationId, Id);
-- index: IX_CoreBackgroundTasks_Type_UpdatedAt
CREATE INDEX IX_CoreBackgroundTasks_Type_UpdatedAt ON CoreBackgroundTasks(TaskType, UpdatedAt DESC);
-- index: IX_ProactiveTriggerRules_RuleId
CREATE UNIQUE INDEX IX_ProactiveTriggerRules_RuleId ON ProactiveTriggerRules(RuleId);
-- index: IX_ProactiveTriggerStates_RuleId
CREATE UNIQUE INDEX IX_ProactiveTriggerStates_RuleId ON ProactiveTriggerStates(RuleId);
-- index: IX_TimerRecords_RecordId
CREATE UNIQUE INDEX IX_TimerRecords_RecordId ON TimerRecords(RecordId);
-- index: IX_VoiceCacheGenerations_Status_UpdatedAt
CREATE INDEX IX_VoiceCacheGenerations_Status_UpdatedAt ON VoiceCacheGenerations(Status, UpdatedAt);
-- index: IX_VoiceRoleCards_RoleId
CREATE UNIQUE INDEX IX_VoiceRoleCards_RoleId ON VoiceRoleCards(RoleId);
-- index: sqlite_autoindex_CoreBackgroundTasks_1
;
-- index: sqlite_autoindex_NotebookAttachments_1
;
-- index: sqlite_autoindex_VoiceCacheGenerations_1
;
-- index: sqlite_autoindex_VoiceConversations_1
;
-- index: UX_VoiceCacheGenerations_Context
CREATE UNIQUE INDEX UX_VoiceCacheGenerations_Context ON VoiceCacheGenerations(RoleId, IntimacyLevel, CacheKey);
-- index: UX_VoiceRoleAudioCaches_Slot
CREATE UNIQUE INDEX UX_VoiceRoleAudioCaches_Slot
  ON VoiceRoleAudioCaches(RoleId, IntimacyLevel, CacheKey, TriggerId, BodyPart);
-- table: ActionTagDefinitions
CREATE TABLE "ActionTagDefinitions" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_ActionTagDefinitions" PRIMARY KEY AUTOINCREMENT,
    "Tag" TEXT NOT NULL,
    "DisplayName" TEXT NOT NULL,
    "ResourcePath" TEXT NOT NULL,
    "IsEnabled" INTEGER NOT NULL,
    "UpdatedAt" TEXT NOT NULL
);
-- table: AgentCapabilities
CREATE TABLE AgentCapabilities (
    Id INTEGER NOT NULL CONSTRAINT PK_AgentCapabilities PRIMARY KEY AUTOINCREMENT,
    CapabilityName TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    Description TEXT NOT NULL,
    ExecutorType TEXT NOT NULL,
    ConfigJson TEXT NULL,
    ArgsSchemaJson TEXT NULL,
    ResultPolicy TEXT NOT NULL DEFAULT 'simple_status',
    RiskLevel TEXT NOT NULL DEFAULT 'low',
    RequireConfirm INTEGER NOT NULL DEFAULT 0,
    Enabled INTEGER NOT NULL DEFAULT 1,
    SortOrder INTEGER NOT NULL DEFAULT 0,
    ChatCommandLauncherId INTEGER NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: AgentToolCalls
CREATE TABLE AgentToolCalls (
    Id INTEGER NOT NULL CONSTRAINT PK_AgentToolCalls PRIMARY KEY AUTOINCREMENT,
    ConversationId TEXT NOT NULL,
    ParentToolCallId INTEGER NULL,
    CapabilityName TEXT NOT NULL,
    ExecutorType TEXT NOT NULL,
    ArgsJson TEXT NOT NULL DEFAULT '{}',
    Status TEXT NOT NULL DEFAULT 'pending',
    ExitCode INTEGER NULL,
    Stdout TEXT NOT NULL DEFAULT '',
    Stderr TEXT NOT NULL DEFAULT '',
    StartedAt TEXT NOT NULL,
    FinishedAt TEXT NULL,
    DurationMs INTEGER NOT NULL DEFAULT 0,
    ErrorMessage TEXT NOT NULL DEFAULT '',
    ConfirmedByUser INTEGER NOT NULL DEFAULT 0,
    ResultPolicy TEXT NOT NULL DEFAULT '',
    DisplayResult TEXT NULL,
    CreatedAt TEXT NOT NULL
, RejectedByUser INTEGER NOT NULL DEFAULT 0);
-- table: AiConversations
CREATE TABLE "AiConversations" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_AiConversations" PRIMARY KEY AUTOINCREMENT,
    "Provider" TEXT NOT NULL,
    "Content" TEXT NOT NULL,
    "UpdatedAt" TEXT NOT NULL
);
-- table: AppRuntimeStates
CREATE TABLE "AppRuntimeStates" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_AppRuntimeStates" PRIMARY KEY AUTOINCREMENT,
    "LastRole" TEXT NOT NULL,
    "LastModel" TEXT NOT NULL,
    "LastVoiceId" TEXT NOT NULL,
    "LastInteractionAt" TEXT NULL,
    "DisturbanceMode" TEXT NOT NULL,
    "LastProactiveTriggerId" TEXT NOT NULL,
    "TtsStatus" TEXT NOT NULL,
    "OllamaStatus" TEXT NOT NULL,
    "LastLlmLatencyMs" INTEGER NOT NULL,
    "LastTtsLatencyMs" INTEGER NOT NULL,
    "UpdatedAt" TEXT NOT NULL
, AgentStateJson TEXT NOT NULL DEFAULT '{}');
-- table: AppSettings
CREATE TABLE "AppSettings" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_AppSettings" PRIMARY KEY AUTOINCREMENT,
    "Key" TEXT NOT NULL,
    "Value" TEXT NOT NULL
, "UpdatedAt" TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00');
-- table: ChatCommandLaunchers
CREATE TABLE ChatCommandLaunchers (
    Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    CommandText TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    ExePath TEXT NOT NULL,
    Arguments TEXT NOT NULL,
    WorkingDirectory TEXT NOT NULL,
    Enabled INTEGER NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: ChatMessages
CREATE TABLE ChatMessages (
    Id INTEGER NOT NULL CONSTRAINT PK_ChatMessages PRIMARY KEY AUTOINCREMENT,
    ConversationId TEXT NOT NULL,
    Role TEXT NOT NULL,
    Content TEXT NOT NULL,
    CharacterId TEXT NOT NULL DEFAULT '',
    ModelName TEXT NOT NULL DEFAULT '',
    Source TEXT NOT NULL DEFAULT 'normal_chat',
    CreatedAt TEXT NOT NULL,
    MetadataJson TEXT NOT NULL DEFAULT ''
);
-- table: CoreBackgroundTasks
CREATE TABLE CoreBackgroundTasks (TaskId TEXT PRIMARY KEY, TaskType TEXT NOT NULL, State INTEGER NOT NULL, Progress REAL NOT NULL, Message TEXT NOT NULL, ResultJson TEXT NOT NULL, Error TEXT NOT NULL, CreatedAt TEXT NOT NULL, UpdatedAt TEXT NOT NULL);
-- table: CryptoMarketEvents
CREATE TABLE CryptoMarketEvents (
    Id INTEGER NOT NULL CONSTRAINT PK_CryptoMarketEvents PRIMARY KEY AUTOINCREMENT,
    EventType TEXT NOT NULL,
    Source TEXT NOT NULL,
    Network TEXT NOT NULL,
    Symbol TEXT NOT NULL,
    Address TEXT NOT NULL,
    TransactionHash TEXT NOT NULL,
    Amount TEXT NULL,
    Price TEXT NULL,
    DedupeKey TEXT NOT NULL,
    PayloadJson TEXT NOT NULL,
    OccurredAt TEXT NOT NULL,
    CreatedAt TEXT NOT NULL
);
-- table: CryptoMarketProviderConfigurations
CREATE TABLE CryptoMarketProviderConfigurations (
    Id INTEGER NOT NULL CONSTRAINT PK_CryptoMarketProviderConfigurations PRIMARY KEY,
    IsEnabled INTEGER NOT NULL,
    ServiceUrl TEXT NOT NULL,
    TimeoutSeconds INTEGER NOT NULL,
    LastHealthStatus TEXT NOT NULL,
    LastHealthLatencyMs INTEGER NULL,
    LastCheckedAt TEXT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: CryptoMarketWatchlistItems
CREATE TABLE CryptoMarketWatchlistItems (
    Id INTEGER NOT NULL CONSTRAINT PK_CryptoMarketWatchlistItems PRIMARY KEY AUTOINCREMENT,
    Symbol TEXT NOT NULL,
    BaseAsset TEXT NOT NULL,
    QuoteAsset TEXT NOT NULL,
    MarketType TEXT NOT NULL,
    IsEnabled INTEGER NOT NULL,
    SortOrder INTEGER NOT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: DbColumnComments
CREATE TABLE DbColumnComments (
    Id INTEGER NOT NULL CONSTRAINT PK_DbColumnComments PRIMARY KEY AUTOINCREMENT,
    TableName TEXT NOT NULL,
    ColumnName TEXT NOT NULL,
    CommentZh TEXT NOT NULL,
    CommentEn TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: DesktopContextSnapshots
CREATE TABLE "DesktopContextSnapshots" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_DesktopContextSnapshots" PRIMARY KEY AUTOINCREMENT,
    "CapturedAt" TEXT NOT NULL,
    "TimePeriod" TEXT NOT NULL,
    "ForegroundWindowTitle" TEXT NOT NULL,
    "ForegroundProcessName" TEXT NOT NULL,
    "AppCategory" TEXT NOT NULL,
    "IdleSeconds" INTEGER NOT NULL,
    "IsFullscreen" INTEGER NOT NULL,
    "LastInteractionAt" TEXT NULL
);
-- table: DisturbanceSettings
CREATE TABLE "DisturbanceSettings" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_DisturbanceSettings" PRIMARY KEY AUTOINCREMENT,
    "Mode" TEXT NOT NULL,
    "QuietHoursEnabled" INTEGER NOT NULL,
    "QuietHoursStart" TEXT NOT NULL,
    "QuietHoursEnd" TEXT NOT NULL,
    "SuppressWhenFullscreen" INTEGER NOT NULL,
    "MaxProactivePerHour" INTEGER NOT NULL,
    "UpdatedAt" TEXT NOT NULL
);
-- table: LlmBusinessModelConfigs
CREATE TABLE LlmBusinessModelConfigs (
    Id INTEGER NOT NULL CONSTRAINT PK_LlmBusinessModelConfigs PRIMARY KEY AUTOINCREMENT,
    BusinessKey TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    Description TEXT NOT NULL,
    Provider TEXT NOT NULL DEFAULT 'Gemini',
    ModelKey TEXT NOT NULL DEFAULT 'Gemini',
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: LlmCallLogs
CREATE TABLE LlmCallLogs (
    Id INTEGER NOT NULL CONSTRAINT PK_LlmCallLogs PRIMARY KEY AUTOINCREMENT,
    CreatedAt TEXT NOT NULL,
    CompletedAt TEXT NULL,
    ConversationId TEXT NOT NULL,
    CorrelationId TEXT NOT NULL,
    Source TEXT NOT NULL,
    Provider TEXT NOT NULL,
    Model TEXT NOT NULL,
    Endpoint TEXT NOT NULL,
    RequestUrl TEXT NOT NULL,
    SystemPrompt TEXT NOT NULL,
    UserPrompt TEXT NOT NULL,
    RequestJson TEXT NOT NULL,
    ResponseStatusCode INTEGER NOT NULL,
    ResponseId TEXT NOT NULL,
    PreviousResponseId TEXT NOT NULL,
    RawResponseJson TEXT NOT NULL,
    ResponseText TEXT NOT NULL,
    ParsedResponseJson TEXT NOT NULL,
    AudioPath TEXT NOT NULL,
    VoiceId TEXT NOT NULL,
    Error TEXT NOT NULL,
    DurationMs INTEGER NOT NULL,
    UpdatedAt TEXT NOT NULL
, PromptTokens INTEGER NOT NULL DEFAULT 0, CompletionTokens INTEGER NOT NULL DEFAULT 0, TotalTokens INTEGER NOT NULL DEFAULT 0);
-- table: LlmChatConversations
CREATE TABLE LlmChatConversations (
            Id INTEGER NOT NULL CONSTRAINT PK_LlmChatConversations PRIMARY KEY AUTOINCREMENT,
            ConversationId TEXT NOT NULL,
            RoleId TEXT NOT NULL,
            Provider TEXT NOT NULL,
            Model TEXT NOT NULL,
            Summary TEXT NOT NULL,
            LastResponseId TEXT NOT NULL,
            IsActive INTEGER NOT NULL,
            CreatedAt TEXT NOT NULL,
            UpdatedAt TEXT NOT NULL
        );
-- table: LlmChatMessages
CREATE TABLE LlmChatMessages (
            Id INTEGER NOT NULL CONSTRAINT PK_LlmChatMessages PRIMARY KEY AUTOINCREMENT,
            MessageId TEXT NOT NULL,
            ConversationId TEXT NOT NULL,
            Role TEXT NOT NULL,
            Content TEXT NOT NULL,
            VoiceStyle TEXT NOT NULL,
            Provider TEXT NOT NULL,
            Model TEXT NOT NULL,
            ResponseId TEXT NOT NULL,
            CreatedAt TEXT NOT NULL
        );
-- table: LlmProviderSelections
CREATE TABLE LlmProviderSelections (
            Id INTEGER NOT NULL CONSTRAINT PK_LlmProviderSelections PRIMARY KEY,
            DefaultProvider TEXT NOT NULL,
            SelectedProvider TEXT NOT NULL,
            LocalQwenModel TEXT NOT NULL,
            GeminiModel TEXT NOT NULL,
            UpdatedAt TEXT NOT NULL
        );
-- table: LlmSourcePrompts
CREATE TABLE LlmSourcePrompts (
    Id INTEGER NOT NULL CONSTRAINT PK_LlmSourcePrompts PRIMARY KEY AUTOINCREMENT,
    SourceKey TEXT NOT NULL,
    Purpose TEXT NOT NULL,
    SystemPromptTemplate TEXT NOT NULL,
    UserPromptTemplate TEXT NOT NULL,
    OutputSchemaJson TEXT NOT NULL,
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: MaidStates
CREATE TABLE "MaidStates" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_MaidStates" PRIMARY KEY AUTOINCREMENT,
    "MaidId" TEXT NOT NULL,
    "ImagePath" TEXT NOT NULL,
    "Name" TEXT NOT NULL,
    "Mood" TEXT NOT NULL,
    "Favorability" INTEGER NOT NULL,
    "CompanionshipSeconds" INTEGER NOT NULL,
    "InteractionCount" INTEGER NOT NULL,
    "LastInteractionTime" TEXT NULL,
    "CreatedAt" TEXT NOT NULL,
    "UpdatedAt" TEXT NOT NULL
, IsCurrent INTEGER NOT NULL DEFAULT 0);
-- table: NotebookAttachments
CREATE TABLE NotebookAttachments (
        Id TEXT NOT NULL CONSTRAINT PK_NotebookAttachments PRIMARY KEY,
        NoteId TEXT NOT NULL,
        OriginalName TEXT NULL,
        StoredPath TEXT NOT NULL,
        MimeType TEXT NULL,
        SizeBytes INTEGER NOT NULL DEFAULT 0,
        Width INTEGER NULL,
        Height INTEGER NULL,
        Sha256 TEXT NULL,
        IsDeleted INTEGER NOT NULL DEFAULT 0,
        CreatedAt TEXT NOT NULL
    );
-- table: NotebookNotes
CREATE TABLE NotebookNotes (
        Id INTEGER NOT NULL CONSTRAINT PK_NotebookNotes PRIMARY KEY AUTOINCREMENT,
        NoteId TEXT NOT NULL,
        Title TEXT NOT NULL,
        ContentXaml TEXT NOT NULL,
        ImagePathsJson TEXT NOT NULL,
        CreatedAt TEXT NOT NULL,
        UpdatedAt TEXT NOT NULL
    , ContentRich TEXT NOT NULL DEFAULT '', ContentPlainText TEXT NOT NULL DEFAULT '', IsPinned INTEGER NOT NULL DEFAULT 0, IsDeleted INTEGER NOT NULL DEFAULT 0);
-- table: ProactiveBroadcastSourceSettings
CREATE TABLE ProactiveBroadcastSourceSettings (
    Id INTEGER NOT NULL CONSTRAINT PK_ProactiveBroadcastSourceSettings PRIMARY KEY AUTOINCREMENT,
    SourceKey TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    Enabled INTEGER NOT NULL,
    FrequencyMinutes INTEGER NOT NULL,
    CooldownMinutes INTEGER NOT NULL,
    MaxItems INTEGER NOT NULL,
    ParameterJson TEXT NOT NULL,
    Priority INTEGER NOT NULL DEFAULT 50,
    MinScore INTEGER NOT NULL DEFAULT 60,
    LastSnapshot TEXT NOT NULL,
    LastSnapshotHash TEXT NOT NULL DEFAULT '',
    LastScore INTEGER NOT NULL DEFAULT 0,
    LastSelectReason TEXT NOT NULL DEFAULT '',
    LastBroadcastMessage TEXT NOT NULL DEFAULT '',
    LastBroadcastMessageHash TEXT NOT NULL DEFAULT '',
    LastCollectedAt TEXT NULL,
    LastBroadcastAt TEXT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: ProactiveBroadcastTriggerLogs
CREATE TABLE ProactiveBroadcastTriggerLogs (
    Id INTEGER NOT NULL CONSTRAINT PK_ProactiveBroadcastTriggerLogs PRIMARY KEY AUTOINCREMENT,
    TriggeredAt TEXT NOT NULL,
    EventId TEXT NOT NULL,
    EventType TEXT NOT NULL,
    EventSource TEXT NOT NULL,
    RoleId TEXT NOT NULL,
    RoleDisplayName TEXT NOT NULL,
    VoiceId TEXT NOT NULL,
    IntimacyLevel INTEGER NOT NULL,
    AiProvider TEXT NOT NULL,
    ProcessName TEXT NOT NULL,
    WindowTitle TEXT NOT NULL,
    Scene TEXT NOT NULL,
    SelectedSourceKeys TEXT NOT NULL,
    CandidatesJson TEXT NOT NULL,
    PayloadJson TEXT NOT NULL,
    Responded INTEGER NOT NULL,
    Spoke INTEGER NOT NULL,
    Message TEXT NOT NULL,
    VoiceTrigger TEXT NOT NULL,
    AudioPath TEXT NOT NULL,
    Result TEXT NOT NULL,
    Reason TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: ProactiveTriggerRules
CREATE TABLE ProactiveTriggerRules (Id INTEGER PRIMARY KEY AUTOINCREMENT, RuleId TEXT NOT NULL, Enabled INTEGER NOT NULL, Event TEXT NOT NULL, ConditionJson TEXT NOT NULL, Priority INTEGER NOT NULL, CooldownSeconds INTEGER NOT NULL, DisturbanceLevel TEXT NOT NULL, AllowTts INTEGER NOT NULL, ActionTag TEXT NOT NULL, TextTemplatesJson TEXT NOT NULL, Source TEXT NOT NULL, CreatedAt TEXT NOT NULL, UpdatedAt TEXT NOT NULL);
-- table: ProactiveTriggerStates
CREATE TABLE ProactiveTriggerStates (Id INTEGER PRIMARY KEY AUTOINCREMENT, RuleId TEXT NOT NULL, LastTriggeredAt TEXT NULL, TriggerCount INTEGER NOT NULL, LastResult TEXT NOT NULL, UpdatedAt TEXT NOT NULL);
-- table: ReminderLogs
CREATE TABLE "ReminderLogs" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_ReminderLogs" PRIMARY KEY AUTOINCREMENT,
    "ReminderId" TEXT NOT NULL,
    "TriggeredAt" TEXT NOT NULL,
    "Result" TEXT NOT NULL,
    "PlayedTts" INTEGER NOT NULL
);
-- table: Reminders
CREATE TABLE "Reminders" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Reminders" PRIMARY KEY AUTOINCREMENT,
    "ReminderId" TEXT NOT NULL,
    "Title" TEXT NOT NULL,
    "Message" TEXT NOT NULL,
    "DueAt" TEXT NOT NULL,
    "Repeat" TEXT NOT NULL,
    "Enabled" INTEGER NOT NULL,
    "AllowTts" INTEGER NOT NULL,
    "LastTriggeredAt" TEXT NULL,
    "NextDueAt" TEXT NULL,
    "CreatedAt" TEXT NOT NULL,
    "UpdatedAt" TEXT NOT NULL
);
-- table: RemoteDownloadTasks
CREATE TABLE RemoteDownloadTasks (
    TaskId INTEGER NOT NULL CONSTRAINT PK_RemoteDownloadTasks PRIMARY KEY AUTOINCREMENT,
    VideoItemId INTEGER NULL,
    OriginalUrl TEXT NOT NULL DEFAULT '',
    Title TEXT NOT NULL DEFAULT '',
    AuthorName TEXT NOT NULL DEFAULT '',
    SiteName TEXT NOT NULL DEFAULT '',
    OutputPath TEXT NOT NULL DEFAULT '',
    QualityPreference TEXT NOT NULL DEFAULT '',
    Status TEXT NOT NULL DEFAULT 'Queued',
    Progress REAL NOT NULL DEFAULT 0,
    SpeedText TEXT NOT NULL DEFAULT '',
    EtaText TEXT NOT NULL DEFAULT '',
    ErrorMessage TEXT NOT NULL DEFAULT '',
    FileSize INTEGER NOT NULL DEFAULT 0,
    CreatedAt TEXT NOT NULL,
    StartedAt TEXT NULL,
    FinishedAt TEXT NULL
);
-- table: RemotePlayHistories
CREATE TABLE RemotePlayHistories (
    Id INTEGER NOT NULL CONSTRAINT PK_RemotePlayHistories PRIMARY KEY AUTOINCREMENT,
    VideoItemId INTEGER NULL,
    OriginalUrl TEXT NOT NULL DEFAULT '',
    Title TEXT NOT NULL DEFAULT '',
    AuthorName TEXT NOT NULL DEFAULT '',
    SiteName TEXT NOT NULL DEFAULT '',
    PlayAction TEXT NOT NULL DEFAULT '',
    CoverUrl TEXT NOT NULL DEFAULT '',
    CachePath TEXT NOT NULL DEFAULT '',
    PlayedAt TEXT NOT NULL
);
-- table: RemoteSiteConfigs
CREATE TABLE "RemoteSiteConfigs" (
    Id INTEGER NOT NULL CONSTRAINT PK_VideoSiteConfigs PRIMARY KEY AUTOINCREMENT,
    SiteName TEXT NOT NULL DEFAULT '',
    DomainPattern TEXT NOT NULL DEFAULT '',
    CookieFilePath TEXT NOT NULL DEFAULT '',
    UserAgent TEXT NOT NULL DEFAULT '',
    Referer TEXT NOT NULL DEFAULT '',
    QualityPreference TEXT NOT NULL DEFAULT 'best',
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    Remark TEXT NOT NULL DEFAULT '',
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
, SupportedActions TEXT NOT NULL DEFAULT 'DirectStream,CachePlay,Download', DefaultPlayAction TEXT NOT NULL DEFAULT 'DirectStream', CookieContent TEXT NOT NULL DEFAULT '', CookieContentFormat TEXT NOT NULL DEFAULT 'Auto', CookieUpdatedAt TEXT NULL, CookieRemark TEXT NOT NULL DEFAULT '', DownloadRootOverride TEXT NOT NULL DEFAULT '', AdapterKey TEXT NOT NULL DEFAULT '');
-- table: RemoteVideoItems
CREATE TABLE RemoteVideoItems (
    Id INTEGER NOT NULL CONSTRAINT PK_RemoteVideoItems PRIMARY KEY AUTOINCREMENT,
    SiteName TEXT NOT NULL DEFAULT '',
    Extractor TEXT NOT NULL DEFAULT '',
    VideoId TEXT NOT NULL DEFAULT '',
    OriginalUrl TEXT NOT NULL DEFAULT '',
    Title TEXT NOT NULL DEFAULT '',
    AuthorName TEXT NOT NULL DEFAULT '',
    AuthorId TEXT NOT NULL DEFAULT '',
    Duration INTEGER NOT NULL DEFAULT 0,
    DurationText TEXT NOT NULL DEFAULT '',
    CoverUrl TEXT NOT NULL DEFAULT '',
    CoverPath TEXT NOT NULL DEFAULT '',
    PublishTime TEXT NULL,
    Description TEXT NOT NULL DEFAULT '',
    LocalFilePath TEXT NOT NULL DEFAULT '',
    DownloadStatus TEXT NOT NULL DEFAULT 'None',
    LastResolvedAt TEXT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: RemoteVideoSettings
CREATE TABLE RemoteVideoSettings (
    Id INTEGER NOT NULL CONSTRAINT PK_RemoteVideoSettings PRIMARY KEY,
    DownloadRoot TEXT NOT NULL DEFAULT '',
    CacheRoot TEXT NOT NULL DEFAULT '',
    DefaultQualityPreference TEXT NOT NULL DEFAULT 'best',
    FileNameTemplate TEXT NOT NULL DEFAULT '{site}\{author}\{title} [{id}].{ext}',
    DownloadThumbnail INTEGER NOT NULL DEFAULT 1,
    DownloadInfoJson INTEGER NOT NULL DEFAULT 1,
    DownloadSubtitles INTEGER NOT NULL DEFAULT 0,
    DownloadDanmaku INTEGER NOT NULL DEFAULT 0,
    OverwriteExisting INTEGER NOT NULL DEFAULT 1,
    AutoImportToVideoLibrary INTEGER NOT NULL DEFAULT 1,
    MaxConcurrentDownloads INTEGER NOT NULL DEFAULT 3,
    CacheRetentionHours INTEGER NOT NULL DEFAULT 24,
    CacheMaxSizeGb REAL NOT NULL DEFAULT 10,
    UpdatedAt TEXT NOT NULL
);
-- table: sqlite_sequence
CREATE TABLE sqlite_sequence(name,seq);
-- table: TimerRecords
CREATE TABLE "TimerRecords" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_TimerRecords" PRIMARY KEY AUTOINCREMENT,
    "SavedAt" TEXT NOT NULL,
    "Mode" INTEGER NOT NULL,
    "DisplayText" TEXT NOT NULL,
    "DurationSeconds" INTEGER NOT NULL,
    "Status" TEXT NOT NULL
, "RecordId" TEXT NULL);
-- table: UserProfiles
CREATE TABLE "UserProfiles" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_UserProfiles" PRIMARY KEY AUTOINCREMENT,
    "PreferredRole" TEXT NOT NULL,
    "PreferredModel" TEXT NOT NULL,
    "PreferredVoiceId" TEXT NOT NULL,
    "DislikedPhrasesJson" TEXT NOT NULL,
    "UpdatedAt" TEXT NOT NULL
);
-- table: VaultItemHistories
CREATE TABLE VaultItemHistories (
    Id INTEGER NOT NULL CONSTRAINT PK_VaultItemHistories PRIMARY KEY AUTOINCREMENT,
    ItemId INTEGER NOT NULL,
    FieldName TEXT NOT NULL,
    OldValueEncrypted TEXT NULL,
    NewValueEncrypted TEXT NULL,
    ChangeRemark TEXT NULL,
    CreatedAt TEXT NOT NULL
);
-- table: VaultItems
CREATE TABLE VaultItems (
    Id INTEGER NOT NULL CONSTRAINT PK_VaultItems PRIMARY KEY AUTOINCREMENT,
    ItemType TEXT NOT NULL,
    Name TEXT NOT NULL,
    Category TEXT NULL,
    Account TEXT NULL,
    PasswordEncrypted TEXT NULL,
    Url TEXT NULL,
    Platform TEXT NULL,
    ApiKeyEncrypted TEXT NULL,
    SecretEncrypted TEXT NULL,
    ChainType TEXT NULL,
    WalletAddress TEXT NULL,
    PrivateKeyEncrypted TEXT NULL,
    MnemonicEncrypted TEXT NULL,
    ServerAddress TEXT NULL,
    ServerPort TEXT NULL,
    Remark TEXT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: VideoAlbums
CREATE TABLE VideoAlbums (
    Id INTEGER NOT NULL CONSTRAINT PK_VideoAlbums PRIMARY KEY AUTOINCREMENT,
    Name TEXT NOT NULL DEFAULT '',
    Description TEXT NOT NULL DEFAULT '',
    CoverVideoId INTEGER NULL,
    SortOrder INTEGER NOT NULL DEFAULT 0,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
, CoverPath TEXT NOT NULL DEFAULT '');
-- table: VideoItems
CREATE TABLE VideoItems (
    Id INTEGER NOT NULL CONSTRAINT PK_VideoItems PRIMARY KEY AUTOINCREMENT,
    SourceType TEXT NOT NULL DEFAULT 'LocalFile',
    Title TEXT NOT NULL DEFAULT '',
    FileName TEXT NOT NULL DEFAULT '',
    FilePath TEXT NOT NULL DEFAULT '',
    OriginalUrl TEXT NOT NULL DEFAULT '',
    ResolvedPlayUrl TEXT NOT NULL DEFAULT '',
    CoverPath TEXT NOT NULL DEFAULT '',
    DurationSeconds INTEGER NOT NULL DEFAULT 0,
    LastPositionSeconds INTEGER NOT NULL DEFAULT 0,
    IsFavorite INTEGER NOT NULL DEFAULT 0,
    IsCompleted INTEGER NOT NULL DEFAULT 0,
    Tags TEXT NOT NULL DEFAULT '',
    SubtitlePath TEXT NOT NULL DEFAULT '',
    SubtitleFolderId INTEGER NULL,
    LastPlayedAt TEXT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL,
    FileSize INTEGER NOT NULL DEFAULT 0,
    FileModifiedAt TEXT NULL,
    Remark TEXT NOT NULL DEFAULT ''
, CoverStatus TEXT NOT NULL DEFAULT 'Pending', PreviewStatus TEXT NOT NULL DEFAULT 'None', PreviewIndexPath TEXT NOT NULL DEFAULT '', PreviewGeneratedAt TEXT NULL, PreviewError TEXT NOT NULL DEFAULT '', AlbumId INTEGER NULL, BaseName TEXT NOT NULL DEFAULT '', Extension TEXT NOT NULL DEFAULT '', LastWriteTime TEXT NULL);
-- table: VideoPlaybackHistories
CREATE TABLE VideoPlaybackHistories (
    Id INTEGER NOT NULL CONSTRAINT PK_VideoPlaybackHistories PRIMARY KEY AUTOINCREMENT,
    VideoItemId INTEGER NOT NULL,
    PositionSeconds INTEGER NOT NULL DEFAULT 0,
    DurationSeconds INTEGER NOT NULL DEFAULT 0,
    PlayedAt TEXT NOT NULL
);
-- table: VideoSubtitleBindings
CREATE TABLE VideoSubtitleBindings (
    Id INTEGER NOT NULL CONSTRAINT PK_VideoSubtitleBindings PRIMARY KEY AUTOINCREMENT,
    VideoId INTEGER NOT NULL,
    SubtitlePath TEXT NOT NULL DEFAULT '',
    MatchType TEXT NOT NULL DEFAULT 'ExactBaseName',
    CreatedAt TEXT NOT NULL
);
-- table: VideoTagDefinitions
CREATE TABLE VideoTagDefinitions (
    Id INTEGER NOT NULL CONSTRAINT PK_VideoTagDefinitions PRIMARY KEY AUTOINCREMENT,
    Name TEXT NOT NULL DEFAULT '',
    CreatedAt TEXT NOT NULL
);
-- table: VoiceAssets
CREATE TABLE VoiceAssets (
    Id INTEGER NOT NULL CONSTRAINT PK_VoiceAssets PRIMARY KEY AUTOINCREMENT,
    VoiceId TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    VoiceFolderPath TEXT NOT NULL DEFAULT '',
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: VoiceCacheDedupeLogs
CREATE TABLE VoiceCacheDedupeLogs (
            Id INTEGER NOT NULL CONSTRAINT PK_VoiceCacheDedupeLogs PRIMARY KEY AUTOINCREMENT,
            CacheKey TEXT NOT NULL,
            RoleId TEXT NOT NULL,
            TriggerType TEXT NOT NULL,
            Scene TEXT NOT NULL,
            Tier TEXT NOT NULL,
            Text TEXT NOT NULL,
            VoiceStyle TEXT NOT NULL,
            DedupeStatus TEXT NOT NULL,
            DuplicateReason TEXT NOT NULL,
            AttemptIndex INTEGER NOT NULL,
            Source TEXT NOT NULL,
            CreatedAt TEXT NOT NULL
        );
-- table: VoiceCacheGenerations
CREATE TABLE VoiceCacheGenerations (
    GenerationId TEXT PRIMARY KEY, RoleId TEXT NOT NULL, IntimacyLevel INTEGER NOT NULL,
    CacheKey TEXT NOT NULL, ContextHash TEXT NOT NULL, CatalogVersion TEXT NOT NULL,
    Status TEXT NOT NULL, TotalEntries INTEGER NOT NULL, CompletedEntries INTEGER NOT NULL,
    PeriodStartAt TEXT NOT NULL, PeriodEndAt TEXT NOT NULL, ErrorCode TEXT NOT NULL DEFAULT '',
    ErrorMessage TEXT NOT NULL DEFAULT '', CreatedAt TEXT NOT NULL, UpdatedAt TEXT NOT NULL);
-- table: VoiceConversations
CREATE TABLE VoiceConversations (
    ConversationId TEXT NOT NULL CONSTRAINT PK_VoiceConversations PRIMARY KEY,
    VoiceRoleId TEXT NOT NULL,
    Title TEXT NOT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: VoiceRoleAudioCaches
CREATE TABLE VoiceRoleAudioCaches (
    Id INTEGER NOT NULL CONSTRAINT PK_VoiceRoleAudioCaches PRIMARY KEY AUTOINCREMENT,
    CacheKind TEXT NOT NULL,
    CacheKey TEXT NOT NULL DEFAULT '',
    RoleId TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    VoiceId TEXT NOT NULL,
    Style TEXT NOT NULL DEFAULT '',
    IntimacyLevel INTEGER NOT NULL,
    TierId TEXT NOT NULL,
    TierName TEXT NOT NULL,
    TriggerId TEXT NOT NULL,
    Category TEXT NOT NULL,
    BodyPart TEXT NOT NULL,
    Emotion TEXT NOT NULL,
    Text TEXT NOT NULL,
    TextHash TEXT NOT NULL DEFAULT '',
    AudioPath TEXT NOT NULL,
    ExpiresAt TEXT NULL,
    IsEnabled INTEGER NOT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
, "GenerationId" TEXT NOT NULL DEFAULT '', "ContextHash" TEXT NOT NULL DEFAULT '');
-- table: VoiceRoleBindings
CREATE TABLE VoiceRoleBindings (
    Id INTEGER NOT NULL CONSTRAINT PK_VoiceRoleBindings PRIMARY KEY AUTOINCREMENT,
    TargetType TEXT NOT NULL,
    TargetKey TEXT NOT NULL,
    RoleId TEXT NOT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: VoiceRoleCards
CREATE TABLE VoiceRoleCards (
    Id INTEGER NOT NULL CONSTRAINT PK_VoiceRoleCards PRIMARY KEY AUTOINCREMENT,
    RoleId TEXT NOT NULL,
    Name TEXT NOT NULL,
    VoiceName TEXT NOT NULL,
    RoleTitle TEXT NOT NULL,
    CardPath TEXT NOT NULL,
    SourceCardJson TEXT NOT NULL,
    CardSummary TEXT NOT NULL DEFAULT '',
    CardSchemaVersion TEXT NOT NULL DEFAULT '',
    PreferredVoiceId TEXT NOT NULL,
    ValidationStatus TEXT NOT NULL DEFAULT 'unknown',
    ValidationMessage TEXT NOT NULL DEFAULT '',
    LastValidatedAt TEXT NULL,
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
, TemplateCardJson TEXT NOT NULL DEFAULT '', TemplateCardGeneratedAt TEXT NULL, TemplateCardSourceHash TEXT NOT NULL DEFAULT '', TemplateCardGenerationStatus TEXT NOT NULL DEFAULT 'missing', TemplateCardGenerationMessage TEXT NOT NULL DEFAULT '', TemplateCardLastAttemptAt TEXT NULL, TemplateCardIterationCount INTEGER NOT NULL DEFAULT 0, "AvatarPath" TEXT NOT NULL DEFAULT '');
-- table: VoiceRoles
CREATE TABLE VoiceRoles (
    Id INTEGER NOT NULL CONSTRAINT PK_VoiceRoles PRIMARY KEY AUTOINCREMENT,
    RoleId TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    AvatarPath TEXT NOT NULL DEFAULT '',
    SortOrder INTEGER NOT NULL DEFAULT 0,
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: VoiceRoleVoices
CREATE TABLE VoiceRoleVoices (
    Id INTEGER NOT NULL CONSTRAINT PK_VoiceRoleVoices PRIMARY KEY AUTOINCREMENT,
    RoleId TEXT NOT NULL,
    VoiceId TEXT NOT NULL,
    Style TEXT NOT NULL,
    IsDefault INTEGER NOT NULL,
    IsEnabled INTEGER NOT NULL,
    CreatedAt TEXT NOT NULL,
    UpdatedAt TEXT NOT NULL
);
-- table: VoiceTriggerLogs
CREATE TABLE "VoiceTriggerLogs" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_VoiceTriggerLogs" PRIMARY KEY AUTOINCREMENT,
    "CreatedAt" TEXT NOT NULL,
    "Source" TEXT NOT NULL,
    "TriggerId" TEXT NOT NULL,
    "RoleId" TEXT NOT NULL,
    "Category" TEXT NOT NULL,
    "BodyPart" TEXT NOT NULL,
    "Played" INTEGER NOT NULL,
    "Reason" TEXT NOT NULL,
    "Text" TEXT NOT NULL,
    "AudioPath" TEXT NOT NULL
, "GenerationId" TEXT NOT NULL DEFAULT '', "ContextHash" TEXT NOT NULL DEFAULT '', "HitAreaName" TEXT NOT NULL DEFAULT '', "NormalizedX" REAL NULL, "NormalizedY" REAL NULL);
