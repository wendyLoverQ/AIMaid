import { useEffect, useRef, useState } from 'react'
import { Button, Container, Divider, Range, Text, TrayMenuSurface, TrayMusicPlayer } from '../../components/ui'
import type { IpcEventEnvelope } from '../../../shared/ipc'
import { bridge } from '../../shared/bridge'

interface MasterAudioState {
  muted: boolean
  volume: number
}

interface MusicPlaybackState {
  url: string
  title: string
  singer: string
  isPlaying: boolean
  isPaused: boolean
}

export function TrayMenuPage(): React.JSX.Element {
  const safeAudio: MasterAudioState = { muted: true, volume: 0 }
  const confirmedAudio = useRef(safeAudio)
  const surfaceRef = useRef<HTMLElement>(null)
  const [audio, setAudio] = useState<MasterAudioState>(safeAudio)
  const [music, setMusic] = useState<MusicPlaybackState | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadMasterAudio().then((loaded) => {
      confirmedAudio.current = loaded
      setAudio(loaded)
    }).catch((reason: unknown) => setError(messageOf(reason, '主音量设置读取失败。')))
    void loadCurrentMusic().then(setMusic).catch((reason: unknown) => setError(messageOf(reason, '当前音乐读取失败。')))
    return bridge.events.subscribe(
      ['music.playback.requested', 'music.playback.state_changed', 'music.playback.stopped'],
      (event) => updateMusicFromEvent(event, setMusic)
    )
  }, [])

  const save = async (next: MasterAudioState): Promise<void> => {
    const normalized = { muted: next.muted || next.volume <= 0, volume: next.volume }
    const response = await bridge.core.invoke({
      type: 'settings.save',
      payload: { values: { master_audio_muted: String(normalized.muted), master_audio_volume: String(normalized.volume) } }
    })
    if (response.success) {
      confirmedAudio.current = normalized
      setAudio(normalized)
      setError('')
    } else {
      setAudio(confirmedAudio.current)
      setError(response.error?.message ?? '主音量设置保存失败。')
    }
  }

  const controlMusic = async (action: 'toggle-pause' | 'stop'): Promise<void> => {
    const response = await bridge.core.invoke({
      type: action === 'toggle-pause' ? 'music.toggle_pause' : 'music.stop',
      payload: {}
    })
    if (!response.success) {
      setError(response.error?.message ?? '音乐控制失败。')
      return
    }
    setMusic(action === 'stop' ? null : isPlaybackState(response.payload) ? response.payload : music)
    setError('')
  }

  const run = async (action: 'show' | 'reset-position' | 'hide' | 'quit'): Promise<void> => {
    const response = await bridge.tray.action(action)
    if (!response.success) setError(response.error?.message ?? '托盘操作失败。')
  }

  const openShowcase = async (): Promise<void> => {
    const response = await bridge.window.open('ui-showcase')
    if (!response.success) {
      setError(response.error?.message ?? '控件展示窗口打开失败。')
      return
    }
    await bridge.window.close()
  }

  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    let lastHeight = 0
    const report = (): void => {
      const height = Math.ceil(surface.getBoundingClientRect().height)
      if (height === lastHeight) return
      lastHeight = height
      void bridge.tray.resize(height).then((response) => {
        if (!response.success) setError(response.error?.message ?? '托盘尺寸更新失败。')
      })
    }
    const observer = new ResizeObserver(report)
    observer.observe(surface)
    report()
    return () => observer.disconnect()
  }, [])
  const hasMusic = music !== null && music.url !== '' && (music.isPlaying || music.isPaused)
  return <TrayMenuSurface ref={surfaceRef} onKeyDown={(event) => { if (event.key === 'Escape') void bridge.window.close() }} tabIndex={-1}>
    <Button onClick={() => run('show')}>显示</Button>
    <Divider />
    {hasMusic
      ? <TrayMusicPlayer title={music.title} singer={music.singer} paused={music.isPaused}
          onTogglePause={() => void controlMusic('toggle-pause')} onStop={() => void controlMusic('stop')} />
      : <Text size="xs" tone="muted">当前未播放音乐</Text>}
    <Divider />
    <Button variant={audio.muted ? 'primary' : 'secondary'} onClick={() => void save({ ...audio, muted: !audio.muted })}>
      {audio.muted ? '声音：已静音' : '声音：正常'}
    </Button>
    <Container>
      <Range label="主音量" valueLabel={`${audio.volume}%`} min="0" max="100" step="1" value={audio.volume}
        onChange={(event) => setAudio({ muted: Number(event.target.value) <= 0, volume: Number(event.target.value) })}
        onPointerUp={(event) => { const volume = Number(event.currentTarget.value); void save({ muted: volume <= 0, volume }) }}
        onKeyUp={(event) => { const volume = Number(event.currentTarget.value); void save({ muted: volume <= 0, volume }) }} />
    </Container>
    {error !== '' ? <Text size="xs" tone="danger">{error}</Text> : null}
    <Divider />
    <Button onClick={() => void openShowcase()}>控件展示</Button>
    <Divider />
    <Button onClick={() => run('reset-position')}>位置回归</Button>
    <Button onClick={() => run('hide')}>隐藏</Button>
    <Button variant="danger" onClick={() => run('quit')}>退出</Button>
  </TrayMenuSurface>
}

async function loadMasterAudio(): Promise<MasterAudioState> {
  const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['master_audio_muted', 'master_audio_volume'] } })
  if (!response.success) throw new Error(response.error?.message ?? '主音量设置读取失败。')
  const payload = response.payload as { settings?: Array<{ key: string; value: string }> } | null
  const settings = new Map(payload?.settings?.map((item) => [item.key, item.value]))
  const volume = Math.min(100, Math.max(0, Number.parseInt(settings.get('master_audio_volume') ?? '100', 10) || 0))
  return { muted: settings.get('master_audio_muted')?.toLowerCase() === 'true' || volume <= 0, volume }
}

async function loadCurrentMusic(): Promise<MusicPlaybackState | null> {
  const response = await bridge.core.invoke({ type: 'music.current', payload: {} })
  if (!response.success) throw new Error(response.error?.message ?? '当前音乐读取失败。')
  return isPlaybackState(response.payload) && response.payload.url !== '' ? response.payload : null
}

function updateMusicFromEvent(event: IpcEventEnvelope, update: (state: MusicPlaybackState | null) => void): void {
  if (event.type === 'music.playback.stopped') {
    update(null)
    return
  }
  const data = isRecord(event.payload) ? event.payload.data : null
  if (isRecord(data) && isPlaybackState(data.playback)) update(data.playback)
}

function isPlaybackState(value: unknown): value is MusicPlaybackState {
  return isRecord(value) && typeof value.url === 'string' && typeof value.title === 'string' &&
    typeof value.singer === 'string' && typeof value.isPlaying === 'boolean' && typeof value.isPaused === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() !== '' ? reason.message : fallback
}
