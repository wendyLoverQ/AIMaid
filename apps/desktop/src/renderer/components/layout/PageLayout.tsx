import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react'

export function AppViewport({ children, className = '', ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>): React.JSX.Element {
  return <div className={`ui-app-viewport ${className}`.trim()} {...props}>{children}</div>
}

export function PageToolbar({ lead, actions }: { lead: ReactNode; actions: ReactNode }): React.JSX.Element {
  return <section className="ui-page-toolbar"><div className="ui-page-toolbar__lead">{lead}</div><div className="ui-page-toolbar__actions">{actions}</div></section>
}

export function WorkspaceGrid({ children }: PropsWithChildren): React.JSX.Element {
  return <main className="ui-workspace-grid">{children}</main>
}

type SurfaceVariant = 'character-navigation' | 'character-detail' | 'character-info' | 'character-card-status' | 'character-binding' | 'template-card-reader' | 'character-editor-preview' | 'character-editor-form' | 'reminder-row' | 'notebook-navigation' | 'notebook-editor' | 'conversation-navigation' | 'conversation-detail'
export function Surface({ children, className = '', variant, scroll = false, ...props }: PropsWithChildren<HTMLAttributes<HTMLElement> & { scroll?: boolean; variant?: SurfaceVariant }>): React.JSX.Element {
  return <section className={`ui-surface${scroll ? ' ui-surface--scroll' : ''}${variant === undefined ? '' : ` ${variant}`} ${className}`.trim()} {...props}>{children}</section>
}

export function SurfaceHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }): React.JSX.Element {
  return <header className="ui-surface__header"><strong>{title}</strong>{meta !== undefined ? <span>{meta}</span> : null}</header>
}

export function ActionGroup({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-action-group">{children}</div>
}

export function DetailList({ title, children }: PropsWithChildren<{ title?: ReactNode }>): React.JSX.Element {
  return <div className="ui-detail-list">{title !== undefined ? <h3>{title}</h3> : null}{children}</div>
}

export function DetailRow({ label, value, wrap = false }: { label: ReactNode; value: ReactNode; wrap?: boolean }): React.JSX.Element {
  return <div className={`ui-detail-row${wrap ? ' ui-detail-row--wrap' : ''}`}><span>{label}</span><strong>{value}</strong></div>
}
