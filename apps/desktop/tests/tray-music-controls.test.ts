import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('tray music controls', () => {
  it('shows the current song and exposes pause, resume, playlist next, and stop without seeking', () => {
    const tray = readFileSync(resolve(root, 'src/renderer/pages/system/TrayMenuPage.tsx'), 'utf8')
    const player = readFileSync(resolve(root, 'src/renderer/components/media/TrayMusicPlayer.tsx'), 'utf8')
    expect(tray).toContain("type: 'music.current'")
    expect(tray).toContain("action === 'next' ? 'music.next' : 'music.stop'")
    expect(tray).toContain('<TrayMusicPlayer')
    expect(tray).not.toContain('ResizeObserver')
    expect(tray).toContain('bridge.tray.resize(height)')
    expect(tray).toContain('heightReported.current = true')
    expect(player).toContain("label={paused ? '继续播放' : '暂停'}")
    expect(player).toContain('<UiIcon name={paused ? \'play\' : \'pause\'} />')
    expect(player).toContain('label="下一曲"')
    expect(player).toContain('<UiIcon name="next" />')
    expect(player).toContain('label="停止"')
    expect(player).toContain('<UiIcon name="stop" />')
    expect(`${tray}\n${player}`).not.toMatch(/seek|快进/u)
  })

  it('shrinks the menu when idle and preserves its bottom edge', () => {
    const router = readFileSync(resolve(root, 'src/main/ipc/ipc-router.ts'), 'utf8')
    const resizeStart = router.indexOf("case 'tray.resize'")
    const resizeEnd = router.indexOf("case 'douyin.session.save'", resizeStart)
    const resizeHandler = router.slice(resizeStart, resizeEnd)
    expect(router).toContain("case 'tray.resize'")
    expect(router).toContain('const requestedHeight = readTrayHeight(request.payload)')
    expect(router).toContain('const height = Math.min(requestedHeight, workArea.height)')
    expect(router).toContain('bottom - height')
    expect(resizeHandler.indexOf('window.show()')).toBeGreaterThan(resizeHandler.indexOf('window.setBounds'))
    expect(resizeHandler.slice(resizeHandler.indexOf('window.show()'))).not.toContain('window.setBounds')
    expect(router).not.toMatch(/visible \? \d+ : \d+/u)
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
