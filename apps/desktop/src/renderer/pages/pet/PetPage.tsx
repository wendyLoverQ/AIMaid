import { useEffect, useState } from 'react'
import type { PetRuntime } from '../../live2d/pet-runtime'
import { ActionButton } from '../../components/base/ActionButton'

export default function PetPage(): React.JSX.Element {
  const [runtime, setRuntime] = useState<PetRuntime | null>(null)

  useEffect(() => {
    let active = true
    void import('../../live2d/pet-runtime').then((module) => {
      if (active) setRuntime(module.createPetRuntime())
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <main className="pet-shell">
      <div className="pet-placeholder" aria-label="Live2D placeholder">
        <span>Live2D</span>
        <small>{runtime?.state ?? 'loading'}</small>
      </div>
      <p>PetWindow 专用懒加载入口</p>
      <div className="actions centered">
        <ActionButton onClick={() => void window.aimaid.window.hide?.()}>隐藏</ActionButton>
        <ActionButton onClick={() => void window.aimaid.window.close?.()}>关闭</ActionButton>
      </div>
    </main>
  )
}
