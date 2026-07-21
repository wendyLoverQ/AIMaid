import { CoreProcessManager, MockCoreProcessAdapter } from './core/core-process-manager'
import { MockCoreClient } from './core/mock-core-client'
import { EventRouter } from './ipc/event-router'
import { IpcRouter } from './ipc/ipc-router'
import { ApplicationLifecycle } from './lifecycle/application-lifecycle'
import { logger } from './logging/logger'
import { configureApplicationPaths } from './paths/application-paths'
import { WindowFactory } from './windows/window-factory'
import { WindowManager } from './windows/window-manager'

const applicationPaths = configureApplicationPaths()
logger.info('paths', 'Application paths initialized', { ...applicationPaths })

const coreClient = new MockCoreClient()
const coreProcess = new CoreProcessManager(new MockCoreProcessAdapter(), logger)
const windowManager = new WindowManager(new WindowFactory(logger), logger)
const ipcRouter = new IpcRouter(windowManager, coreClient, coreProcess, logger)
const eventRouter = new EventRouter(windowManager, coreClient, coreProcess)
const lifecycle = new ApplicationLifecycle(windowManager, ipcRouter, eventRouter, coreClient, coreProcess, logger)

process.on('uncaughtException', (error) => logger.error('process', 'Uncaught exception', error))
process.on('unhandledRejection', (error) => logger.error('process', 'Unhandled rejection', error))

void lifecycle.run().catch((error: unknown) => {
  logger.error('startup', 'Application startup failed', error)
  process.exitCode = 1
})
