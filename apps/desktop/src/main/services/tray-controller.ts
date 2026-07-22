import { nativeImage, screen, Tray } from 'electron'
import type { WindowManager } from '../windows/window-manager'
import type { Logger } from '../logging/logger'

const RIGHT_CLICK_SETTLE_DELAY_MS = 100

export class TrayController {
  private tray: Tray | undefined
  private pendingRightClick: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly windows: WindowManager,
    private readonly iconPath: string,
    private readonly log: Logger
  ) {}

  install(): void {
    if (this.tray !== undefined) return
    const image = nativeImage.createFromPath(this.iconPath)
    this.tray = new Tray(image)
    this.tray.setToolTip('AIMaid')
    this.tray.on('click', this.showMenu)
    this.tray.on('right-click', this.queueRightClickMenu)
    this.log.info('tray', 'Tray entry installed')
  }

  dispose(): void {
    this.tray?.off('click', this.showMenu)
    this.tray?.off('right-click', this.queueRightClickMenu)
    if (this.pendingRightClick !== undefined) clearTimeout(this.pendingRightClick)
    this.pendingRightClick = undefined
    this.tray?.destroy()
    this.tray = undefined
  }

  private readonly queueRightClickMenu = (): void => {
    if (this.pendingRightClick !== undefined) clearTimeout(this.pendingRightClick)
    this.pendingRightClick = setTimeout(() => {
      this.pendingRightClick = undefined
      this.showMenu()
    }, RIGHT_CLICK_SETTLE_DELAY_MS)
  }

  private readonly showMenu = (): void => {
    const point = screen.getCursorScreenPoint()
    const work = screen.getDisplayNearestPoint(point).workArea
    const existingMenu = this.windows.get('tray-menu')
    const menu = existingMenu ?? this.windows.open('tray-menu')
    const bounds = menu.getBounds()
    const gap = 8
    let x = Math.min(Math.max(point.x - bounds.width + gap, work.x), work.x + work.width - bounds.width)
    let y = point.y - bounds.height - gap
    if (y < work.y) y = Math.min(point.y + gap, work.y + work.height - bounds.height)
    x = Math.round(x); y = Math.round(Math.max(work.y, y))
    menu.setPosition(x, y, false)
    if (existingMenu !== undefined) this.windows.open('tray-menu')
  }
}
