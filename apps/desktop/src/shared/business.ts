export interface ReminderDto {
  reminderId: string
  title: string
  message: string
  dueAt: string
  repeat: 'none' | 'daily'
  enabled: boolean
  allowTts: boolean
  lastTriggeredAt: string | null
  nextDueAt: string | null
  createdAt: string
  updatedAt: string
  voiceStyle?: string
}

export interface ReminderSavePayload {
  reminderId: string | null
  title: string
  message: string
  dueAt: string
  repeat: 'none' | 'daily'
  enabled: boolean
  allowTts: boolean
}

export interface CharacterDto {
  roleId: string
  name: string
  voiceName: string
  roleTitle: string
  cardPath: string
  sourceCardJson: string
  templateCardJson: string
  preferredVoiceId: string
  validationStatus: string
  isEnabled: boolean
  updatedAt: string
  cardSummary: string
  cardSchemaVersion: string
  templateCardSourceHash: string
  templateCardGenerationStatus: string
  templateCardGenerationMessage: string
  templateCardGeneratedAt: string | null
  templateCardLastAttemptAt: string | null
  templateCardIterationCount: number
  validationMessage: string
  lastValidatedAt: string | null
  avatarPath: string
}

export interface VoiceAssetDto { voiceId: string; displayName: string; voiceFolderPath: string; isEnabled: boolean; updatedAt: string }
export interface RoleVoiceDto { roleId: string; voiceId: string; style: string; isDefault: boolean; isEnabled: boolean; updatedAt: string }
export interface CharacterObjectBindingDto { targetType: string; targetKey: string; roleId: string; createdAt: string; updatedAt: string }
export interface AgentCapabilityDto {
  capabilityName: string; displayName: string; description: string; executorType: string
  configJson: string; argsSchemaJson: string; resultPolicy: string; riskLevel: string
  requireConfirm: boolean; enabled: boolean; sortOrder: number; updatedAt: string
}
export interface AgentToolCallDto {
  callId: string; conversationId: string; capabilityName: string; argsJson: string; status: string
  exitCode: number | null; output: string; error: string; confirmedByUser: boolean; rejectedByUser: boolean
  createdAt: string; finishedAt: string | null
}
export interface AgentConfirmationRequest {
  requestId: string; capabilityName: string; displayName: string; summary: string
  executorType: string; riskLevel: string; argsJson: string
}

export interface ChatMessageDto {
  id: number
  conversationId: string
  role: string
  content: string
  characterId: string
  modelName: string
  source: string
  metadataJson: string
  createdAt: string
}

export interface NotebookNoteDto {
  noteId: string
  title: string
  contentMarkdown: string
  contentPlainText: string
  attachmentIds: string[]
  isPinned: boolean
  isDeleted: boolean
  createdAt: string
  updatedAt: string
}

export interface VoiceConversationDto {
  conversationId: string
  voiceRoleId: string
  title: string
  preview: string
  createdAt: string
  updatedAt: string
}

export interface ChatCommandLauncherDto {
  launcherId: string
  commandText: string
  displayName: string
  exePath: string
  arguments: string
  workingDirectory: string
  enabled: boolean
  updatedAt: string
}

export interface TimerRecordDto { recordId: string; savedAt: string; durationSeconds: number }
export interface RemoteSiteDto { siteId: string; siteName: string; domainPattern: string; adapterKey: string; qualityPreference: string; isEnabled: boolean; settingsJson: string; updatedAt: string; hasProtectedCookie: boolean }
export interface RemoteSiteDetailDto { site: RemoteSiteDto }
export interface RemoteVideoFormatDto { formatId: string; selector: string; displayName: string; width: number | null; height: number | null; fps: number | null; hasVideo: boolean; hasAudio: boolean; fileSize: number | null }
export interface RemoteVideoResolvedItemDto { itemId: string; originalUrl: string; title: string; author: string; siteName: string; videoId: string; durationSeconds: number; thumbnailUrl: string; publishedAt: string | null; isLive: boolean; downloadStatus: string; formats: RemoteVideoFormatDto[] }
export interface RemoteVideoResolveResultDto { items: RemoteVideoResolvedItemDto[]; diagnosticSummary: string }
export interface RemoteVideoDownloadDto { taskId: string; itemId: string; originalUrl: string; title: string; author: string; siteName: string; outputPath: string; quality: string; status: 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled'; progress: number; speed: string; eta: string; errorMessage: string; fileSize: number; createdAt: string; startedAt: string | null; finishedAt: string | null }
export interface RemoteVideoPlayHistoryDto { historyId: string; itemId: string | null; originalUrl: string; title: string; author: string; siteName: string; action: string; cachePath: string; playedAt: string }
export interface RemoteVideoSettingsDto { downloadRoot: string; cacheRoot: string; fileNameTemplate: string; defaultQualityPreference: string; downloadThumbnail: boolean; downloadInfoJson: boolean; downloadSubtitles: boolean; overwriteExisting: boolean; autoImportToVideoLibrary: boolean; maxConcurrentDownloads: number; ytDlpPath: string; ffmpegPath: string; potPlayerPath: string; updatedAt: string }
export interface RemoteVideoDiagnosticsDto { checkedAt: string; ytDlpPath: string; ytDlpExists: boolean; ffmpegPath: string; ffmpegExists: boolean; potPlayerPath: string; potPlayerExists: boolean; downloadRoot: string; downloadRootWritable: boolean; activeDownloads: number; lastOperation: string; lastStatus: string; lastMessage: string }
export interface CryptoProviderConfigurationDto { isEnabled: boolean; serviceUrl: string; timeoutSeconds: number; lastHealthStatus: string; lastHealthLatencyMs: number | null; lastCheckedAt: string | null }
export interface MarketSymbolDto { symbol: string; baseAsset: string; quoteAsset: string; marketType: string }
export interface MarketSnapshotDto { symbol: string; lastPrice: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number; fundingRate: number | null; openInterest: number | null; bidAskRatio: number | null; updatedAt: string }
export interface MarketCandleDto { openTime: string; open: number; high: number; low: number; close: number; volume: number }
export interface MarketChartSnapshotDto { symbol: string; interval: string; emaPeriods: number[]; candles: MarketCandleDto[]; updatedAt: string }
export interface MarketEventDto { eventId: string; eventType: string; source: string; network: string; symbol: string; address: string; transactionHash: string; amount: number | null; price: number | null; dedupeKey: string; payloadJson: string; occurredAt: string }
export interface DisturbanceSettingsDto { mode: 'normal' | 'quiet' | 'focus' | 'game' | 'sleep'; quietHoursEnabled: boolean; quietHoursStart: string; quietHoursEnd: string; suppressWhenFullscreen: boolean; maxProactivePerHour: number; updatedAt: string }
export interface ProactiveSourceDto {
  sourceKey: string; displayName: string; enabled: boolean; priority: number; frequencyMinutes: number
  cooldownMinutes: number; maxItems: number; parameterJson: string; minScore: number
  lastCollectedAt: string | null; lastSnapshot: string; lastSnapshotHash: string; lastScore: number
  lastSelectReason: string; lastBroadcastAt: string | null; lastBroadcastMessage: string
  lastBroadcastMessageHash: string; updatedAt: string; isConfigured: boolean
  isImplemented: boolean; statusText: string
}
export interface AppearanceConfigurationDto { themeId: string; contentBrightness: string; fontFamily: string; fontScale: number; cornerRadiusStyle: string; density: string; headerStyle: string; animationsEnabled: boolean }

export interface VideoItemDto {
  videoId: string
  sourceType: string
  title: string
  filePath: string
  originalUrl: string
  coverPath: string
  tags: string
  subtitlePath: string
  isFavorite: boolean
  createdAt: string
  updatedAt: string
  albumId: string | null
  durationSeconds: number
  lastPositionSeconds: number
  isCompleted: boolean
  fileSize: number
  lastPlayedAt: string | null
  remark: string
  coverStatus: 'Pending' | 'Ready' | 'Failed'
  isFileMissing: boolean
}

export interface VideoAlbumDto {
  albumId: string
  name: string
  description: string
  coverPath: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface VideoLibrarySnapshotDto { items: VideoItemDto[]; albums: VideoAlbumDto[]; tags: string[] }
export interface VideoImportFileResultDto { status: 'New' | 'Updated' | 'Existing'; item: VideoItemDto; coverError?: string | null }
export interface VideoImportResultDto { importedCount: number; items: VideoItemDto[]; updatedCount: number; existingCount: number; failedCount: number; coverFailedCount: number }
export interface VideoDependencyStatusDto {
  potPlayerBridgePath: string; potPlayerBridgeAvailable: boolean
  potPlayerPath: string; potPlayerAvailable: boolean
  playlistPath: string; playlistAvailable: boolean
  ffmpegPath: string; ffmpegAvailable: boolean
  ffprobePath: string; ffprobeAvailable: boolean
  ytDlpPath: string; ytDlpAvailable: boolean
}

export interface SubtitleItemDto {
  name: string
  path: string
}

export interface VaultItemDto {
  itemId: string
  itemType: string
  name: string
  category: string
  account: string
  url: string
  platform: string
  publicMetadataJson: string
  hasProtectedSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface VaultItemDetailDto {
  item: VaultItemDto
  secret: string | null
}

export interface VaultHistoryDto {
  historyId: string
  itemId: string
  fieldName: string
  changeRemark: string
  createdAt: string
}

export interface ModelConfigurationDto {
  modelKey: string
  type: 'local' | 'api'
  endpoint: string
  model: string
  apiKey: string
  enableWebSearch: boolean
  think: boolean
}

export interface LlmBusinessModelConfigDto {
  businessKey: string
  displayName: string
  description: string
  provider: string
  modelKey: string
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface LlmSourcePromptDto {
  sourceKey: string
  purpose: string
  systemPromptTemplate: string
  userPromptTemplate: string
  outputSchemaJson: string
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}
