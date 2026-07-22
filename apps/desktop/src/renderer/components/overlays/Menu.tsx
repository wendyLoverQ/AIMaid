import type { ReactNode } from 'react'

export interface MenuItem {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export interface MenuProps {
  open: boolean
  label: string
  items: MenuItem[]
  onClose: () => void
  children: ReactNode
}

export function Menu({ open, label, items, onClose, children }: MenuProps): React.JSX.Element {
  return (
    <span className="ui-menu-anchor">
      {children}
      {open ? (
        <span className="ui-menu" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              className={item.danger === true ? 'ui-menu__item ui-menu__item--danger' : 'ui-menu__item'}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { item.onSelect(); onClose() }}
            >
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}
