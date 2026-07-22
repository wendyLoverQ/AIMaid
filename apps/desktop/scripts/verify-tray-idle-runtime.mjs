import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20300 + Math.floor(Math.random() * 200)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/tray-idle-runtime')
const profile = resolve(`artifacts/.tray-idle-runtime-${Date.now()}`)
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
let trayClient
try {
  const petTarget = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  petClient = await connect(petTarget.webSocketDebuggerUrl)
  await waitFor(() => evaluate(petClient, `window.aimaid?.window !== undefined`))
  await evaluate(petClient, `window.aimaid.window.open('tray-menu')`)

  const trayTarget = await waitForTarget((candidate) => candidate.url.includes('window=tray-menu'))
  trayClient = await connect(trayTarget.webSocketDebuggerUrl)
  await trayClient.send('Page.enable')
  await waitFor(() => evaluate(trayClient, `(() => {
    const surface = document.querySelector('.tray-menu-shell');
    const exit = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '退出');
    if (!(surface instanceof HTMLElement) || !(exit instanceof HTMLElement)) return false;
    return document.body.innerText.includes('当前未播放音乐') &&
      Math.abs(window.innerHeight - Math.ceil(surface.getBoundingClientRect().height)) <= 1 &&
      exit.getBoundingClientRect().bottom <= window.innerHeight;
  })()`))

  const metrics = await evaluate(trayClient, `(() => {
    const exit = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '退出');
    const bounds = exit.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      contentHeight: document.querySelector('.tray-menu-shell').getBoundingClientRect().height,
      exitBottom: bounds.bottom,
      blankAfterExit: window.innerHeight - bounds.bottom,
      musicPlayerVisible: document.querySelector('[aria-label="音乐播放器"]') !== null
    };
  })()`)
  if (Math.abs(metrics.innerHeight - Math.ceil(metrics.contentHeight)) > 1 || metrics.exitBottom > metrics.innerHeight || metrics.blankAfterExit > 16 || metrics.musicPlayerVisible) {
    throw new Error(`Idle tray did not compact correctly: ${JSON.stringify(metrics)}`)
  }

  const screenshot = await trayClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const screenshotPath = resolve(outputDirectory, 'tray-idle-compact.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const proof = { ...metrics, screenshot: screenshotPath }
  await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof, null, 2))
} finally {
  trayClient?.close()
  petClient?.close()
  app.kill()
  await delay(300)
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for compact tray state')
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
