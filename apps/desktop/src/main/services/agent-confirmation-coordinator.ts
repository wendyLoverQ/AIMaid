import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { CoreRequest } from '../../shared/core'
import type { AgentConfirmationRequest } from '../../shared/business'
import type { CoreClient } from '../core/core-client'
import { CoreClientError, CoreRemoteError } from '../core/stdio-core-client'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'

interface PendingConfirmation {
  challenge: AgentConfirmationRequest
  payload: Extract<CoreRequest, { type: 'agent.execute' }>['payload']
  signal: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
  settled: boolean
}

export class AgentConfirmationCoordinator {
  private readonly queue: PendingConfirmation[] = []
  private readonly attachedWindows = new WeakSet<BrowserWindow>()
  private active: PendingConfirmation | undefined

  constructor(
    private readonly windows: WindowManager,
    private readonly core: CoreClient,
    private readonly log: Logger
  ) {}

  async execute(payload: Extract<CoreRequest, { type: 'agent.execute' }>['payload'], signal: AbortSignal): Promise<unknown> {
    try {
      return await this.core.invoke(randomUUID(), { type: 'agent.execute', payload }, signal)
    } catch (error) {
      if (!(error instanceof CoreRemoteError) || error.code !== 'agent.approval_required') throw error
      const challenge = readChallenge(error.details)
      return this.enqueue(challenge, payload, signal)
    }
  }

  current(): AgentConfirmationRequest | null { return this.active?.challenge ?? null }

  resolveCurrent(requestId: string, approved: boolean): boolean {
    const pending = this.active
    if (pending === undefined || pending.challenge.requestId !== requestId || pending.settled) return false
    if (!approved) {
      this.finish(pending, new CoreClientError('AGENT_APPROVAL_REJECTED', '用户已取消能力执行。'))
      return true
    }
    pending.settled = true
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.active = undefined
    this.windows.hide('agent-confirm')
    void this.core.invoke(randomUUID(), {
      type: 'agent.execute',
      payload: { ...pending.payload, approvalToken: pending.challenge.requestId }
    }, pending.signal).then(pending.resolve, pending.reject).finally(() => this.pump())
    return true
  }

  cancelAll(message = 'Agent 确认请求已取消。'): void {
    const error = new CoreClientError('AGENT_APPROVAL_CANCELLED', message)
    const pending = [...(this.active === undefined ? [] : [this.active]), ...this.queue.splice(0)]
    this.active = undefined
    this.windows.hide('agent-confirm')
    for (const item of pending) this.settleQueued(item, error)
  }

  private enqueue(challenge: AgentConfirmationRequest, payload: PendingConfirmation['payload'], signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const pending = {} as PendingConfirmation
      const onAbort = (): void => this.cancel(pending, new CoreClientError('REQUEST_CANCELLED', '调用方已取消 Agent 执行。'))
      Object.assign(pending, {
        challenge, payload, signal, resolve, reject, settled: false,
        timer: setTimeout(() => this.cancel(pending, new CoreClientError('AGENT_APPROVAL_TIMEOUT', 'Agent 确认已超时。')), 120_000),
        removeAbort: () => signal.removeEventListener('abort', onAbort)
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(pending)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active !== undefined) return
    const pending = this.queue.shift()
    if (pending === undefined) return
    if (pending.signal.aborted) { this.settleQueued(pending, new CoreClientError('REQUEST_CANCELLED', '调用方已取消 Agent 执行。')); this.pump(); return }
    this.active = pending
    const window = this.windows.open('agent-confirm')
    if (!this.attachedWindows.has(window)) {
      this.attachedWindows.add(window)
      window.on('hide', () => {
        const current = this.active
        if (current !== undefined && window === this.windows.get('agent-confirm'))
          this.finish(current, new CoreClientError('AGENT_APPROVAL_REJECTED', '用户已关闭确认窗口。'))
      })
      window.on('closed', () => {
        const current = this.active
        if (current !== undefined) this.finish(current, new CoreClientError('AGENT_APPROVAL_REJECTED', '用户已关闭确认窗口。'))
      })
    }
    window.show()
    window.focus()
  }

  private cancel(pending: PendingConfirmation, error: Error): void {
    if (pending.settled) return
    if (this.active === pending) this.finish(pending, error)
    else {
      const index = this.queue.indexOf(pending)
      if (index >= 0) this.queue.splice(index, 1)
      this.settleQueued(pending, error)
    }
  }

  private finish(pending: PendingConfirmation, error: Error): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    pending.removeAbort()
    if (this.active === pending) this.active = undefined
    this.windows.hide('agent-confirm')
    pending.reject(error)
    this.log.info('agent-confirmation', 'Agent confirmation completed without execution', { requestId: pending.challenge.requestId, code: error instanceof CoreClientError ? error.code : 'ERROR' })
    this.pump()
  }

  private settleQueued(pending: PendingConfirmation, error: Error): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    pending.removeAbort()
    pending.reject(error)
  }
}

function readChallenge(details: Record<string, unknown>): AgentConfirmationRequest {
  const read = (key: string): string => typeof details[key] === 'string' ? details[key] : ''
  const approvalToken = read('approvalToken')
  const capabilityName = read('capabilityName')
  if (approvalToken === '' || capabilityName === '') throw new CoreClientError('AGENT_APPROVAL_INVALID', 'Core 返回的 Agent 确认请求不完整。')
  return {
    requestId: approvalToken,
    capabilityName,
    displayName: read('displayName'),
    summary: read('description'),
    executorType: read('executorType'),
    riskLevel: read('riskLevel'),
    argsJson: read('argsJson')
  }
}
