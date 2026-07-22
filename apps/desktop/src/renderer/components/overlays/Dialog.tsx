import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { IconButton } from '../base/IconButton'
import { getPortalRoot } from './portal'

export interface DialogProps {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  size?: 'sm' | 'md' | 'lg' | 'xl'
  closeOnBackdrop?: boolean
}

export function Dialog({ open, title, description, children, footer, onClose, size = 'md', closeOnBackdrop = false }: DialogProps): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  if (!open) return null
  return createPortal(
    <dialog ref={ref} className={`ui-dialog ui-dialog--${size}`} aria-labelledby={titleId}
      onClick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose() }}
      onCancel={(event) => { event.preventDefault(); onClose() }} onClose={onClose}>
      <header className="ui-overlay__header">
        <div><h2 id={titleId}>{title}</h2>{description !== undefined ? <p>{description}</p> : null}</div>
        <IconButton label="关闭对话框" size="sm" onClick={onClose}>×</IconButton>
      </header>
      <div className="ui-overlay__body">{children}</div>
      {footer !== undefined ? <footer className="ui-overlay__footer">{footer}</footer> : null}
    </dialog>,
    getPortalRoot()
  )
}
