import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface RangeProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
  valueLabel?: string
}

export const Range = forwardRef<HTMLInputElement, RangeProps>(function Range({ label, valueLabel, id, className = '', ...props }, ref) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return <label className={`ui-range ${className}`.trim()} htmlFor={inputId}>
    {label !== undefined ? <span className="ui-range__label">{label}{valueLabel !== undefined ? <strong>{valueLabel}</strong> : null}</span> : null}
    <input ref={ref} id={inputId} className="ui-range__control" type="range" {...props} />
  </label>
})
