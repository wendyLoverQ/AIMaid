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

  constructor(
    private readonly statePath: string,
    private readonly assets: PetAssetService,
    private readonly log: Logger,
    private readonly bundledImageRoot: string,
    private readonly bundledPngRoot: string
  ) {
    this.state = this.readState()
  }

  snapshot(): PetPresentationSnapshot {
    if (!isDirectory(this.state.pngRoot)) this.state.pngRoot = this.bundledPngRoot
    this.state.imageFolder = this.resolveImageFolder(this.state.imageFolder)
    const images = this.listMedia(this.state.imageFolder)
    const roles = this.listDirectories(this.state.pngRoot)
    if (!roles.includes(this.state.pngRole)) this.state.pngRole = roles[0] ?? ''
    const roleFolder = this.state.pngRole === '' ? '' : join(this.state.pngRoot, this.state.pngRole)
    const frames = this.listMedia(roleFolder)
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
      imageFolder: this.state.imageFolder,
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
    switch (action) {
      case 'toggle-pause': this.state.paused = !this.state.paused; break
      case 'cycle-mode': this.state.mode = nextMode(this.state.mode); break
      case 'next-image': this.nextImage(); break
      case 'cycle-image-interval': this.state.imageIntervalIndex = (this.state.imageIntervalIndex + 1) % IMAGE_INTERVALS.length; break
      case 'choose-image-folder': await this.chooseImageFolder(parent); break
      case 'cycle-png-fps': this.state.pngFps = nextValue(PNG_FPS_VALUES, this.state.pngFps); break
      case 'cycle-png-role': this.cyclePngRole(); break
      case 'toggle-png-carousel': this.state.pngCarousel = !this.state.pngCarousel; break
      case 'switch-live2d-role': this.cycleLive2dRole(); break
    }
    this.persist()
    return this.snapshot()
  }

  executeHotkey(action: 'cycle-mode-reverse' | 'play-previous'): PetPresentationSnapshot {
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
    return this.snapshot()
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
    if (existsSync(this.state.imageFolder)) options.defaultPath = this.state.imageFolder
    const result = await dialog.showOpenDialog(parent, options)
    if (!result.canceled && result.filePaths[0] !== undefined) {
      this.state.imageFolder = resolve(result.filePaths[0])
      this.state.imageIndex = 0
    }
  }

  private listMedia(folder: string): PetMediaItem[] {
    return this.listFiles(folder).map((path) => ({ name: basename(path), url: this.assets.registerExternalFile(path) }))
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

  private resolveImageFolder(folder: string): string {
    if (!isDirectory(folder)) folder = this.bundledImageRoot
    if (this.listFiles(folder).length > 0) return folder
    const folders = this.listDirectories(folder).filter((name) => this.listFiles(join(folder, name)).length > 0)
    const preferred = folders.find((name) => name.localeCompare('扶她', 'zh-CN', { sensitivity: 'base' }) === 0)
    return preferred === undefined ? (folders[0] === undefined ? folder : join(folder, folders[0])) : join(folder, preferred)
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
      imageFolder: process.env.AIMAID_IMAGE_TILES_ROOT?.trim() || this.bundledImageRoot, imageIndex: 0, imageIntervalIndex: 1,
      pngRoot: process.env.AIMAID_PNG_SEQUENCE_ROOT?.trim() || this.bundledPngRoot, pngRole: 'xinxin', pngFps: 30,
      pngCarousel: false, live2dRole: 'changli'
    }
    try {
      if (!existsSync(this.statePath)) return defaults
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedPresentation>
      return { ...defaults, ...parsed, mode: isMode(parsed.mode) ? parsed.mode : defaults.mode }
    } catch (error) {
      this.log.warn('pet-presentation', 'Failed to read presentation state', { message: String(error) })
      return defaults
    }
  }

  private persist(): void {
    try { writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8') }
    catch (error) { this.log.warn('pet-presentation', 'Failed to persist presentation state', { message: String(error) }) }
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
