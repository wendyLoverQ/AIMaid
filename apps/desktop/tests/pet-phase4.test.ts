import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isSafePetAssetPath, resolveExternalMediaPath } from '../src/main/services/pet-asset-service'
import { PetAssetService } from '../src/main/services/pet-asset-service'
import { PetPresentationService } from '../src/main/services/pet-presentation-service'
import { paginatePetBubble } from '../src/shared/pet'
import { WINDOW_REGISTRY } from '../src/main/windows/window-registry'

describe('phase 4 PetWindow integration', () => {
  it('uses a transparent always-on-top pet window', () => {
    const pet = WINDOW_REGISTRY.pet.options
    const manager = readFileSync(resolve(import.meta.dirname, '../src/main/windows/pet-window-manager.ts'), 'utf8')
    expect(pet.transparent).toBe(true)
    expect(pet.frame).toBe(false)
    expect(pet.resizable).toBe(false)
    expect(pet.skipTaskbar).toBe(true)
    expect(pet.width).toBe(560)
    expect(pet.height).toBe(980)
    expect(pet.alwaysOnTop).toBe(true)
    expect(manager).toContain('window.showInactive()')
    expect(manager).toContain('fitVirtualDesktop')
    expect(manager).toContain("type: 'system.window.fit_virtual_desktop'")
  })

  it('only accepts normalized approved Live2D asset paths', () => {
    expect(isSafePetAssetPath('models/changli/长离.model3.json')).toBe(true)
    expect(isSafePetAssetPath('models/changli/长离.4096/texture_00.png')).toBe(true)
    expect(isSafePetAssetPath('generated/voice.wav')).toBe(true)
    expect(isSafePetAssetPath('../secret.json')).toBe(false)
    expect(isSafePetAssetPath('C:/secret.json')).toBe(false)
    expect(isSafePetAssetPath('models\\secret.json')).toBe(false)
    expect(isSafePetAssetPath('models/changli/readme.txt')).toBe(false)
  })

  it('registers external audio with its real extension', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aimaid-audio-asset-'))
    try {
      const resources = resolve(root, 'live2d')
      const ui = resolve(root, 'ui')
      const notebook = resolve(root, 'notebook')
      mkdirSync(resources, { recursive: true })
      mkdirSync(resolve(ui, 'generated'), { recursive: true })
      writeFileSync(resolve(ui, 'generated', 'voice.wav'), 'RIFF')
      const assets = new PetAssetService(resources, ui, notebook, { info: () => undefined, warn: () => undefined } as never)
      expect(assets.registerExternalFile(resolve(ui, 'generated', 'voice.wav'))).toMatch(/\.wav$/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('paginates long bubble text near the requested Chinese character range', () => {
    const pages = paginatePetBubble('桌'.repeat(180))
    expect(pages).toHaveLength(3)
    expect(pages[0]).toHaveLength(78)
    expect(pages.every((page) => page.length <= 78)).toBe(true)
  })

  it('shows each spoken page only after its audio playback has started', () => {
    const playback = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/chat/tts-playback.ts'), 'utf8')
    const prompt = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/chat/PromptPage.tsx'), 'utf8')
    const voiceConversation = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/voice-conversation/VoiceConversationPage.tsx'), 'utf8')
    const playStarted = playback.indexOf('await audio.play()')
    const pagePublished = playback.indexOf('onPlaybackStarted?.()')
    expect(playStarted).toBeGreaterThan(-1)
    expect(pagePublished).toBeGreaterThan(playStarted)
    expect(playback).toContain('const audio = await playLocalAudio(path, () => onPageStarted(pages[index]!, index))')
    expect(playback).toContain('await waitForAudioEnd(audio)')
    expect(prompt).not.toContain("publishPetBubble(content, payload.suppressSpeech ? 'feedback' : 'speech'")
    expect(prompt).toContain('synthesizeAndPlayPages(content, voiceId')
    expect(voiceConversation).not.toContain("publishPetBubble(reply, 'speech'")
    expect(voiceConversation).toContain('synthesizeAndPlayPages(reply, role.preferredVoiceId')
  })

  it('does not use synchronous GPU pixel readback for hit testing', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/live2d/runtime/Live2DPlayer.ts'), 'utf8')
    expect(source).not.toContain('readPixels(')
    expect(source).toContain('resolveAutoHitArea')
  })

  it('reveals the transparent pet window only after the active renderer has drawn', () => {
    const router = readFileSync(resolve(import.meta.dirname, '../src/main/ipc/ipc-router.ts'), 'utf8')
    const page = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/PetPage.tsx'), 'utf8')
    const presentationGet = router.slice(router.indexOf("case 'pet.presentation.get':"), router.indexOf("case 'pet.presentation.execute':"))
    expect(presentationGet).not.toContain('rendererReady')
    expect(page).toContain('onFirstFrame={revealPetWindow}')
    expect(page).toContain('image.onload = () =>')
    expect(page).toContain('onFirstFrame();')
  })

  it('keeps the chat prompt above the fullscreen pet window', () => {
    const chat = WINDOW_REGISTRY.chat.options
    const manager = readFileSync(resolve(import.meta.dirname, '../src/main/windows/window-manager.ts'), 'utf8')
    expect(chat.alwaysOnTop).toBe(true)
    expect(manager).toContain("if (kind === 'chat') window.setAlwaysOnTop(true, 'screen-saver')")
    expect(manager).toContain("if (kind === 'chat') existing.setAlwaysOnTop(true, 'screen-saver')")
    expect(manager).toContain("if (kind === 'chat') existing.moveTop()")
  })

  it('discovers bundled Live2D roles and switches the requested model manifest', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aimaid-live2d-'))
    try {
      const resources = resolve(root, 'live2d')
      const ui = resolve(root, 'ui')
      const notebook = resolve(root, 'notebook')
      const images = resolve(root, 'images')
      const png = resolve(root, 'png')
      mkdirSync(resolve(resources, 'models', 'changli'), { recursive: true })
      mkdirSync(resolve(resources, 'models', '镜流'), { recursive: true })
      mkdirSync(resolve(resources, 'models', 'nested-only', 'nested'), { recursive: true })
      mkdirSync(ui, { recursive: true })
      mkdirSync(images, { recursive: true })
      mkdirSync(png, { recursive: true })
      writeFileSync(resolve(resources, 'models', 'changli', '长离.model3.json'), '{}')
      writeFileSync(resolve(resources, 'models', '镜流', '镜流.model3.json'), '{}')
      writeFileSync(resolve(resources, 'models', 'nested-only', 'nested', 'ignored.model3.json'), '{}')
      const log = { info: () => undefined, warn: () => undefined } as never
      const assets = new PetAssetService(resources, ui, notebook, log)
      expect(assets.listLive2dRoles()).toEqual(expect.arrayContaining(['changli', '镜流']))
      expect(assets.listLive2dRoles()).not.toContain('nested-only')
      const manifest = assets.getManifest('镜流')
      expect(manifest.modelId).toBe('镜流')
      expect(manifest.modelUrl).toContain('/models/%E9%95%9C%E6%B5%81/%E9%95%9C%E6%B5%81.model3.json')
      expect(() => assets.getManifest('missing')).toThrow('Unknown Live2D role')

      const presentation = new PetPresentationService(resolve(root, 'presentation.json'), assets, log, images, png)
      const before = presentation.snapshot()
      const after = await presentation.execute('switch-live2d-role', null as never)
      expect(before.live2dRoles).toHaveLength(2)
      expect(after.live2dRole).not.toBe(before.live2dRole)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cycles image playback folders from the configured gallery root', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aimaid-image-folders-'))
    try {
      const resources = resolve(root, 'live2d')
      const ui = resolve(root, 'ui')
      const notebook = resolve(root, 'notebook')
      const images = resolve(root, 'images')
      const png = resolve(root, 'png')
      mkdirSync(resources, { recursive: true })
      mkdirSync(ui, { recursive: true })
      mkdirSync(notebook, { recursive: true })
      mkdirSync(resolve(images, '扶她'), { recursive: true })
      mkdirSync(resolve(images, '妹妹'), { recursive: true })
      mkdirSync(png, { recursive: true })
      writeFileSync(resolve(images, '扶她', '01.png'), 'one')
      writeFileSync(resolve(images, '妹妹', '01.png'), 'two')
      const log = { info: () => undefined, warn: () => undefined } as never
      const assets = new PetAssetService(resources, ui, notebook, log)
      const presentation = new PetPresentationService(resolve(root, 'presentation.json'), assets, log, images, png)

      const before = presentation.snapshot()
      const after = await presentation.execute('cycle-image-folder', null as never)

      expect(before.imageRoot).toBe(images)
      expect(before.imageFolderName).toBe('扶她')
      expect(after.imageFolderName).toBe('妹妹')
      expect(after.currentImage?.name).toBe('01.png')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('indexes only the selected PNG sequence and reuses it until the directory changes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aimaid-png-index-'))
    try {
      const resources = resolve(root, 'live2d')
      const ui = resolve(root, 'ui')
      const notebook = resolve(root, 'notebook')
      const images = resolve(root, 'images')
      const png = resolve(root, 'png')
      mkdirSync(resources, { recursive: true })
      mkdirSync(ui, { recursive: true })
      mkdirSync(notebook, { recursive: true })
      mkdirSync(images, { recursive: true })
      mkdirSync(resolve(png, 'xinxin'), { recursive: true })
      mkdirSync(resolve(png, 'unused-role'), { recursive: true })
      writeFileSync(resolve(png, 'xinxin', '01.png'), 'one')
      writeFileSync(resolve(png, 'xinxin', '02.png'), 'two')
      writeFileSync(resolve(png, 'unused-role', '01.png'), 'unused')
      const log = { info: () => undefined, warn: () => undefined } as never
      const assets = new PetAssetService(resources, ui, notebook, log)
      const registerExternalFile = vi.spyOn(assets, 'registerExternalFile')
      const presentation = new PetPresentationService(resolve(root, 'presentation.json'), assets, log, images, png)

      const first = presentation.snapshot()
      const second = presentation.snapshot()
      const registeredPaths = registerExternalFile.mock.calls.map(([path]) => path)

      expect(first.pngFrames).toHaveLength(2)
      expect(second.pngFrames).toEqual(first.pngFrames)
      expect(registeredPaths.filter((path) => path.includes('xinxin'))).toHaveLength(2)
      expect(registeredPaths.some((path) => path.includes('unused-role'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not index PNG frames while ordinary image mode is active', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aimaid-image-mode-'))
    try {
      const resources = resolve(root, 'live2d')
      const ui = resolve(root, 'ui')
      const notebook = resolve(root, 'notebook')
      const images = resolve(root, 'images')
      const png = resolve(root, 'png')
      mkdirSync(resources, { recursive: true })
      mkdirSync(ui, { recursive: true })
      mkdirSync(notebook, { recursive: true })
      mkdirSync(images, { recursive: true })
      mkdirSync(resolve(png, 'xinxin'), { recursive: true })
      writeFileSync(resolve(images, '01.png'), 'image')
      writeFileSync(resolve(png, 'xinxin', '01.png'), 'frame')
      const log = { info: () => undefined, warn: () => undefined } as never
      const assets = new PetAssetService(resources, ui, notebook, log)
      const registerExternalFile = vi.spyOn(assets, 'registerExternalFile')
      const presentation = new PetPresentationService(resolve(root, 'presentation.json'), assets, log, images, png)
      await presentation.executeAction('cycle-mode', null as never)
      await presentation.executeAction('cycle-mode', null as never)

      const snapshot = presentation.snapshot()
      const registeredPaths = registerExternalFile.mock.calls.map(([path]) => path)

      expect(snapshot.mode).toBe('image')
      expect(snapshot.pngFrames).toEqual([])
      expect(registeredPaths.some((path) => path.includes(`${resolve(png)}\\`))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the comic bubble timing state without manual page controls', () => {
    const bubble = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/PetBubble.tsx'), 'utf8')
    expect(bubble).not.toContain('上一页')
    expect(bubble).not.toContain('下一页')
    expect(bubble).not.toContain('Navigation')
    expect(bubble).toContain('Math.min(20_000, 3_500 + Array.from(text).length * 70)')
    expect(bubble).toContain('MAX_VISIBLE_MS = 60_000')
    expect(bubble).toContain('AFTER_SPEECH_VISIBLE_MS = 5_000')
  })

  it('claims a music URL before async setup can start duplicate playback', () => {
    const music = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/pet-music-playback.ts'), 'utf8')
    const claim = music.indexOf('playbackUrl = state.url')
    const loadSettings = music.indexOf('masterAudio = await loadMasterAudio()', claim)
    expect(claim).toBeGreaterThan(0)
    expect(loadSettings).toBeGreaterThan(claim)
  })

  it('renders music once as an independent stage overlay with selectable geometries', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/PetPage.tsx'), 'utf8')
    const contour = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/PetAudioContour.tsx'), 'utf8')
    const settings = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/settings/SettingsPage.tsx'), 'utf8')
    const router = readFileSync(resolve(import.meta.dirname, '../src/main/ipc/event-router.ts'), 'utf8')
    expect(page.match(/<PetAudioContour /gu)?.length).toBe(1)
    expect(page.indexOf('</PetItemSurface>')).toBeLessThan(page.indexOf('<PetAudioContour '))
    expect(page).toContain('sourceCanvasRef={visualCanvasRef}')
    expect(page).toContain('visualizerStyle={visualizerStyle}')
    expect(contour).toContain('captureAlphaContour(source, maskCanvas)')
    expect(contour).toContain('drawSurroundWave(')
    expect(contour).toContain('drawBottomBars(')
    expect(contour).toContain("style === 'surround-bars'")
    expect(contour).toContain('for (let distance = 0; distance < perimeter; distance += spacing)')
    expect(contour).toContain('barSpectrumTarget(spectrum, peak, barIndex)')
    expect(contour).toContain('advanceBarDynamics(dynamics.get(barIndex) ?? 0, target, barIndex)')
    expect(contour).toContain("if (style === 'surround-line') path.closePath()")
    expect(contour).toContain('sourceBounds.left - stageBounds.left - region.left')
    expect(contour).toContain('const MASK_REFRESH_MS = 120')
    expect(contour).toContain("const context = overlay.getContext('2d')")
    expect(contour).toContain('positionOverlay(overlay, sourceBounds, stageBounds, contour)')
    expect(contour).toContain('positionBottomOverlay(overlay, sourceBounds, stageBounds, contour, bottomLayout, anchor)')
    expect(contour).toContain('positionRadialOverlay(overlay, sourceBounds, stageBounds, radialLayout, anchor)')
    expect(contour).not.toContain("overlay.getContext('2d', { willReadFrequently: true })")
    expect(contour).toContain("getPropertyValue('--color-accent')")
    expect(contour).not.toContain("|| '#6e8fff'")
    expect(settings).toContain('MUSIC_VISUALIZER_STYLE_OPTIONS')
    expect(settings).toContain('音浪作为独立覆盖层显示')
    expect(router).not.toContain("this.windows.open('music-visualizer')")
  })

  it('allows command-triggered music to autoplay without a renderer click', () => {
    const main = readFileSync(resolve(import.meta.dirname, '../src/main/main.ts'), 'utf8')
    const html = readFileSync(resolve(import.meta.dirname, '../src/renderer/index.html'), 'utf8')
    expect(main).toContain("app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')")
    expect(html).toContain("media-src 'self' aimaid-asset: https: blob:")
  })

  it('resolves migrated relative media paths under packaged UI resources', () => {
    const uiRoot = resolve('C:/AIMaid/resources/ui')
    expect(resolveExternalMediaPath('characters/genshin_avatars/barbara.png', uiRoot))
      .toBe(resolve(uiRoot, 'characters/genshin_avatars/barbara.png'))
    expect(resolveExternalMediaPath('Assets/characters/1783431322324.jpg', uiRoot))
      .toBe(resolve(uiRoot, 'characters/1783431322324.jpg'))
    expect(() => resolveExternalMediaPath('../secret.png', uiRoot)).toThrow('outside the UI resource root')
  })

  it('fits the pet window to the mixed-DPI virtual desktop', () => {
    const manager = readFileSync(resolve(import.meta.dirname, '../src/main/windows/pet-window-manager.ts'), 'utf8')
    const nativeController = readFileSync(resolve(import.meta.dirname, '../../../src/AIMaid.Platform.Windows/WindowsPetWindowController.cs'), 'utf8')
    expect(manager).toContain('window.getNativeWindowHandle()')
    expect(manager).toContain("type: 'system.window.fit_virtual_desktop'")
    expect(nativeController).toContain('SmXVirtualScreen = 76')
    expect(nativeController).toContain('SetWindowPos(handle')
    expect(nativeController).not.toContain('SwpShowWindow')
    expect(manager).toContain('window.showInactive()')
    expect(manager).toContain("window.setAlwaysOnTop(true, 'screen-saver')")
    expect(manager).not.toContain('setShape')
  })

  it('does not expose a browser window before its first rendered frame', () => {
    const factory = readFileSync(resolve(import.meta.dirname, '../src/main/windows/window-factory.ts'), 'utf8')
    const manager = readFileSync(resolve(import.meta.dirname, '../src/main/windows/window-manager.ts'), 'utf8')
    expect(factory).toContain("backgroundColor: definition.options.backgroundColor ?? DEFAULT_WINDOW_BACKGROUND")
    expect(manager).toContain("window.once('ready-to-show', showLoadedWindow)")
    expect(manager).not.toContain("window.webContents.once('did-finish-load', showLoadedWindow)")
    expect(manager).toContain("window.once('ready-to-show', ready)")
  })

  it('reveals the transparent pet window atomically after visible frames are composited', () => {
    const manager = readFileSync(resolve(import.meta.dirname, '../src/main/windows/pet-window-manager.ts'), 'utf8')
    const reveal = manager.slice(manager.indexOf('private async revealReadyWindow'))
    expect(reveal).toContain('window.setOpacity(0)')
    expect(reveal).toContain('window.showInactive()')
    expect(reveal).toContain('requestAnimationFrame(() => requestAnimationFrame(resolve))')
    expect(reveal).toContain('window.setOpacity(1)')
    expect(reveal.indexOf('window.setOpacity(0)')).toBeLessThan(reveal.indexOf('window.showInactive()'))
    expect(reveal.indexOf('window.showInactive()')).toBeLessThan(reveal.indexOf('window.setOpacity(1)'))
  })

  it('moves and scales the shared pet item without changing the virtual-desktop window', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/PetPage.tsx'), 'utf8')
    const controller = readFileSync(resolve(import.meta.dirname, '../src/renderer/shared/pet-item-interaction-controller.ts'), 'utf8')
    const css = readFileSync(resolve(import.meta.dirname, '../src/renderer/components/components.css'), 'utf8')
    expect(page).toContain('new PetItemInteractionController')
    expect(page.match(/registerHitTest=\{registerHitTest\}/gu)?.length).toBe(3)
    expect(controller).toContain('const WHEEL_ZOOM_IN = 1.08')
    expect(controller).toContain('const WHEEL_ZOOM_OUT = 0.92')
    expect(controller).toContain('this.offsetX = this.dragStartOffsetX')
    expect(controller).toContain('this.applyItemTransform()')
    expect(controller).not.toContain('this.options.updateWindow(')
    expect(controller).not.toContain('this.options.dragMove()')
    expect(css).toContain('.ui-pet-item')
    expect(css).toContain('width: 560px; height: 980px')
  })

})
