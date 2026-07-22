import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'

export interface ContextMenuSurfaceItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  separated?: boolean
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export function ContextMenuSurface({ label, items, position, footer, onClose }: {
  label: string
  items: readonly ContextMenuSurfaceItem[]
  position: { x: number; y: number }
  footer?: ReactNode
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ left: position.x, top: position.y, visibility: 'hidden' })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const margin = 8
    const rect = menu.getBoundingClientRect()
    const left = position.x + rect.width <= window.innerWidth - margin
      ? position.x
      : position.x - rect.width
    const top = position.y + rect.height <= window.innerHeight - margin
      ? position.y
      : position.y - rect.height
    setStyle({
      left: Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin))
    })
  }, [items.length, position.x, position.y])

  useLayoutEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return createPortal(<div className="ui-context-menu-layer" data-pet-interactive onPointerDown={onClose}>
    <div ref={menuRef} className="ui-context-menu ui-context-menu--rich" style={style} role="menu" aria-label={label} onPointerDown={(event) => event.stopPropagation()}>
      {items.map((item) => <div className={item.separated === true ? 'ui-menu__group-start' : undefined} key={item.id}>
        <button className={`ui-menu__item${item.danger === true ? ' ui-menu__item--danger' : ''}`} type="button" role="menuitem" disabled={item.disabled}
          onClick={() => { item.onSelect(); onClose() }}>
          {item.icon !== undefined ? <span className="ui-menu__icon">{item.icon}</span> : null}
          <span className="ui-menu__label">{item.label}</span>
        </button>
      </div>)}
      {footer !== undefined ? <footer className="ui-context-menu__footer">{footer}</footer> : null}
    </div>
  </div>, document.body)
}
