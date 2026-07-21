import type { IpcResponseEnvelope } from '../../shared/ipc'

export function describeResponse(response: IpcResponseEnvelope): string {
  if (response.success) return JSON.stringify(response.payload, null, 2)
  return `${response.error?.code ?? 'UNKNOWN'}: ${response.error?.message ?? 'Unknown error'}`
}
