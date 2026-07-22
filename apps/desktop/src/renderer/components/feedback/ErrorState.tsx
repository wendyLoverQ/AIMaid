import { Button } from '../base/Button'

export interface ErrorStateProps {
  title?: string
  message: string
  onRetry?: () => void
}

export function ErrorState({ title = '出现错误', message, onRetry }: ErrorStateProps): React.JSX.Element {
  return (
    <section className="ui-state ui-state--error" role="alert">
      <span className="ui-state__icon" aria-hidden="true">!</span>
      <h3>{title}</h3>
      <p>{message}</p>
      {onRetry !== undefined ? <Button onClick={onRetry}>重试</Button> : null}
    </section>
  )
}
