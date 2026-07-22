export type PetRuntimeState =
  | 'uninitialized'
  | 'loading'
  | 'ready'
  | 'suspended'
  | 'context-lost'
  | 'failed'
  | 'disposed'

export type PetLifecycleSignal = 'suspend' | 'resume' | 'display-changed' | 'reset-position' | 'presentation-changed'

export interface PetAssetManifest {
  modelId: string
  modelUrl: string
  cubismCoreUrl: string
}

export interface PetPerformanceMetrics {
  state: PetRuntimeState
  fps: number
  averageFrameMs: number
  p95FrameMs: number
  maximumFrameMs: number
  loadTimeMs: number
  windowWidth: number
  windowHeight: number
  canvasWidth: number
  canvasHeight: number
  backingWidth: number
  backingHeight: number
  renderPixelRatio: number
  resizeCount: number
  contextLost: boolean
}

export interface PetRuntimeSnapshot {
  rendererReady: boolean
  metrics: PetPerformanceMetrics | null
  updatedAt: number | null
}

export interface PetWindowUpdate {
  x?: number
  y?: number
  scale?: number
  anchor: 'top-left' | 'center'
}

export interface PetVisualBounds {
  x: number
  y: number
  width: number
  height: number
  anchorX?: number
  anchorY?: number
}

export interface PetLifecycleEvent {
  type: PetLifecycleSignal
  scaleFactor: number
  timestamp: number
}

export function paginatePetBubble(text: string, pageSize = 78): string[] {
  const normalized = text.trim()
  if (normalized.length === 0) return []
  const pages: string[] = []
  for (let offset = 0; offset < normalized.length; offset += pageSize) pages.push(normalized.slice(offset, offset + pageSize))
  return pages
}
