import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { IconButton } from '../base/IconButton'
import { getPortalRoot } from './portal'

export interface DrawerProps {
  open: boolean
  title: string
  children: ReactNode
  side?: 'left' | 'right'
  onClose: () => void
}

export function Drawer({ open, title, children, side = 'right', onClose }: DrawerProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusable = (): HTMLElement[] => dialog === null ? [] : Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (candidates.length === 0) {
        event.preventDefault()
        dialog?.focus()
        return
      }
      const first = candidates[0]!
      const last = candidates[candidates.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="ui-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside ref={dialogRef} className={`ui-drawer ui-drawer--${side}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="ui-overlay__header"><h2 id={titleId}>{title}</h2><IconButton label="关闭抽屉" size="sm" onClick={onClose}>×</IconButton></header>
        <div className="ui-overlay__body">{children}</div>
      </aside>
    </div>,
    getPortalRoot()
  )
}
