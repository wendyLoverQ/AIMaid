import { bridge } from '../../shared/bridge'
import { publishAudioLipSync } from '../../shared/audio-lipsync'
import { paginatePetBubble } from '../../../shared/pet'

let activeAudio: HTMLAudioElement | null = null
let activeAudioContext: AudioContext | null = null
let stopActiveLipSync: (() => void) | null = null
let audioSubscription: (() => void) | null = null
const CACHED_AUDIO_MIN_DURATION_SECONDS = 0.15
const CACHED_AUDIO_READY_TIMEOUT_MS = 5000
type CachedAudioSource = 'startup' | 'click'
type PendingPlayback = { source: CachedAudioSource; cancel: () => void }
let pendingPlayback: PendingPlayback | null = null

export type CachedAudioPlaybackResult =
  | { played: true; durationSeconds: number }
  | { played: false; reason: 'audio_loading' | 'audio_busy' | 'master_muted' | 'volume_zero' | 'file_unreadable' | 'decode_failed' | 'unsupported_format' | 'zero_duration' | 'media_timeout' | 'play_failed'; message: string }

class CachedAudioError extends Error {
  constructor(public readonly reason: Exclude<CachedAudioPlaybackResult, { played: true }>['reason'], message: string) {
    super(message)
  }
}

export async function synthesizeAndPlay(text: string, voiceId?: string): Promise<string> {
  const path = await synthesizeSpeech(text, voiceId)
  await playLocalAudio(path)
  return path
}

export async function synthesizeAndPlayPages(
  text: string,
  voiceId: string | undefined,
  onPageStarted: (page: string, index: number) => void
): Promise<string[]> {
  const pages = paginatePetBubble(text)
  if (pages.length === 0) return []
  const paths: string[] = []
  for (const page of pages) paths.push(await synthesizeSpeech(page, voiceId))
  for (const [index, path] of paths.entries()) {
    const audio = await playLocalAudio(path, () => onPageStarted(pages[index]!, index))
    if (audio === null) break
    await waitForAudioEnd(audio)
  }
  return paths
}

async function synthesizeSpeech(text: string, voiceId?: string): Promise<string> {
  const response = await bridge.core.invoke({
    type: 'tts.speak',
    payload: { text, ...(voiceId === undefined || voiceId.trim() === '' ? {} : { voiceId }) }
  }, 120_000)
  if (!response.success || typeof response.payload !== 'string' || response.payload.trim() === '')
    throw new Error(response.error?.message ?? '语音合成失败。')
  return response.payload
}

export async function playLocalAudio(filePath: string, onPlaybackStarted?: () => void, options?: { requireReady?: boolean; source?: CachedAudioSource }): Promise<HTMLAudioElement | null> {
  ensureAudioSubscription()
  cancelPendingPlayback()
  const master = await loadMasterAudio()
  if (master.muted || master.volume <= 0) {
    stopAudioPlayback()
    return null
  }
  const registered = await bridge.media.registerLocalFile(filePath)
  if (!registered.success || registered.payload?.url === undefined)
    throw options?.requireReady === true
      ? new CachedAudioError('file_unreadable', registered.error?.message ?? '语音文件读取失败。')
      : new Error(registered.error?.message ?? '语音文件读取失败。')
  stopAudioPlayback()
  const audio = new Audio(registered.payload.url)
  audio.preload = 'auto'
  audio.volume = master.volume / 100
  let context: AudioContext | null = null
  let cancelled = false
  let rejectPending: ((error: Error) => void) | null = null
  const pending: PendingPlayback = {
    source: options?.source ?? 'click',
    cancel: () => {
      cancelled = true
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      rejectPending?.(new CachedAudioError('audio_loading', '语音加载已取消。'))
    }
  }
  pendingPlayback = pending
  audio.addEventListener('ended', () => {
    releaseAudio(audio)
  }, { once: true })
  audio.addEventListener('error', () => releaseAudio(audio), { once: true })
  try {
    if (options?.requireReady === true) {
      await Promise.race([
        waitForCachedAudioReady(audio, registered.payload.url),
        new Promise<never>((_, reject) => { rejectPending = reject })
      ])
    }
    if (cancelled) throw new CachedAudioError('audio_loading', '语音加载已取消。')
    context = new AudioContext()
    const source = context.createMediaElementSource(audio)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.minDecibels = -90
    analyser.maxDecibels = -10
    analyser.smoothingTimeConstant = 0.85
    source.connect(analyser)
    analyser.connect(context.destination)
    await context.resume()
    if (cancelled) throw new CachedAudioError('audio_loading', '语音加载已取消。')
    await audio.play()
    await waitForAudioPlaying(audio)
    if (cancelled) throw new CachedAudioError('audio_loading', '语音加载已取消。')
    activeAudio = audio
    activeAudioContext = context
    if (pendingPlayback === pending) pendingPlayback = null
    context = null
    stopActiveLipSync = publishAudioLipSync('tts', analyser)
    reportPlayback(true)
    onPlaybackStarted?.()
    return audio
  } catch (error) {
    if (pendingPlayback === pending) pendingPlayback = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    void context?.close().catch((reason: unknown) => console.error('[TTSPlayback] pending audio context close failed', reason))
    throw error
  }
}

export async function playCachedAudio(filePath: string, source: CachedAudioSource = 'click'): Promise<CachedAudioPlaybackResult> {
  if (activeAudio !== null) return { played: false, reason: 'audio_busy', message: '当前正在播放其他语音。' }
  if (pendingPlayback !== null) {
    if (source === 'click' && pendingPlayback.source === 'startup') cancelPendingPlayback()
    else return { played: false, reason: 'audio_loading', message: '语音正在加载，请稍候。' }
  }
  const master = await loadMasterAudio()
  if (master.muted) return { played: false, reason: master.volume <= 0 ? 'volume_zero' : 'master_muted', message: master.volume <= 0 ? '应用主音量为 0，无法播放语音。' : '应用主音量已静音。' }
  try {
    const audio = await playLocalAudio(filePath, undefined, { requireReady: true, source })
    if (audio === null) return { played: false, reason: 'play_failed', message: '语音未进入播放状态。' }
    return { played: true, durationSeconds: audio.duration }
  } catch (error) {
    if (error instanceof CachedAudioError) return { played: false, reason: error.reason, message: error.message }
    return { played: false, reason: 'play_failed', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function playLocalAudioPaths(paths: readonly string[], onPlaybackStarted?: (index: number) => void): Promise<number> {
  let played = 0
  for (const [index, path] of paths.entries()) {
    try {
      const audio = await playLocalAudio(path, () => onPlaybackStarted?.(index))
      if (audio === null) continue
      played += 1
      await waitForAudioEnd(audio)
    } catch { /* old project skips missing cached files and never resynthesizes here */ }
  }
  return played
}

function waitForAudioEnd(audio: HTMLAudioElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    audio.addEventListener('ended', () => resolve(), { once: true })
    audio.addEventListener('error', () => reject(new Error('语音文件播放失败。')), { once: true })
  })
}

function waitForCachedAudioReady(audio: HTMLAudioElement, registeredUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let loadedMetadataReceived = false
    let canplayReceived = false
    const timer = window.setTimeout(() => finish(new CachedAudioError('media_timeout', '语音媒体加载超时。')), CACHED_AUDIO_READY_TIMEOUT_MS)
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('canplay', onCanplay)
      audio.removeEventListener('error', onError)
      if (error !== undefined) {
        console.warn('[TTSPlayback] cached media failed', {
          registeredUrl,
          readyState: audio.readyState,
          networkState: audio.networkState,
          mediaErrorCode: audio.error?.code ?? null,
          duration: Number.isFinite(audio.duration) ? audio.duration : null,
          loadedMetadataReceived,
          canplayReceived,
          contentType: expectedAudioMime(registeredUrl),
          reason: error instanceof CachedAudioError ? error.reason : error.message
        })
        reject(error)
      }
      else resolve()
    }
    const onError = (): void => finish(new CachedAudioError(audio.error?.code === 4 ? 'unsupported_format' : 'decode_failed', describeMediaError(audio)))
    const check = (): void => {
      if (audio.error !== null) return onError()
      if (!Number.isFinite(audio.duration)) return
      if (audio.duration <= CACHED_AUDIO_MIN_DURATION_SECONDS) return finish(new CachedAudioError('zero_duration', `语音时长无效：${audio.duration || 0} 秒。`))
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) finish()
    }
    const onLoadedMetadata = (): void => { loadedMetadataReceived = true; check() }
    const onCanplay = (): void => { canplayReceived = true; check() }
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('canplay', onCanplay)
    audio.addEventListener('error', onError)
    audio.load()
    check()
  })
}

function waitForAudioPlaying(audio: HTMLAudioElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new CachedAudioError('play_failed', '语音未进入 playing 状态。')), 3000)
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('error', onError)
      error === undefined ? resolve() : reject(error)
    }
    const onPlaying = (): void => finish()
    const onError = (): void => finish(new CachedAudioError(audio.error?.code === 4 ? 'unsupported_format' : 'decode_failed', describeMediaError(audio)))
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('error', onError)
    if (!audio.paused && audio.currentTime > 0) finish()
  })
}

function describeMediaError(audio: HTMLAudioElement): string {
  const code = audio.error?.code
  return code === 3 ? 'Chromium 解码语音失败。' : code === 4 ? '浏览器不支持该语音格式。' : `语音媒体读取失败（错误码 ${code ?? 'unknown'}）。`
}

function expectedAudioMime(url: string): string {
  const extension = new URL(url).pathname.match(/\.[a-z0-9]+$/iu)?.[0]?.toLowerCase()
  return extension === '.wav' ? 'audio/wav' : extension === '.mp3' ? 'audio/mpeg' : extension === '.ogg' ? 'audio/ogg' : 'unknown'
}

function cancelPendingPlayback(): void {
  const pending = pendingPlayback
  pendingPlayback = null
  pending?.cancel()
}

export function stopAudioPlayback(): void {
  cancelPendingPlayback()
  if (activeAudio !== null) {
    const audio = activeAudio
    audio.pause()
    releaseAudio(audio)
  }
}

function releaseAudio(audio: HTMLAudioElement): void {
  if (activeAudio !== audio) return
  activeAudio = null
  stopActiveLipSync?.()
  stopActiveLipSync = null
  const context = activeAudioContext
  activeAudioContext = null
  void context?.close().catch((error: unknown) => console.error('[TTSPlayback] audio context close failed', error))
  reportPlayback(false)
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
