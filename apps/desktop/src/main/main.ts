import { app, protocol } from 'electron'
import { join } from 'node:path'
import { createCoreLaunchSpec } from './core/core-launch-spec'
import { CoreProcessManager } from './core/core-process-manager'
import { StdioCoreClient } from './core/stdio-core-client'
import { EventRouter } from './ipc/event-router'
import { IpcRouter } from './ipc/ipc-router'
import { ApplicationLifecycle } from './lifecycle/application-lifecycle'
import { configureFileLogging, logger } from './logging/logger'
import { configureApplicationPaths } from './paths/application-paths'
import { WindowFactory } from './windows/window-factory'
import { WindowManager } from './windows/window-manager'
import { PetAssetService } from './services/pet-asset-service'
import { PetWindowManager } from './windows/pet-window-manager'
import { PetPresentationService } from './services/pet-presentation-service'
import { TrayController } from './services/tray-controller'
import { DouyinSessionService } from './services/douyin-session-service'
import { NotebookAttachmentService } from './services/notebook-attachment-service'
import { SystemSettingsService } from './services/system-settings-service'
import { AgentConfirmationCoordinator } from './services/agent-confirmation-coordinator'
import { SpeechAudioService } from './services/speech-audio-service'
import { NativeReminderNotifier, ReminderScheduler } from './services/reminder-scheduler'

protocol.registerSchemesAsPrivileged([{
  scheme: 'aimaid-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}])
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setAppUserModelId('com.aimaid.desktop')

const applicationPaths = configureApplicationPaths()
const logFilePath = configureFileLogging(applicationPaths.logRoot)
logger.info('paths', 'Application paths initialized', { ...applicationPaths, logFilePath })

const coreProcess = new CoreProcessManager(createCoreLaunchSpec(), logger)
const coreClient = new StdioCoreClient(coreProcess, app.getVersion(), logger)
const petResourceRoot = app.isPackaged
  ? join(process.resourcesPath, 'live2d')
  : join(applicationPaths.resourceRoot, 'live2d')
const uiResourceRoot = app.isPackaged
  ? join(process.resourcesPath, 'ui')
  : join(applicationPaths.resourceRoot, 'ui')
const applicationIconPath = join(uiResourceRoot, 'maid_assistant_icon.ico')
const windowManager = new WindowManager(new WindowFactory(applicationIconPath, logger), logger)
const petAssets = new PetAssetService(petResourceRoot, uiResourceRoot, join(applicationPaths.dataRoot, 'notebook', 'attachments'), logger)
const notebookAttachments = new NotebookAttachmentService(applicationPaths.dataRoot, petAssets)
const speechAudio = new SpeechAudioService(applicationPaths.cacheRoot)
const petWindows = new PetWindowManager(windowManager, coreClient, logger)
windowManager.setForeignWindowMoveHandlers({
  onStart: () => petWindows.suspendHitTestingForForeignWindowMove(),
  onEnd: () => petWindows.resumeHitTestingAfterForeignWindowMove()
})
const trayController = new TrayController(windowManager, applicationIconPath, logger)
const douyinSession = new DouyinSessionService(applicationPaths.configRoot)
const petPresentation = new PetPresentationService(
  join(applicationPaths.configRoot, 'pet-presentation.json'),
  petAssets,
  logger,
  join(uiResourceRoot, 'image_tiles'),
  join(uiResourceRoot, 'pngLine')
)
const eventRouter = new EventRouter(windowManager, coreClient, coreProcess, logger)
const systemSettings = new SystemSettingsService(windowManager, petWindows, petPresentation, coreClient, logger)
const reminderScheduler = new ReminderScheduler(coreClient, new NativeReminderNotifier(), logger)
const agentConfirmation = new AgentConfirmationCoordinator(windowManager, coreClient, logger)
const ipcRouter = new IpcRouter(windowManager, coreClient, coreProcess, eventRouter, petAssets, petWindows, petPresentation, douyinSession, notebookAttachments, speechAudio, systemSettings, agentConfirmation, logger)
const lifecycle = new ApplicationLifecycle(
  windowManager, ipcRouter, eventRouter, coreClient, coreProcess, petAssets, petWindows, trayController, systemSettings, reminderScheduler, logger
)

process.on('uncaughtException', (error) => logger.error('process', 'Uncaught exception', error))
process.on('unhandledRejection', (error) => logger.error('process', 'Unhandled rejection', error))

void lifecycle.run().catch((error: unknown) => {
  logger.error('startup', 'Application startup failed', error)
  app.exit(1)
})
