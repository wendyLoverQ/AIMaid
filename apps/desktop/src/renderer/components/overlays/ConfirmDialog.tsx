import { Button } from '../base/Button'
import { Dialog } from './Dialog'
export interface ConfirmDialogProps { open: boolean; title: string; description: string; confirmText?: string; cancelText?: string; confirmVariant?: 'primary' | 'danger'; loading?: boolean; onConfirm: () => void; onCancel: () => void }
export function ConfirmDialog({ open, title, description, confirmText = '确定', cancelText = '取消', confirmVariant = 'primary', loading = false, onConfirm, onCancel }: ConfirmDialogProps): React.JSX.Element | null {
  return <Dialog open={open} size="sm" title={title} description={description} onClose={onCancel} footer={<><Button disabled={loading} onClick={onCancel}>{cancelText}</Button><Button variant={confirmVariant} loading={loading} onClick={onConfirm}>{confirmText}</Button></>}><span className="ui-visually-hidden">请确认此操作</span></Dialog>
}
