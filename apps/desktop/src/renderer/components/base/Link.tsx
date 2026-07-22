import type { AnchorHTMLAttributes, PropsWithChildren } from 'react'

export function Link({ children, external = false, ...props }: PropsWithChildren<Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'style'> & { external?: boolean }>): React.JSX.Element {
  return <a className="ui-link" target={external ? '_blank' : props.target} rel={external ? 'noreferrer' : props.rel} {...props}>{children}</a>
}
