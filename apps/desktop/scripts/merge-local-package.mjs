import { execFileSync } from 'node:child_process'
import { cp, mkdir, rename, rm, stat, symlink } from 'node:fs/promises'
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

for (const resourceName of ['core', 'live2d', 'ui']) {
  const source = resolve('resources', resourceName)
  const target = resolve(resources, resourceName)
  if (!(await exists(source))) throw new Error(`Local resource source is unavailable: ${source}`)
  await rm(target, { recursive: true, force: true })
  await symlink(source, target, 'junction')
  process.stdout.write(`Created Junction: ${target} -> ${source}\n`)
}

if (await exists(asarPath)) {
  await rm(asarBackup, { force: true })
  await rename(asarPath, asarBackup)
}

process.stdout.write('Local React app updated; core, live2d, and ui use source-resource Junctions.\n')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
