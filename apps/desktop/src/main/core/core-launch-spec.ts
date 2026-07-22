import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CoreLaunchSpec } from './core-process-manager'

export function createCoreLaunchSpec(): CoreLaunchSpec {
  if (app.isPackaged) {
    const executableName = process.platform === 'win32' ? 'AIMaid.CoreHost.exe' : 'AIMaid.CoreHost'
    const executable = join(process.resourcesPath, 'core', `${process.platform}-${process.arch}`, executableName)
    assertExists(executable)
    return { command: executable, args: [], workingDirectory: dirname(executable), environment: { ...process.env } }
  }

  const assembly = resolve(app.getAppPath(), '../../src/AIMaid.CoreHost/bin/Debug/net8.0/AIMaid.CoreHost.dll')
  assertExists(assembly)
  return { command: 'dotnet', args: [assembly], workingDirectory: dirname(assembly), environment: { ...process.env } }
}

function assertExists(path: string): void {
  if (!existsSync(path)) throw new Error(`Expected Core artifact is missing: ${path}`)
}
