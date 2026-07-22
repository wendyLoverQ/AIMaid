export interface LoadingProps {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  label?: string
}

export const Spinner = Loading

export function Loading({ size = 'md', label = '正在加载' }: LoadingProps): React.JSX.Element {
  return (
    <span className={`ui-loading ui-loading--${size}`} role="status" aria-label={label || '正在加载'}>
      <span className="ui-loading__spinner" aria-hidden="true" />
      {label !== '' ? <span>{label}</span> : null}
    </span>
  )
}
