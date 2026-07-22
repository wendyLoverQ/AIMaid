import type { PetVisualBounds, PetWindowUpdate } from '../../shared/pet'
import { PET_BASE_WINDOW_HEIGHT, PET_BASE_WINDOW_WIDTH } from '../../shared/pet-geometry'

const STORAGE_KEY = 'aimaid.pet-item-state.v1'
const MIN_SCALE = 0.25
const WHEEL_ZOOM_IN = 1.08
const WHEEL_ZOOM_OUT = 0.92
const SAVE_DELAY_MS = 160
const CLICK_MOVE_TOLERANCE = 6

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
  reportVisualBounds: (bounds: PetVisualBounds) => void
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
  private locked = false
  private lastPointerX = Number.NaN
  private lastPointerY = Number.NaN
  private moveFrame: number | null = null
  private boundsFrame: number | null = null
  private saveTimer: number | null = null
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
    if (this.boundsFrame !== null) cancelAnimationFrame(this.boundsFrame)
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
  }

  setLocked(locked: boolean): void {
    this.locked = locked
    if (locked) this.setIgnoring(false)
    else this.refreshHitTest()
  }

  refreshHitTest(): void {
    if (this.locked || !Number.isFinite(this.lastPointerX) || this.dragging) return
    this.setIgnoring(!this.isInteractivePoint(this.lastPointerX, this.lastPointerY))
  }

  refreshVisualBounds(): void {
    this.queueVisualBoundsReport()
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
      if (!this.movedDuringDrag && distance < CLICK_MOVE_TOLERANCE) return
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
    this.dragStartX = event.clientX
    this.dragStartY = event.clientY
    this.dragStartOffsetX = this.offsetX
    this.dragStartOffsetY = this.offsetY
    this.setIgnoring(false)
  }

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (this.dragging && !this.movedDuringDrag) this.options.onClick(event)
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
    if (this.dragging && this.movedDuringDrag) {
      this.queueSave()
    }
    this.dragging = false
    this.movedDuringDrag = false
    this.refreshHitTest()
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
    this.options.item.style.left = `calc(50% + ${this.offsetX}px)`
    this.options.item.style.top = `calc(50% + ${this.offsetY}px)`
    this.options.item.style.width = `${Math.round(PET_BASE_WINDOW_WIDTH * this.scale)}px`
    this.options.item.style.height = `${Math.round(PET_BASE_WINDOW_HEIGHT * this.scale)}px`
    this.options.item.style.transform = 'translate(-50%, -50%)'
    this.options.onScale(this.scale)
    this.queueVisualBoundsReport()
  }

  private queueVisualBoundsReport(): void {
    if (this.boundsFrame !== null) return
    this.boundsFrame = requestAnimationFrame(() => {
      this.boundsFrame = null
      const bounds = this.options.item.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return
      this.options.reportVisualBounds({
        x: Math.round(window.screenX + bounds.x),
        y: Math.round(window.screenY + bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      })
    })
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
