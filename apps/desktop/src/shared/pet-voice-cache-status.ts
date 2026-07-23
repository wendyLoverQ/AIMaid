export function shouldDisplayVoiceCacheStatus(payload: Record<string, unknown> | null, currentRoleId: string): boolean {
  if (payload?.isForeground !== true) return false
  const eventRoleId = typeof payload.roleId === 'string' ? payload.roleId : ''
  return currentRoleId === '' || eventRoleId === currentRoleId
}
