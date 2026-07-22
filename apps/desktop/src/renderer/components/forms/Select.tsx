import { forwardRef, useId } from 'react'
import type { SelectHTMLAttributes } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'style'> {
  label?: string
  error?: string
  options: SelectOption[]
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, options, id, ...props },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <label className="ui-field" htmlFor={inputId}>
      {label !== undefined ? <span className="ui-field__label">{label}</span> : null}
      <select ref={ref} id={inputId} className="ui-select" aria-invalid={error !== undefined} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error !== undefined ? <span className="ui-field__error">{error}</span> : null}
    </label>
  )
})
