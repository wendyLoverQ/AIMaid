import type { PropsWithChildren, ReactNode } from 'react'

export function ShowcasePage({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-showcase">{children}</div>
}

export function ShowcaseContent({ children }: PropsWithChildren): React.JSX.Element {
  return <main className="ui-showcase__content">{children}</main>
}

export function ShowcaseIntro({ title, description, meta }: { title: string; description?: string; meta?: ReactNode }): React.JSX.Element {
  return <section className="ui-showcase__intro"><div><span>GLOBAL UI FOUNDATION</span><h1>{title}</h1><p>{description}</p></div>{meta !== undefined ? <aside>{meta}</aside> : null}</section>
}

export function ShowcaseSection({ title, description, children }: PropsWithChildren<{ title: string; description?: string }>): React.JSX.Element {
  return <section className="ui-showcase__section"><header><div><h2>{title}</h2>{description !== undefined ? <p>{description}</p> : null}</div></header><div className="ui-showcase__section-body">{children}</div></section>
}

export function ShowcaseRow({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-showcase__row">{children}</div>
}

export function ShowcaseFormGrid({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-showcase__form-grid">{children}</div>
}

export function ShowcaseStateGrid({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-showcase__state-grid">{children}</div>
}

export function ShowcaseIconGrid({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-showcase__icon-grid">{children}</div>
}

export function ShowcaseIcon({ icon, label }: { icon: ReactNode; label: string }): React.JSX.Element {
  return <div className="ui-showcase__icon"><span>{icon}</span><small>{label}</small></div>
}
