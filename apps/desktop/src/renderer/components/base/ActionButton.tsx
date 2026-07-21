import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

type ActionButtonProps = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>

export function ActionButton({ children, className = '', ...props }: ActionButtonProps): React.JSX.Element {
  return (
    <button className={`action-button ${className}`.trim()} type="button" {...props}>
      {children}
    </button>
  )
}
