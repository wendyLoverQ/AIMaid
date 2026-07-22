import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react'

type Clean<T> = Omit<T, 'className' | 'style' | 'dangerouslySetInnerHTML'>

export function ProductPage({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-product-page">{children}</div>
}

export function ProductWorkspace({ children, layout = 'single', ...props }: PropsWithChildren<Clean<HTMLAttributes<HTMLElement>> & {
  layout?: 'single' | 'sidebar' | 'dashboard' | 'media' | 'center'
}>): React.JSX.Element {
  return <main className={`ui-product-workspace ui-product-workspace--${layout}`} {...props}>{children}</main>
}

export function ProductSidebar({ title, description, actions, children }: PropsWithChildren<{
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}>): React.JSX.Element {
  return <aside className="ui-product-sidebar">
    {title !== undefined || description !== undefined || actions !== undefined ? <header className="ui-product-sidebar__header">
      <div>{title !== undefined ? <h2>{title}</h2> : null}{description !== undefined ? <p>{description}</p> : null}</div>
      {actions !== undefined ? <div className="ui-product-sidebar__actions">{actions}</div> : null}
    </header> : null}
    <div className="ui-product-sidebar__body">{children}</div>
  </aside>
}

export function ProductPanel({ title, description, actions, footer, children, scroll = false, emphasis = false, wide = false }: PropsWithChildren<{
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  scroll?: boolean
  emphasis?: boolean
  wide?: boolean
}>): React.JSX.Element {
  const classes = ['ui-product-panel', scroll ? 'ui-product-panel--scroll' : '', emphasis ? 'ui-product-panel--emphasis' : '', wide ? 'ui-product-panel--wide' : ''].filter(Boolean).join(' ')
  return <section className={classes}>
    {title !== undefined || description !== undefined || actions !== undefined ? <header className="ui-product-panel__header">
      <div>{title !== undefined ? <h2>{title}</h2> : null}{description !== undefined ? <p>{description}</p> : null}</div>
      {actions !== undefined ? <div className="ui-product-panel__actions">{actions}</div> : null}
    </header> : null}
    <div className="ui-product-panel__body">{children}</div>
    {footer !== undefined ? <footer className="ui-product-panel__footer">{footer}</footer> : null}
  </section>
}

export function ProductToolbar({ lead, actions, layout = 'inline' }: { lead?: ReactNode; actions?: ReactNode; layout?: 'inline' | 'stacked' }): React.JSX.Element {
  return <section className={`ui-product-toolbar ui-product-toolbar--${layout}`}>
    <div className="ui-product-toolbar__lead">{lead}</div>
    <div className="ui-product-toolbar__actions">{actions}</div>
  </section>
}

export function ProductFieldActions({ field, actions }: { field: ReactNode; actions: ReactNode }): React.JSX.Element {
  return <div className="remote-video-source">
    {field}
    <div className="remote-video-source__actions">{actions}</div>
  </div>
}

export function ProductTabNavigation({ tabs, actions, label }: { tabs: ReactNode; actions?: ReactNode; label: string }): React.JSX.Element {
  return <nav className="remote-video-navigation" aria-label={label}>
    <div className="remote-video-tabs" role="tablist" aria-label={label}>{tabs}</div>
    {actions !== undefined ? <div className="remote-video-navigation__actions">{actions}</div> : null}
  </nav>
}

export function ProductStatusBar({ children, actions }: PropsWithChildren<{ actions?: ReactNode }>): React.JSX.Element {
  return <footer className="ui-product-status" role="status" aria-live="polite" aria-atomic="true"><div>{children}</div>{actions !== undefined ? <div className="ui-product-status__actions">{actions}</div> : null}</footer>
}

export function ProductGrid({ children, density = 'comfortable' }: PropsWithChildren<{ density?: 'comfortable' | 'compact' | 'cards' | 'metrics' | 'quick-actions' | 'actions' }>): React.JSX.Element {
  return <div className={`ui-product-grid ui-product-grid--${density}`}>{children}</div>
}

export function ProductHero({ eyebrow, value, detail, actions }: { eyebrow?: ReactNode; value: ReactNode; detail?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <section className="ui-product-hero">
    <div className="ui-product-hero__content">{eyebrow !== undefined ? <span>{eyebrow}</span> : null}<strong>{value}</strong>{detail !== undefined ? <p>{detail}</p> : null}</div>
    {actions !== undefined ? <div className="ui-product-hero__actions">{actions}</div> : null}
  </section>
}

export function ProductMetric({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }): React.JSX.Element {
  return <div className="ui-product-metric"><span>{label}</span><strong>{value}</strong>{detail !== undefined ? <small>{detail}</small> : null}</div>
}

export function ProductList({ children, compact = false }: PropsWithChildren<{ compact?: boolean }>): React.JSX.Element {
  return <div className={`ui-product-list${compact ? ' ui-product-list--compact' : ''}`}>{children}</div>
}

export function ProductComposer({ children }: PropsWithChildren): React.JSX.Element {
  return <footer className="ui-product-composer">{children}</footer>
}
