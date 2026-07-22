import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** @type {Readonly<Record<string, string>>} */
const runtimeIds = {
  'win32-x64': 'win-x64',
  'win32-arm64': 'win-arm64',
  'darwin-x64': 'osx-x64',
  'darwin-arm64': 'osx-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64'
}

const target = `${process.platform}-${process.arch}`
const runtimeId = runtimeIds[target]
if (runtimeId === undefined) throw new Error(`Unsupported Core publish target: ${target}`)

const project = resolve(import.meta.dirname, '../../../src/AIMaid.CoreHost/AIMaid.CoreHost.csproj')
const output = resolve(import.meta.dirname, `../resources/core/${target}`)
mkdirSync(output, { recursive: true })

const result = spawnSync('dotnet', [
  'publish', project,
  '-c', 'Release',
  '-r', runtimeId,
  '--self-contained', 'true',
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:NuGetAudit=false',
  '-o', output
], { stdio: 'inherit', shell: false })

if (result.error !== undefined) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
