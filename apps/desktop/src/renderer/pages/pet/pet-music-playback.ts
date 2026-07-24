import type { IpcEventEnvelope } from '../../../shared/ipc'
import { resampleLogFrequencyBands } from '../../../shared/audio-bar-dynamics'
import { publishAudioLipSync } from '../../shared/audio-lipsync'
import { bridge } from '../../shared/bridge'

interface MusicPlaybackState {
  url: string
  title: string
  singer: string
  lyrics: string
  isPlaying: boolean
  isPaused: boolean
}

export interface PetMusicLyricsSnapshot {
  readonly title: string
  readonly singer: string
  readonly current: string
  readonly next: string
}

interface TimedLyricLine {
  readonly time: number
  readonly text: string
}

let activeAnalyser: AnalyserNode | null = null
let activeFrequencyData: Uint8Array<ArrayBuffer> | null = null
let activeLyricsSnapshot: PetMusicLyricsSnapshot | null = null
const lyricsListeners = new Set<(snapshot: PetMusicLyricsSnapshot | null) => void>()

export function subscribePetMusicLyrics(listener: (snapshot: PetMusicLyricsSnapshot | null) => void): () => void {
  lyricsListeners.add(listener)
  listener(activeLyricsSnapshot)
  return () => { lyricsListeners.delete(listener) }
}

export function readPetMusicSpectrum(target: Uint8Array<ArrayBuffer>): boolean {
  if (activeAnalyser === null || activeFrequencyData === null) return false
  activeAnalyser.getByteFrequencyData(activeFrequencyData)
  resampleLogFrequencyBands(activeFrequencyData, target, activeAnalyser.context.sampleRate, activeAnalyser.fftSize)
  return target.some((value) => value > 0)
}

export function readPetMusicWaveform(target: Uint8Array<ArrayBuffer>): boolean {
  if (activeAnalyser === null) return false
  activeAnalyser.getByteTimeDomainData(target)
  return true
}

export function startPetMusicPlayback(): () => void {
  let audio: HTMLAudioElement | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let stopLipSync: (() => void) | null = null
  let playbackUrl = ''
  let lyricLines: TimedLyricLine[] = []
  let activeLyricIndex = -1
  let refreshLyrics: (() => void) | null = null
  let disposed = false
  let masterAudio = { muted: false, volume: 100 }

  const stopLocal = (): void => {
    stopLipSync?.()
    stopLipSync = null
    audio?.pause()
    audio = null
    playbackUrl = ''
    lyricLines = []
    activeLyricIndex = -1
    refreshLyrics = null
    publishLyrics(null)
    activeAnalyser = null
    activeFrequencyData = null
    analyser = null
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
    lyricLines = parseTimedLyrics(state.lyrics)
    activeLyricIndex = -1
    const updateLyrics = (): void => {
      if (element.paused) {
        publishLyrics(null)
        return
      }
      const nextIndex = findCurrentLyricIndex(lyricLines, element.currentTime)
      if (nextIndex === activeLyricIndex) return
      activeLyricIndex = nextIndex
      publishLyrics(nextIndex < 0 ? null : {
        title: state.title,
        singer: state.singer,
        current: lyricLines[nextIndex]!.text,
        next: lyricLines[nextIndex + 1]?.text ?? ''
      })
    }
    refreshLyrics = updateLyrics
    element.addEventListener('timeupdate', updateLyrics)
    element.addEventListener('seeked', updateLyrics)
    element.addEventListener('ended', () => { void stop() }, { once: true })
    element.addEventListener('error', () => { void stop() }, { once: true })

    const context = new AudioContext()
    const source = context.createMediaElementSource(element)
    const nextAnalyser = context.createAnalyser()
    nextAnalyser.fftSize = 1024
    nextAnalyser.smoothingTimeConstant = 0.55
    source.connect(nextAnalyser)
    nextAnalyser.connect(context.destination)
    audio = element
    audioContext = context
    analyser = nextAnalyser
    activeAnalyser = nextAnalyser
    activeFrequencyData = new Uint8Array(nextAnalyser.frequencyBinCount)
    await context.resume()
    await element.play()
    if (!disposed && audio === element && analyser === nextAnalyser) stopLipSync = publishAudioLipSync('music', nextAnalyser)
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
    if (event.type === 'music.playback.state_changed' && isRecord(data) && isPlaybackState(data.playback)) {
      const state = data.playback
      if (state.url !== playbackUrl || audio === null) {
        if (state.isPlaying) void play(state)
        return
      }
      if (state.isPaused) {
        stopLipSync?.()
        stopLipSync = null
        audio.pause()
        publishLyrics(null)
        activeAnalyser = null
        activeFrequencyData = null
      } else if (state.isPlaying) {
        activeAnalyser = analyser
        activeFrequencyData = analyser === null ? null : new Uint8Array(analyser.frequencyBinCount)
        void audioContext?.resume().then(() => audio?.play()).then(() => {
          activeLyricIndex = -1
          refreshLyrics?.()
          if (analyser !== null && stopLipSync === null) stopLipSync = publishAudioLipSync('music', analyser)
        }).catch((reason: unknown) => {
          console.error('[MusicPlayback] resume failed', reason)
          void stop()
        })
      }
      return
    }
    if (event.type === 'music.playback.requested' && isRecord(data) && isPlaybackState(data.playback)) {
      void play(data.playback).catch((reason: unknown) => {
        console.error('[MusicPlayback] start failed', reason)
        void stop()
      })
    }
  }

  const unsubscribe = bridge.events.subscribe(
    ['music.playback.requested', 'music.playback.state_changed', 'music.playback.stopped', 'settings.changed'],
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
    typeof value.singer === 'string' && typeof value.lyrics === 'string' &&
    typeof value.isPlaying === 'boolean' && typeof value.isPaused === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publishLyrics(snapshot: PetMusicLyricsSnapshot | null): void {
  activeLyricsSnapshot = snapshot
  for (const listener of lyricsListeners) listener(snapshot)
}

function parseTimedLyrics(value: string): TimedLyricLine[] {
  const lines: TimedLyricLine[] = []
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g
  for (const rawLine of value.split(/\r?\n/)) {
    const text = rawLine.replace(timestamp, '').trim()
    if (text === '') continue
    timestamp.lastIndex = 0
    for (const match of rawLine.matchAll(timestamp)) {
      const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
      lines.push({
        time: Number(match[1]) * 60 + Number(match[2]) + Number(fraction) / 1000,
        text
      })
    }
  }
  return lines.sort((left, right) => left.time - right.time)
}

function findCurrentLyricIndex(lines: TimedLyricLine[], currentTime: number): number {
  let low = 0
  let high = lines.length - 1
  let result = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (lines[middle]!.time <= currentTime + 0.08) {
      result = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return result
}
