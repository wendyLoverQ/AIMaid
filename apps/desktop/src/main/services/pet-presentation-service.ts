import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { PetDisplayMode, PetMediaItem, PetPresentationAction, PetPresentationSnapshot } from '../../shared/presentation'
import type { Logger } from '../logging/logger'
import type { PetAssetService } from './pet-asset-service'

interface PersistedPresentation {
  mode: PetDisplayMode
  paused: boolean
  imageRoot: string
  imageFolder: string
  imageIndex: number
  imageIntervalIndex: number
  pngRoot: string
  pngRole: string
  pngFps: number
  pngCarousel: boolean
  live2dRole: string
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
const IMAGE_INTERVALS = [5, 10, 20, 40, 60, 180, 300, 600] as const
const PNG_FPS_VALUES = [30, 40, 50, 60, 70, 80] as const

export class PetPresentationService {
  private state: PersistedPresentation
  private snapshotLogged = false
  private readonly mediaCache = new Map<string, { modifiedAtMs: number; items: PetMediaItem[] }>()

  constructor(
    private readonly statePath: string,
    private readonly assets: PetAssetService,
    private readonly log: Logger,
    private readonly bundledImageRoot: string,
    private readonly bundledPngRoot: string
  ) {
    this.state = this.readState()
  }

  currentMode(): PetDisplayMode {
    return this.state.mode
  }

  snapshot(): PetPresentationSnapshot {
    if (!isDirectory(this.state.pngRoot)) this.state.pngRoot = this.bundledPngRoot
    if (!isDirectory(this.state.imageRoot)) this.state.imageRoot = this.bundledImageRoot
    this.state.imageFolder = this.resolveImageFolder(this.state.imageRoot, this.state.imageFolder)
    const images = this.listMedia(this.state.imageFolder)
    const roles = this.listDirectories(this.state.pngRoot)
    if (!roles.includes(this.state.pngRole)) this.state.pngRole = roles[0] ?? ''
    const roleFolder = this.state.pngRole === '' ? '' : join(this.state.pngRoot, this.state.pngRole)
    const frames = this.state.mode === 'png-sequence' ? this.listMedia(roleFolder) : []
    const live2dRoles = this.assets.listLive2dRoles()
    if (!live2dRoles.includes(this.state.live2dRole)) this.state.live2dRole = live2dRoles[0] ?? ''
    const imageIndex = images.length === 0 ? 0 : Math.min(Math.max(0, this.state.imageIndex), images.length - 1)
    this.state.imageIndex = imageIndex
    if (!this.snapshotLogged) {
      this.snapshotLogged = true
      this.log.info('pet-presentation', 'Bundled presentation assets resolved', {
        imageFolder: this.state.imageFolder,
        imageCount: images.length,
        pngRoot: this.state.pngRoot,
        pngRole: this.state.pngRole,
        pngFrameCount: frames.length
      })
    }
    return {
      mode: this.state.mode,
      paused: this.state.paused,
      imageRoot: this.state.imageRoot,
      imageFolder: this.state.imageFolder,
      imageFolderName: this.imageFolderName(this.state.imageFolder),
      imageIntervalSeconds: IMAGE_INTERVALS[this.state.imageIntervalIndex] ?? IMAGE_INTERVALS[1],
      currentImage: images[imageIndex] ?? null,
      pngRoot: this.state.pngRoot,
      pngRole: this.state.pngRole,
      pngSourceFps: this.readPngSourceFps(roleFolder),
      pngFps: this.state.pngFps,
      pngCarousel: this.state.pngCarousel,
      pngFrames: frames,
      pngRoles: roles,
      live2dRole: this.state.live2dRole,
      live2dRoles
    }
  }

  async execute(action: PetPresentationAction, parent: BrowserWindow): Promise<PetPresentationSnapshot> {
    await this.executeAction(action, parent)
    return this.snapshot()
  }

  async executeAction(action: PetPresentationAction, parent: BrowserWindow): Promise<void> {
    switch (action) {
      case 'toggle-pause': this.state.paused = !this.state.paused; break
      case 'cycle-mode': this.state.mode = nextMode(this.state.mode); break
      case 'next-image': this.nextImage(); break
      case 'cycle-image-interval': this.state.imageIntervalIndex = (this.state.imageIntervalIndex + 1) % IMAGE_INTERVALS.length; break
      case 'choose-image-folder': await this.chooseImageFolder(parent); break
      case 'cycle-image-folder': await this.cycleImageFolder(parent); break
      case 'cycle-png-fps': this.state.pngFps = nextValue(PNG_FPS_VALUES, this.state.pngFps); break
      case 'cycle-png-role': this.cyclePngRole(); break
      case 'toggle-png-carousel': this.state.pngCarousel = !this.state.pngCarousel; break
      case 'switch-live2d-role': this.cycleLive2dRole(); break
    }
    this.persist()
  }

  executeHotkey(action: 'cycle-mode-reverse' | 'play-previous'): void {
    if (action === 'cycle-mode-reverse') {
      this.state.mode = previousMode(this.state.mode)
    } else if (this.state.mode === 'image') {
      const count = this.listFiles(this.state.imageFolder).length
      this.state.imageIndex = count === 0 ? 0 : (this.state.imageIndex - 1 + count) % count
    } else if (this.state.mode === 'png-sequence') {
      const roles = this.listDirectories(this.state.pngRoot)
      const index = roles.indexOf(this.state.pngRole)
      this.state.pngRole = roles.length === 0 ? '' : roles[(index - 1 + roles.length) % roles.length] ?? ''
    } else {
      const roles = this.snapshot().live2dRoles
      const index = roles.indexOf(this.state.live2dRole)
      this.state.live2dRole = roles.length === 0 ? '' : roles[(index - 1 + roles.length) % roles.length] ?? ''
    }
    this.persist()
  }

  private nextImage(): void {
    const count = this.listFiles(this.state.imageFolder).length
    this.state.imageIndex = count === 0 ? 0 : (this.state.imageIndex + 1) % count
  }

  private cyclePngRole(): void {
    const roles = this.listDirectories(this.state.pngRoot)
    if (roles.length === 0) { this.state.pngRole = ''; return }
    const index = roles.indexOf(this.state.pngRole)
    this.state.pngRole = roles[(index + 1 + roles.length) % roles.length] ?? ''
  }

  private cycleLive2dRole(): void {
    const roles = this.snapshot().live2dRoles
    if (roles.length === 0) { this.state.live2dRole = ''; return }
    const index = roles.indexOf(this.state.live2dRole)
    this.state.live2dRole = roles[(index + 1 + roles.length) % roles.length] ?? ''
  }

  private async chooseImageFolder(parent: BrowserWindow): Promise<void> {
    const options: Electron.OpenDialogOptions = {
      title: '选择图片文件夹',
      properties: ['openDirectory']
    }
    if (existsSync(this.state.imageRoot)) options.defaultPath = this.state.imageRoot
    const result = await dialog.showOpenDialog(parent, options)
    if (!result.canceled && result.filePaths[0] !== undefined) {
      this.state.imageRoot = resolve(result.filePaths[0])
      this.state.imageFolder = this.resolveImageFolder(this.state.imageRoot)
      this.state.imageIndex = 0
    }
  }

  private async cycleImageFolder(parent: BrowserWindow): Promise<void> {
    const folders = this.listImageFolders(this.state.imageRoot)
    if (folders.length === 0) {
      await this.chooseImageFolder(parent)
      return
    }
    if (folders.length === 1) {
      this.nextImage()
      return
    }
    const current = folders.findIndex((folder) => samePath(folder, this.state.imageFolder))
    this.state.imageFolder = folders[(current + 1 + folders.length) % folders.length]!
    this.state.imageIndex = 0
  }

  private listMedia(folder: string): PetMediaItem[] {
    if (folder === '' || !existsSync(folder)) return []
    const modifiedAtMs = statSync(folder).mtimeMs
    const cached = this.mediaCache.get(folder)
    if (cached?.modifiedAtMs === modifiedAtMs) return cached.items
    const items = this.listFiles(folder).map((path) => ({ name: basename(path), url: this.assets.registerExternalFile(path) }))
    this.mediaCache.set(folder, { modifiedAtMs, items })
    return items
  }

  private listFiles(folder: string): string[] {
    if (folder === '' || !existsSync(folder) || !statSync(folder).isDirectory()) return []
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => join(folder, entry.name))
      .sort(naturalCompare)
  }

  private listDirectories(folder: string): string[] {
    if (folder === '' || !existsSync(folder) || !statSync(folder).isDirectory()) return []
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(naturalCompare)
  }

  private listImageFolders(root: string): string[] {
    if (!isDirectory(root)) return []
    const folders = this.listDirectories(root)
      .map((name) => join(root, name))
      .filter((folder) => this.listFiles(folder).length > 0)
    if (folders.length > 0) return folders
    return this.listFiles(root).length > 0 ? [root] : []
  }

  private resolveImageFolder(root: string, preferredFolder?: string): string {
    const folders = this.listImageFolders(root)
    const preferred = folders.find((folder) => preferredFolder !== undefined && samePath(folder, preferredFolder))
      ?? folders.find((folder) => this.imageFolderName(folder).localeCompare('扶她', 'zh-CN', { sensitivity: 'base' }) === 0)
    return preferred ?? folders[0] ?? root
  }

  private imageFolderName(folder: string): string {
    if (samePath(folder, this.bundledImageRoot)) return '扶她'
    return basename(folder) || '自定义'
  }

  private readPngSourceFps(roleFolder: string): number {
    if (roleFolder === '') return this.state.pngFps
    try {
      const manifestPath = join(roleFolder, 'manifest.json')
      if (!existsSync(manifestPath)) return this.state.pngFps
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { fps?: unknown }
      return typeof manifest.fps === 'number' && Number.isFinite(manifest.fps)
        ? Math.min(120, Math.max(1, manifest.fps))
        : this.state.pngFps
    } catch (error) {
      this.log.warn('pet-presentation', 'Failed to read PNG sequence manifest', { roleFolder, message: String(error) })
      return this.state.pngFps
    }
  }

  private readState(): PersistedPresentation {
    const defaults: PersistedPresentation = {
      mode: 'png-sequence', paused: false,
      imageRoot: process.env.AIMAID_IMAGE_TILES_ROOT?.trim() || this.bundledImageRoot,
      imageFolder: process.env.AIMAID_IMAGE_TILES_ROOT?.trim() || this.bundledImageRoot, imageIndex: 0, imageIntervalIndex: 1,
      pngRoot: process.env.AIMAID_PNG_SEQUENCE_ROOT?.trim() || this.bundledPngRoot, pngRole: 'xinxin', pngFps: 30,
      pngCarousel: false, live2dRole: 'changli'
    }
    try {
      if (!existsSync(this.statePath)) return defaults
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedPresentation>
      const imageRoot = typeof parsed.imageRoot === 'string' && parsed.imageRoot.trim() !== ''
        ? parsed.imageRoot
        : this.inferLegacyImageRoot(parsed.imageFolder, defaults.imageRoot)
      return { ...defaults, ...parsed, imageRoot, mode: isMode(parsed.mode) ? parsed.mode : defaults.mode }
    } catch (error) {
      this.log.warn('pet-presentation', 'Failed to read presentation state', { message: String(error) })
      return defaults
    }
  }

  private persist(): void {
    try { writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8') }
    catch (error) { this.log.warn('pet-presentation', 'Failed to persist presentation state', { message: String(error) }) }
  }

  private inferLegacyImageRoot(imageFolder: string | undefined, fallbackRoot: string): string {
    if (imageFolder === undefined || imageFolder.trim() === '') return fallbackRoot
    const bundled = resolve(this.bundledImageRoot)
    const selected = resolve(imageFolder)
    return selected === bundled || selected.startsWith(`${bundled}\\`) ? bundled : selected
  }
}

function nextMode(mode: PetDisplayMode): PetDisplayMode {
  return mode === 'image' ? 'png-sequence' : mode === 'png-sequence' ? 'live2d' : 'image'
}
function previousMode(mode: PetDisplayMode): PetDisplayMode {
  return mode === 'image' ? 'live2d' : mode === 'live2d' ? 'png-sequence' : 'image'
}
function nextValue<const T extends readonly number[]>(values: T, current: number): T[number] {
  const index = values.indexOf(current as T[number])
  return values[(index + 1 + values.length) % values.length]!
}
function isMode(value: unknown): value is PetDisplayMode { return value === 'image' || value === 'png-sequence' || value === 'live2d' }
function naturalCompare(a: string, b: string): number { return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }) }
function isDirectory(path: string): boolean { return path !== '' && existsSync(path) && statSync(path).isDirectory() }
function samePath(left: string, right: string): boolean { return resolve(left).localeCompare(resolve(right), undefined, { sensitivity: 'accent' }) === 0 }
