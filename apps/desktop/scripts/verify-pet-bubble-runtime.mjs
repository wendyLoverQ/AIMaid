import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20600 + Math.floor(Math.random() * 200)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/pet-bubble-runtime')
const profile = resolve(`artifacts/.pet-bubble-runtime-${Date.now()}`)
await mkdir(outputDirectory, { recursive: true })

const app = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore', windowsHide: true,
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
  await client.send('Page.enable')
  await waitFor(() => evaluate(client, `document.querySelector('.ui-pet-item') !== null`))
  await showBubble(client, 'speech', '气泡位置、尾角与语音保持运行态验证。')
  await waitFor(() => evaluate(client, `document.querySelector('.ui-pet-bubble') !== null`))
  await delay(350)
  const geometry = await evaluate(client, `(() => {
    const bubble = document.querySelector('.ui-pet-bubble');
    const item = document.querySelector('.ui-pet-item');
    const rect = bubble.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const tail = getComputedStyle(bubble, '::before');
    return {
      bubble: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      item: { x: itemRect.x, y: itemRect.y, width: itemRect.width, height: itemRect.height },
      tailLeft: parseFloat(tail.left),
      tailWidth: parseFloat(tail.width)
    };
  })()`)
  const tailRatio = (geometry.tailLeft + geometry.tailWidth / 2) / geometry.bubble.width
  if (Math.abs((geometry.bubble.x + geometry.bubble.width / 2) - (geometry.item.x + geometry.item.width / 2)) > 1.5)
    throw new Error(`Bubble is not centered over the pet item: ${JSON.stringify(geometry)}`)
  if (tailRatio < 0.6 || tailRatio > 0.7)
    throw new Error(`Bubble tail is outside the intended head anchor: ${JSON.stringify({ tailRatio, geometry })}`)

  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, geometry.bubble.x - 20),
      y: Math.max(0, geometry.bubble.y - 20),
      width: geometry.bubble.width + 40,
      height: geometry.bubble.height + 70,
      scale: 1
    }
  })
  await writeFile(resolve(outputDirectory, 'bubble.png'), Buffer.from(screenshot.data, 'base64'))

  await setHold(client, true)
  await delay(6_000)
  const visibleWhileHeld = await evaluate(client, `document.querySelector('.ui-pet-bubble') !== null`)
  if (!visibleWhileHeld) throw new Error('Speech bubble disappeared while active audio held it')
  await setHold(client, false)
  await delay(5_500)
  const hiddenAfterRelease = await evaluate(client, `document.querySelector('.ui-pet-bubble') === null`)
  if (!hiddenAfterRelease) throw new Error('Speech bubble did not disappear after audio release')

  const proof = { geometry, tailRatio, visibleWhileHeld, hiddenAfterRelease }
  await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof, null, 2))
  client.close()
} finally {
  app.kill()
  await delay(300)
}

async function showBubble(client, kind, text) {
  await evaluate(client, `(() => { const payload = JSON.stringify({ text: ${JSON.stringify(text)}, kind: ${JSON.stringify(kind)}, nonce: crypto.randomUUID(), createdAt: Date.now() }); window.dispatchEvent(new StorageEvent('storage', { key: 'aimaid.pet-bubble', newValue: payload })); })()`)
}

async function setHold(client, held) {
  await evaluate(client, `window.dispatchEvent(new CustomEvent('aimaid:bubble-hold', { detail: { held: ${held} } }))`)
}

async function waitForTarget(predicate) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target !== undefined) return target
    } catch { /* Electron is still starting. */ }
    await delay(100)
  }
  throw new Error('Timed out waiting for the pet window')
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for runtime state')
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
