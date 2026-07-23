import type { PropsWithChildren, ReactNode } from 'react'
import { UiIcon } from '../base/UiIcon'
import type { UiIconName } from '../base/UiIcon'
import { Meter } from './Semantics'

export type StatusHealth = 'online' | 'offline' | 'unknown'

export function StatusDot({ state }: { state: StatusHealth }): React.JSX.Element {
  return <span className={`status-dot status-dot--${state}`} aria-hidden="true" />
}

export function StatusHero({ eyebrow, value, detail, actions, avatar, compact = false }: {
  eyebrow?: ReactNode
  value: ReactNode
  detail?: ReactNode
  actions?: ReactNode
  avatar?: ReactNode
  compact?: boolean
}): React.JSX.Element {
  return <div className={`status-hero${compact ? ' status-hero--compact' : ''}`}>
    {avatar}
    <div className="status-hero__lead">
      {eyebrow !== undefined ? <span className="status-hero__eyebrow">{eyebrow}</span> : null}
      <strong className="ui-strong">{value}</strong>
      {detail !== undefined ? <small className="ui-small-text">{detail}</small> : null}
    </div>
    {actions !== undefined ? <div className="status-hero__trailing">{actions}</div> : null}
  </div>
}

export function StatusPanelGrid({ children, variant = 'main' }: PropsWithChildren<{ variant?: 'main' | 'summary' }>): React.JSX.Element {
  return <div className={`status-grid-3 status-grid-3--${variant}`}>{children}</div>
}

export function StatusPanelTitle({ icon, children }: PropsWithChildren<{ icon: UiIconName }>): React.JSX.Element {
  return <span className="status-panel-title"><span className="status-panel-title__icon"><UiIcon name={icon} /></span>{children}</span>
}

export function StatusMetricGrid({ children, columns = 2 }: PropsWithChildren<{ columns?: 1 | 2 | 3 | 4 }>): React.JSX.Element {
  return <div className={`status-metric-grid status-metric-grid--${columns}`}>{children}</div>
}

export function StatusMetric({ label, value, state, detail, meterPercent, tone = 'neutral', wide = false }: {
  label: ReactNode
  value: ReactNode
  state?: StatusHealth
  detail?: ReactNode
  meterPercent?: number
  tone?: 'neutral' | 'success' | 'danger' | 'accent'
  wide?: boolean
}): React.JSX.Element {
  const hasMeter = meterPercent !== undefined
  return <div className={`status-metric status-metric--${tone}${wide ? ' status-metric--wide' : ''}`}>
    <span className="status-metric__label">{state !== undefined ? <StatusDot state={state} /> : null}{label}</span>
    <strong className="ui-strong">{value}</strong>
    {detail !== undefined ? <small className="ui-small-text">{detail}</small> : null}
    {hasMeter ? <Meter value={Math.max(0, Math.min(100, meterPercent))} max={100} /> : null}
  </div>
}
