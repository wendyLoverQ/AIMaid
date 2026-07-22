import { ErrorState } from './ErrorState'

export function UnauthorizedState({ onAuthorize }: { onAuthorize?: () => void }): React.JSX.Element {
  return <ErrorState title="需要授权" message="当前操作需要明确授权后才能继续。" {...(onAuthorize === undefined ? {} : { onRetry: onAuthorize })} />
}
