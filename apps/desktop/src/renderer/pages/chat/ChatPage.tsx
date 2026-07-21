import { useState } from 'react'
import { ActionButton } from '../../components/base/ActionButton'
import { describeResponse } from '../../shared/format-error'

export function ChatPage(): React.JSX.Element {
  const [result, setResult] = useState('尚未发送测试消息')

  async function testCore(): Promise<void> {
    const response = await window.aimaid.core.invoke?.({ type: 'mock.echo', payload: { message: 'ChatWindow capability check' } })
    if (response !== undefined) setResult(describeResponse(response))
  }

  return (
    <main className="shell compact">
      <p className="eyebrow">ChatWindow · 骨架</p>
      <h1>聊天窗口边界</h1>
      <p>正式聊天页面尚未迁移；这里只验证该窗口可调用受限 Core API。</p>
      <div className="actions">
        <ActionButton onClick={() => void testCore()}>验证 Core</ActionButton>
        <ActionButton onClick={() => void window.aimaid.window.hide?.()}>隐藏窗口</ActionButton>
      </div>
      <pre>{result}</pre>
    </main>
  )
}
