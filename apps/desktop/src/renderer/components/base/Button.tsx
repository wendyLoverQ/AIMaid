import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import { Loading } from '../feedback/Loading'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'left' | 'right'
  fullWidth?: boolean
  visibility?: 'visible' | 'hidden'
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconPosition = 'left',
  fullWidth = false,
  visibility = 'visible',
  disabled,
  className = '',
  ...props
}: PropsWithChildren<ButtonProps>): React.JSX.Element {
  return (
    <button
      className={`ui-button ui-button--${variant} ui-control--${size}${fullWidth ? ' ui-button--full' : ''}${visibility === 'hidden' ? ' ui-button--hidden' : ''} ${className}`.trim()}
      type="button"
      disabled={disabled === true || loading}
      aria-busy={loading}
      {...props}
    >
      <span className={`ui-button__content${loading ? ' ui-button__content--loading' : ''}`}>
        {icon !== undefined && iconPosition === 'left' ? <span className="ui-button__icon">{icon}</span> : null}
        <span>{children}</span>
        {icon !== undefined && iconPosition === 'right' ? <span className="ui-button__icon">{icon}</span> : null}
      </span>
      {loading ? <span className="ui-button__spinner"><Loading size="sm" label="" /></span> : null}
    </button>
  )
}
