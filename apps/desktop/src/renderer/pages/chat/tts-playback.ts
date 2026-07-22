import { bridge } from '../../shared/bridge'

let activeAudio: HTMLAudioElement | null = null
let audioSubscription: (() => void) | null = null

export async function synthesizeAndPlay(text: string, voiceId?: string): Promise<string> {
  reportBubbleHold(true)
  try {
    const response = await bridge.core.invoke({
      type: 'tts.speak',
      payload: { text, ...(voiceId === undefined || voiceId.trim() === '' ? {} : { voiceId }) }
    }, 120_000)
    if (!response.success || typeof response.payload !== 'string' || response.payload.trim() === '')
      throw new Error(response.error?.message ?? '语音合成失败。')
    await playLocalAudio(response.payload)
    return response.payload
  } catch (error) {
    reportBubbleHold(false)
    throw error
  }
}

export async function playLocalAudio(filePath: string): Promise<void> {
  ensureAudioSubscription()
  const master = await loadMasterAudio()
  if (master.muted || master.volume <= 0) {
    stopAudioPlayback()
    return
  }
  const registered = await bridge.media.registerLocalFile(filePath)
  if (!registered.success || registered.payload?.url === undefined)
    throw new Error(registered.error?.message ?? '语音文件读取失败。')
  stopAudioPlayback()
  const audio = new Audio(registered.payload.url)
  audio.volume = master.volume / 100
  activeAudio = audio
  audio.addEventListener('ended', () => {
    if (activeAudio === audio) activeAudio = null
    reportPlayback(false)
  }, { once: true })
  audio.addEventListener('error', () => reportPlayback(false), { once: true })
  await audio.play()
  reportPlayback(true)
}

export async function playLocalAudioPaths(paths: readonly string[]): Promise<number> {
  let played = 0
  for (const path of paths) {
    try {
      await playLocalAudio(path)
      const audio = activeAudio
      if (audio === null) continue
      played += 1
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener('ended', () => resolve(), { once: true })
        audio.addEventListener('error', () => reject(new Error('语音文件播放失败。')), { once: true })
      })
    } catch { /* old project skips missing cached files and never resynthesizes here */ }
  }
  return played
}

export function stopAudioPlayback(): void {
  if (activeAudio !== null) {
    activeAudio.pause()
    reportPlayback(false)
  }
  activeAudio = null
}

function reportPlayback(playing: boolean): void {
  reportBubbleHold(playing)
  void bridge.core.invoke({ type: 'tts.playback.set', payload: { playing } })
}

function reportBubbleHold(held: boolean): void {
  const detail = { held, nonce: crypto.randomUUID() }
  localStorage.setItem('aimaid.bubble-hold', JSON.stringify(detail))
  window.dispatchEvent(new CustomEvent('aimaid:bubble-hold', { detail }))
}

function ensureAudioSubscription(): void {
  if (audioSubscription !== null) return
  audioSubscription = bridge.events.subscribe(['settings.changed'], (event) => {
    const payload = isRecord(event.payload) ? event.payload.data : null
    if (!isRecord(payload) || !Array.isArray(payload.keys) ||
      !payload.keys.some((key) => key === 'master_audio_muted' || key === 'master_audio_volume')) return
    void loadMasterAudio().then((master) => {
      if (master.muted || master.volume <= 0) stopAudioPlayback()
      else if (activeAudio !== null) activeAudio.volume = master.volume / 100
    }).catch(() => stopAudioPlayback())
  })
}

async function loadMasterAudio(): Promise<{ muted: boolean; volume: number }> {
  const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['master_audio_muted', 'master_audio_volume'] } })
  if (!response.success) throw new Error(response.error?.message ?? '主音量设置读取失败。')
  const payload = response.payload as { settings?: Array<{ key: string; value: string }> } | null
  const settings = new Map(payload?.settings?.map((item) => [item.key, item.value]))
  const parsed = Number.parseInt(settings.get('master_audio_volume') ?? '100', 10)
  const volume = Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 100
  return { muted: settings.get('master_audio_muted')?.toLowerCase() === 'true' || volume <= 0, volume }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function attachAudioMetadata(messageId: number, audioPaths: readonly string[], metadata: Record<string, unknown> = {}): Promise<void> {
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || audioPaths.length === 0) return
  const response = await bridge.core.invoke({
    type: 'chat.update_metadata',
    payload: { messageId, metadataJson: JSON.stringify({ ...metadata, audioPaths }) }
  })
  if (!response.success) throw new Error(response.error?.message ?? '语音记录保存失败。')
}
