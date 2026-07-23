import type { PetWindowUpdate } from '../../shared/pet'
import { PET_BASE_WINDOW_HEIGHT, PET_BASE_WINDOW_WIDTH } from '../../shared/pet-geometry'
import { calculatePetHoldGeometry, easeOutCubic, PET_HOLD_GROWTH_PER_MS, PET_HOLD_RELEASE_MS } from '../../shared/pet-hold-scale'

const STORAGE_KEY = 'aimaid.pet-item-state.v1'
const MIN_SCALE = 0.25
const WHEEL_ZOOM_IN = 1.08
const WHEEL_ZOOM_OUT = 0.92
const SAVE_DELAY_MS = 160
const CLICK_MOVE_TOLERANCE = 5
const DRAG_START_DISTANCE = 8

interface PersistedItemState {
  offsetX: number
  offsetY: number
  scale: number
}

export interface PetItemInteractionOptions {
  item: HTMLElement
  hitTest: (clientX: number, clientY: number) => boolean
  setIgnoreMouseEvents: (ignore: boolean) => void
  dragStart: () => void
  dragMove: () => void
  dragEnd: () => void
  updateWindow: (update: PetWindowUpdate) => void
  onScale: (scale: number) => void
  onClick: (event: MouseEvent) => void
}

export class PetItemInteractionController {
  private scale = 1
  private offsetX = 0
  private offsetY = 0
  private dragStartX = 0
  private dragStartY = 0
  private dragStartOffsetX = 0
  private dragStartOffsetY = 0
  private dragging = false
  private movedDuringDrag = false
  private pressDistance = 0
  private locked = false
  private lastPointerX = Number.NaN
  private lastPointerY = Number.NaN
  private moveFrame: number | null = null
  private saveTimer: number | null = null
  private holdGrowFrame: number | null = null
  private holdReleaseFrame: number | null = null
  private holdStartedAt: number | null = null
  private holdScale = 1
  private holdOriginX = 0.5
  private holdOriginY = 0.5
  private ignoringMouse = true
  private lastHitState: boolean | undefined

  constructor(private readonly options: PetItemInteractionOptions) {
    const saved = readPersistedItemState()
    if (saved !== null) {
      this.scale = saved.scale
      this.offsetX = saved.offsetX
      this.offsetY = saved.offsetY
    }
    this.applyItemTransform()
    window.addEventListener('mousemove', this.onMouseMove, true)
    window.addEventListener('mousedown', this.onMouseDown, true)
    window.addEventListener('mouseup', this.onMouseUp, true)
    window.addEventListener('mouseleave', this.onMouseLeave)
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    window.addEventListener('blur', this.onBlur)
  }

  dispose(): void {
    window.removeEventListener('mousemove', this.onMouseMove, true)
    window.removeEventListener('mousedown', this.onMouseDown, true)
    window.removeEventListener('mouseup', this.onMouseUp, true)
    window.removeEventListener('mouseleave', this.onMouseLeave)
    window.removeEventListener('wheel', this.onWheel, true)
    window.removeEventListener('blur', this.onBlur)
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame)
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.resetHoldScale()
  }

  setLocked(locked: boolean): void {
    this.locked = locked
    if (locked) {
      this.finishDrag()
      this.setIgnoring(false)
    }
    else this.refreshHitTest()
  }

  refreshHitTest(): void {
    if (this.locked || !Number.isFinite(this.lastPointerX) || this.dragging) return
    this.setIgnoring(!this.isInteractivePoint(this.lastPointerX, this.lastPointerY))
  }

  resetPosition(): void {
    this.offsetX = 0
    this.offsetY = 0
    this.applyItemTransform()
    this.queueSave()
  }

  syncAfterDisplayChange(): void {
    this.applyItemTransform()
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.lastPointerX = event.clientX
    this.lastPointerY = event.clientY
    if (this.dragging) {
      const distance = Math.hypot(event.clientX - this.dragStartX, event.clientY - this.dragStartY)
      this.pressDistance = distance
      if (!this.movedDuringDrag && distance <= DRAG_START_DISTANCE) return
      if (!this.movedDuringDrag) this.stopHoldScale()
      this.movedDuringDrag = true
      this.offsetX = this.dragStartOffsetX + event.clientX - this.dragStartX
      this.offsetY = this.dragStartOffsetY + event.clientY - this.dragStartY
      this.applyItemTransform()
      return
    }
    if (this.locked || event.buttons !== 0) return
    const interactive = this.isInteractivePoint(event.clientX, event.clientY)
    if (interactive !== this.lastHitState) {
      this.lastHitState = interactive
      console.info(`[PetInteraction] pointer ${interactive ? 'entered visible content' : 'entered transparent content'} at ${event.clientX},${event.clientY}`)
    }
    this.setIgnoring(!interactive)
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (this.locked || event.button !== 0 || this.dragging) return
    if (isInteractiveControl(event.target) || !this.options.hitTest(event.clientX, event.clientY)) return
    event.preventDefault()
    this.dragging = true
    this.movedDuringDrag = false
    this.pressDistance = 0
    this.dragStartX = event.clientX
    this.dragStartY = event.clientY
    this.dragStartOffsetX = this.offsetX
    this.dragStartOffsetY = this.offsetY
    this.startHoldScale(event.clientX, event.clientY)
    this.setIgnoring(false)
  }

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (this.dragging && !this.movedDuringDrag && this.pressDistance < CLICK_MOVE_TOLERANCE) this.options.onClick(event)
    this.finishDrag()
  }
  private readonly onMouseLeave = (): void => {
    if (!this.dragging) this.setIgnoring(true)
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.locked || isInteractiveControl(event.target) || !this.options.hitTest(event.clientX, event.clientY)) return
    event.preventDefault()
    const next = Math.max(MIN_SCALE, this.scale * (event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT))
    if (Math.abs(next - this.scale) < 0.0001) return
    this.scale = next
    this.applyItemTransform()
    this.queueSave()
  }

  private readonly onBlur = (): void => {
    this.finishDrag()
  }

  private finishDrag(): void {
    this.stopHoldScale()
    if (this.dragging && this.movedDuringDrag) {
      this.queueSave()
    }
    this.dragging = false
    this.movedDuringDrag = false
    this.pressDistance = 0
    this.refreshHitTest()
  }

  private startHoldScale(clientX: number, clientY: number): void {
    this.cancelHoldFrames()
    this.holdScale = 1
    this.applyItemTransform()
    const bounds = this.options.item.getBoundingClientRect()
    this.holdOriginX = bounds.width > 0 ? (clientX - bounds.left) / bounds.width : 0.5
    this.holdOriginY = bounds.height > 0 ? (clientY - bounds.top) / bounds.height : 0.5
    this.options.item.dataset.holdScaling = ''
    this.setImageBreathingEnabled(false)
    this.holdStartedAt = performance.now()
    this.holdGrowFrame = requestAnimationFrame(this.growHoldScale)
  }

  private readonly growHoldScale = (now: number): void => {
    if (this.holdStartedAt === null) return
    this.holdScale = 1 + (now - this.holdStartedAt) * PET_HOLD_GROWTH_PER_MS
    this.applyItemTransform()
    this.holdGrowFrame = requestAnimationFrame(this.growHoldScale)
  }

  private stopHoldScale(): void {
    if (this.holdStartedAt === null && this.holdScale === 1) return
    this.holdStartedAt = null
    if (this.holdGrowFrame !== null) cancelAnimationFrame(this.holdGrowFrame)
    this.holdGrowFrame = null
    if (this.holdScale === 1) {
      this.finishHoldRelease()
      return
    }
    const releaseStartedAt = performance.now()
    const releaseStartedScale = this.holdScale
    const release = (now: number): void => {
      const progress = Math.min(1, (now - releaseStartedAt) / PET_HOLD_RELEASE_MS)
      this.holdScale = releaseStartedScale + (1 - releaseStartedScale) * easeOutCubic(progress)
      this.applyItemTransform()
      if (progress < 1) this.holdReleaseFrame = requestAnimationFrame(release)
      else this.finishHoldRelease()
    }
    this.holdReleaseFrame = requestAnimationFrame(release)
  }

  private finishHoldRelease(): void {
    this.holdReleaseFrame = null
    this.holdScale = 1
    this.holdOriginX = 0.5
    this.holdOriginY = 0.5
    delete this.options.item.dataset.holdScaling
    this.setImageBreathingEnabled(true)
    this.applyItemTransform()
  }

  private resetHoldScale(): void {
    this.cancelHoldFrames()
    this.holdStartedAt = null
    this.finishHoldRelease()
  }

  private cancelHoldFrames(): void {
    if (this.holdGrowFrame !== null) cancelAnimationFrame(this.holdGrowFrame)
    if (this.holdReleaseFrame !== null) cancelAnimationFrame(this.holdReleaseFrame)
    this.holdGrowFrame = null
    this.holdReleaseFrame = null
  }

  private setImageBreathingEnabled(enabled: boolean): void {
    const canvas = this.options.item.querySelector<HTMLElement>('.ui-transparent-canvas[data-mode="image"]')
    if (canvas !== null) canvas.style.animation = enabled ? '' : 'none'
  }

  private queueSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      const value: PersistedItemState = { offsetX: this.offsetX, offsetY: this.offsetY, scale: this.scale }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    }, SAVE_DELAY_MS)
  }

  private setIgnoring(ignore: boolean): void {
    if (this.ignoringMouse === ignore) return
    this.ignoringMouse = ignore
    this.options.setIgnoreMouseEvents(ignore)
  }

  private isInteractivePoint(clientX: number, clientY: number): boolean {
    const target = document.elementFromPoint(clientX, clientY)
    return (target !== null && target.closest('[data-pet-interactive]') !== null) || this.options.hitTest(clientX, clientY)
  }

  private applyItemTransform(): void {
    const baseWidth = PET_BASE_WINDOW_WIDTH * this.scale
    const baseHeight = PET_BASE_WINDOW_HEIGHT * this.scale
    const { width, height, originShiftX, originShiftY } = calculatePetHoldGeometry(
      baseWidth, baseHeight, this.holdScale, this.holdOriginX, this.holdOriginY
    )
    this.options.item.style.left = `calc(50% + ${this.offsetX + originShiftX}px)`
    this.options.item.style.top = `calc(50% + ${this.offsetY + originShiftY}px)`
    this.options.item.style.width = `${Math.round(width)}px`
    this.options.item.style.height = `${Math.round(height)}px`
    this.options.item.style.transform = 'translate(-50%, -50%)'
    this.options.onScale(this.scale * this.holdScale)
  }
}

function readPersistedItemState(): PersistedItemState | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedItemState> | null
    if (value === null || !Number.isFinite(value.offsetX) || !Number.isFinite(value.offsetY) || !Number.isFinite(value.scale)) return null
    return { offsetX: value.offsetX!, offsetY: value.offsetY!, scale: Math.max(MIN_SCALE, value.scale!) }
  } catch {
    return null
  }
}

function isInteractiveControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-pet-interactive]') !== null
}
