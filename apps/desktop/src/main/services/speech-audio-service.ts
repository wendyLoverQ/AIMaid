import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000
const AUDIO_DATA_URL = /^data:audio\/(webm|wav|x-wav|mpeg|mp4|ogg)(?:;codecs=[^;,]+)?;base64,([a-z0-9+/=]+)$/iu

export class SpeechAudioService {
  private readonly root: string

  constructor(cacheRoot: string) {
    this.root = resolve(cacheRoot, 'asr')
  }

  async importData(dataUrl: string): Promise<{ path: string }> {
    const match = AUDIO_DATA_URL.exec(dataUrl)
    if (match === null) throw new TypeError('录音格式不受支持。')
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.length === 0) throw new TypeError('录音内容为空。')
    if (bytes.length > MAX_AUDIO_BYTES) throw new TypeError('单次录音不能超过 25 MB。')
    await mkdir(this.root, { recursive: true })
    await this.purgeExpired()
    const extension = extensionFor(match[1]!)
    const path = join(this.root, `recording_${randomUUID().replaceAll('-', '')}${extension}`)
    await writeFile(path, bytes, { flag: 'wx' })
    return { path }
  }

  private async purgeExpired(): Promise<void> {
    const cutoff = Date.now() - MAX_CACHE_AGE_MS
    const entries = await readdir(this.root, { withFileTypes: true })
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const path = join(this.root, entry.name)
      const file = await stat(path)
      if (file.mtimeMs < cutoff) await unlink(path)
    }))
  }
}

function extensionFor(mediaType: string): string {
  if (mediaType === 'wav' || mediaType === 'x-wav') return '.wav'
  if (mediaType === 'mpeg') return '.mp3'
  if (mediaType === 'mp4') return '.m4a'
  if (mediaType === 'ogg') return '.ogg'
  return '.webm'
}
