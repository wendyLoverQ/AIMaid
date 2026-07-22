import { PET_BASE_WINDOW_HEIGHT, PET_BASE_WINDOW_WIDTH } from '../../shared/pet-geometry'
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

export interface ScreenCoordinateMapper {
  dipToScreenPoint: (point: Point) => Point
  screenToDipPoint: (point: Point) => Point
}

export type PetWindowAlignment = 'center' | 'right-of-center'

const PET_WINDOW_GAP = 16

export function resolvePetVisualBounds(
  petWindowBounds: Bounds,
  rendererVisualBounds?: Bounds,
  coordinateMapper?: ScreenCoordinateMapper,
  rendererScaleFactor = 1
): Bounds {
  const relative = rendererVisualBounds ?? {
    x: Math.round((petWindowBounds.width - PET_BASE_WINDOW_WIDTH) / 2),
    y: Math.round((petWindowBounds.height - PET_BASE_WINDOW_HEIGHT) / 2),
    width: PET_BASE_WINDOW_WIDTH,
    height: PET_BASE_WINDOW_HEIGHT
  }
  if (coordinateMapper === undefined) {
    return {
      x: petWindowBounds.x + relative.x,
      y: petWindowBounds.y + relative.y,
      width: relative.width,
      height: relative.height
    }
  }

  const physicalWindowOrigin = coordinateMapper.dipToScreenPoint({ x: petWindowBounds.x, y: petWindowBounds.y })
  const center = coordinateMapper.screenToDipPoint({
    x: physicalWindowOrigin.x + (relative.x + relative.width / 2) * rendererScaleFactor,
    y: physicalWindowOrigin.y + (relative.y + relative.height / 2) * rendererScaleFactor
  })
  return {
    x: center.x - relative.width / 2,
    y: center.y - relative.height / 2,
    width: relative.width,
    height: relative.height
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
