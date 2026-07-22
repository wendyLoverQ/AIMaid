import type { ReminderDto, ReminderSavePayload } from '../../../shared/business'
import { bridge } from '../../shared/bridge'

export async function listReminders(): Promise<ReminderDto[]> {
  const response = await bridge.core.invoke({ type: 'reminder.list', payload: {} })
  if (!response.success) throw new Error(response.error?.message ?? '提醒读取失败。')
  return Array.isArray(response.payload) ? response.payload as ReminderDto[] : []
}
export async function saveReminder(payload: ReminderSavePayload): Promise<ReminderDto> {
  return invokeReminder({ type: 'reminder.save', payload })
}
export async function setReminderEnabled(reminderId: string, enabled: boolean): Promise<ReminderDto> {
  return invokeReminder({ type: 'reminder.set_enabled', payload: { reminderId, enabled } })
}
export async function setReminderAllowTts(reminderId: string, allowTts: boolean): Promise<ReminderDto> {
  return invokeReminder({ type: 'reminder.set_allow_tts', payload: { reminderId, allowTts } })
}
export async function deleteReminder(reminderId: string): Promise<void> {
  const response = await bridge.core.invoke({ type: 'reminder.delete', payload: { reminderId } })
  if (!response.success) throw new Error(response.error?.message ?? '提醒删除失败。')
}
export async function processDueReminders(): Promise<void> {
  const response = await bridge.core.invoke({ type: 'reminder.process_due', payload: { now: new Date().toISOString() } })
  if (!response.success) throw new Error(response.error?.message ?? '提醒检查失败。')
}
async function invokeReminder(request: Parameters<typeof bridge.core.invoke>[0]): Promise<ReminderDto> {
  const response = await bridge.core.invoke(request)
  if (!response.success || response.payload === null) throw new Error(response.error?.message ?? '提醒保存失败。')
  return response.payload as ReminderDto
}
