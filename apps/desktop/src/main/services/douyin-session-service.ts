import { session } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'

export interface DouyinSessionMetadata {
  cookieCount: number
  hasSession: boolean
  hasTtwid: boolean
  hasMsToken: boolean
  savedAt: string
}

export class DouyinSessionService {
  private readonly metadataPath: string
  constructor(configRoot: string) { this.metadataPath = join(configRoot, 'douyin-profile-metadata.json') }

  async saveMetadata(): Promise<DouyinSessionMetadata> {
    const metadata = await this.inspect()
    await mkdir(dirname(this.metadataPath), { recursive: true })
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
    return metadata
  }

  async inspect(): Promise<DouyinSessionMetadata> {
    const cookies = await session.fromPartition('persist:aimaid-douyin').cookies.get({ url: 'https://www.douyin.com/' })
    const names = new Set(cookies.map((cookie) => cookie.name.toLowerCase()))
    const metadata: DouyinSessionMetadata = {
      cookieCount: cookies.length,
      hasSession: names.has('sessionid') || names.has('sessionid_ss'),
      hasTtwid: names.has('ttwid'),
      hasMsToken: names.has('mstoken'),
      savedAt: new Date().toISOString()
    }
    return metadata
  }

  async clear(): Promise<void> {
    await session.fromPartition('persist:aimaid-douyin').clearStorageData()
    await rm(this.metadataPath, { force: true })
  }
}
