import type { PetDisplayMode } from '../../shared/presentation'
import type { WindowKind } from '../../shared/windows'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export type PetWindowAlignment = 'center' | 'right-of-center'

const PET_WINDOW_GAP = 16

export function physicalPetItemBoundsToDip(
  physicalPetWindowBounds: Bounds,
  rendererItemBounds: Bounds,
  rendererScaleFactor: number,
  screenToDipPoint: (point: Point) => Point,
  targetDisplayScaleFactor: (dipPoint: Point) => number
): Bounds {
  const physicalWidth = rendererItemBounds.width * rendererScaleFactor
  const physicalHeight = rendererItemBounds.height * rendererScaleFactor
  const physicalCenter = {
    x: physicalPetWindowBounds.x + (rendererItemBounds.x + rendererItemBounds.width / 2) * rendererScaleFactor,
    y: physicalPetWindowBounds.y + (rendererItemBounds.y + rendererItemBounds.height / 2) * rendererScaleFactor
  }
  const dipCenter = screenToDipPoint(physicalCenter)
  const displayScaleFactor = targetDisplayScaleFactor(dipCenter)
  return {
    x: dipCenter.x - physicalWidth / displayScaleFactor / 2,
    y: dipCenter.y - physicalHeight / displayScaleFactor / 2,
    width: physicalWidth / displayScaleFactor,
    height: physicalHeight / displayScaleFactor
  }
}

export function petWindowAlignment(kind: WindowKind, displayMode?: PetDisplayMode): PetWindowAlignment {
  return kind === 'chat' || kind === 'status' || displayMode === 'image' || displayMode === 'png-sequence'
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
