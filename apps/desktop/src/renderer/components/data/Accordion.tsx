import { useState } from 'react'
import type { ReactNode } from 'react'
export interface AccordionProps { title: string; children: ReactNode; defaultOpen?: boolean; disabled?: boolean }
export function Accordion({ title, children, defaultOpen = false, disabled = false }: AccordionProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return <section className="ui-accordion"><button type="button" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}><span>{title}</span><span aria-hidden="true">⌄</span></button>{open ? <div className="ui-accordion__content">{children}</div> : null}</section>
}
