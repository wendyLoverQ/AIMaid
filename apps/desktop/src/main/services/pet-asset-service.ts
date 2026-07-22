import { net, protocol } from 'electron'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { PetAssetManifest } from '../../shared/pet'
import type { Logger } from '../logging/logger'

const SCHEME = 'aimaid-asset'
const HOST = 'pet'
const UI_HOST = 'ui'
const NOTEBOOK_ATTACHMENT_HOST = 'notebook-attachments'
const ALLOWED_EXTENSIONS = new Set([
  '.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.html', '.css', '.motion3', '.exp3', '.physics3', '.cdi3', '.js',
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts',
  '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac'
])

export class PetAssetService {
  private readonly root: string
  private readonly uiRoot: string
  private readonly notebookAttachmentRoot: string
  private readonly externalFiles = new Map<string, string>()
  private registered = false

  constructor(resourceRoot: string, uiResourceRoot: string, notebookAttachmentRoot: string, private readonly log: Logger) {
    this.root = realpathSync(resolve(resourceRoot))
    this.uiRoot = realpathSync(resolve(uiResourceRoot))
    mkdirSync(notebookAttachmentRoot, { recursive: true })
    this.notebookAttachmentRoot = realpathSync(resolve(notebookAttachmentRoot))
  }

  register(): void {
    if (this.registered) return
    protocol.handle(SCHEME, async (request) => this.handle(request))
    this.registered = true
  }

  dispose(): void {
    if (!this.registered) return
    protocol.unhandle(SCHEME)
    this.registered = false
  }

  listLive2dRoles(): string[] {
    const modelsRoot = join(this.root, 'models')
    if (!existsSync(modelsRoot)) return []
    return readdirSync(modelsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && this.resolveModelFile(join(modelsRoot, entry.name)) !== null)
      .map((entry) => entry.name)
      .sort(naturalCompare)
  }

  getManifest(modelId: string): PetAssetManifest {
    const roles = this.listLive2dRoles()
    if (!roles.includes(modelId)) throw new Error(`Unknown Live2D role: ${modelId}`)
    const modelFile = this.resolveModelFile(join(this.root, 'models', modelId))
    if (modelFile === null) throw new Error(`Live2D model file is missing: ${modelId}`)
    const modelPath = relative(this.root, modelFile).split(sep).map(encodeURIComponent).join('/')
    return {
      modelId,
      modelUrl: `${SCHEME}://${HOST}/${modelPath}`,
      cubismCoreUrl: `${SCHEME}://${HOST}/vendor/live2dcubismcore.min.js`
    }
  }

  private resolveModelFile(folder: string): string | null {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json'))
      .map((entry) => join(folder, entry.name))
      .sort(naturalCompare)[0] ?? null
  }

  registerExternalFile(path: string): string {
    const real = realpathSync(resolveExternalMediaPath(path, this.uiRoot))
    if (!ALLOWED_EXTENSIONS.has(extname(real).toLowerCase())) throw new Error('Unsupported pet media file')
    const token = createHash('sha256').update(real.toLowerCase()).digest('hex')
    this.externalFiles.set(token, real)
    return `${SCHEME}://media/${token}`
  }

  registerNotebookAttachment(path: string): string {
    const real = realpathSync(resolve(path))
    if (!ALLOWED_EXTENSIONS.has(extname(real).toLowerCase())) throw new Error('Unsupported notebook attachment')
    const relativePath = relative(this.notebookAttachmentRoot, real)
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) throw new Error('Notebook attachment is outside its root')
    return `${SCHEME}://${NOTEBOOK_ATTACHMENT_HOST}/${relativePath.split(sep).map(encodeURIComponent).join('/')}`
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if ((url.host === 'media' || url.host === NOTEBOOK_ATTACHMENT_HOST) && request.method === 'GET') {
        if (url.host === NOTEBOOK_ATTACHMENT_HOST) {
          return this.serveRootFile(this.notebookAttachmentRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ''))
        }
        const token = url.pathname.replace(/^\/+/, '')
        const path = this.externalFiles.get(token)
        if (path === undefined || !existsSync(path)) return new Response('Not found', { status: 404 })
        const range = request.headers.get('range')
        return withCors(await net.fetch(pathToFileURL(path).toString(), range === null ? {} : { headers: { Range: range } }))
      }
      if (url.host === UI_HOST && request.method === 'GET') {
        return this.serveRootFile(this.uiRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ''))
      }
      if (url.host !== HOST || request.method !== 'GET') return new Response('Not found', { status: 404 })
      const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      return this.serveRootFile(this.root, decoded)
    } catch (error) {
      this.log.warn('pet-assets', 'Rejected asset request', {
        message: error instanceof Error ? error.message : String(error)
      })
      return new Response('Bad request', { status: 400 })
    }
  }

  private async serveRootFile(root: string, decoded: string): Promise<Response> {
    if (!isSafePetAssetPath(decoded)) return new Response('Forbidden', { status: 403 })
    const candidate = resolve(root, decoded)
    if (!existsSync(candidate)) return new Response('Not found', { status: 404 })
    const real = realpathSync(candidate)
    const relativePath = relative(root, real)
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
      return new Response('Forbidden', { status: 403 })
    }
    return withCors(await net.fetch(pathToFileURL(real).toString()))
  }
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function isSafePetAssetPath(value: string): boolean {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || value.includes(':')) return false
  const parts = value.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return false
  return ALLOWED_EXTENSIONS.has(extname(value).toLowerCase()) && join(...parts) === value.replaceAll('/', sep)
}

export function resolveExternalMediaPath(path: string, uiRoot: string): string {
  if (isAbsolute(path)) return resolve(path)
  const segments = path.replaceAll('\\', '/').split('/').filter((segment) => segment !== '')
  if (segments[0]?.toLocaleLowerCase() === 'assets') segments.shift()
  const candidate = resolve(uiRoot, ...segments)
  const relativePath = relative(uiRoot, candidate)
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new Error('Relative media file is outside the UI resource root')
  }
  return candidate
}
