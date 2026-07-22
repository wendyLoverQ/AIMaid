import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  label?: string
  error?: string
  hint?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, className = '', type, ...props },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const descriptionId = `${inputId}-description`
  return (
    <label className={`ui-field ${className}`.trim()} htmlFor={inputId}>
      {label !== undefined ? <span className="ui-field__label">{label}</span> : null}
      <input ref={ref} id={inputId} className="ui-input" type={type} aria-invalid={error !== undefined}
        aria-describedby={error !== undefined || hint !== undefined ? descriptionId : undefined} {...props} />
      {error !== undefined || hint !== undefined ? (
        <span id={descriptionId} className={error !== undefined ? 'ui-field__error' : 'ui-field__hint'}>
          {error ?? hint}
        </span>
      ) : null}
    </label>
  )
})
