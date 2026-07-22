import type { ReactNode } from 'react'

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }): React.JSX.Element {
  return (
    <section className="ui-state" aria-label={title}>
      <span className="ui-state__icon" aria-hidden="true">◇</span>
      <h3>{title}</h3>
      {description !== undefined ? <p>{description}</p> : null}
      {action}
    </section>
  )
}
