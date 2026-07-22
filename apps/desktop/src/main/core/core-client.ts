import type { CoreRequest, CoreStatus } from '../../shared/core'
import type { IpcEventEnvelope } from '../../shared/ipc'

export type CoreEventListener = (event: IpcEventEnvelope) => void

export interface CoreClient {
  start(): Promise<void>
  stop(): Promise<void>
  invoke(requestId: string, request: CoreRequest, signal: AbortSignal): Promise<unknown>
  cancel(requestId: string): Promise<void>
  getStatus(): CoreStatus
  subscribe(listener: CoreEventListener): () => void
}
