import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 19900 + Math.floor(Math.random() * 80)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/pet-coordinates')
const profile = resolve(`artifacts/.pet-coordinates-${Date.now()}`)
const outputPath = resolve(outputDirectory, 'latest.json')

await mkdir(outputDirectory, { recursive: true })
await mkdir(profile, { recursive: true })

const app = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: resolve(profile, 'data'),
    AIMAID_CONFIG_ROOT: resolve(profile, 'config'),
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: resolve(profile, 'logs')
  }
})

try {
  const target = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  const snapshot = await waitForSnapshot(client)
  client.close()
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(JSON.stringify(snapshot, null, 2))
  console.log(`\nSaved: ${outputPath}`)
} finally {
  app.kill()
  await delay(300)
}

async function waitForSnapshot(client) {
  let lastError = 'PET element is not ready'
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const result = await evaluate(client, `(async () => {
        const item = document.querySelector('.ui-pet-item');
        if (!(item instanceof HTMLElement) || window.aimaid.pet === undefined) return null;
        const rect = item.getBoundingClientRect();
        const response = await window.aimaid.pet.captureCoordinates({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        if (!response.success || response.payload === null) throw new Error(response.error?.message ?? 'Coordinate capture failed');
        return {
          ...response.payload,
          renderer: {
            localBounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            devicePixelRatio: window.devicePixelRatio
          }
        };
      })()`)
      if (
        result !== null &&
        result.windowDipBounds.width > result.itemDipBounds.width &&
        result.windowDipBounds.height > result.itemDipBounds.height
      ) return result
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(`Timed out capturing PET coordinates: ${lastError}`)
}

async function waitForTarget(predicate) {
  let lastTargets = []
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      lastTargets = targets
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target !== undefined) return target
    } catch { /* Electron is still starting. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for Electron PET target: ${JSON.stringify(lastTargets)}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const handler = pending.get(message.id)
    if (handler === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) handler.reject(new Error(message.error.message))
    else handler.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolveSend, reject) => pending.set(id, { resolve: resolveSend, reject }))
    },
    close() { socket.close() }
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
