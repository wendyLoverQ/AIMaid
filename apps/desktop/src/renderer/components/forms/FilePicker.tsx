import { useId, useRef, useState } from 'react'
import type { DragEvent, InputHTMLAttributes } from 'react'
import { Button } from '../base/Button'
import { Alert } from '../feedback/Alert'
export interface FilePickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> { label: string; maxBytes?: number; onFiles: (files: readonly File[]) => void }
export function FilePicker({ label, maxBytes, onFiles, multiple, accept, ...props }: FilePickerProps): React.JSX.Element {
  const id = useId(); const ref = useRef<HTMLInputElement>(null); const [error, setError] = useState<string>()
  const receive = (files: readonly File[]): void => {
    const oversized = maxBytes === undefined ? undefined : files.find((file) => file.size > maxBytes)
    if (oversized !== undefined) { setError(`${oversized.name} 超过大小限制。`); return }
    setError(undefined); onFiles(files)
  }
  const drop = (event: DragEvent<HTMLDivElement>): void => { event.preventDefault(); receive(Array.from(event.dataTransfer.files)) }
  return <div className="ui-file-picker" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
    <input {...props} ref={ref} id={id} className="ui-visually-hidden" type="file" multiple={multiple} accept={accept} onChange={(event) => receive(Array.from(event.target.files ?? []))}/>
    <strong>{label}</strong><span>拖放文件到这里，或使用系统文件选择器。</span><Button onClick={() => ref.current?.click()}>选择文件</Button>
    {error !== undefined ? <Alert tone="error">{error}</Alert> : null}
  </div>
}
