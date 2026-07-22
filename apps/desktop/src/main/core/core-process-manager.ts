import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type { CoreHandshake, CoreProcessState, CoreStatus } from '../../shared/core'
import type { Logger } from '../logging/logger'

export interface CoreLaunchSpec {
  command: string
  args: string[]
  workingDirectory: string
  environment: NodeJS.ProcessEnv
}

export class CoreProcessManager extends EventEmitter {
  private state: CoreProcessState = 'stopped'
  private child: ChildProcessWithoutNullStreams | undefined
  private startedAt: number | undefined
  private lastError: string | undefined
  private handshake: CoreHandshake | undefined
  private expectedExit = false

  constructor(
    private readonly launchSpec: CoreLaunchSpec,
    private readonly log: Logger,
    private readonly startTimeoutMs = 10_000,
    private readonly stopTimeoutMs = 5_000
  ) {
    super()
  }

  get status(): CoreStatus {
    const status: CoreStatus = { state: this.state, implementation: 'real' }
    if (this.startedAt !== undefined) status.startedAt = this.startedAt
    if (this.lastError !== undefined) status.lastError = this.lastError
    if (this.handshake !== undefined) {
      status.coreVersion = this.handshake.coreVersion
      status.protocolVersion = this.handshake.protocolVersion
      status.capabilities = [...this.handshake.capabilities]
    }
    if (this.child?.pid !== undefined) status.processId = this.child.pid
    return status
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'exited' && this.state !== 'failed') return
    const startRequestedAt = performance.now()
    this.setState('starting')
    this.expectedExit = false
    this.handshake = undefined
    this.lastError = undefined
    this.log.info('core-process', 'Core process launch started', {
      workingDirectory: this.launchSpec.workingDirectory,
      startTimeoutMs: this.startTimeoutMs
    })

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.launchSpec.command, this.launchSpec.args, {
        cwd: this.launchSpec.workingDirectory,
        env: this.launchSpec.environment,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`Core start timed out after ${this.startTimeoutMs}ms`))
      }, this.startTimeoutMs)
      child.once('spawn', () => {
        clearTimeout(timer)
        this.startedAt = Date.now()
        this.installProcessRouting(child)
        this.setState('handshaking')
        this.log.info('core-process', 'Core process spawned', {
          processId: child.pid ?? -1,
          durationMs: elapsedMs(startRequestedAt)
        })
        resolve()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.lastError = error.message
        this.setState('failed')
        this.log.error('core-process', 'Core process launch failed', error, { durationMs: elapsedMs(startRequestedAt) })
        reject(error)
      })
    })
  }

  markReady(handshake: CoreHandshake): void {
    if (this.state !== 'handshaking') throw new Error('Core cannot become ready before process handshake')
    this.handshake = handshake
    this.setState('ready')
    this.log.info('core-process', 'Core process ready', {
      processId: this.child?.pid ?? -1,
      coreVersion: handshake.coreVersion,
      protocolVersion: handshake.protocolVersion,
      capabilitiesCount: handshake.capabilities.length,
      startupDurationMs: this.startedAt === undefined ? undefined : Date.now() - this.startedAt
    })
  }

  expectExit(): void {
    this.expectedExit = true
  }

  writeLine(line: string): void {
    if (this.child === undefined || this.child.stdin.destroyed || (this.state !== 'handshaking' && this.state !== 'ready')) {
      throw new Error('Core stdin is unavailable')
    }
    this.child.stdin.write(`${line}\n`, 'utf8')
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) {
      this.setState('stopped')
      return
    }
    this.expectedExit = true
    this.setState('stopping')
    const exited = await waitForExit(child, this.stopTimeoutMs)
    if (!exited && child.exitCode === null) {
      this.log.warn('core-process', 'Graceful stop timed out; terminating Core', { processId: child.pid ?? -1 })
      child.kill()
      await waitForExit(child, 2_000)
    }
    this.child = undefined
    this.startedAt = undefined
    this.handshake = undefined
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  health(): boolean {
    return this.state === 'ready' && this.child !== undefined && this.child.exitCode === null
  }

  private installProcessRouting(child: ChildProcessWithoutNullStreams): void {
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity })
    stdout.on('line', (line) => this.emit('line', line))
    stderr.on('line', (line) => {
      const record = parseStructuredCoreLog(line)
      if (record === undefined) this.log.warn('core-stderr', 'Unstructured Core stderr', { line })
      else this.log.info('core-stderr', readCoreLogMessage(record), record)
      this.emit('stderr', line)
    })
    child.once('exit', (code, signal) => {
      stdout.close()
      stderr.close()
      const uptimeMs = this.startedAt === undefined ? undefined : Date.now() - this.startedAt
      this.child = undefined
      this.startedAt = undefined
      this.handshake = undefined
      if (this.expectedExit) this.setState('stopped')
      else {
        this.lastError = `Core exited unexpectedly (code=${String(code)}, signal=${String(signal)})`
        this.setState(code === 0 ? 'exited' : 'failed')
      }
      this.log.info('core-process', 'Core process exited', {
        processId: child.pid ?? -1,
        code,
        signal,
        expected: this.expectedExit,
        uptimeMs
      })
      this.emit('exit', { code, signal, expected: this.expectedExit })
    })
  }

  private setState(state: CoreProcessState): void {
    const previousState = this.state
    this.state = state
    this.log.info('core-process', 'Core process state changed', { previousState, state, processId: this.child?.pid ?? null })
    this.emit('status', this.status)
  }
}

function parseStructuredCoreLog(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function readCoreLogMessage(record: Record<string, unknown>): string {
  if (typeof record.message === 'string') return record.message
  if (typeof record.eventName === 'string') return record.eventName
  return 'Core log'
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}
