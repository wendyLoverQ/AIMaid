import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20400 + Math.floor(Math.random() * 200)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/pet-item-chat-position')
const profile = resolve(`artifacts/.pet-item-chat-position-${Date.now()}`)
const logPath = resolve(profile, 'logs/aimaid-desktop.jsonl')
await mkdir(outputDirectory, { recursive: true })

const app = spawn(electronPath, ['.', '--headless', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
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
  const petTarget = await waitForTarget((target) => target.url.includes('window=pet'))
  const pet = await connect(petTarget.webSocketDebuggerUrl)
  await waitFor(() => evaluate(pet, `document.querySelector('.ui-pet-item') !== null`))
  await delay(500)
  const itemRelativeBounds = await evaluate(pet, `(() => {
    const rect = document.querySelector('.ui-pet-item').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`)
  await evaluate(pet, `window.aimaid.window.open('chat')`)
  const chatTarget = await waitForTarget((target) => target.url.includes('window=chat'))
  const chat = await connect(chatTarget.webSocketDebuggerUrl)
  await waitFor(() => evaluate(chat, `document.querySelector('textarea') !== null`))
  const records = await waitForPositioningRecords()
  const petWindowBounds = records.item.data.petWindowBounds
  const itemBounds = records.item.data.itemAbsoluteBounds
  const expectedItemBounds = {
    x: petWindowBounds.x + itemRelativeBounds.x,
    y: petWindowBounds.y + itemRelativeBounds.y,
    width: itemRelativeBounds.width,
    height: itemRelativeBounds.height
  }
  const chatBounds = records.chat.data.windowBounds
  const itemCenter = center(itemBounds)
  const chatCenter = center(chatBounds)
  const delta = { x: Math.abs(itemCenter.x - chatCenter.x), y: Math.abs(itemCenter.y - chatCenter.y) }
  const proof = { petWindowBounds, itemRelativeBounds, expectedItemBounds, itemBounds, itemCenter, chatBounds, chatCenter, delta }
  await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  if (JSON.stringify(itemBounds) !== JSON.stringify(expectedItemBounds)) {
    throw new Error(`Reported item bounds are not absolute: ${JSON.stringify(proof)}`)
  }
  if (delta.x > 1.5 || delta.y > 1.5) throw new Error(`Item/chat centers do not match: ${JSON.stringify(proof)}`)
  console.log(JSON.stringify(proof, null, 2))
  pet.close()
  chat.close()
} finally {
  app.kill()
  await delay(300)
}

function center(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

async function waitForPositioningRecords() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const records = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      const item = records.findLast((record) => record.scope === 'window-positioning' && record.message === 'Pet item bounds reported')
      const chat = records.findLast((record) => record.scope === 'window-positioning' && record.message === 'Pet-owned window positioned' && record.data?.kind === 'chat')
      if (item !== undefined && chat !== undefined) return { item, chat }
    } catch { /* The log is not ready yet. */ }
    await delay(100)
  }
  throw new Error('Timed out waiting for actual window positioning records')
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
  throw new Error(`Timed out waiting for Electron target: ${JSON.stringify(lastTargets)}`)
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
