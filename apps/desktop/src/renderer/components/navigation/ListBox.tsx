import type { PropsWithChildren, ReactNode } from 'react'

export function ListBox({ label, children }: PropsWithChildren<{ label: string }>): React.JSX.Element {
  return <div className="ui-listbox" role="listbox" aria-label={label}>{children}</div>
}

export function ListBoxItem({ selected = false, disabled = false, leading, title, description, badge, onSelect }: {
  selected?: boolean
  disabled?: boolean
  leading?: ReactNode
  title: ReactNode
  description?: ReactNode
  badge?: ReactNode
  onSelect: () => void
}): React.JSX.Element {
  return <button className="ui-listbox__item" type="button" role="option" aria-selected={selected} disabled={disabled} onClick={onSelect}>
    {leading !== undefined ? <span className="ui-listbox__leading">{leading}</span> : null}
    <span className="ui-listbox__content"><strong>{title}</strong>{description !== undefined ? <small>{description}</small> : null}</span>
    {badge !== undefined ? <span className="ui-listbox__badge">{badge}</span> : null}
  </button>
}
