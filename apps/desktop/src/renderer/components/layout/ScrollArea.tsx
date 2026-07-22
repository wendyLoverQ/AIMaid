import type { HTMLAttributes, PropsWithChildren } from 'react'

export interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'> {
  maxHeight?: 'sm' | 'md' | 'lg' | 'viewport'
}

export function ScrollArea({ children, maxHeight = 'md', ...props }: PropsWithChildren<ScrollAreaProps>): React.JSX.Element {
  return <div className={`ui-scroll-area ui-scroll-area--${maxHeight}`} {...props}>{children}</div>
}
