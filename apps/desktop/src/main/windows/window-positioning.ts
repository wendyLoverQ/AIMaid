import { PET_BASE_WINDOW_HEIGHT, PET_BASE_WINDOW_WIDTH } from '../../shared/pet-geometry'
import type { PetDisplayMode } from '../../shared/presentation'
import type { WindowKind } from '../../shared/windows'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export type PetWindowAlignment = 'center' | 'right-of-pet'

const PET_WINDOW_GAP = 16

export function resolvePetVisualBounds(petWindowBounds: Bounds, rendererVisualBounds?: Bounds): Bounds {
  const relative = rendererVisualBounds ?? {
    x: Math.round((petWindowBounds.width - PET_BASE_WINDOW_WIDTH) / 2),
    y: Math.round((petWindowBounds.height - PET_BASE_WINDOW_HEIGHT) / 2),
    width: PET_BASE_WINDOW_WIDTH,
    height: PET_BASE_WINDOW_HEIGHT
  }
  return {
    x: petWindowBounds.x + relative.x,
    y: petWindowBounds.y + relative.y,
    width: relative.width,
    height: relative.height
  }
}

export function petWindowAlignment(kind: WindowKind, displayMode?: PetDisplayMode): PetWindowAlignment {
  return kind === 'status' || displayMode === 'image' || displayMode === 'png-sequence'
    ? 'center'
    : 'right-of-pet'
}

export function positionWindowNearPet(
  windowBounds: Bounds,
  petBounds: Bounds,
  workArea: Bounds,
  alignment: PetWindowAlignment,
  petAnchor?: { x: number; y: number }
): Bounds {
  const width = Math.min(windowBounds.width, workArea.width)
  const height = Math.min(windowBounds.height, workArea.height)
  const anchorX = petAnchor?.x ?? petBounds.x + petBounds.width / 2
  const anchorY = petAnchor?.y ?? petBounds.y + petBounds.height / 2
  const desiredX = alignment === 'center' ? anchorX - width / 2 : petBounds.x + petBounds.width + PET_WINDOW_GAP
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
