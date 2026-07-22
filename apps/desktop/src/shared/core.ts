import type { AgentCapabilityDto, AppearanceConfigurationDto, CharacterDto, ChatCommandLauncherDto, CryptoProviderConfigurationDto, DisturbanceSettingsDto, LlmBusinessModelConfigDto, LlmSourcePromptDto, MarketEventDto, ModelConfigurationDto, NotebookNoteDto, ReminderSavePayload, RemoteSiteDto, RemoteVideoSettingsDto, RoleVoiceDto, TimerRecordDto, VaultItemDto, VoiceConversationDto } from './business'

export const CORE_PROTOCOL_VERSION = '1.0' as const

export const CORE_DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const CORE_LONG_REQUEST_TIMEOUT_MS = 120_000

const LONG_RUNNING_CORE_REQUEST_TYPES = new Set<string>([
  'chat.send',
  'tts.speak',
  'asr.transcribe',
  'agent.execute',
  'agent.decide',
  'character.template.generate',
  'remote_video.resolve',
  'remote_video.thumbnail',
  'remote_video.formats',
  'remote_video.play',
  'remote_video.play.replay',
  'remote_video.download.play',
  'vault.export',
  'crypto_provider.check'
])

export function coreRequestTimeoutMs(type: CoreRequest['type']): number {
  return LONG_RUNNING_CORE_REQUEST_TYPES.has(type)
    ? CORE_LONG_REQUEST_TIMEOUT_MS
    : CORE_DEFAULT_REQUEST_TIMEOUT_MS
}

export type CoreRequest =
  | { type: 'system.health'; payload: Record<string, never> }
  | { type: 'system.window.fit_virtual_desktop'; payload: { windowHandle: string } }
  | { type: 'settings.get'; payload: { keys?: string[] } }
  | { type: 'settings.save'; payload: { values: Record<string, string> } }
  | { type: 'chat.history'; payload: { conversationId?: string; limit?: number } }
  | { type: 'chat.send'; payload: { content: string; conversationId?: string; characterId?: string; modelName?: string } }
  | { type: 'chat.update_metadata'; payload: { messageId: number; metadataJson: string } }
  | { type: 'tts.speak'; payload: { text: string; voiceId?: string; style?: string } }
  | { type: 'asr.transcribe'; payload: { audioPath: string; characterId: string; sessionId?: string; language?: string; requestId?: string } }
  | { type: 'voice_conversation.list'; payload: { roleId?: string; search?: string } }
  | { type: 'voice_conversation.save'; payload: { conversation: VoiceConversationDto } }
  | { type: 'voice_conversation.delete'; payload: { conversationId: string } }
  | { type: 'script.list'; payload: Record<string, never> }
  | { type: 'script.save'; payload: { launcher: ChatCommandLauncherDto } }
  | { type: 'script.run'; payload: { launcherId: string } }
  | { type: 'timer_record.list'; payload: Record<string, never> }
  | { type: 'timer_record.save'; payload: { record: TimerRecordDto } }
  | { type: 'timer_record.delete'; payload: { recordId: string } }
  | { type: 'remote_site.list'; payload: { enabledOnly?: boolean } }
  | { type: 'remote_site.get'; payload: { siteId: string; includeCookie?: boolean } }
  | { type: 'remote_site.save'; payload: { site: RemoteSiteDto; plainCookie: string | null } }
  | { type: 'remote_site.delete'; payload: { siteId: string } }
  | { type: 'remote_video.resolve'; payload: { input: string } }
  | { type: 'remote_video.thumbnail'; payload: { itemId: string } }
  | { type: 'remote_video.formats'; payload: { itemId: string } }
  | { type: 'remote_video.play'; payload: { itemId: string; formatSelector?: string; mode: 'direct' | 'cache' } }
  | { type: 'remote_video.download.start'; payload: { itemIds: string[]; formatSelector?: string } }
  | { type: 'remote_video.download.cancel'; payload: { taskId: string } }
  | { type: 'remote_video.download.list'; payload: Record<string, never> }
  | { type: 'remote_video.download.delete'; payload: { taskId: string } }
  | { type: 'remote_video.download.play'; payload: { taskId: string } }
  | { type: 'remote_video.play.list'; payload: Record<string, never> }
  | { type: 'remote_video.play.replay'; payload: { historyId: string } }
  | { type: 'remote_video.settings.get'; payload: Record<string, never> }
  | { type: 'remote_video.settings.save'; payload: { settings: RemoteVideoSettingsDto } }
  | { type: 'remote_video.diagnostics'; payload: Record<string, never> }
  | { type: 'crypto_provider.get'; payload: Record<string, never> }
  | { type: 'crypto_provider.save'; payload: { configuration: CryptoProviderConfigurationDto } }
  | { type: 'crypto_provider.check'; payload: { configuration: CryptoProviderConfigurationDto } }
  | { type: 'market.symbols'; payload: Record<string, never> }
  | { type: 'market.snapshot'; payload: { symbol: string } }
  | { type: 'market.chart_snapshot'; payload: { symbol: string; interval: string; emaPeriods: number[] } }
  | { type: 'market.list'; payload: { symbol?: string; limit?: number } }
  | { type: 'market.record'; payload: { marketEvent: MarketEventDto } }
  | { type: 'notebook.list'; payload: Record<string, never> }
  | { type: 'notebook.save'; payload: { note: NotebookNoteDto } }
  | { type: 'notebook.delete'; payload: { noteId: string } }
  | { type: 'video.list'; payload: { favoritesOnly?: boolean } }
  | { type: 'video.import_file'; payload: { filePath: string; albumId?: string | null } }
  | { type: 'video.import_folder'; payload: { folderPath: string; recursive: boolean; albumId?: string | null } }
  | { type: 'video.refresh_metadata'; payload: { videoIds: string[] } }
  | { type: 'video.toggle_favorite'; payload: { videoId: string } }
  | { type: 'video.set_display_name'; payload: { videoId: string; displayName: string } }
  | { type: 'video.set_remark'; payload: { videoId: string; remark: string } }
  | { type: 'video.update_progress'; payload: { videoId: string; positionSeconds: number; durationSeconds: number } }
  | { type: 'video.album.create'; payload: { name: string; description?: string } }
  | { type: 'video.album.rename'; payload: { albumId: string; name: string } }
  | { type: 'video.album.delete'; payload: { albumId: string } }
  | { type: 'video.album.move'; payload: { videoIds: string[]; albumId: string | null } }
  | { type: 'video.tag.create'; payload: { tag: string } }
  | { type: 'video.tag.rename'; payload: { oldTag: string; newTag: string } }
  | { type: 'video.tag.delete'; payload: { tag: string } }
  | { type: 'video.tag.set'; payload: { videoIds: string[]; tags: string } }
  | { type: 'video.remove_records'; payload: { videoIds: string[] } }
  | { type: 'video.delete_local_files'; payload: { videoIds: string[] } }
  | { type: 'video.play'; payload: { videoIds: string[]; startVideoId: string } }
  | { type: 'video.dependencies'; payload: Record<string, never> }
  | { type: 'subtitle.list'; payload: Record<string, never> }
  | { type: 'subtitle.import'; payload: { sourcePath: string } }
  | { type: 'subtitle.import_folder'; payload: { folderPath: string } }
  | { type: 'subtitle.delete'; payload: { path: string } }
  | { type: 'vault.list'; payload: { itemType?: string } }
  | { type: 'vault.get'; payload: { itemId: string } }
  | { type: 'vault.secret.reveal'; payload: { itemId: string } }
  | { type: 'vault.save'; payload: { item: VaultItemDto; plainSecret: string | null } }
  | { type: 'vault.delete'; payload: { itemId: string } }
  | { type: 'vault.history.list'; payload: { itemId: string } }
  | { type: 'vault.history.restore'; payload: { historyId: string } }
  | { type: 'vault.export'; payload: { outputPath: string } }
  | { type: 'reminder.list'; payload: Record<string, never> }
  | { type: 'reminder.save'; payload: ReminderSavePayload }
  | { type: 'reminder.delete'; payload: { reminderId: string } }
  | { type: 'reminder.set_enabled'; payload: { reminderId: string; enabled: boolean } }
  | { type: 'reminder.set_allow_tts'; payload: { reminderId: string; allowTts: boolean } }
  | { type: 'reminder.process_due'; payload: { now: string; reminderIds?: string[] } }
  | { type: 'character.list'; payload: Record<string, never> }
  | { type: 'character.set_current'; payload: { roleId: string } }
  | { type: 'character.save'; payload: { character: CharacterDto } }
  | { type: 'character.delete'; payload: { roleId: string } }
  | { type: 'character.voice_assets'; payload: Record<string, never> }
  | { type: 'character.voice_asset.add'; payload: { baseName: string; displayName: string; style: string; sourceFolderPath: string } }
  | { type: 'character.avatar.import'; payload: { sourcePath: string } }
  | { type: 'character.voices'; payload: { roleId: string } }
  | { type: 'character.voices.set'; payload: { roleId: string; voices: RoleVoiceDto[] } }
  | { type: 'character.binding.get'; payload: { targetKey: string } }
  | { type: 'character.binding.set'; payload: { targetKey: string; roleId: string } }
  | { type: 'character.binding.clear'; payload: { targetKey: string } }
  | { type: 'character.template.generate'; payload: { roleId: string; continueIteration: boolean } }
  | { type: 'agent.capabilities.list'; payload: Record<string, never> }
  | { type: 'agent.capability.save'; payload: { capability: AgentCapabilityDto } }
  | { type: 'agent.execute'; payload: { conversationId: string; capabilityName: string; argsJson: string; approvalToken?: string } }
  | { type: 'agent.decide'; payload: { content: string; conversationId?: string; characterId?: string; saveUserMessage: boolean; toolResultJson?: string; toolStep?: number; maxSteps?: number; source?: string; continueConversation?: boolean } }
  | { type: 'pet.voice_menu.get'; payload: Record<string, never> }
  | { type: 'pet.voice_intimacy.cycle'; payload: Record<string, never> }
  | { type: 'pet.voice_cache.clear'; payload: Record<string, never> }
  | { type: 'music.current'; payload: Record<string, never> }
  | { type: 'music.search_and_play'; payload: { songName: string } }
  | { type: 'music.toggle_pause'; payload: Record<string, never> }
  | { type: 'music.stop'; payload: Record<string, never> }
  | { type: 'status.resources'; payload: Record<string, never> }
  | { type: 'status.network'; payload: Record<string, never> }
  | { type: 'status.role'; payload: Record<string, never> }
  | { type: 'status.tts'; payload: Record<string, never> }
  | { type: 'status.llm_latencies'; payload: { chatModel: string; cacheModel: string; proactiveModel: string } }
  | { type: 'status.server.health'; payload: Record<string, never> }
  | { type: 'status.server.summary'; payload: Record<string, never> }
  | { type: 'status.codex_quota'; payload: Record<string, never> }
  | { type: 'tts.playback.set'; payload: { playing: boolean } }
  | { type: 'appearance.get'; payload: Record<string, never> }
  | { type: 'appearance.save'; payload: { configuration: AppearanceConfigurationDto } }
  | { type: 'disturbance_settings.get'; payload: Record<string, never> }
  | { type: 'disturbance_settings.save'; payload: { settings: DisturbanceSettingsDto } }
  | { type: 'model.list'; payload: Record<string, never> }
  | { type: 'model.save'; payload: { configurations: ModelConfigurationDto[] } }
  | { type: 'model.add'; payload: { modelKey: string; modelType: 'local' | 'api' } }
  | { type: 'business_model.list'; payload: Record<string, never> }
  | { type: 'business_model.save'; payload: { configurations: LlmBusinessModelConfigDto[] } }
  | { type: 'source_prompt.list'; payload: Record<string, never> }
  | { type: 'source_prompt.save'; payload: { prompt: LlmSourcePromptDto } }
  | { type: 'system.stream'; payload: { steps: number; delayMs: number } }

export const CORE_EVENT_TYPES = [
  'core.ready',
  'core.status-changed',
  'system.stream.progress',
  'system.stream.completed',
  'system.protocol.error',
  'request.cancelled',
  'settings.changed',
  'chat.delta',
  'chat.completed',
  'reminder.due',
  'character.changed',
  'agent.approval_requested',
  'agent.tool_call_completed',
  'music.playback.requested',
  'music.playback.state_changed',
  'music.playback.stopped',
  'core.stderr',
  'core.exit'
] as const

export type CoreEventType = (typeof CORE_EVENT_TYPES)[number]

export function isCoreEventType(value: unknown): value is CoreEventType {
  return typeof value === 'string' && CORE_EVENT_TYPES.some((type) => type === value)
}

export type CoreProcessState = 'stopped' | 'starting' | 'handshaking' | 'ready' | 'stopping' | 'exited' | 'failed'

export interface CoreStatus {
  state: CoreProcessState
  implementation: 'real'
  startedAt?: number
  lastError?: string
  coreVersion?: string
  protocolVersion?: string
  capabilities?: string[]
  processId?: number
}

export interface CoreHandshake {
  coreVersion: string
  protocolVersion: string
  capabilities: string[]
  platform: string
  arch: string
  desktopVersion: string
}

export function isCoreRequest(value: unknown): value is CoreRequest {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.payload)) return false
  switch (value.type) {
    case 'system.health':
      return Object.keys(value.payload).length === 0
    case 'system.window.fit_virtual_desktop':
      return typeof value.payload.windowHandle === 'string' && /^\d{1,20}$/u.test(value.payload.windowHandle)
    case 'settings.get':
      return value.payload.keys === undefined || (
        Array.isArray(value.payload.keys) &&
        value.payload.keys.length <= 20 &&
        value.payload.keys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 100)
      )
    case 'settings.save':
      return isRecord(value.payload.values) &&
        Object.keys(value.payload.values).length > 0 &&
        Object.keys(value.payload.values).length <= 50 &&
        Object.entries(value.payload.values).every(([key, settingValue]) =>
          key.length > 0 && key.length <= 100 && typeof settingValue === 'string' && settingValue.length <= 4096)
    case 'chat.history':
      return (value.payload.conversationId === undefined || isNonEmptyString(value.payload.conversationId)) &&
        (value.payload.limit === undefined || isIntegerInRange(value.payload.limit, 1, 100))
    case 'chat.send':
      return isNonEmptyString(value.payload.content) &&
        (value.payload.conversationId === undefined || isNonEmptyString(value.payload.conversationId)) &&
        (value.payload.characterId === undefined || typeof value.payload.characterId === 'string') &&
        (value.payload.modelName === undefined || typeof value.payload.modelName === 'string')
    case 'chat.update_metadata':
      return Number.isSafeInteger(value.payload.messageId) && Number(value.payload.messageId) > 0 &&
        typeof value.payload.metadataJson === 'string' && value.payload.metadataJson.length <= 65_536
    case 'tts.speak':
      return isNonEmptyString(value.payload.text) && value.payload.text.length <= 20_000 &&
        (value.payload.voiceId === undefined || typeof value.payload.voiceId === 'string') &&
        (value.payload.style === undefined || typeof value.payload.style === 'string')
    case 'asr.transcribe':
      return isNonEmptyString(value.payload.audioPath) && value.payload.audioPath.length <= 32_768 &&
        isNonEmptyString(value.payload.characterId) && value.payload.characterId.length <= 96 &&
        (value.payload.sessionId === undefined || isNonEmptyString(value.payload.sessionId)) &&
        (value.payload.language === undefined || isNonEmptyString(value.payload.language)) &&
        (value.payload.requestId === undefined || isNonEmptyString(value.payload.requestId))
    case 'voice_conversation.list':
      return (value.payload.roleId === undefined || typeof value.payload.roleId === 'string') &&
        (value.payload.search === undefined || typeof value.payload.search === 'string')
    case 'voice_conversation.save':
      return isVoiceConversation(value.payload.conversation)
    case 'voice_conversation.delete':
      return isNonEmptyString(value.payload.conversationId)
    case 'script.list':
      return Object.keys(value.payload).length === 0
    case 'script.save':
      return isChatCommandLauncher(value.payload.launcher)
    case 'script.run':
      return isNonEmptyString(value.payload.launcherId)
    case 'timer_record.list':
      return Object.keys(value.payload).length === 0
    case 'timer_record.save':
      return isTimerRecord(value.payload.record)
    case 'timer_record.delete':
      return isNonEmptyString(value.payload.recordId)
    case 'remote_site.list':
      return value.payload.enabledOnly === undefined || typeof value.payload.enabledOnly === 'boolean'
    case 'remote_site.get':
      return isNonEmptyString(value.payload.siteId) && (value.payload.includeCookie === undefined || typeof value.payload.includeCookie === 'boolean')
    case 'remote_site.save':
      return isRemoteSite(value.payload.site) && (value.payload.plainCookie === null || typeof value.payload.plainCookie === 'string')
    case 'remote_site.delete':
      return isNonEmptyString(value.payload.siteId)
    case 'remote_video.resolve':
      return isNonEmptyString(value.payload.input) && value.payload.input.length <= 20_000
    case 'remote_video.thumbnail':
    case 'remote_video.formats':
      return isNonEmptyString(value.payload.itemId)
    case 'remote_video.play':
      return isNonEmptyString(value.payload.itemId) &&
        (value.payload.formatSelector === undefined || typeof value.payload.formatSelector === 'string') &&
        (value.payload.mode === 'direct' || value.payload.mode === 'cache')
    case 'remote_video.download.start':
      return Array.isArray(value.payload.itemIds) && value.payload.itemIds.length > 0 && value.payload.itemIds.length <= 100 &&
        value.payload.itemIds.every(isNonEmptyString) &&
        (value.payload.formatSelector === undefined || typeof value.payload.formatSelector === 'string')
    case 'remote_video.download.cancel':
    case 'remote_video.download.delete':
    case 'remote_video.download.play':
      return isNonEmptyString(value.payload.taskId)
    case 'remote_video.download.list':
    case 'remote_video.play.list':
    case 'remote_video.settings.get':
    case 'remote_video.diagnostics':
      return Object.keys(value.payload).length === 0
    case 'remote_video.play.replay':
      return isNonEmptyString(value.payload.historyId)
    case 'remote_video.settings.save':
      return isRemoteVideoSettings(value.payload.settings)
    case 'crypto_provider.get':
    case 'market.symbols':
      return Object.keys(value.payload).length === 0
    case 'crypto_provider.save':
    case 'crypto_provider.check':
      return isCryptoProviderConfiguration(value.payload.configuration)
    case 'market.snapshot':
      return isNonEmptyString(value.payload.symbol)
    case 'market.chart_snapshot':
      return isNonEmptyString(value.payload.symbol) && typeof value.payload.interval === 'string' &&
        Array.isArray(value.payload.emaPeriods) && value.payload.emaPeriods.every((item) => Number.isInteger(item))
    case 'market.list':
      return (value.payload.symbol === undefined || typeof value.payload.symbol === 'string') &&
        (value.payload.limit === undefined || isIntegerInRange(value.payload.limit, 1, 1000))
    case 'market.record':
      return isRecord(value.payload.marketEvent) && isNonEmptyString(value.payload.marketEvent.eventId) &&
        isNonEmptyString(value.payload.marketEvent.eventType) && isNonEmptyString(value.payload.marketEvent.symbol)
    case 'notebook.list':
      return Object.keys(value.payload).length === 0
    case 'notebook.save':
      return isNotebookNote(value.payload.note)
    case 'notebook.delete':
      return isNonEmptyString(value.payload.noteId)
    case 'video.list':
      return value.payload.favoritesOnly === undefined || typeof value.payload.favoritesOnly === 'boolean'
    case 'video.import_file':
      return isNonEmptyString(value.payload.filePath) && isOptionalNullableId(value.payload.albumId)
    case 'video.import_folder':
      return isNonEmptyString(value.payload.folderPath) && typeof value.payload.recursive === 'boolean' && isOptionalNullableId(value.payload.albumId)
    case 'video.refresh_metadata':
    case 'video.remove_records':
    case 'video.delete_local_files':
      return isVideoIds(value.payload.videoIds)
    case 'video.play':
      return isVideoIds(value.payload.videoIds) && isNonEmptyString(value.payload.startVideoId) && value.payload.videoIds.includes(value.payload.startVideoId)
    case 'video.toggle_favorite':
      return isNonEmptyString(value.payload.videoId)
    case 'video.set_display_name':
      return isNonEmptyString(value.payload.videoId) && isNonEmptyString(value.payload.displayName)
    case 'video.set_remark':
      return isNonEmptyString(value.payload.videoId) && typeof value.payload.remark === 'string'
    case 'video.update_progress':
      return isNonEmptyString(value.payload.videoId) && isNonNegativeInteger(value.payload.positionSeconds) && isNonNegativeInteger(value.payload.durationSeconds)
    case 'video.album.create':
      return isNonEmptyString(value.payload.name) && (value.payload.description === undefined || typeof value.payload.description === 'string')
    case 'video.album.rename':
      return isNonEmptyString(value.payload.albumId) && isNonEmptyString(value.payload.name)
    case 'video.album.delete':
      return isNonEmptyString(value.payload.albumId)
    case 'video.album.move':
      return isVideoIds(value.payload.videoIds) && (value.payload.albumId === null || isNonEmptyString(value.payload.albumId))
    case 'video.tag.create':
    case 'video.tag.delete':
      return isNonEmptyString(value.payload.tag)
    case 'video.tag.rename':
      return isNonEmptyString(value.payload.oldTag) && isNonEmptyString(value.payload.newTag)
    case 'video.tag.set':
      return isVideoIds(value.payload.videoIds) && typeof value.payload.tags === 'string'
    case 'video.dependencies':
      return Object.keys(value.payload).length === 0
    case 'subtitle.list':
      return Object.keys(value.payload).length === 0
    case 'subtitle.import':
      return isNonEmptyString(value.payload.sourcePath)
    case 'subtitle.import_folder':
      return isNonEmptyString(value.payload.folderPath)
    case 'subtitle.delete':
      return isNonEmptyString(value.payload.path)
    case 'vault.list':
      return value.payload.itemType === undefined || typeof value.payload.itemType === 'string'
    case 'vault.get':
    case 'vault.secret.reveal':
      return isNonEmptyString(value.payload.itemId)
    case 'vault.save':
      return isVaultItem(value.payload.item) && (value.payload.plainSecret === null || typeof value.payload.plainSecret === 'string')
    case 'vault.delete':
      return isNonEmptyString(value.payload.itemId)
    case 'vault.history.list':
      return isNonEmptyString(value.payload.itemId)
    case 'vault.history.restore':
      return isNonEmptyString(value.payload.historyId)
    case 'vault.export':
      return isNonEmptyString(value.payload.outputPath) && value.payload.outputPath.toLowerCase().endsWith('.7z')
    case 'reminder.list':
    case 'character.list':
    case 'appearance.get':
    case 'disturbance_settings.get':
      return Object.keys(value.payload).length === 0
    case 'reminder.save':
      return isReminderSave(value.payload)
    case 'reminder.delete':
      return isNonEmptyString(value.payload.reminderId)
    case 'reminder.set_enabled':
      return isNonEmptyString(value.payload.reminderId) && typeof value.payload.enabled === 'boolean'
    case 'reminder.set_allow_tts':
      return isNonEmptyString(value.payload.reminderId) && typeof value.payload.allowTts === 'boolean'
    case 'reminder.process_due':
      return typeof value.payload.now === 'string' && !Number.isNaN(Date.parse(value.payload.now)) &&
        (value.payload.reminderIds === undefined || (Array.isArray(value.payload.reminderIds) &&
          value.payload.reminderIds.length > 0 && value.payload.reminderIds.length <= 5 &&
          value.payload.reminderIds.every(isNonEmptyString)))
    case 'character.set_current':
    case 'character.delete':
      return isNonEmptyString(value.payload.roleId)
    case 'character.save':
      return isCharacter(value.payload.character)
    case 'character.voice_assets':
    case 'pet.voice_menu.get':
    case 'pet.voice_cache.clear':
    case 'pet.voice_intimacy.cycle':
    case 'music.current':
    case 'music.toggle_pause':
    case 'music.stop':
    case 'status.resources':
    case 'status.network':
    case 'status.role':
    case 'status.tts':
    case 'status.server.health':
    case 'status.server.summary':
    case 'status.codex_quota':
      return Object.keys(value.payload).length === 0
    case 'music.search_and_play':
      return isNonEmptyString(value.payload.songName) && value.payload.songName.length <= 200
    case 'status.llm_latencies':
      return typeof value.payload.chatModel === 'string' && typeof value.payload.cacheModel === 'string' && typeof value.payload.proactiveModel === 'string'
    case 'tts.playback.set':
      return typeof value.payload.playing === 'boolean'
    case 'character.voice_asset.add':
      return isNonEmptyString(value.payload.baseName) && typeof value.payload.displayName === 'string' && isNonEmptyString(value.payload.style) && isNonEmptyString(value.payload.sourceFolderPath)
    case 'character.avatar.import':
      return isNonEmptyString(value.payload.sourcePath)
    case 'character.voices':
      return isNonEmptyString(value.payload.roleId)
    case 'character.voices.set':
      return isNonEmptyString(value.payload.roleId) && Array.isArray(value.payload.voices) && value.payload.voices.every(isRoleVoice)
    case 'character.binding.get':
    case 'character.binding.clear':
      return isNonEmptyString(value.payload.targetKey)
    case 'character.binding.set':
      return isNonEmptyString(value.payload.targetKey) && isNonEmptyString(value.payload.roleId)
    case 'character.template.generate':
      return isNonEmptyString(value.payload.roleId) && typeof value.payload.continueIteration === 'boolean'
    case 'agent.capabilities.list':
      return Object.keys(value.payload).length === 0
    case 'agent.capability.save':
      return isAgentCapability(value.payload.capability)
    case 'agent.execute':
      return isNonEmptyString(value.payload.conversationId) && isNonEmptyString(value.payload.capabilityName) &&
        isNonEmptyString(value.payload.argsJson) && (value.payload.approvalToken === undefined || isNonEmptyString(value.payload.approvalToken))
    case 'agent.decide':
      return isNonEmptyString(value.payload.content) && typeof value.payload.saveUserMessage === 'boolean' &&
        (value.payload.conversationId === undefined || isNonEmptyString(value.payload.conversationId)) &&
        (value.payload.characterId === undefined || isNonEmptyString(value.payload.characterId)) &&
        (value.payload.toolResultJson === undefined || typeof value.payload.toolResultJson === 'string') &&
        (value.payload.continueConversation === undefined || typeof value.payload.continueConversation === 'boolean') &&
        (value.payload.toolStep === undefined || isIntegerInRange(value.payload.toolStep, 1, 20)) &&
        (value.payload.maxSteps === undefined || isIntegerInRange(value.payload.maxSteps, 1, 20))
    case 'appearance.save':
      return isAppearanceConfiguration(value.payload.configuration)
    case 'disturbance_settings.save':
      return isDisturbanceSettings(value.payload.settings)
    case 'model.list':
    case 'business_model.list':
    case 'source_prompt.list':
      return Object.keys(value.payload).length === 0
    case 'model.save':
      return Array.isArray(value.payload.configurations) && value.payload.configurations.length > 0 && value.payload.configurations.every(isModelConfiguration)
    case 'model.add':
      return isNonEmptyString(value.payload.modelKey) && (value.payload.modelType === 'local' || value.payload.modelType === 'api')
    case 'business_model.save':
      return Array.isArray(value.payload.configurations) && value.payload.configurations.length > 0 && value.payload.configurations.every(isBusinessModelConfiguration)
    case 'source_prompt.save':
      return isSourcePrompt(value.payload.prompt)
    case 'system.stream':
      return isIntegerInRange(value.payload.steps, 1, 20) && isIntegerInRange(value.payload.delayMs, 20, 5_000)
    default:
      return false
  }
}

function isAppearanceConfiguration(value: unknown): value is AppearanceConfigurationDto {
  return isRecord(value) && isNonEmptyString(value.themeId) && typeof value.contentBrightness === 'string' &&
    typeof value.fontFamily === 'string' && typeof value.fontScale === 'number' &&
    typeof value.cornerRadiusStyle === 'string' && typeof value.density === 'string' &&
    typeof value.headerStyle === 'string' && typeof value.animationsEnabled === 'boolean'
}

function isDisturbanceSettings(value: unknown): value is DisturbanceSettingsDto {
  return isRecord(value) && ['normal', 'quiet', 'focus', 'game', 'sleep'].includes(String(value.mode)) &&
    typeof value.quietHoursEnabled === 'boolean' && typeof value.quietHoursStart === 'string' &&
    typeof value.quietHoursEnd === 'string' && typeof value.suppressWhenFullscreen === 'boolean' &&
    Number.isInteger(value.maxProactivePerHour) && typeof value.updatedAt === 'string'
}

function isModelConfiguration(value: unknown): value is ModelConfigurationDto {
  return isRecord(value) && isNonEmptyString(value.modelKey) && (value.type === 'local' || value.type === 'api') &&
    typeof value.endpoint === 'string' && isNonEmptyString(value.model) && typeof value.apiKey === 'string' &&
    typeof value.enableWebSearch === 'boolean' && typeof value.think === 'boolean'
}
function isBusinessModelConfiguration(value: unknown): value is LlmBusinessModelConfigDto {
  return isRecord(value) && isNonEmptyString(value.businessKey) && typeof value.displayName === 'string' &&
    typeof value.description === 'string' && typeof value.provider === 'string' && isNonEmptyString(value.modelKey) &&
    typeof value.isEnabled === 'boolean' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}
function isSourcePrompt(value: unknown): value is LlmSourcePromptDto {
  return isRecord(value) && isNonEmptyString(value.sourceKey) && typeof value.purpose === 'string' &&
    typeof value.systemPromptTemplate === 'string' && typeof value.userPromptTemplate === 'string' &&
    typeof value.outputSchemaJson === 'string' && typeof value.isEnabled === 'boolean' &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}

function isVoiceConversation(value: unknown): value is VoiceConversationDto {
  return isRecord(value) && isNonEmptyString(value.conversationId) && isNonEmptyString(value.voiceRoleId) &&
    typeof value.title === 'string' && typeof value.preview === 'string' &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}
function isRoleVoice(value: unknown): value is RoleVoiceDto {
  return isRecord(value) && typeof value.roleId === 'string' && isNonEmptyString(value.voiceId) && isNonEmptyString(value.style) &&
    typeof value.isDefault === 'boolean' && typeof value.isEnabled === 'boolean' && typeof value.updatedAt === 'string'
}

function isChatCommandLauncher(value: unknown): value is ChatCommandLauncherDto {
  return isRecord(value) && typeof value.launcherId === 'string' && isNonEmptyString(value.commandText) &&
    typeof value.displayName === 'string' && typeof value.exePath === 'string' && typeof value.arguments === 'string' &&
    typeof value.workingDirectory === 'string' && typeof value.enabled === 'boolean' && typeof value.updatedAt === 'string'
}

function isTimerRecord(value: unknown): value is TimerRecordDto {
  return isRecord(value) && isNonEmptyString(value.recordId) && typeof value.savedAt === 'string' &&
    typeof value.durationSeconds === 'number' && Number.isInteger(value.durationSeconds) && value.durationSeconds >= 0
}
function isRemoteSite(value: unknown): value is RemoteSiteDto {
  return isRecord(value) && isNonEmptyString(value.siteId) && typeof value.siteName === 'string' && typeof value.domainPattern === 'string' &&
    typeof value.adapterKey === 'string' && typeof value.qualityPreference === 'string' && typeof value.isEnabled === 'boolean' &&
    typeof value.settingsJson === 'string' && typeof value.updatedAt === 'string' && typeof value.hasProtectedCookie === 'boolean'
}
function isRemoteVideoSettings(value: unknown): value is RemoteVideoSettingsDto {
  return isRecord(value) && isNonEmptyString(value.downloadRoot) && isNonEmptyString(value.cacheRoot) &&
    isNonEmptyString(value.fileNameTemplate) && typeof value.defaultQualityPreference === 'string' &&
    typeof value.downloadThumbnail === 'boolean' && typeof value.downloadInfoJson === 'boolean' &&
    typeof value.downloadSubtitles === 'boolean' && typeof value.overwriteExisting === 'boolean' &&
    typeof value.autoImportToVideoLibrary === 'boolean' && isIntegerInRange(value.maxConcurrentDownloads, 1, 4) &&
    isNonEmptyString(value.ytDlpPath) && isNonEmptyString(value.ffmpegPath) && isNonEmptyString(value.potPlayerPath) &&
    typeof value.updatedAt === 'string'
}
function isCryptoProviderConfiguration(value: unknown): value is CryptoProviderConfigurationDto {
  return isRecord(value) && typeof value.isEnabled === 'boolean' && typeof value.serviceUrl === 'string' && Number.isInteger(value.timeoutSeconds) &&
    typeof value.lastHealthStatus === 'string' && (value.lastHealthLatencyMs === null || typeof value.lastHealthLatencyMs === 'number') &&
    (value.lastCheckedAt === null || typeof value.lastCheckedAt === 'string')
}

function isReminderSave(value: Record<string, unknown>): boolean {
  return (value.reminderId === null || typeof value.reminderId === 'string') &&
    typeof value.title === 'string' && typeof value.message === 'string' &&
    typeof value.dueAt === 'string' && !Number.isNaN(Date.parse(value.dueAt)) &&
    (value.repeat === 'none' || value.repeat === 'daily') &&
    typeof value.enabled === 'boolean' && typeof value.allowTts === 'boolean'
}
function isNotebookNote(value: unknown): value is NotebookNoteDto {
  return isRecord(value) && isNonEmptyString(value.noteId) && typeof value.title === 'string' &&
    typeof value.contentMarkdown === 'string' && typeof value.contentPlainText === 'string' &&
    Array.isArray(value.attachmentIds) && value.attachmentIds.every((id) => typeof id === 'string') &&
    typeof value.isPinned === 'boolean' && typeof value.isDeleted === 'boolean' &&
    typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
}
function isCharacter(value: unknown): value is CharacterDto {
  return isRecord(value) && isNonEmptyString(value.roleId) && typeof value.name === 'string' &&
    typeof value.voiceName === 'string' && typeof value.roleTitle === 'string' && typeof value.cardPath === 'string' &&
    typeof value.sourceCardJson === 'string' && typeof value.templateCardJson === 'string' && typeof value.preferredVoiceId === 'string' &&
    typeof value.validationStatus === 'string' && typeof value.avatarPath === 'string' && typeof value.isEnabled === 'boolean' && typeof value.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(value.updatedAt))
}
function isAgentCapability(value: unknown): value is AgentCapabilityDto {
  return isRecord(value) && isNonEmptyString(value.capabilityName) && isNonEmptyString(value.displayName) &&
    typeof value.description === 'string' && isNonEmptyString(value.executorType) && typeof value.configJson === 'string' &&
    typeof value.argsSchemaJson === 'string' && typeof value.resultPolicy === 'string' && typeof value.riskLevel === 'string' &&
    typeof value.requireConfirm === 'boolean' && typeof value.enabled === 'boolean' && Number.isInteger(value.sortOrder) && typeof value.updatedAt === 'string'
}
function isVaultItem(value: unknown): value is VaultItemDto {
  return isRecord(value) && isNonEmptyString(value.itemId) && isNonEmptyString(value.itemType) &&
    typeof value.name === 'string' && typeof value.category === 'string' && typeof value.account === 'string' &&
    typeof value.url === 'string' && typeof value.platform === 'string' && typeof value.publicMetadataJson === 'string' &&
    typeof value.hasProtectedSecret === 'boolean' && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
}
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isOptionalNullableId(value: unknown): boolean { return value === undefined || value === null || isNonEmptyString(value) }
function isVideoIds(value: unknown): value is string[] { return Array.isArray(value) && value.length >= 1 && value.length <= 1000 && value.every(isNonEmptyString) }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}
