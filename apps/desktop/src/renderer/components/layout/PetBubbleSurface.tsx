import type { HTMLAttributes, PropsWithChildren } from 'react'
export function PetBubbleSurface({ children, ...props }: PropsWithChildren<Omit<HTMLAttributes<HTMLElement>, 'className' | 'style'>>): React.JSX.Element {
  return <aside className="ui-pet-bubble" {...props}>{children}</aside>
}
