import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 19800 + Math.floor(Math.random() * 200)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/live2d-runtime')
const profile = resolve(`artifacts/.live2d-runtime-${Date.now()}`)
const configRoot = resolve(profile, 'config')
const logRoot = resolve(profile, 'logs')
const targetActionModel = 'baimeimo_by_令吾05_671ced21afd775e7bb09387bbdb26fca'

await mkdir(outputDirectory, { recursive: true })
await mkdir(configRoot, { recursive: true })
await writeFile(resolve(configRoot, 'pet-presentation.json'), JSON.stringify({
  mode: 'live2d',
  paused: false,
  live2dRole: '符玄'
}, null, 2))

const app = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: resolve(profile, 'data'),
    AIMAID_CONFIG_ROOT: configRoot,
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: logRoot
  }
})

try {
  const target = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await waitFor(() => evaluate(client, `document.querySelector('canvas[aria-label="Live2D 桌宠模型"]') !== null`))
  await delay(2_000)
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, 'fuxuan.png'), Buffer.from(screenshot.data, 'base64'))

  const switched = await evaluate(client, `(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await window.aimaid.pet.presentation.get();
      if (state.payload?.live2dRole === ${JSON.stringify(targetActionModel)}) return true;
      await window.aimaid.pet.presentation.execute('switch-live2d-role');
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    return false;
  })()`)
  if (!switched) throw new Error('Could not switch to the action test model')
  await evaluate(client, 'location.reload()')
  await delay(2_000)
  await evaluate(client, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1' }))`)
  await evaluate(client, `window.dispatchEvent(new StorageEvent('storage', {
    key: 'aimaid.pet-bubble',
    newValue: JSON.stringify({ text: '动作验证', kind: 'speech', nonce: crypto.randomUUID(), createdAt: Date.now(), actionTag: 'touch_body' })
  }))`)
  await delay(500)
  client.close()
} finally {
  app.kill()
  await delay(300)
}

const log = await readFile(resolve(logRoot, 'aimaid-desktop.jsonl'), 'utf8')
const records = log.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
const messages = records.filter((record) => record.scope === 'pet-renderer').map((record) => String(record.message))
const fuxuanMask = messages.find((message) => message.includes('Mask stats:') && message.includes('"drawableCount":433'))
if (fuxuanMask === undefined) throw new Error('Missing Fu Xuan mask statistics')
const maskStats = JSON.parse(fuxuanMask.slice(fuxuanMask.indexOf('{')))
if (maskStats.totalMaskedDrawables <= 0 || maskStats.uniqueClipGroups <= 36 || maskStats.neededRenderTextureCount <= 1) {
  throw new Error(`Fu Xuan mask plan was not expanded: ${JSON.stringify(maskStats)}`)
}
if (!messages.some((message) => message.includes('Renderer re-initialized successfully'))) {
  throw new Error('Fu Xuan renderer did not reinitialize its mask buffers')
}
if (!messages.some((message) => message.includes('[Hotkey] Live2D model shortcut requested') && message.includes('TriggerAnimation'))) {
  throw new Error('The VTube model action shortcut did not execute')
}
if (!messages.some((message) => message.includes('[ActionTag] model action completed') && message.includes('touch_body'))) {
  throw new Error('The automatically generated body action did not execute')
}

const proof = {
  maskStats,
  rendererReinitialized: true,
  modelShortcutExecuted: true,
  generatedBodyActionExecuted: true,
  screenshot: resolve(outputDirectory, 'fuxuan.png')
}
await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
console.log(JSON.stringify(proof, null, 2))

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
  throw new Error(`Timed out waiting for Electron target: ${JSON.stringify(lastTargets)}`)
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for Live2D renderer')
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
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
