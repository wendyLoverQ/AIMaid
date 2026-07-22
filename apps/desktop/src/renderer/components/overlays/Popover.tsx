import type { PropsWithChildren, ReactNode } from 'react'

export function Popover({ open, anchor, children, placement = 'bottom-end' }: PropsWithChildren<{
  open: boolean
  anchor: ReactNode
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
}>): React.JSX.Element {
  return <span className="ui-popover-anchor">{anchor}{open ? <span className={`ui-popover ui-popover--${placement}`} role="dialog">{children}</span> : null}</span>
}
