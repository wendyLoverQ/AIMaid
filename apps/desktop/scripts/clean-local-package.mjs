import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const localPackage = resolve('release', 'win-unpacked')
await rm(localPackage, { recursive: true, force: true })
process.stdout.write(`Removed local package directory: ${localPackage}\n`)
