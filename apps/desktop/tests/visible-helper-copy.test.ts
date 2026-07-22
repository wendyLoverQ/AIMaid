import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(import.meta.dirname, '..')

function filesUnder(path: string): string[] {
  return readdirSync(resolve(desktopRoot, path), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${path}/${entry.name}`
    return entry.isDirectory() ? filesUnder(relative) : entry.name.endsWith('.tsx') ? [relative] : []
  })
}

describe('visible helper copy', () => {
  it('keeps business pages free of instructional labels and placeholders', () => {
    const files = [
      ...filesUnder('src/renderer/pages'),
      ...filesUnder('src/renderer/features')
    ]
    const banned = [
      /\bsubtitle=/u,
      /\bplaceholder=/u,
      /\bhint=/u,
      /<Keycap\b/u,
      /快捷命令|输入对话、提醒|按 Enter|Enter 发送|回车添加|继续对话|TTS 试听/u
    ]

    for (const file of files) {
      const source = readFileSync(resolve(desktopRoot, file), 'utf8')
      for (const pattern of banned) expect(source, `${file} contains ${pattern}`).not.toMatch(pattern)
    }
  })
})
