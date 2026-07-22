import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcEventEnvelope } from '../src/shared/ipc'
import type { CoreRequest } from '../src/shared/core'
import type { ModelConfigurationDto } from '../src/shared/business'
import type { Logger } from '../src/main/logging/logger'
import { CoreProcessManager } from '../src/main/core/core-process-manager'
import { StdioCoreClient } from '../src/main/core/stdio-core-client'
import { runAgentConversation } from '../src/shared/agent-conversation'

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const tempRoot = mkdtempSync(join(tmpdir(), 'aimaid-core-integration-'))
const assembly = process.env.AIMAID_CORE_TEST_ASSEMBLY === undefined
  ? resolve(import.meta.dirname, '../../../src/AIMaid.CoreHost/bin/Debug/net8.0/AIMaid.CoreHost.dll')
  : resolve(process.env.AIMAID_CORE_TEST_ASSEMBLY)
const environment = {
  ...process.env,
  AIMAID_RESOURCE_ROOT: join(tempRoot, 'resources'),
  AIMAID_DATA_ROOT: join(tempRoot, 'data'),
  AIMAID_CONFIG_ROOT: join(tempRoot, 'config'),
  AIMAID_CACHE_ROOT: join(tempRoot, 'cache'),
  AIMAID_LOG_ROOT: join(tempRoot, 'logs')
}
const manager = new CoreProcessManager({ command: 'dotnet', args: [assembly], workingDirectory: dirname(assembly), environment }, silentLogger)
const client = new StdioCoreClient(manager, '0.1.0-test', silentLogger)

describe('real C# Core integration', () => {
  beforeAll(async () => {
    await manager.start()
    await client.start()
  })

  afterAll(async () => {
    await client.stop()
    await manager.stop()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('handshakes and executes real health/settings queries', async () => {
    expect(client.getStatus()).toMatchObject({ state: 'ready', implementation: 'real', protocolVersion: '1.0' })
    await expect(client.invoke('request-health-001', { type: 'system.health', payload: {} }, new AbortController().signal))
      .resolves.toMatchObject({ ready: true, protocolVersion: '1.0' })
    await expect(client.invoke('request-settings-001', { type: 'settings.get', payload: { keys: ['app.language'] } }, new AbortController().signal))
      .resolves.toMatchObject({ settings: [] })
  })

  it('returns effective user defaults and validates runtime settings before persistence', async () => {
    const defaults = await client.invoke('request-settings-defaults', {
      type: 'settings.get', payload: { keys: ['ui_language', 'user_config:App:Tts:Enabled', 'voice_cache_period_hours'] }
    }, new AbortController().signal) as { settings: Array<{ key: string; value: string }> }
    expect(Object.fromEntries(defaults.settings.map((item) => [item.key, item.value]))).toMatchObject({
      ui_language: 'zh-CN',
      'user_config:App:Tts:Enabled': 'True',
      voice_cache_period_hours: '1'
    })
    await client.invoke('request-settings-save-runtime', {
      type: 'settings.save', payload: { values: { realtime_tts_enabled: 'False', voice_cache_period_hours: '8' } }
    }, new AbortController().signal)
    const saved = await client.invoke('request-settings-read-runtime', {
      type: 'settings.get', payload: { keys: ['realtime_tts_enabled', 'voice_cache_period_hours'] }
    }, new AbortController().signal) as { settings: Array<{ key: string; value: string }> }
    expect(Object.fromEntries(saved.settings.map((item) => [item.key, item.value]))).toMatchObject({
      realtime_tts_enabled: 'False', voice_cache_period_hours: '8'
    })
    await expect(client.invoke('request-settings-invalid-cache', {
      type: 'settings.save', payload: { values: { voice_cache_period_hours: '3' } }
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'settings.invalid_cache_period' })
  })

  it('persists the music visualizer style in SQLite across a Core restart', async () => {
    const restartRoot = join(tempRoot, 'music-visualizer-restart')
    const restartEnvironment = {
      ...environment,
      AIMAID_DATA_ROOT: join(restartRoot, 'data'),
      AIMAID_CONFIG_ROOT: join(restartRoot, 'config'),
      AIMAID_CACHE_ROOT: join(restartRoot, 'cache'),
      AIMAID_LOG_ROOT: join(restartRoot, 'logs')
    }
    const firstManager = new CoreProcessManager({ command: 'dotnet', args: [assembly], workingDirectory: dirname(assembly), environment: restartEnvironment }, silentLogger)
    const firstClient = new StdioCoreClient(firstManager, '0.1.0-test', silentLogger)
    await firstManager.start()
    await firstClient.start()
    await firstClient.invoke('request-visualizer-save-before-restart', {
      type: 'settings.save', payload: { values: { music_visualizer_style: 'bottom-wave' } }
    }, new AbortController().signal)
    await firstClient.stop()
    await firstManager.stop()

    const secondManager = new CoreProcessManager({ command: 'dotnet', args: [assembly], workingDirectory: dirname(assembly), environment: restartEnvironment }, silentLogger)
    const secondClient = new StdioCoreClient(secondManager, '0.1.0-test', silentLogger)
    try {
      await secondManager.start()
      await secondClient.start()
      const persisted = await secondClient.invoke('request-visualizer-read-after-restart', {
        type: 'settings.get', payload: { keys: ['music_visualizer_style'] }
      }, new AbortController().signal) as { settings: Array<{ key: string; value: string }> }
      expect(persisted.settings).toContainEqual(expect.objectContaining({
        key: 'music_visualizer_style', value: 'bottom-wave'
      }))
    } finally {
      await secondClient.stop()
      await secondManager.stop()
    }
  })

  it('allows hotkey settings without weakening secret-key protection', async () => {
    await client.invoke('request-settings-save-hotkey', {
      type: 'settings.save', payload: { values: { hotkey_open_chat: 'Ctrl+Shift+F' } }
    }, new AbortController().signal)
    const saved = await client.invoke('request-settings-read-hotkey', {
      type: 'settings.get', payload: { keys: ['hotkey_open_chat'] }
    }, new AbortController().signal) as { settings: Array<{ key: string; value: string }> }
    expect(saved.settings).toContainEqual(expect.objectContaining({ key: 'hotkey_open_chat', value: 'Ctrl+Shift+F' }))
    await expect(client.invoke('request-settings-read-secret', {
      type: 'settings.get', payload: { keys: ['provider_api_key'] }
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('turns the exact prompt "播放  night dancer" into audible music playback', async () => {
    const now = new Date().toISOString()
    const character = {
      roleId: 'music-command-role', name: '音乐测试角色', voiceName: '', roleTitle: '', cardPath: '', sourceCardJson: '{}',
      templateCardJson: '', preferredVoiceId: '', validationStatus: 'valid', isEnabled: true, updatedAt: now,
      cardSummary: '', cardSchemaVersion: '', templateCardSourceHash: '', templateCardGenerationStatus: '',
      templateCardGenerationMessage: '', templateCardGeneratedAt: null, templateCardLastAttemptAt: null,
      templateCardIterationCount: 0, validationMessage: '', lastValidatedAt: null, avatarPath: ''
    }
    await client.invoke('request-music-character', {
      type: 'character.save', payload: { character }
    }, new AbortController().signal)
    await client.invoke('request-music-capability', {
      type: 'agent.capability.save', payload: { capability: {
        capabilityName: 'music.search', displayName: '搜索播放音乐', description: '按歌曲名搜索并播放音乐。',
        executorType: 'internal_service', configJson: JSON.stringify({ operation: 'search_and_play_music' }),
        argsSchemaJson: JSON.stringify({ type: 'object', required: ['songName'], properties: { songName: { type: 'string' } } }),
        resultPolicy: 'simple_status', riskLevel: 'low', requireConfirm: false, enabled: true, sortOrder: 1, updatedAt: now
      } }
    }, new AbortController().signal)

    const playbackRequested = new Promise<IpcEventEnvelope>((resolveEvent) => {
      const unsubscribe = client.subscribe((event) => {
        if (event.type !== 'music.playback.requested') return
        unsubscribe()
        resolveEvent(event)
      })
    })
    let requestNumber = 0
    const invokeCore = async (request: CoreRequest) => {
      requestNumber += 1
      try {
        const payload = await client.invoke(
          `request-music-conversation-${requestNumber}`,
          request,
          new AbortController().signal
        )
        return { success: true, payload }
      } catch (reason) {
        return { success: false, payload: null, error: { message: reason instanceof Error ? reason.message : String(reason) } }
      }
    }
    const conversation = runAgentConversation('播放  night dancer', {
      characterId: character.roleId,
      continueConversation: false,
      source: 'normal_chat'
    }, invokeCore)
    await expect(playbackRequested).resolves.toMatchObject({ type: 'music.playback.requested' })
    await expect(conversation).resolves.toMatchObject({ content: expect.stringContaining('NIGHT DANCER') })

    const playback = await client.invoke('request-music-current', {
      type: 'music.current', payload: {}
    }, new AbortController().signal) as { url: string; title: string; singer: string; isPlaying: boolean; isPaused: boolean }
    expect(playback).toMatchObject({ title: 'NIGHT DANCER', singer: 'imase', isPlaying: true, isPaused: false })
    expect(playback.url).toMatch(/^https:\/\//u)
    const response = await fetch(playback.url, { headers: { Range: 'bytes=0-4095' } })
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toMatch(/^audio\//u)
    const totalLength = Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1] ?? response.headers.get('content-length'))
    expect(totalLength).toBeGreaterThan(1_000_000)
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)

    const paused = await client.invoke('request-music-pause', {
      type: 'music.toggle_pause', payload: {}
    }, new AbortController().signal)
    expect(paused).toMatchObject({ title: 'NIGHT DANCER', isPlaying: false, isPaused: true })
    const resumed = await client.invoke('request-music-resume', {
      type: 'music.toggle_pause', payload: {}
    }, new AbortController().signal)
    expect(resumed).toMatchObject({ title: 'NIGHT DANCER', isPlaying: true, isPaused: false })
    await client.invoke('request-music-stop', { type: 'music.stop', payload: {} }, new AbortController().signal)
    const stopped = await client.invoke('request-music-stopped-state', {
      type: 'music.current', payload: {}
    }, new AbortController().signal)
    expect(stopped).toMatchObject({ url: '', title: '', isPlaying: false, isPaused: false })
  }, 120_000)

  it('keeps a separately verified music API available for provider failover', async () => {
    const search = await fetch('https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=night%20dancer&count=1&pages=1')
    expect(search.ok).toBe(true)
    const songs = await search.json() as Array<{ url_id: string; name: string; artist: string[] }>
    expect(songs[0]).toMatchObject({ name: 'NIGHT DANCER', artist: expect.arrayContaining(['imase']) })
    const metadata = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${encodeURIComponent(songs[0]!.url_id)}&br=320`)
    expect(metadata.ok).toBe(true)
    const stream = await metadata.json() as { url: string; size: number }
    expect(stream.url).toMatch(/^https:\/\//u)
    expect(stream.size).toBeGreaterThan(1_000_000)
    const audio = await fetch(stream.url, { headers: { Range: 'bytes=0-4095' } })
    expect(audio.ok).toBe(true)
    expect(audio.headers.get('content-type')).toMatch(/^audio\//u)
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(0)
  }, 120_000)

  it('masks model API keys and preserves or clears the encrypted value explicitly', async () => {
    const configuration: ModelConfigurationDto = {
      modelKey: 'integration-api', type: 'api', endpoint: 'https://example.com/v1/chat/completions',
      model: 'integration-model', apiKey: 'integration-model-secret', enableWebSearch: false, think: false
    }
    await client.invoke('request-model-save-secret', {
      type: 'model.save', payload: { configurations: [configuration] }
    }, new AbortController().signal)
    const listed = await client.invoke('request-model-list-masked', {
      type: 'model.list', payload: {}
    }, new AbortController().signal) as Array<typeof configuration>
    const masked = listed.find((item) => item.modelKey === configuration.modelKey)
    expect(masked?.apiKey).toBe('••••••••')
    expect(JSON.stringify(listed)).not.toContain('integration-model-secret')

    await client.invoke('request-model-preserve-secret', {
      type: 'model.save', payload: { configurations: [{ ...masked!, endpoint: 'https://example.com/v1' }] }
    }, new AbortController().signal)
    const preserved = await client.invoke('request-model-list-preserved', {
      type: 'model.list', payload: {}
    }, new AbortController().signal) as Array<typeof configuration>
    expect(preserved.find((item) => item.modelKey === configuration.modelKey)).toMatchObject({
      endpoint: 'https://example.com/v1', apiKey: '••••••••'
    })

    await client.invoke('request-model-clear-secret', {
      type: 'model.save', payload: { configurations: [{ ...configuration, apiKey: '' }] }
    }, new AbortController().signal)
    const cleared = await client.invoke('request-model-list-cleared', {
      type: 'model.list', payload: {}
    }, new AbortController().signal) as Array<typeof configuration>
    expect(cleared.find((item) => item.modelKey === configuration.modelKey)?.apiKey).toBe('')
  })

  it('receives ordered events and a terminal event', async () => {
    const received: IpcEventEnvelope[] = []
    const completed = new Promise<void>((resolveCompleted) => {
      const unsubscribe = client.subscribe((event) => {
        const payload = event.payload as { correlationId: string | null }
        if (payload.correlationId !== 'request-stream-001') return
        received.push(event)
        if (event.type === 'system.stream.completed') { unsubscribe(); resolveCompleted() }
      })
    })
    await client.invoke('request-stream-001', { type: 'system.stream', payload: { steps: 3, delayMs: 20 } }, new AbortController().signal)
    await completed
    expect(received.map((event) => event.type)).toEqual([
      'system.stream.progress', 'system.stream.progress', 'system.stream.progress', 'system.stream.completed'
    ])
  })

  it('cancels a real long-running stream', async () => {
    const cancelled = new Promise<void>((resolveCancelled) => {
      const unsubscribe = client.subscribe((event) => {
        const payload = event.payload as { correlationId: string | null }
        if (event.type === 'request.cancelled' && payload.correlationId === 'request-stream-002') {
          unsubscribe(); resolveCancelled()
        }
      })
    })
    await client.invoke('request-stream-002', { type: 'system.stream', payload: { steps: 20, delayMs: 100 } }, new AbortController().signal)
    await client.cancel('request-stream-002')
    await cancelled
  })

  it('runs the real reminder create, list, toggle and delete chain', async () => {
    const dueAt = new Date(Date.now() + 600_000).toISOString()
    const disabled = await client.invoke('request-reminder-save-disabled', {
      type: 'reminder.save',
      payload: { reminderId: null, title: '暂不启用', message: '链路验证', dueAt, repeat: 'none', enabled: false, allowTts: false }
    }, new AbortController().signal) as { reminderId: string; enabled: boolean; nextDueAt: string | null }
    expect(disabled).toMatchObject({ enabled: false, nextDueAt: null })
    await client.invoke('request-reminder-delete-disabled', {
      type: 'reminder.delete', payload: { reminderId: disabled.reminderId }
    }, new AbortController().signal)
    const created = await client.invoke('request-reminder-save', {
      type: 'reminder.save',
      payload: { reminderId: null, title: '集成测试提醒', message: '链路验证', dueAt, repeat: 'daily', enabled: true, allowTts: true }
    }, new AbortController().signal) as { reminderId: string; repeat: string; enabled: boolean }
    expect(created).toMatchObject({ repeat: 'daily', enabled: true })
    const listed = await client.invoke('request-reminder-list', { type: 'reminder.list', payload: {} }, new AbortController().signal) as Array<{ reminderId: string }>
    expect(listed.some((item) => item.reminderId === created.reminderId)).toBe(true)
    await expect(client.invoke('request-reminder-disable', {
      type: 'reminder.set_enabled', payload: { reminderId: created.reminderId, enabled: false }
    }, new AbortController().signal)).resolves.toMatchObject({ enabled: false })
    await client.invoke('request-reminder-delete', { type: 'reminder.delete', payload: { reminderId: created.reminderId } }, new AbortController().signal)
    const afterDelete = await client.invoke('request-reminder-list-after-delete', { type: 'reminder.list', payload: {} }, new AbortController().signal) as Array<{ reminderId: string }>
    expect(afterDelete.some((item) => item.reminderId === created.reminderId)).toBe(false)
  })

  it('completes only explicitly consumed due reminder ids', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString()
    const first = await client.invoke('request-reminder-due-first', {
      type: 'reminder.save', payload: { reminderId: null, title: '第一条', message: '第一条', dueAt, repeat: 'none', enabled: true, allowTts: false }
    }, new AbortController().signal) as { reminderId: string }
    const second = await client.invoke('request-reminder-due-second', {
      type: 'reminder.save', payload: { reminderId: null, title: '第二条', message: '第二条', dueAt, repeat: 'none', enabled: true, allowTts: false }
    }, new AbortController().signal) as { reminderId: string }

    const completed = await client.invoke('request-reminder-due-consumed', {
      type: 'reminder.process_due', payload: { now: new Date().toISOString(), reminderIds: [first.reminderId] }
    }, new AbortController().signal) as Array<{ reminderId: string }>
    expect(completed.map((item) => item.reminderId)).toEqual([first.reminderId])

    const listed = await client.invoke('request-reminder-due-list', {
      type: 'reminder.list', payload: {}
    }, new AbortController().signal) as Array<{ reminderId: string; enabled: boolean }>
    expect(listed.find((item) => item.reminderId === first.reminderId)?.enabled).toBe(false)
    expect(listed.find((item) => item.reminderId === second.reminderId)?.enabled).toBe(true)
    await client.invoke('request-reminder-due-cleanup-first', { type: 'reminder.delete', payload: { reminderId: first.reminderId } }, new AbortController().signal)
    await client.invoke('request-reminder-due-cleanup-second', { type: 'reminder.delete', payload: { reminderId: second.reminderId } }, new AbortController().signal)
  })

  it('persists video playback progress through the real Core route', async () => {
    const videoPath = join(tempRoot, 'progress-persistence.mp4')
    writeFileSync(videoPath, 'integration fixture')
    const imported = await client.invoke('request-video-import-progress', {
      type: 'video.import_file', payload: { filePath: videoPath, albumId: null }
    }, new AbortController().signal) as { videoId: string }

    await client.invoke('request-video-update-progress', {
      type: 'video.update_progress', payload: { videoId: imported.videoId, positionSeconds: 61, durationSeconds: 600 }
    }, new AbortController().signal)

    const snapshot = await client.invoke('request-video-list-progress', {
      type: 'video.list', payload: {}
    }, new AbortController().signal) as { items: Array<{ videoId: string; lastPositionSeconds: number; durationSeconds: number; isCompleted: boolean }> }
    expect(snapshot.items.find((item) => item.videoId === imported.videoId)).toMatchObject({
      lastPositionSeconds: 61, durationSeconds: 600, isCompleted: false
    })
  })

  it('runs the voice conversation save, list and delete chain', async () => {
    const now = new Date().toISOString()
    const conversation = { conversationId: 'voice_chat_integration', voiceRoleId: 'role-test', title: '新对话', preview: '测试消息', createdAt: now, updatedAt: now }
    await client.invoke('request-voice-save', { type: 'voice_conversation.save', payload: { conversation } }, new AbortController().signal)
    const listed = await client.invoke('request-voice-list', { type: 'voice_conversation.list', payload: { roleId: 'role-test' } }, new AbortController().signal) as Array<{ conversationId: string }>
    expect(listed.some((item) => item.conversationId === conversation.conversationId)).toBe(true)
    await client.invoke('request-voice-delete', { type: 'voice_conversation.delete', payload: { conversationId: conversation.conversationId } }, new AbortController().signal)
    const afterDelete = await client.invoke('request-voice-list-after-delete', { type: 'voice_conversation.list', payload: { roleId: 'role-test' } }, new AbortController().signal) as Array<{ conversationId: string }>
    expect(afterDelete.some((item) => item.conversationId === conversation.conversationId)).toBe(false)
  })

  it('runs notebook and timer persistence chains', async () => {
    const now = new Date().toISOString()
    const note = { noteId: 'note-integration', title: 'Core 笔记', contentMarkdown: '正文', contentPlainText: '正文', attachmentIds: [], isPinned: false, isDeleted: false, createdAt: now, updatedAt: now }
    await client.invoke('request-note-save', { type: 'notebook.save', payload: { note } }, new AbortController().signal)
    const notes = await client.invoke('request-note-list', { type: 'notebook.list', payload: {} }, new AbortController().signal) as Array<{ noteId: string }>
    expect(notes.some((item) => item.noteId === note.noteId)).toBe(true)
    await client.invoke('request-note-delete', { type: 'notebook.delete', payload: { noteId: note.noteId } }, new AbortController().signal)
    const afterNoteDelete = await client.invoke('request-note-list-after-delete', { type: 'notebook.list', payload: {} }, new AbortController().signal) as Array<{ noteId: string }>
    expect(afterNoteDelete.some((item) => item.noteId === note.noteId)).toBe(false)

    const record = { recordId: 'timer-integration', savedAt: now, durationSeconds: 123 }
    await client.invoke('request-timer-save', { type: 'timer_record.save', payload: { record } }, new AbortController().signal)
    const records = await client.invoke('request-timer-list', { type: 'timer_record.list', payload: {} }, new AbortController().signal) as Array<{ recordId: string }>
    expect(records.some((item) => item.recordId === record.recordId)).toBe(true)
    await client.invoke('request-timer-delete', { type: 'timer_record.delete', payload: { recordId: record.recordId } }, new AbortController().signal)
  })

  it('runs character and remote-site persistence chains', async () => {
    const now = new Date().toISOString()
    const character = {
      roleId: 'role-integration', name: '集成角色', voiceName: '', roleTitle: '', cardPath: '', sourceCardJson: '{}',
      templateCardJson: '', preferredVoiceId: '', validationStatus: 'valid', isEnabled: true, updatedAt: now,
      cardSummary: '', cardSchemaVersion: '', templateCardSourceHash: '', templateCardGenerationStatus: '',
      templateCardGenerationMessage: '', templateCardGeneratedAt: null, templateCardLastAttemptAt: null,
      templateCardIterationCount: 0, validationMessage: '', lastValidatedAt: null, avatarPath: ''
    }
    await client.invoke('request-character-save', { type: 'character.save', payload: { character } }, new AbortController().signal)
    const characters = await client.invoke('request-character-list', { type: 'character.list', payload: {} }, new AbortController().signal) as Array<{ roleId: string }>
    expect(characters.some((item) => item.roleId === character.roleId)).toBe(true)
    const conversation = { conversationId: 'character-delete-chat', voiceRoleId: character.roleId, title: '角色会话', preview: '', createdAt: now, updatedAt: now }
    await client.invoke('request-character-conversation-save', {
      type: 'voice_conversation.save', payload: { conversation }
    }, new AbortController().signal)
    await expect(client.invoke('request-character-chat-seed', {
      type: 'chat.send', payload: { conversationId: conversation.conversationId, characterId: character.roleId, content: '待删除的历史' }
    }, new AbortController().signal)).rejects.toBeTruthy()
    const historyBeforeDelete = await client.invoke('request-character-history-before-delete', {
      type: 'chat.history', payload: { conversationId: conversation.conversationId, limit: 20 }
    }, new AbortController().signal) as { messages: unknown[] }
    expect(historyBeforeDelete.messages).toHaveLength(1)
    await client.invoke('request-character-delete', { type: 'character.delete', payload: { roleId: character.roleId } }, new AbortController().signal)
    const historyAfterDelete = await client.invoke('request-character-history-after-delete', {
      type: 'chat.history', payload: { conversationId: conversation.conversationId, limit: 20 }
    }, new AbortController().signal) as { messages: unknown[] }
    expect(historyAfterDelete.messages).toEqual([])

    const site = { siteId: 'site-integration', siteName: '集成站点', domainPattern: 'example.com', adapterKey: 'generic', qualityPreference: 'best', isEnabled: true, settingsJson: '{}', updatedAt: now, hasProtectedCookie: false }
    await client.invoke('request-site-save', { type: 'remote_site.save', payload: { site, plainCookie: 'sessionid=integration-secret' } }, new AbortController().signal)
    const sites = await client.invoke('request-site-list', { type: 'remote_site.list', payload: { enabledOnly: false } }, new AbortController().signal) as Array<{ siteId: string }>
    expect(sites.some((item) => item.siteId === site.siteId)).toBe(true)
    const detail = await client.invoke('request-site-get', { type: 'remote_site.get', payload: { siteId: site.siteId, includeCookie: true } }, new AbortController().signal) as { site: { hasProtectedCookie: boolean }; cookie?: string }
    expect(detail).toEqual({ site: expect.objectContaining({ hasProtectedCookie: true }) })
    expect(JSON.stringify(detail)).not.toContain('integration-secret')
    await client.invoke('request-site-preserve-cookie', { type: 'remote_site.save', payload: { site: { ...site, hasProtectedCookie: false }, plainCookie: null } }, new AbortController().signal)
    const preserved = await client.invoke('request-site-get-preserved', { type: 'remote_site.get', payload: { siteId: site.siteId } }, new AbortController().signal) as { site: { hasProtectedCookie: boolean } }
    expect(preserved.site.hasProtectedCookie).toBe(true)
    await client.invoke('request-site-clear-cookie', { type: 'remote_site.save', payload: { site: { ...site, hasProtectedCookie: true }, plainCookie: '' } }, new AbortController().signal)
    const cleared = await client.invoke('request-site-get-cleared', { type: 'remote_site.get', payload: { siteId: site.siteId } }, new AbortController().signal) as { site: { hasProtectedCookie: boolean } }
    expect(cleared.site.hasProtectedCookie).toBe(false)
    await client.invoke('request-site-delete', { type: 'remote_site.delete', payload: { siteId: site.siteId } }, new AbortController().signal)
  })

  it('runs vault history and market-event database chains', async () => {
    const now = new Date().toISOString()
    const item = { itemId: 'vault-integration', itemType: 'account', name: '集成条目', category: 'test', account: 'demo', url: '', platform: '', publicMetadataJson: '{}', hasProtectedSecret: true, createdAt: now, updatedAt: now }
    await client.invoke('request-vault-save-one', { type: 'vault.save', payload: { item, plainSecret: '{"Password":"one"}' } }, new AbortController().signal)
    await client.invoke('request-vault-save-two', { type: 'vault.save', payload: { item: { ...item, updatedAt: new Date().toISOString() }, plainSecret: '{"Password":"two"}' } }, new AbortController().signal)
    const detail = await client.invoke('request-vault-secret-reveal', { type: 'vault.secret.reveal', payload: { itemId: item.itemId } }, new AbortController().signal) as { item: { itemId: string }; secret: string }
    expect(detail.item.itemId).toBe(item.itemId)
    expect(detail.secret).toContain('two')
    const history = await client.invoke('request-vault-history', { type: 'vault.history.list', payload: { itemId: item.itemId } }, new AbortController().signal) as unknown[]
    expect(history.length).toBeGreaterThan(0)
    await client.invoke('request-vault-delete', { type: 'vault.delete', payload: { itemId: item.itemId } }, new AbortController().signal)

    const marketEvent = { eventId: 'market-integration', eventType: 'liquidation', source: 'integration', network: '', symbol: 'BTCUSDT', address: '', transactionHash: '', amount: 1, price: 100, dedupeKey: 'market-integration', payloadJson: '{"side":"SELL"}', occurredAt: now }
    await client.invoke('request-market-record', { type: 'market.record', payload: { marketEvent } }, new AbortController().signal)
    const events = await client.invoke('request-market-list', { type: 'market.list', payload: { symbol: 'BTCUSDT', limit: 10 } }, new AbortController().signal) as Array<{ eventId: string }>
    expect(events.some((event) => event.eventId === marketEvent.eventId)).toBe(true)
  })

})
