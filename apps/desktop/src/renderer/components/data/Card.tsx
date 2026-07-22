import type { ReactNode } from 'react'
export interface CardProps { children: ReactNode; header?: ReactNode; footer?: ReactNode; padding?: 'compact' | 'default' | 'large'; selected?: boolean; disabled?: boolean }
export function Card({ children, header, footer, padding = 'default', selected = false, disabled = false }: CardProps): React.JSX.Element {
  return <section className={`ui-card ui-card--${padding}`} aria-disabled={disabled} data-selected={selected || undefined}>{header !== undefined ? <header>{header}</header> : null}<div className="ui-card__body">{children}</div>{footer !== undefined ? <footer>{footer}</footer> : null}</section>
}
