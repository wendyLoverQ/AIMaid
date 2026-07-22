import { useEffect, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { IconButton } from '../base/IconButton'
import { Loading } from '../feedback/Loading'

export interface SearchBoxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'size'> {
  value: string
  onChange: (value: string) => void
  onSearch?: (value: string) => void
  loading?: boolean
  debounceMs?: number
}

export function SearchBox({ value, onChange, onSearch, loading = false, debounceMs = 300, ...props }: SearchBoxProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => onChange(draft), debounceMs)
    return () => window.clearTimeout(timer)
  }, [debounceMs, draft, onChange, value])
  return <div className="ui-search-box">
    <span className="ui-search-box__icon" aria-hidden="true">⌕</span>
    <input {...props} className="ui-input" type="search" value={draft} onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSearch?.(draft)
        if (event.key === 'Escape') { setDraft(''); onChange('') }
        props.onKeyDown?.(event)
      }}/>
    {loading ? <Loading size="sm" label="搜索中"/> : draft.length > 0 ? <IconButton label="清空搜索" size="sm" onClick={() => { setDraft(''); onChange('') }}>×</IconButton> : null}
  </div>
}
