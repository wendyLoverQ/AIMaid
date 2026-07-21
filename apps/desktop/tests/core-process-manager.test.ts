import { describe, expect, it } from 'vitest'
import { CoreProcessManager, MockCoreProcessAdapter } from '../src/main/core/core-process-manager'
import type { Logger } from '../src/main/logging/logger'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

describe('CoreProcessManager', () => {
  it('runs a single start/health/stop lifecycle', async () => {
    const manager = new CoreProcessManager(new MockCoreProcessAdapter(), silentLogger)
    await manager.start()
    await manager.start()

    expect(manager.status.state).toBe('running')
    expect(await manager.health()).toBe(true)

    await manager.stop()
    expect(manager.status.state).toBe('stopped')
  })
})
