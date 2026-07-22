import type { ButtonHTMLAttributes } from 'react'
import { Loading } from '../feedback/Loading'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  label: string
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  tooltip?: string
}

export function IconButton({ label, tooltip, size = 'md', loading = false, disabled, className = '', children, ...props }: IconButtonProps): React.JSX.Element {
  return (
    <button
      className={`ui-icon-button ui-control--${size} ${className}`.trim()}
      type="button"
      aria-label={label}
      title={tooltip ?? label}
      disabled={disabled === true || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? <Loading size="sm" label="" /> : children}
    </button>
  )
}
