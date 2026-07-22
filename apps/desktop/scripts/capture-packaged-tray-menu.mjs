import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 9334
const outputDirectory = resolve('artifacts/tray-menu')
await mkdir(outputDirectory, { recursive: true })
const developmentElectronPath = process.env.AIMAID_CAPTURE_ELECTRON_PATH
const executablePath = developmentElectronPath ?? resolve('release/win-unpacked/AIMaid.exe')
const executableArguments = developmentElectronPath === undefined
  ? [`--remote-debugging-port=${port}`]
  : [resolve('.'), `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(`artifacts/.capture-tray-${Date.now()}`)}`]
const app = spawn(executablePath, executableArguments, { stdio: 'ignore', windowsHide: true })

try {
  const initialClient = await connect((await waitForTarget(() => true)).webSocketDebuggerUrl)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(initialClient, "typeof window.aimaid?.window?.open === 'function'")) break
    await delay(50)
    if (attempt === 99) throw new Error('Electron preload API did not become ready')
  }
  await evaluate(initialClient, "window.aimaid.window.open('tray-menu')")
  initialClient.close()

  const client = await connect((await waitForTarget((target) => target.url.includes('tray-menu'))).webSocketDebuggerUrl)
  await client.send('Page.enable')
  const metrics = await evaluate(client, `(() => {
    const menu = document.querySelector('.tray-menu-shell');
    const buttons = [...menu.querySelectorAll(':scope > .ui-button')];
    const rect = menu.getBoundingClientRect();
    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
    const childRects = [...menu.children].map((child) => child.getBoundingClientRect());
    const rangeRect = document.querySelector('.ui-range__control')?.getBoundingClientRect();
    const rangeContainer = document.querySelector('.ui-range__control')?.closest('.ui-container');
    let nextAction = rangeContainer?.nextElementSibling;
    while (nextAction !== null && nextAction !== undefined && !nextAction.classList.contains('ui-button')) nextAction = nextAction.nextElementSibling;
    const nextActionRect = nextAction?.getBoundingClientRect();
    const thumbSize = Number.parseFloat(getComputedStyle(menu).getPropertyValue('--space-4'));
    const paintedRangeBottom = rangeRect === undefined ? undefined : rangeRect.top + rangeRect.height / 2 + thumbSize / 2;
    const gaps = childRects.slice(1).map((item, index) => Math.max(0, item.top - childRects[index].bottom));
    const contentBottom = Math.max(...childRects.map((item) => item.bottom)) - rect.top;
    return {
      width: Math.round(rect.width), height: Math.round(rect.height),
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight,
      buttonCount: buttons.length,
      buttonFontSize: getComputedStyle(buttons[0]).fontSize,
      buttonWidths: buttonRects.map((item) => Math.round(item.width)),
      maxItemGap: Math.round(Math.max(0, ...gaps)),
      blankBottom: Math.round(rect.height - contentBottom),
      hasRange: rangeRect !== undefined,
      rangeActionClearance: paintedRangeBottom === undefined || nextActionRect === undefined ? null : Math.round(nextActionRect.top - paintedRangeBottom)
    };
  })()`)
  const failures = []
  if (metrics.buttonCount !== 6) failures.push(`expected 6 direct actions, got ${metrics.buttonCount}`)
  if (!metrics.hasRange) failures.push('master volume range is missing')
  if (metrics.rangeActionClearance !== null && metrics.rangeActionClearance < 4) failures.push(`master volume range clearance is too small: ${metrics.rangeActionClearance}px`)
  if (metrics.scrollHeight > metrics.clientHeight) failures.push('tray menu content is clipped')
  if (metrics.maxItemGap > 12) failures.push(`tray item gap is too large: ${metrics.maxItemGap}px`)
  if (metrics.blankBottom > 24) failures.push(`tray menu has too much empty space: ${metrics.blankBottom}px`)
  if (metrics.buttonWidths.some((width) => width < metrics.width - 24)) failures.push('tray actions are not full width')
  if (Number.parseFloat(metrics.buttonFontSize) > 14) failures.push(`tray action font is too large: ${metrics.buttonFontSize}`)
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, '01-menu.png'), Buffer.from(shot.data, 'base64'))
  await writeFile(resolve(outputDirectory, 'metrics.json'), `${JSON.stringify({ ...metrics, failures }, null, 2)}\n`)
  client.close()
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify(metrics, null, 2))
} finally {
  app.kill()
}

async function waitForTarget(predicate) {
  let lastTargets = []
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      lastTargets = targets
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target !== undefined) return target
    } catch { /* App is still starting. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for Electron renderer target: ${JSON.stringify(lastTargets.map(({ title, type, url }) => ({ title, type, url })))}`)
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
