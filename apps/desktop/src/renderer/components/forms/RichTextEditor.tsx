import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ClipboardEvent } from 'react'

export interface RichTextEditorHandle { focus: () => void; insertHtml: (html: string) => void }
export interface RichTextEditorProps { value: string; label: string; disabled?: boolean; onChange: (html: string, text: string) => void; onPasteFiles?: (files: readonly File[]) => void }

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor({ value, label, disabled = false, onChange, onPasteFiles }, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(forwardedRef, () => ({
    focus: () => ref.current?.focus(),
    insertHtml: (html) => {
      ref.current?.focus()
      document.execCommand('insertHTML', false, html)
      if (ref.current !== null) onChange(ref.current.innerHTML, ref.current.innerText)
    }
  }), [onChange])
  useEffect(() => { if (ref.current !== null && ref.current.innerHTML !== value) ref.current.innerHTML = value }, [value])
  const paste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const files = Array.from(event.clipboardData.files)
    if (files.length > 0 && onPasteFiles !== undefined) { event.preventDefault(); onPasteFiles(files) }
  }
  return <div ref={ref} className="ui-rich-editor" role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled}
    contentEditable={!disabled} suppressContentEditableWarning onInput={(event) => onChange(event.currentTarget.innerHTML, event.currentTarget.innerText)} onPaste={paste}/>
})
