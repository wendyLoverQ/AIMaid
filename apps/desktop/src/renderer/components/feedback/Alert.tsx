import type { ReactNode } from 'react'

export interface AlertProps { tone?: 'info' | 'success' | 'warning' | 'error'; title?: string; children: ReactNode; action?: ReactNode }
export function Alert({ tone = 'info', title, children, action }: AlertProps): React.JSX.Element {
  return <div className={`ui-alert ui-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <div>{title !== undefined ? <strong>{title}</strong> : null}<div>{children}</div></div>{action}
  </div>
}
