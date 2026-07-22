import type { PropsWithChildren } from 'react'

export function Badge({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger' }>): React.JSX.Element {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>
}

export const StatusBadge = Badge

export function Progress({ value, max = 100, label }: { value: number; max?: number; label: string }): React.JSX.Element {
  return <label className="ui-progress"><span>{label}</span><progress value={value} max={max} /></label>
}

export const LinearProgress = Progress
export function CircularProgress({ value, max = 100, label }: { value?: number; max?: number; label: string }): React.JSX.Element {
  const percent = value === undefined ? undefined : Math.max(0, Math.min(100, value / max * 100))
  return <span className="ui-circular-progress" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemax={max} data-indeterminate={value === undefined || undefined} style={percent === undefined ? undefined : { '--ui-progress': `${percent * 3.6}deg` } as React.CSSProperties}/>
}
