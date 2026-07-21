import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export interface ApplicationPaths {
  readonly resourceRoot: string
  readonly dataRoot: string
  readonly configRoot: string
  readonly cacheRoot: string
  readonly logRoot: string
  readonly sessionRoot: string
}

export function configureApplicationPaths(): ApplicationPaths {
  const userRoot = absoluteOverride('AIMAID_USER_ROOT') ?? app.getPath('userData')
  const paths: ApplicationPaths = Object.freeze({
    resourceRoot:
      absoluteOverride('AIMAID_RESOURCE_ROOT') ??
      (app.isPackaged ? join(process.resourcesPath, 'resources') : resolve(app.getAppPath(), 'resources')),
    dataRoot: absoluteOverride('AIMAID_DATA_ROOT') ?? join(userRoot, 'data'),
    configRoot: absoluteOverride('AIMAID_CONFIG_ROOT') ?? join(userRoot, 'config'),
    cacheRoot: absoluteOverride('AIMAID_CACHE_ROOT') ?? join(userRoot, 'cache'),
    logRoot: absoluteOverride('AIMAID_LOG_ROOT') ?? join(userRoot, 'logs'),
    sessionRoot: absoluteOverride('AIMAID_SESSION_ROOT') ?? join(app.getPath('temp'), 'AIMaid', 'electron-session')
  })

  for (const directory of [paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.logRoot, paths.sessionRoot]) {
    mkdirSync(directory, { recursive: true })
  }
  app.setPath('sessionData', paths.sessionRoot)
  app.setAppLogsPath(paths.logRoot)
  process.env.AIMAID_RESOURCE_ROOT = paths.resourceRoot
  process.env.AIMAID_DATA_ROOT = paths.dataRoot
  process.env.AIMAID_CONFIG_ROOT = paths.configRoot
  process.env.AIMAID_CACHE_ROOT = paths.cacheRoot
  process.env.AIMAID_LOG_ROOT = paths.logRoot
  return paths
}

function absoluteOverride(name: string): string | undefined {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return resolve(value)
}
