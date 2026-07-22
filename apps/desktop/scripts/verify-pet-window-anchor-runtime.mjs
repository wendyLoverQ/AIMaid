import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20500 + Math.floor(Math.random() * 100)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/pet-window-anchor-runtime')
const profile = resolve(`artifacts/.pet-window-anchor-${Date.now()}`)
const logPath = resolve(profile, 'logs/aimaid-desktop.jsonl')
await mkdir(outputDirectory, { recursive: true })

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

let petClient
let statusClient
try {
  const petTarget = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  petClient = await connect(petTarget.webSocketDebuggerUrl)
  await waitFor(() => evaluate(petClient, `(() => {
    const item = document.querySelector('.ui-pet-item');
    if (!(item instanceof HTMLElement) || window.aimaid?.window?.open === undefined) return false;
    const bounds = item.getBoundingClientRect();
    return window.innerWidth > bounds.width && window.innerHeight > bounds.height;
  })()`))
  const opened = await evaluate(petClient, `window.aimaid.window.open('status')`)
  if (!opened.success) throw new Error(`Status open failed: ${JSON.stringify(opened.error)}`)

  const statusTarget = await waitForTarget((candidate) => candidate.url.includes('window=status'))
  statusClient = await connect(statusTarget.webSocketDebuggerUrl)
  await waitFor(() => evaluate(statusClient, 'document.readyState === "complete"'))
  await waitForLog(logPath, 'Window centered on PET item for first open')
  const reopened = await evaluate(petClient, `window.aimaid.window.open('status')`)
  if (!reopened.success) throw new Error(`Status reopen failed: ${JSON.stringify(reopened.error)}`)
  await delay(250)
  const records = await readRecords(logPath)
  const anchorRecord = records.findLast((record) => record.message === 'PET item anchor resolved for first window placement')
  const positionRecord = records.findLast((record) => record.message === 'Window centered on PET item for first open' && record.data?.kind === 'status')
  if (anchorRecord === undefined || positionRecord === undefined) throw new Error('Missing PET anchor runtime evidence')

  const petBounds = positionRecord.data.petBounds
  const windowBounds = positionRecord.data.bounds
  const petCenter = { x: petBounds.x + petBounds.width / 2, y: petBounds.y + petBounds.height / 2 }
  const windowCenter = { x: windowBounds.x + windowBounds.width / 2, y: windowBounds.y + windowBounds.height / 2 }
  const centerDelta = { x: Math.abs(petCenter.x - windowCenter.x), y: Math.abs(petCenter.y - windowCenter.y) }
  if (centerDelta.x > 1 || centerDelta.y > 1) throw new Error(`First-open window was not centered: ${JSON.stringify({ petBounds, windowBounds, centerDelta })}`)

  const proof = {
    physicalPetBounds: anchorRecord.data.physicalBounds,
    dipPetBounds: petBounds,
    firstWindowBounds: windowBounds,
    centerDelta,
    win32MappedOnce: records.filter((record) => record.message === 'PET item anchor resolved for first window placement').length === 1
  }
  if (!proof.win32MappedOnce) throw new Error('Win32 PET mapping did not run exactly once')
  await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof, null, 2))
} finally {
  statusClient?.close()
  petClient?.close()
  app.kill()
  await delay(300)
}

async function readRecords(path) {
  const text = await readFile(path, 'utf8')
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
}

async function waitForLog(path, message) {
  await waitFor(async () => {
    try { return (await readFile(path, 'utf8')).includes(message) } catch { return false }
  })
}

async function waitForTarget(predicate) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target !== undefined) return target
    } catch { /* Electron is still starting. */ }
    await delay(100)
  }
  throw new Error('Timed out waiting for Electron window')
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for PET window anchor proof')
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

async function evaluate(target, expression) {
  const result = await target.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
