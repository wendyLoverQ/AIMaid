import { useEffect, useState } from 'react'
import type { MouseEvent, PropsWithChildren } from 'react'
import type { MenuItem } from './Menu'

export function ContextMenu({ label, items, children }: PropsWithChildren<{ label: string; items: MenuItem[] }>): React.JSX.Element {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (position === null) return
    const close = (): void => setPosition(null)
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [position])

  function open(event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault()
    setPosition({ x: event.clientX, y: event.clientY })
  }

  return (
    <div onContextMenu={open}>
      {children}
      {position !== null ? (
        <div className="ui-context-menu" role="menu" aria-label={label} style={{ left: position.x, top: position.y }}>
          {items.map((item) => (
            <button
              key={item.id}
              className={item.danger === true ? 'ui-menu__item ui-menu__item--danger' : 'ui-menu__item'}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { item.onSelect(); setPosition(null) }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
