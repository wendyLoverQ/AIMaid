import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '../base/IconButton'
import { getPortalRoot } from '../overlays/portal'

type ToastTone = 'info' | 'success' | 'warning' | 'error'
interface ToastItem { id: string; message: string; tone: ToastTone }
interface ToastContextValue { show: (message: string, tone?: ToastTone) => void }

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = crypto.randomUUID()
    setItems((current) => {
      const duplicate = current.find((item) => item.message === message && item.tone === tone)
      return duplicate === undefined ? [...current, { id, message, tone }].slice(-3) : current
    })
    if (tone !== 'error') setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 3_000)
  }, [])
  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(<div className="ui-toast-region" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <div key={item.id} className={`ui-toast ui-toast--${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
            <span>{item.message}</span>
            <IconButton label="关闭通知" size="sm" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}>×</IconButton>
          </div>
        ))}
      </div>, getPortalRoot())}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (context === null) throw new Error('useToast 必须在 ToastProvider 内使用')
  return context
}
