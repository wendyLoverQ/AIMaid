import { net, protocol } from 'electron'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

type Live2DFileDefinition = { Name?: string; File: string }
type Live2DModelJson = {
  FileReferences?: {
    Expressions?: Live2DFileDefinition[]
    Motions?: Record<string, Live2DFileDefinition[]>
    [key: string]: unknown
  }
  AIMaidHotkeys?: Live2DHotkeyDefinition[]
  [key: string]: unknown
}

export type Live2DHotkeyDefinition = {
  name: string
  action: 'ToggleExpression' | 'TriggerAnimation' | 'RemoveAllExpressions'
  file: string
  triggers: string[]
}

export type EnrichedLive2DModel = {
  data: Buffer
  motionOutfitParameterIds: Map<string, Set<string>>
  expressionCount: number
  motionGroups: Record<string, number>
}

export class PetAssetService {
  private readonly root: string
  private readonly uiRoot: string
  private readonly notebookAttachmentRoot: string
  private readonly externalFiles = new Map<string, string>()
  private readonly motionOutfitParameterIds = new Map<string, Set<string>>()
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

  getLive2dRoleFolder(modelId: string): string {
    const roles = this.listLive2dRoles()
    if (!roles.includes(modelId)) return ''
    return join(this.root, 'models', modelId)
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
    return `${SCHEME}://media/${token}${extname(real).toLowerCase()}`
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
        const match = url.pathname.match(/^\/+([a-f0-9]{64})(\.[a-z0-9]+)$/iu)
        if (match === null) return new Response('Not found', { status: 404 })
        const token = match[1]!
        const extension = match[2]!.toLowerCase()
        const path = this.externalFiles.get(token)
        if (path === undefined || !existsSync(path) || extname(path).toLowerCase() !== extension) return new Response('Not found', { status: 404 })
        const range = request.headers.get('range')
        const upstream = await net.fetch(pathToFileURL(path).toString(), range === null ? {} : { headers: { Range: range } })
        const headers = new Headers(upstream.headers)
        headers.set('Content-Type', audioMimeType(extension))
        headers.set('Accept-Ranges', upstream.headers.get('Accept-Ranges') ?? 'bytes')
        return withCors(new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers }))
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
    if (root === this.root && real.toLowerCase().endsWith('.model3.json')) {
      const enriched = await enrichLive2DModel(real)
      for (const [motionPath, parameterIds] of enriched.motionOutfitParameterIds) {
        this.motionOutfitParameterIds.set(motionPath, parameterIds)
      }
      this.log.info('pet-assets', 'Enriched Live2D model settings', {
        modelPath: real,
        expressions: enriched.expressionCount,
        motionGroups: enriched.motionGroups
      })
      return jsonBufferResponse(enriched.data)
    }
    if (root === this.root && real.toLowerCase().endsWith('.motion3.json')) {
      const protectedParameterIds = this.motionOutfitParameterIds.get(normalizeLocalFileKey(real))
      const transformed = await readMotionWithoutOutfitCurves(real, protectedParameterIds)
      if (transformed.removedCurveCount > 0) {
        this.log.info('pet-assets', 'Removed outfit-changing curves from click motion', {
          motionPath: real,
          removed: transformed.removedCurveCount
        })
      }
      return jsonBufferResponse(transformed.data)
    }
    return withCors(await net.fetch(pathToFileURL(real).toString()))
  }
}

/**
 * VTube Studio exports often leave expression and motion files beside the
 * model without registering them in model3.json. Expose those resources to
 * Cubism at request time without modifying the bundled source assets.
 */
export async function enrichLive2DModel(modelPath: string): Promise<EnrichedLive2DModel> {
  const raw = await readFile(modelPath, 'utf8')
  const model = JSON.parse(raw) as Live2DModelJson
  const modelDir = dirname(modelPath)
  const files = await listFilesRecursively(modelDir)
  const references = model.FileReferences ?? (model.FileReferences = {})

  const expressions = references.Expressions ?? (references.Expressions = [])
  const knownExpressionFiles = new Set(expressions.map((item) => normalizeAssetPath(item.File).toLowerCase()))
  const usedExpressionNames = new Set(expressions.map((item) => item.Name).filter((name): name is string => typeof name === 'string'))
  for (const file of files.filter((item) => item.toLowerCase().endsWith('.exp3.json'))) {
    const relativePath = normalizeAssetPath(relative(modelDir, file))
    if (knownExpressionFiles.has(relativePath.toLowerCase())) continue
    const baseName = basename(file).replace(/\.exp3\.json$/iu, '')
    let name = baseName
    let suffix = 2
    while (usedExpressionNames.has(name)) name = `${baseName}_${suffix++}`
    expressions.push({ Name: name, File: relativePath })
    knownExpressionFiles.add(relativePath.toLowerCase())
    usedExpressionNames.add(name)
  }

  const motions = references.Motions ?? (references.Motions = {})
  const knownMotionFiles = new Set(
    Object.values(motions).flat().map((item) => normalizeAssetPath(item.File).toLowerCase())
  )
  for (const file of files.filter((item) => item.toLowerCase().endsWith('.motion3.json'))) {
    const relativePath = normalizeAssetPath(relative(modelDir, file))
    if (knownMotionFiles.has(relativePath.toLowerCase())) continue
    const group = classifyMotionGroup(basename(file))
    ;(motions[group] ?? (motions[group] = [])).push({ File: relativePath })
    knownMotionFiles.add(relativePath.toLowerCase())
  }

  const protectedParameterIds = await collectOutfitParameterIds(modelDir, expressions)
  const motionOutfitParameterIds = new Map<string, Set<string>>()
  for (const definition of Object.values(motions).flat()) {
    const motionPath = resolveContainedModelFile(modelDir, definition.File)
    motionOutfitParameterIds.set(normalizeLocalFileKey(motionPath), protectedParameterIds)
  }

  model.AIMaidHotkeys = await readVTubeHotkeys(files)

  return {
    data: Buffer.from(JSON.stringify(model), 'utf8'),
    motionOutfitParameterIds,
    expressionCount: expressions.length,
    motionGroups: Object.fromEntries(Object.entries(motions).map(([name, items]) => [name, items.length]))
  }
}

async function readVTubeHotkeys(files: string[]): Promise<Live2DHotkeyDefinition[]> {
  const vtubePath = files
    .filter((file) => file.toLowerCase().endsWith('.vtube.json'))
    .sort(naturalCompare)[0]
  if (vtubePath === undefined) return []

  const vtube = JSON.parse(await readFile(vtubePath, 'utf8')) as {
    Hotkeys?: Array<{
      Name?: unknown
      Action?: unknown
      File?: unknown
      IsActive?: unknown
      Triggers?: { Trigger1?: unknown; Trigger2?: unknown; Trigger3?: unknown }
    }>
  }
  const supportedActions = new Set<Live2DHotkeyDefinition['action']>([
    'ToggleExpression', 'TriggerAnimation', 'RemoveAllExpressions'
  ])
  return (vtube.Hotkeys ?? []).flatMap((hotkey): Live2DHotkeyDefinition[] => {
    if (hotkey.IsActive === false || typeof hotkey.Action !== 'string' ||
        !supportedActions.has(hotkey.Action as Live2DHotkeyDefinition['action'])) return []
    const triggers = [hotkey.Triggers?.Trigger1, hotkey.Triggers?.Trigger2, hotkey.Triggers?.Trigger3]
      .filter((trigger): trigger is string => typeof trigger === 'string' && trigger !== '')
    if (triggers.length === 0) return []
    return [{
      name: typeof hotkey.Name === 'string' ? hotkey.Name : '',
      action: hotkey.Action as Live2DHotkeyDefinition['action'],
      file: typeof hotkey.File === 'string' ? normalizeAssetPath(hotkey.File) : '',
      triggers
    }]
  })
}

export async function readMotionWithoutOutfitCurves(
  motionPath: string,
  protectedParameterIds: Set<string> | undefined
): Promise<{ data: Buffer; removedCurveCount: number }> {
  const raw = await readFile(motionPath, 'utf8')
  if (protectedParameterIds === undefined || protectedParameterIds.size === 0) {
    return { data: Buffer.from(raw, 'utf8'), removedCurveCount: 0 }
  }
  const motion = JSON.parse(raw) as {
    Curves?: Array<{ Target?: unknown; Id?: unknown }>
    Meta?: { CurveCount?: number }
  }
  if (!Array.isArray(motion.Curves)) return { data: Buffer.from(raw, 'utf8'), removedCurveCount: 0 }

  const before = motion.Curves.length
  motion.Curves = motion.Curves.filter((curve) => !(
    curve.Target === 'Parameter' &&
    typeof curve.Id === 'string' &&
    protectedParameterIds.has(curve.Id)
  ))
  const removedCurveCount = before - motion.Curves.length
  if (removedCurveCount > 0 && motion.Meta && typeof motion.Meta.CurveCount === 'number') {
    motion.Meta.CurveCount = motion.Curves.length
  }
  return { data: Buffer.from(JSON.stringify(motion), 'utf8'), removedCurveCount }
}

async function collectOutfitParameterIds(
  modelDir: string,
  expressions: Live2DFileDefinition[]
): Promise<Set<string>> {
  const ids = new Set<string>()
  await Promise.all(expressions.map(async (definition) => {
    if (!isOutfitExpressionName(`${definition.Name ?? ''} ${definition.File}`)) return
    const expressionPath = resolveContainedModelFile(modelDir, definition.File)
    const expression = JSON.parse(await readFile(expressionPath, 'utf8')) as {
      Parameters?: Array<{ Id?: unknown }>
    }
    for (const parameter of expression.Parameters ?? []) {
      if (typeof parameter.Id === 'string') ids.add(parameter.Id)
    }
  }))
  return ids
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await listFilesRecursively(fullPath))
    else if (entry.isFile()) result.push(fullPath)
  }
  return result
}

function resolveContainedModelFile(modelDir: string, assetPath: string): string {
  const resolved = resolve(modelDir, assetPath)
  const relativePath = relative(modelDir, resolved)
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new Error(`Live2D model reference is outside its model directory: ${assetPath}`)
  }
  return resolved
}

function classifyMotionGroup(fileName: string): 'Idle' | 'TapHead' | 'TapLeg' | 'TapBody' {
  const name = fileName.toLowerCase()
  if (/(idle|daiji|待机)/iu.test(name)) return 'Idle'
  if (/(blink|eye|face|head|zhaiyan|meiyan|眨眼|美颜|头|脸)/iu.test(name)) return 'TapHead'
  if (/(leg|foot|shoe|tixie|腿|脚|鞋)/iu.test(name)) return 'TapLeg'
  return 'TapBody'
}

function isOutfitExpressionName(label: string): boolean {
  return /(outfit|costume|wardrobe|full.?set|skin|dress|clothes|clothing|hair|hairstyle|bang|fringe|ponytail|duanfa|panfa|changfa|glasses|eyeglass|yanjing|horn|hat|headwear|earring|jiao|microphone|\bmic\b|handheld|prop|huatong|paizi|shanzi|stocking|sock|shoe|boot|heisi|hexie|\bxie\b|cape|vest|coat|jacket|shirt|skirt|pijian|majia|整套|套装|套裝|衣装|衣裝|服装|服裝|换装|換裝|头发|頭髮|髮型|发型|刘海|劉海|马尾|馬尾|眼镜|眼鏡|帽|角|头饰|頭飾|耳饰|耳飾|麦克风|麥克風|话筒|話筒|扇子|牌子|手持|丝袜|絲襪|袜|襪|鞋|靴|披肩|披风|披風|马甲|馬甲|外套|上衣|裙|衣服)/iu.test(label)
}

function normalizeAssetPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function normalizeLocalFileKey(filePath: string): string {
  return resolve(filePath).replaceAll('\\', '/').toLowerCase()
}

function jsonBufferResponse(data: Buffer): Response {
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function audioMimeType(extension: string): string {
  return {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac'
  }[extension] ?? 'application/octet-stream'
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
