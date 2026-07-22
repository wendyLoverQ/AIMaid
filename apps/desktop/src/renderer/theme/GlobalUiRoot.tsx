import { useEffect } from 'react'
import type { PropsWithChildren } from 'react'
import { ToastProvider } from '../components/feedback/Toast'
import { applyStoredAppearance, subscribeAppearance } from '../pages/appearance/appearance-runtime'

export function GlobalUiRoot({ children }: PropsWithChildren): React.JSX.Element {
  useEffect(() => {
    const apply = (): void => applyStoredAppearance()
    apply()
    const unsubscribe = subscribeAppearance(apply)
    return unsubscribe
  }, [])
  return <ToastProvider><div className="aimaid-ui-root">{children}</div></ToastProvider>
}
