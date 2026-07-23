import { bridge } from '../../shared/bridge'
import { publishAudioLipSync } from '../../shared/audio-lipsync'
import { paginatePetBubble } from '../../../shared/pet'

let activeAudio: HTMLAudioElement | null = null
let activeAudioContext: AudioContext | null = null
let stopActiveLipSync: (() => void) | null = null
let audioSubscription: (() => void) | null = null
const CACHED_AUDIO_MIN_DURATION_SECONDS = 0.15
type CachedAudioSource = 'startup' | 'click'
type PendingPlayback = { source: CachedAudioSource; cancel: () => void }
let pendingPlayback: PendingPlayback | null = null

export type CachedAudioPlaybackResult =
  | { played: true; durationSeconds: number }
  | { played: false; reason: 'audio_loading' | 'audio_busy' | 'master_muted' | 'volume_zero' | 'file_unreadable' | 'decode_failed' | 'unsupported_format' | 'zero_duration' | 'play_failed'; message: string }

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
  const pending: PendingPlayback = {
    source: options?.source ?? 'click',
    cancel: () => {
      cancelled = true
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }
  pendingPlayback = pending
  audio.addEventListener('ended', () => {
    releaseAudio(audio)
  }, { once: true })
  audio.addEventListener('error', () => releaseAudio(audio), { once: true })
  try {
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
    if (cancelled) throw new CachedAudioError('audio_loading', '语音加载已取消。')
    if (audio.paused) throw new CachedAudioError('play_failed', '语音未进入播放状态。')
    if (Number.isFinite(audio.duration) && audio.duration <= CACHED_AUDIO_MIN_DURATION_SECONDS)
      throw new CachedAudioError('zero_duration', `语音时长无效：${audio.duration || 0} 秒。`)
    activeAudio = audio
    activeAudioContext = context
    if (pendingPlayback === pending) pendingPlayback = null
    context = null
    stopActiveLipSync = publishAudioLipSync('tts', analyser)
    reportPlayback(true)
    onPlaybackStarted?.()
    return audio
  } catch (error) {
    const failure = normalizeCachedAudioError(audio, error)
    if (options?.requireReady === true) logCachedAudioFailure(audio, registered.payload.url, failure)
    if (pendingPlayback === pending) pendingPlayback = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    void context?.close().catch((reason: unknown) => console.error('[TTSPlayback] pending audio context close failed', reason))
    throw failure
  }
}

export async function playCachedAudio(filePath: string, source: CachedAudioSource = 'click'): Promise<CachedAudioPlaybackResult> {
  if (activeAudio !== null) return { played: false, reason: 'audio_busy', message: '当前正在播放其他语音。' }
  if (pendingPlayback !== null) {
    if (source === 'click' && pendingPlayback.source === 'startup') cancelPendingPlayback()
    else return { played: false, reason: 'audio_loading', message: '语音正在加载，请稍候。' }
  }
  const master = await loadMasterAudio()
  if (master.muted || master.volume <= 0) return { played: false, reason: master.volume <= 0 ? 'volume_zero' : 'master_muted', message: master.volume <= 0 ? '应用主音量为 0，无法播放语音。' : '应用主音量已静音。' }
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

function logCachedAudioFailure(audio: HTMLAudioElement, registeredUrl: string, error: unknown): void {
  console.warn('[TTSPlayback] cached media failed ' + JSON.stringify({
    registeredUrl,
    readyState: audio.readyState,
    networkState: audio.networkState,
    mediaErrorCode: audio.error?.code ?? null,
    duration: Number.isFinite(audio.duration) ? audio.duration : null,
    currentTime: audio.currentTime,
    paused: audio.paused,
    contentType: expectedAudioMime(registeredUrl),
    reason: error instanceof CachedAudioError ? error.reason : error instanceof Error ? error.message : String(error)
  }))
}

function normalizeCachedAudioError(audio: HTMLAudioElement, error: unknown): unknown {
  if (error instanceof CachedAudioError) return error
  if (audio.error !== null)
    return new CachedAudioError(audio.error.code === 4 ? 'unsupported_format' : 'decode_failed', describeMediaError(audio))
  if (error instanceof DOMException && error.name === 'NotSupportedError')
    return new CachedAudioError('unsupported_format', error.message || '浏览器不支持该语音格式。')
  return error
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
