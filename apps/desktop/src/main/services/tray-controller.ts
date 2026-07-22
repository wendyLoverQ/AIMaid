import { nativeImage, screen, Tray } from 'electron'
import type { WindowManager } from '../windows/window-manager'
import type { Logger } from '../logging/logger'

export class TrayController {
  private tray: Tray | undefined

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
    this.tray.on('right-click', this.showMenu)
    this.tray.on('mouse-down', this.handleMouseDown)
    this.tray.on('mouse-up', this.handleMouseUp)
    this.log.info('tray', 'Tray entry installed')
  }

  dispose(): void {
    this.tray?.off('click', this.showMenu)
    this.tray?.off('right-click', this.showMenu)
    this.tray?.off('mouse-down', this.handleMouseDown)
    this.tray?.off('mouse-up', this.handleMouseUp)
    this.windows.setTrayIconPointerDown(false)
    this.tray?.destroy()
    this.tray = undefined
  }

  private readonly handleMouseDown = (): void => this.windows.setTrayIconPointerDown(true)

  private readonly handleMouseUp = (): void => this.windows.setTrayIconPointerDown(false)

  private readonly showMenu = (): void => {
    const existingMenu = this.windows.get('tray-menu')
    if (existingMenu?.isVisible()) {
      if (!existingMenu.isFocused()) existingMenu.focus()
      return
    }
    const point = screen.getCursorScreenPoint()
    const work = screen.getDisplayNearestPoint(point).workArea
    const menu = existingMenu ?? this.windows.open('tray-menu')
    const bounds = menu.getBounds()
    const gap = 8
    let x = Math.min(Math.max(point.x - bounds.width + gap, work.x), work.x + work.width - bounds.width)
    let y = point.y - bounds.height - gap
    if (y < work.y) y = Math.min(point.y + gap, work.y + work.height - bounds.height)
    x = Math.round(x); y = Math.round(Math.max(work.y, y))
    menu.setBounds({ ...bounds, x, y }, false)
    if (existingMenu !== undefined) {
      menu.show()
      menu.focus()
    }
  }
}
