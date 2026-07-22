import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('tray music controls', () => {
  it('shows the current song and exposes pause, resume, and stop without seeking', () => {
    const tray = readFileSync(resolve(root, 'src/renderer/pages/system/TrayMenuPage.tsx'), 'utf8')
    expect(tray).toContain("type: 'music.current'")
    expect(tray).toContain("type: action === 'toggle-pause' ? 'music.toggle_pause' : 'music.stop'")
    expect(tray).toContain("music.isPaused ? '继续播放' : '暂停'")
    expect(tray).toContain('正在播放')
    expect(tray).toContain('停止')
    expect(tray).not.toMatch(/seek|快进/u)
  })

  it('keeps actual audio pause and resume inside the pet renderer', () => {
    const playback = readFileSync(resolve(root, 'src/renderer/pages/pet/pet-music-playback.ts'), 'utf8')
    expect(playback).toContain("event.type === 'music.playback.state_changed'")
    expect(playback).toContain('audio.pause()')
    expect(playback).toContain("audioContext?.resume().then(() => audio?.play())")
  })

  it('publishes a synchronized Core state while leaving playback to the renderer', () => {
    const service = readFileSync(resolve(root, '../../src/AIMaid.Core/MusicApplicationService.cs'), 'utf8')
    expect(service).toContain('TogglePauseAsync')
    expect(service).toContain('MusicPlaybackStateChangedEvent')
    expect(service).not.toContain('MediaPlayer')
  })
})
