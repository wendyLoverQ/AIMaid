import { ErrorState } from './ErrorState'

export function OfflineState({ onRetry }: { onRetry?: () => void }): React.JSX.Element {
  return <ErrorState title="当前离线" message="无法连接到所需服务，请检查连接后重试。" {...(onRetry === undefined ? {} : { onRetry })} />
}
