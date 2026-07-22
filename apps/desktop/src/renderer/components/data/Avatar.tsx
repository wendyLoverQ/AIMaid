export function Avatar({ source, fallback, size = 'md' }: { source?: string; fallback: string; size?: 'sm' | 'md' | 'lg' | 'preview' }): React.JSX.Element {
  return <span className={`ui-avatar ui-avatar--${size}`}>{source !== undefined && source !== '' ? <img src={source} alt="" /> : fallback.slice(0, 1)}</span>
}
