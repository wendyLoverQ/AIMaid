import { useEffect, useState } from 'react'
import type { CoreStatus } from '../../../shared/core'
import type { IpcEventEnvelope } from '../../../shared/ipc'
import type { WindowKind } from '../../../shared/windows'
import { ActionButton } from '../../components/base/ActionButton'
import { StatusPill } from '../../components/base/StatusPill'
import { describeResponse } from '../../shared/format-error'

export function MainPage(): React.JSX.Element {
  const [status, setStatus] = useState<CoreStatus | null>(null)
  const [output, setOutput] = useState('等待测试…')
  const [events, setEvents] = useState<IpcEventEnvelope[]>([])

  useEffect(() => {
    const unsubscribe = window.aimaid.core.subscribe?.((event) => {
      setEvents((current) => [event, ...current].slice(0, 6))
      if (event.type === 'core.status-changed') setStatus(event.payload as CoreStatus)
    })
    void refreshStatus()
    return unsubscribe
  }, [])

  async function refreshStatus(): Promise<void> {
    const response = await window.aimaid.core.status?.()
    if (response?.success === true && response.payload !== null) setStatus(response.payload)
    else if (response !== undefined) setOutput(describeResponse(response))
  }

  async function invokeEcho(): Promise<void> {
    const response = await window.aimaid.core.invoke?.({ type: 'mock.echo', payload: { message: 'Renderer → Preload → Main → Mock Core' } })
    if (response !== undefined) setOutput(describeResponse(response))
  }

  async function openWindow(target: WindowKind): Promise<void> {
    const response = await window.aimaid.window.open?.(target)
    if (response !== undefined) setOutput(describeResponse(response))
  }

  async function chooseFile(): Promise<void> {
    const response = await window.aimaid.dialog?.openFile([{ name: '文本', extensions: ['txt', 'md'] }])
    if (response !== undefined) setOutput(describeResponse(response))
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AIMaid Electron · Phase 1</p>
          <h1>桌面端架构骨架</h1>
          <p>当前页面只验证进程边界、窗口管理和 Mock Core 链路，不承载正式业务。</p>
        </div>
        <StatusPill status={status?.state ?? 'unknown'} />
      </header>

      <section className="panel">
        <h2>多窗口注册表</h2>
        <div className="actions">
          <ActionButton onClick={() => void openWindow('pet')}>打开 PetWindow</ActionButton>
          <ActionButton onClick={() => void openWindow('chat')}>打开 ChatWindow</ActionButton>
          <ActionButton onClick={() => void openWindow('settings')}>打开 SettingsWindow</ActionButton>
        </div>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>安全桥验证</h2>
          <div className="actions">
            <ActionButton onClick={() => void invokeEcho()}>调用 Mock Core</ActionButton>
            <ActionButton onClick={() => void refreshStatus()}>刷新状态</ActionButton>
            <ActionButton onClick={() => void chooseFile()}>受限文件选择</ActionButton>
          </div>
          <pre>{output}</pre>
        </article>
        <article className="panel">
          <h2>事件订阅</h2>
          {events.length === 0 ? <p className="muted">暂无事件</p> : null}
          <ol className="event-list">
            {events.map((event) => (
              <li key={event.requestId}>
                <strong>{event.type}</strong>
                <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
        </article>
      </section>
    </main>
  )
}
