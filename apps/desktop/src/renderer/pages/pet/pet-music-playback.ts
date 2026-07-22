import type { IpcEventEnvelope } from '../../../shared/ipc'
import { bridge } from '../../shared/bridge'

interface MusicPlaybackState {
  url: string
  title: string
  singer: string
  isPlaying: boolean
}

let activeAnalyser: AnalyserNode | null = null

export function readPetMusicSpectrum(target: Uint8Array<ArrayBuffer>): boolean {
  if (activeAnalyser === null) return false
  activeAnalyser.getByteFrequencyData(target)
  return target.some((value) => value > 0)
}

export function startPetMusicPlayback(): () => void {
  let audio: HTMLAudioElement | null = null
  let audioContext: AudioContext | null = null
  let playbackUrl = ''
  let disposed = false
  let masterAudio = { muted: false, volume: 100 }

  const stopLocal = (): void => {
    audio?.pause()
    audio = null
    playbackUrl = ''
    activeAnalyser = null
    void audioContext?.close()
    audioContext = null
  }

  const stop = async (): Promise<void> => {
    stopLocal()
    await bridge.core.invoke({ type: 'music.stop', payload: {} })
  }

  const play = async (state: MusicPlaybackState): Promise<void> => {
    if (disposed || !state.isPlaying || state.url === '' || state.url === playbackUrl) return
    stopLocal()
    // Claim before the first await because music.current and the event can race.
    playbackUrl = state.url
    masterAudio = await loadMasterAudio()
    if (disposed || playbackUrl !== state.url) return
    if (masterAudio.muted || masterAudio.volume <= 0) {
      await stop()
      return
    }

    const element = new Audio()
    element.crossOrigin = 'anonymous'
    element.src = state.url
    element.preload = 'auto'
    element.volume = masterAudio.volume / 100
    element.addEventListener('ended', () => { void stop() }, { once: true })
    element.addEventListener('error', () => { void stop() }, { once: true })

    const context = new AudioContext()
    const source = context.createMediaElementSource(element)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.72
    source.connect(analyser)
    analyser.connect(context.destination)
    audio = element
    audioContext = context
    activeAnalyser = analyser
    await context.resume()
    await element.play()
  }

  const onCoreEvent = (event: IpcEventEnvelope): void => {
    if (event.type === 'settings.changed') {
      const data = readEventData(event.payload)
      if (!isRecord(data) || !Array.isArray(data.keys) ||
        !data.keys.some((key) => key === 'master_audio_muted' || key === 'master_audio_volume')) return
      void loadMasterAudio().then((master) => {
        masterAudio = master
        if (master.muted || master.volume <= 0) void stop()
        else if (audio !== null) audio.volume = master.volume / 100
      }).catch(() => { void stop() })
      return
    }
    if (event.type === 'music.playback.stopped') {
      stopLocal()
      return
    }
    const data = readEventData(event.payload)
    if (event.type === 'music.playback.requested' && isRecord(data) && isPlaybackState(data.playback)) {
      void play(data.playback).catch((reason: unknown) => {
        console.error('[MusicPlayback] start failed', reason)
        void stop()
      })
    }
  }

  const unsubscribe = bridge.events.subscribe(
    ['music.playback.requested', 'music.playback.stopped', 'settings.changed'],
    onCoreEvent
  )
  void bridge.core.invoke({ type: 'music.current', payload: {} }).then((response) => {
    if (!response.success) throw new Error(response.error?.message ?? '当前音乐状态读取失败。')
    if (isPlaybackState(response.payload)) return play(response.payload)
  }).catch((reason: unknown) => {
    console.error('[MusicPlayback] current state failed', reason)
    void stop()
  })

  return () => {
    disposed = true
    unsubscribe()
    stopLocal()
  }
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

function readEventData(value: unknown): unknown {
  return isRecord(value) ? value.data : null
}

function isPlaybackState(value: unknown): value is MusicPlaybackState {
  return isRecord(value) && typeof value.url === 'string' && typeof value.title === 'string' &&
    typeof value.singer === 'string' && typeof value.isPlaying === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
