import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('global hotkey window behavior', () => {
  it('toggles target windows instead of opening them repeatedly', () => {
    const service = readFileSync(new URL('../src/main/services/system-settings-service.ts', import.meta.url), 'utf8')
    expect(service).toContain('this.windows.toggle(definition.target')
    expect(service).not.toContain('this.windows.open(definition.target')
  })

  it('does not enumerate presentation assets before opening a target window', () => {
    const service = readFileSync(new URL('../src/main/services/system-settings-service.ts', import.meta.url), 'utf8')
    const targetWindowBranch = service.slice(
      service.indexOf("if ('target' in definition"),
      service.indexOf("const parent = this.windows.get('pet')")
    )

    expect(targetWindowBranch).not.toContain('this.presentation.snapshot()')
  })
})
