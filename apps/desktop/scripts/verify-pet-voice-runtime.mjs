import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20900 + Math.floor(Math.random() * 200)
const appRoot = join(process.env.APPDATA, '@aimaid', 'desktop')
const executable = resolve('release/win-unpacked/AIMaid.exe')
const outputDirectory = resolve('artifacts/pet-voice-runtime')
await mkdir(outputDirectory, { recursive: true })

const app = spawn(executable, [`--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: resolve('../..', 'data'),
    AIMAID_CONFIG_ROOT: join(appRoot, 'config'),
    AIMAID_CACHE_ROOT: join(appRoot, 'Cache'),
    AIMAID_LOG_ROOT: join(appRoot, 'logs')
  }
})

try {
  const target = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await waitFor(() => evaluate(client, `document.querySelector('canvas[aria-label="Live2D 桌宠模型"]') !== null`))
  await delay(4_000)

  const expectedLines = await evaluate(client, `(async () => {
    const result = {};
    for (const bodyPart of ['head', 'hair', 'face', 'chest', 'body', 'hand', 'leg', 'foot']) {
      const response = await window.aimaid.core.invoke({ type: 'pet.voice.play', payload: { triggerId: 'click', bodyPart, source: 'runtime.probe' } });
      if (response.success && response.payload?.matched === true) result[bodyPart] = response.payload.text;
    }
    return result;
  })()`)
  if (Object.keys(expectedLines).length !== 8) throw new Error(`Expected 8 click cache entries, got ${JSON.stringify(expectedLines)}`)

  const point = await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas[aria-label="Live2D 桌宠模型"]');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })

  let bubbleText = ''
  await waitFor(async () => {
    bubbleText = await evaluate(client, `document.querySelector('.ui-pet-bubble')?.textContent?.trim() ?? ''`)
    return Object.values(expectedLines).includes(bubbleText)
  }, 200)
  await delay(300)
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const screenshotPath = resolve(outputDirectory, 'click-voice.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const proof = {
    presentationMode: 'live2d',
    cacheEntryCount: Object.keys(expectedLines).length,
    clickPoint: point,
    bubbleText,
    matchedBodyPart: Object.entries(expectedLines).find(([, text]) => text === bubbleText)?.[0] ?? null,
    screenshot: screenshotPath
  }
  await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof, null, 2))
  client.close()
} finally {
  app.kill()
  await delay(500)
}

async function waitForTarget(predicate) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target !== undefined) return target
    } catch { /* Electron is still starting. */ }
    await delay(100)
  }
  throw new Error('Timed out waiting for the pet window')
}

async function waitFor(predicate, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for pet voice runtime state')
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
