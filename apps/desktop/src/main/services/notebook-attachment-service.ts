import { clipboard, dialog, nativeImage, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { PetAssetService } from './pet-asset-service'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'])

export interface NotebookImage {
  path: string
  url: string
  name: string
}

export class NotebookAttachmentService {
  private readonly root: string

  constructor(dataRoot: string, private readonly assets: PetAssetService) {
    this.root = resolve(dataRoot, 'notebook', 'attachments')
  }

  async importFile(sourcePath: string): Promise<NotebookImage> {
    const source = resolve(sourcePath)
    const extension = validateExtension(source)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) throw new TypeError('所选路径不是文件。')
    if (sourceStat.size > MAX_IMAGE_BYTES) throw new TypeError('图片不能超过 25 MB。')
    return this.store(extension, basename(source), async (destination) => copyFile(source, destination))
  }

  async importData(name: string, dataUrl: string): Promise<NotebookImage> {
    const match = /^data:image\/(png|jpeg|jpg|bmp|gif|webp);base64,([a-z0-9+/=]+)$/iu.exec(dataUrl)
    if (match === null) throw new TypeError('图片数据格式不受支持。')
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.length > MAX_IMAGE_BYTES) throw new TypeError('图片不能超过 25 MB。')
    const extension = validateExtension(name.length > 0 ? name : `clipboard.${match[1]}`)
    return this.store(extension, name.length > 0 ? basename(name) : `clipboard${extension}`, async (destination) => writeFile(destination, bytes))
  }

  async action(action: 'copy' | 'openLocation' | 'saveAs', storedPath: string, parent?: BrowserWindow): Promise<void> {
    const fullPath = this.resolveStoredPath(storedPath)
    await stat(fullPath)
    if (action === 'copy') {
      const image = nativeImage.createFromBuffer(await readFile(fullPath))
      if (image.isEmpty()) throw new TypeError('图片读取失败。')
      clipboard.writeImage(image)
      return
    }
    if (action === 'openLocation') {
      shell.showItemInFolder(fullPath)
      return
    }
    const options = { defaultPath: basename(fullPath), filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }, { name: '所有文件', extensions: ['*'] }] }
    const result = parent === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options)
    if (!result.canceled && result.filePath !== undefined) await copyFile(fullPath, result.filePath)
  }

  private async store(extension: string, originalName: string, write: (destination: string) => Promise<unknown>): Promise<NotebookImage> {
    const now = new Date()
    const year = String(now.getFullYear())
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const fileName = `${randomUUID().replaceAll('-', '')}${extension}`
    const directory = join(this.root, year, month)
    const destination = join(directory, fileName)
    await mkdir(directory, { recursive: true })
    await write(destination)
    const storedPath = join('notebook', 'attachments', year, month, fileName)
    return { path: storedPath, url: this.assets.registerNotebookAttachment(destination), name: originalName }
  }

  private resolveStoredPath(storedPath: string): string {
    const normalized = storedPath.replaceAll('/', sep)
    const prefix = join('notebook', 'attachments') + sep
    if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) throw new TypeError('无效的笔记附件路径。')
    const candidate = resolve(this.root, normalized.slice(prefix.length))
    const relativePath = relative(this.root, candidate)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new TypeError('无效的笔记附件路径。')
    return candidate
  }
}

function validateExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new TypeError('图片格式不受支持。')
  return extension
}
