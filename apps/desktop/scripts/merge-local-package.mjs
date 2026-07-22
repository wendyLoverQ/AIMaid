import { execFileSync } from 'node:child_process'
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const targetPackage = resolve('release', 'win-unpacked')
const resources = resolve(targetPackage, 'resources')
const appDirectory = resolve(resources, 'app')
const asarPath = resolve(resources, 'app.asar')
const asarBackup = resolve(resources, 'app.asar.packaged')
const asarCli = resolve('node_modules', '@electron', 'asar', 'bin', 'asar.js')

await mkdir(resources, { recursive: true })
if (!(await exists(appDirectory))) {
  const sourceAsar = (await exists(asarPath)) ? asarPath : asarBackup
  if (!(await exists(sourceAsar))) throw new Error('Packaged app.asar is unavailable for initial local extraction')
  execFileSync(process.execPath, [asarCli, 'extract', sourceAsar, appDirectory], { stdio: 'inherit' })
}

await cp(resolve('out'), resolve(appDirectory, 'out'), { recursive: true, force: true })
await cp(resolve('package.json'), resolve(appDirectory, 'package.json'), { force: true })
await cp(resolve('resources', 'core'), resolve(resources, 'core'), { recursive: true, force: true })
await cp(resolve('resources', 'live2d'), resolve(resources, 'live2d'), { recursive: true, force: true })
for (const legacyUi of ['notebook_web', 'video_library', 'voice_conversation', 'character_role_list', 'crypto_web', 'video_player', 'music_visualizer', 'webview_transparency_demo']) {
  await rm(resolve(resources, 'ui', legacyUi), { recursive: true, force: true })
}
await rm(resolve(resources, 'ui', 'electron-webview-bridge.js'), { force: true })

if (await exists(asarPath)) {
  await rm(asarBackup, { force: true })
  await rename(asarPath, asarBackup)
}

process.stdout.write('Local React app updated; retired HTML UI resources removed and bulk visual assets left unchanged.\n')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
