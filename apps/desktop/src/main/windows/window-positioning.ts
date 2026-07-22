export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export type PetWindowAlignment = 'center' | 'right-of-center'

const PET_WINDOW_GAP = 16

export function petWindowAlignment(kind: WindowKind, displayMode?: PetDisplayMode): PetWindowAlignment {
  return kind === 'status' || displayMode === 'image' || displayMode === 'png-sequence'
    ? 'center'
    : 'right-of-center'
}

export function positionWindowNearPet(
  windowBounds: Bounds,
  petBounds: Bounds,
  workArea: Bounds,
  alignment: PetWindowAlignment
): Bounds {
  const width = Math.min(windowBounds.width, workArea.width)
  const height = Math.min(windowBounds.height, workArea.height)
  const anchorX = petBounds.x + petBounds.width / 2
  const anchorY = petBounds.y + petBounds.height / 2
  const desiredX = alignment === 'center' ? anchorX - width / 2 : anchorX + PET_WINDOW_GAP
  const desiredY = anchorY - height / 2

  return {
    x: clamp(Math.round(desiredX), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(desiredY), workArea.y, workArea.y + workArea.height - height),
    width,
    height
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}
import type { PetDisplayMode } from '../../shared/presentation'
import type { WindowKind } from '../../shared/windows'
