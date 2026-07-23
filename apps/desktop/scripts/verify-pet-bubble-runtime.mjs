import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20600 + Math.floor(Math.random() * 200)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/pet-bubble-runtime')
const profile = resolve(`artifacts/.pet-bubble-runtime-${Date.now()}`)
const configRoot = resolve(profile, 'config')
const dataRoot = process.env.AIMAID_RUNTIME_DATA_ROOT ?? resolve(profile, 'data')
await mkdir(outputDirectory, { recursive: true })
await mkdir(configRoot, { recursive: true })
await writeFile(resolve(configRoot, 'pet-presentation.json'), JSON.stringify({
  mode: 'live2d', paused: false, live2dRole: '符玄'
}, null, 2))

const app = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore', windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: dataRoot,
    AIMAID_CONFIG_ROOT: configRoot,
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: resolve(profile, 'logs')
  }
})

try {
  const target = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await waitFor(() => evaluate(client, `document.querySelector('canvas[aria-label="Live2D 桌宠模型"]') !== null`))
  await showBubble(client, 'speech', '气泡位置、尾角与语音保持运行态验证。')
  await waitFor(() => evaluate(client, `document.querySelector('.ui-pet-bubble[data-alpha-anchored]') !== null`))
  await delay(500)
  const before = await measureAnchor(client)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.hit.x, y: before.hit.y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.hit.x, y: before.hit.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.hit.x + 120, y: before.hit.y + 48, button: 'left', buttons: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.hit.x + 120, y: before.hit.y + 48, button: 'left', buttons: 0, clickCount: 1 })
  await delay(700)
  const after = await measureAnchor(client)
  const alphaDelta = { x: after.alphaTop.x - before.alphaTop.x, y: after.alphaTop.y - before.alphaTop.y }
  const tailDelta = { x: after.tailTip.x - before.tailTip.x, y: after.tailTip.y - before.tailTip.y }
  if (Math.abs(alphaDelta.x - tailDelta.x) > 6 || Math.abs(alphaDelta.y - tailDelta.y) > 6)
    throw new Error(`Bubble did not follow the Live2D alpha anchor: ${JSON.stringify({ before, after, alphaDelta, tailDelta })}`)
  if (Math.abs(after.alphaTop.x - after.tailTip.x) > 6 || Math.abs(after.alphaTop.y - after.tailTip.y - 5) > 6)
    throw new Error(`Bubble tail is detached from the Live2D alpha top: ${JSON.stringify({ before, after })}`)

  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, after.bubble.x - 20),
      y: Math.max(0, after.bubble.y - 20),
      width: after.bubble.width + 40,
      height: after.bubble.height + 70,
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

  const proof = { before, after, alphaDelta, tailDelta, visibleWhileHeld, hiddenAfterRelease }
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

async function measureAnchor(client) {
  return evaluate(client, `(() => {
    const bubble = document.querySelector('.ui-pet-bubble');
    if (!(bubble instanceof HTMLElement)) throw new Error('Live2D bubble is missing');
    const alphaTopX = Number(bubble.dataset.alphaAnchorX);
    const alphaTopY = Number(bubble.dataset.alphaAnchorY);
    const hitX = Number(bubble.dataset.alphaHitX);
    const hitY = Number(bubble.dataset.alphaHitY);
    if (![alphaTopX, alphaTopY, hitX, hitY].every(Number.isFinite)) throw new Error('Live2D alpha diagnostics are missing');
    const bubbleRect = bubble.getBoundingClientRect();
    const tail = getComputedStyle(bubble, '::before');
    return {
      alphaTop: { x: alphaTopX, y: alphaTopY },
      hit: { x: hitX, y: hitY },
      bubble: { x: bubbleRect.x, y: bubbleRect.y, width: bubbleRect.width, height: bubbleRect.height },
      tailTip: { x: bubbleRect.x + parseFloat(tail.left), y: bubbleRect.bottom + Math.abs(parseFloat(tail.bottom)) }
    };
  })()`)
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
