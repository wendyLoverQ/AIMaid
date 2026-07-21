import { useState } from 'react'
import { ActionButton } from '../../components/base/ActionButton'
import { describeResponse } from '../../shared/format-error'

export function SettingsPage(): React.JSX.Element {
  const [result, setResult] = useState('设置业务尚未接入')

  async function chooseFile(): Promise<void> {
    const response = await window.aimaid.dialog?.openFile([{ name: 'JSON', extensions: ['json'] }])
    if (response !== undefined) setResult(describeResponse(response))
  }

  return (
    <main className="shell compact">
      <p className="eyebrow">SettingsWindow · 骨架</p>
      <h1>设置窗口边界</h1>
      <p>此窗口可以使用文件选择器，但不订阅 Core 事件。</p>
      <div className="actions">
        <ActionButton onClick={() => void chooseFile()}>选择配置文件</ActionButton>
        <ActionButton onClick={() => void window.aimaid.window.hide?.()}>隐藏窗口</ActionButton>
      </div>
      <pre>{result}</pre>
    </main>
  )
}
