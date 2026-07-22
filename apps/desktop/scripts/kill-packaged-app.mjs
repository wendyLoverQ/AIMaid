import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const executable = resolve('release', 'win-unpacked', 'AIMaid.exe').replaceAll("'", "''")
const coreExecutable = resolve('release', 'win-unpacked', 'resources', 'core', `win32-${process.arch}`, 'AIMaid.CoreHost.exe').replaceAll("'", "''")
const command = [
  `$targets = @('${executable}', '${coreExecutable}')`,
  'Get-Process -Name AIMaid,AIMaid.CoreHost -ErrorAction SilentlyContinue | Where-Object { $targets -contains $_.Path } | Stop-Process -Force -ErrorAction SilentlyContinue',
  'exit 0'
].join('\n')

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' })
