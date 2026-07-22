import { forwardRef, useId } from 'react'
import type { TextareaHTMLAttributes } from 'react'

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  label?: string
  error?: string
  hint?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, id, className = '', ...props },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const descriptionId = `${inputId}-description`
  return (
    <label className={`ui-field ${className}`.trim()} htmlFor={inputId}>
      {label !== undefined ? <span className="ui-field__label">{label}</span> : null}
      <textarea
        ref={ref}
        id={inputId}
        className="ui-textarea"
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined || hint !== undefined ? descriptionId : undefined}
        {...props}
      />
      {error !== undefined || hint !== undefined ? (
        <span id={descriptionId} className={error !== undefined ? 'ui-field__error' : 'ui-field__hint'}>
          {error ?? hint}
        </span>
      ) : null}
    </label>
  )
})
