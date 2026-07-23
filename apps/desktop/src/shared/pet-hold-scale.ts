export const PET_HOLD_GROWTH_PER_MS = 0.02 / 16
export const PET_HOLD_RELEASE_MS = 140

export interface PetHoldGeometry {
  width: number
  height: number
  originShiftX: number
  originShiftY: number
}

export function calculatePetHoldGeometry(
  baseWidth: number,
  baseHeight: number,
  holdScale: number,
  originX: number,
  originY: number,
  resizeSurface = true
): PetHoldGeometry {
  if (!resizeSurface) {
    return {
      width: baseWidth,
      height: baseHeight,
      originShiftX: 0,
      originShiftY: 0
    }
  }
  const width = baseWidth * holdScale
  const height = baseHeight * holdScale
  return {
    width,
    height,
    originShiftX: (0.5 - originX) * (width - baseWidth),
    originShiftY: (0.5 - originY) * (height - baseHeight)
  }
}

export function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3
}
