export const PET_HOLD_GROWTH_PER_MS = 0.02 / 16
export const PET_HOLD_RELEASE_MS = 140

export function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3
}
