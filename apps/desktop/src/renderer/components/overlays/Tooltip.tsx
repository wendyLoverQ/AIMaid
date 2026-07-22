import type { PropsWithChildren } from 'react'

export function Tooltip({ content, children }: PropsWithChildren<{ content: string }>): React.JSX.Element {
  return <span className="ui-tooltip" data-tooltip={content}>{children}</span>
}
