import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'

type TrayMenuSurfaceProps = Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'dangerouslySetInnerHTML'>

export const TrayMenuSurface = forwardRef<HTMLElement, TrayMenuSurfaceProps>(function TrayMenuSurface(props, ref) {
  return <main ref={ref} className="tray-menu-shell" {...props} />
})
