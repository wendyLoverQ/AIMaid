import type { ReactNode } from 'react'

export interface PageHeaderProps { title: string; description?: string; backAction?: ReactNode; actions?: ReactNode }
export function PageHeader({ title, description, backAction, actions }: PageHeaderProps): React.JSX.Element {
  return <header className="ui-page-header"><div className="ui-page-header__lead">{backAction}<div><h1>{title}</h1>{description !== undefined ? <p>{description}</p> : null}</div></div>{actions !== undefined ? <div className="ui-page-header__actions">{actions}</div> : null}</header>
}

export function Toolbar({ children, label = '页面工具栏' }: { children: ReactNode; label?: string }): React.JSX.Element {
  return <div className="ui-toolbar" role="toolbar" aria-label={label}>{children}</div>
}

export interface SettingsSectionProps { title: string; description?: string; children: ReactNode }
export function SettingsSection({ title, description, children }: SettingsSectionProps): React.JSX.Element {
  return <section className="ui-settings-section"><header><h2>{title}</h2>{description !== undefined ? <p>{description}</p> : null}</header><div>{children}</div></section>
}
export interface SettingRowProps { title: string; description?: string; control: ReactNode }
export function SettingRow({ title, description, control }: SettingRowProps): React.JSX.Element {
  return <div className="ui-setting-row"><div><strong>{title}</strong>{description !== undefined ? <p>{description}</p> : null}</div><div>{control}</div></div>
}
