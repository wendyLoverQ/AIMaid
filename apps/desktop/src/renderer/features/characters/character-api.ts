import type { CharacterDto } from '../../../shared/business'
import { bridge } from '../../shared/bridge'

export async function loadCharacters(): Promise<{ items: CharacterDto[]; currentRoleId: string }> {
  const [characters, settings] = await Promise.all([
    bridge.core.invoke({ type: 'character.list', payload: {} }),
    bridge.core.invoke({ type: 'settings.get', payload: { keys: ['voice_current_role_id'] } })
  ])
  if (!characters.success) throw new Error(characters.error?.message ?? '语音角色读取失败。')
  if (!settings.success) throw new Error(settings.error?.message ?? '当前语音角色读取失败。')
  const payload = settings.payload as { settings?: Array<{ key: string; value: string }> } | null
  const current = payload?.settings?.find((item) => item.key === 'voice_current_role_id')?.value ?? ''
  return { items: Array.isArray(characters.payload) ? characters.payload as CharacterDto[] : [], currentRoleId: current }
}

export async function setCurrentCharacter(roleId: string): Promise<void> {
  const response = await bridge.core.invoke({ type: 'character.set_current', payload: { roleId } })
  if (!response.success) throw new Error(response.error?.message ?? '语音角色切换失败。')
}

export async function deleteCharacter(roleId: string): Promise<void> {
  const response = await bridge.core.invoke({ type: 'character.delete', payload: { roleId } })
  if (!response.success) throw new Error(response.error?.message ?? '语音角色删除失败。')
}
