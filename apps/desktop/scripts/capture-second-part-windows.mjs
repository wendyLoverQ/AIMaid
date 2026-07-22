import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 9334
const appPath = resolve('release/win-unpacked/AIMaid.exe')
const outputDirectory = resolve('artifacts/ui-second-part')
const windows = [
  { kind: 'timer', layout: 'product', width: 460, height: 560, minWidth: 460, minHeight: 500 },
  { kind: 'bitcoin', layout: 'product', width: 1120, height: 640, minWidth: 840, minHeight: 520 },
  { kind: 'crypto-provider', layout: 'product', width: 640, height: 520, minWidth: 520, minHeight: 420 },
  { kind: 'crypto-events', layout: 'product', width: 920, height: 640, minWidth: 720, minHeight: 480 },
  { kind: 'crypto-chart', layout: 'product', width: 1120, height: 720, minWidth: 720, minHeight: 480 },
  { kind: 'video', layout: 'product', width: 1480, height: 820, minWidth: 1120, minHeight: 720 },
  { kind: 'video-player', layout: 'product', width: 720, height: 480, minWidth: 480, minHeight: 420 },
  { kind: 'video-subtitles', layout: 'product', width: 720, height: 520, minWidth: 560, minHeight: 420 },
  { kind: 'remote-video', layout: 'product', width: 1260, height: 840, minWidth: 1040, minHeight: 720 },
  { kind: 'remote-site-config', layout: 'product', width: 1100, height: 760, minWidth: 980, minHeight: 680 },
  { kind: 'douyin-login', layout: 'product', width: 1180, height: 820, minWidth: 920, minHeight: 680 },
  { kind: 'vault', layout: 'product', width: 1220, height: 760, minWidth: 980, minHeight: 620 },
  { kind: 'scripts', layout: 'product', width: 980, height: 680, minWidth: 820, minHeight: 560 },
  { kind: 'agent-confirm', layout: 'product', width: 480, height: 420 },
  { kind: 'tray-menu', layout: 'tray', width: 240, height: 308 },
  { kind: 'music-visualizer', layout: 'canvas', width: 560, height: 760 }
]

await mkdir(outputDirectory, { recursive: true })
const profile = resolve(`artifacts/.capture-second-${Date.now()}`)
const app = spawn(appPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore', windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: resolve(profile, 'data'),
    AIMAID_CONFIG_ROOT: resolve(profile, 'config'),
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: resolve(profile, 'logs')
  }
})
const report = []

try {
  const initialTarget = await waitForTarget(() => true)
  const initialClient = await connect(initialTarget.webSocketDebuggerUrl)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(initialClient, "typeof window.aimaid?.window?.open === 'function'")) break
    await delay(50)
    if (attempt === 99) throw new Error('Electron preload API did not become ready')
  }
  await delay(2_500)
  await initialClient.send('Page.enable')
  await initialClient.send('Runtime.enable')
  report.push(await capturePetState(initialClient, 'default'))
  await evaluate(initialClient, `(() => { const text = '这是桌宠气泡的分页、长文本与安全边距验收内容。'; const payload = JSON.stringify({ text }); localStorage.setItem('aimaid.pet-bubble', payload); window.dispatchEvent(new StorageEvent('storage', { key: 'aimaid.pet-bubble', newValue: payload })); return true })()`)
  await delay(250)
  report.push(await capturePetState(initialClient, 'bubble'))
  await evaluate(initialClient, `(() => { const target = document.querySelector('[data-pet-interactive], canvas, img') ?? document.body; const rect = target.getBoundingClientRect(); target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.max(24, Math.min(innerWidth - 260, rect.left + rect.width / 2)), clientY: Math.max(24, Math.min(innerHeight - 300, rect.top + rect.height / 2)) })); return true })()`)
  await delay(250)
  report.push(await capturePetState(initialClient, 'context-menu'))

  for (const windowConfig of windows) {
    const { kind } = windowConfig
    const result = await initialClient.send('Runtime.evaluate', {
      expression: `window.aimaid?.window?.open?.(${JSON.stringify(kind)})`,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
    const target = await waitForTarget((candidate) => candidate.id !== initialTarget.id && candidate.url.includes(kind))
    const client = await connect(target.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await delay(450)
    report.push(await captureState(client, windowConfig, 'default'))
    for (const scale of [1, 1.25, 1.5]) report.push(await captureDpiState(client, windowConfig, scale))
    if (windowConfig.minWidth !== undefined && windowConfig.minHeight !== undefined) {
      await evaluate(client, `window.resizeTo(${windowConfig.minWidth}, ${windowConfig.minHeight})`)
      await delay(350)
      const resized = await evaluate(client, `({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })`)
      const expectedViewport = { width: windowConfig.minWidth + 2, height: windowConfig.minHeight + 2 }
      const emulatedMinimum = Math.abs(resized.width - expectedViewport.width) > 3 || Math.abs(resized.height - expectedViewport.height) > 3
      if (emulatedMinimum) {
        await client.send('Emulation.setDeviceMetricsOverride', { ...expectedViewport, deviceScaleFactor: resized.scale, mobile: false })
        await delay(180)
      }
      report.push({ ...await captureState(client, windowConfig, 'minimum'), emulatedMinimum })
      if (emulatedMinimum) await client.send('Emulation.clearDeviceMetricsOverride')
    }
    client.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined)
    await delay(120)
  }
  initialClient.close()
  const failures = report.flatMap((item) => {
    const messages = []
    if (item.layout === 'product' && !item.hasProductPage) messages.push('missing ProductPage')
    if (item.layout === 'product' && !item.hasWorkspace) messages.push('missing ProductWorkspace')
    if (item.layout === 'tray' && !item.hasTraySurface) messages.push('missing TrayMenuSurface')
    if (item.layout === 'canvas' && !item.hasMediaCanvas) messages.push('missing MediaCanvas')
    if (item.layout === 'canvas' && !item.transparentSurface) messages.push('visualizer surface is not transparent')
    if (item.layout === 'pet' && !item.hasPetStage) messages.push('missing pet stage')
    if (item.horizontalOverflow) messages.push('horizontal overflow')
    if (item.panelsOutsideHorizontalViewport > 0) messages.push(`${item.panelsOutsideHorizontalViewport} panels outside horizontal viewport`)
    return messages.map((message) => `${item.kind}/${item.size}: ${message}`)
  })
  await writeFile(resolve(outputDirectory, 'metrics.json'), `${JSON.stringify({ windows: report, failures }, null, 2)}\n`)
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Process may already have exited. */ }
  try { execFileSync(process.execPath, [resolve('scripts/kill-packaged-app.mjs')], { stdio: 'ignore' }) } catch { /* Cleanup is best effort. */ }
}

async function capturePetState(client, size) {
  const metrics = await evaluate(client, `(() => ({
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    hasPetStage: Boolean(document.querySelector('.ui-transparent-stage, [data-display-mode]')),
    hasPetBubble: Boolean(document.querySelector('.ui-pet-bubble, [role="status"]')),
    hasContextMenu: Boolean(document.querySelector('[role="menu"]')),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
    panelsOutsideHorizontalViewport: 0
  }))()`)
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, `pet-${size}.png`), Buffer.from(shot.data, 'base64'))
  return { kind: 'pet', layout: 'pet', size, expected: { width: 560, height: 760 }, ...metrics }
}

async function captureDpiState(client, definition, scale) {
  const base = await evaluate(client, `({ width: innerWidth, height: innerHeight })`)
  await client.send('Emulation.setDeviceMetricsOverride', { width: base.width, height: base.height, deviceScaleFactor: scale, mobile: false })
  await delay(180)
  const result = await captureState(client, definition, `dpi-${Math.round(scale * 100)}`)
  await client.send('Emulation.clearDeviceMetricsOverride')
  return result
}

async function captureState(client, definition, size) {
    await evaluate(client, `(() => { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; document.querySelectorAll('.ui-page-content--scroll,.ui-product-workspace,.ui-product-panel').forEach((item) => { item.scrollTop = 0 }); return true })()`)
    const metrics = await evaluate(client, `(() => {
      const page = document.querySelector('.ui-product-page');
      const workspace = document.querySelector('.ui-product-workspace');
      const panels = [...document.querySelectorAll('.ui-product-panel, .ui-product-sidebar')];
      const viewport = { width: innerWidth, height: innerHeight };
      const transparent = (element) => {
        if (element === null) return false;
        const color = getComputedStyle(element).backgroundColor;
        return color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
      };
      return {
        title: document.title,
        viewport,
        devicePixelRatio,
        hasProductPage: Boolean(page),
        hasWorkspace: Boolean(workspace),
        hasTraySurface: Boolean(document.querySelector('.tray-menu-shell')),
        hasMediaCanvas: Boolean(document.querySelector('.ui-media-canvas')),
        transparentSurface: [document.documentElement, document.body, document.getElementById('root'), document.querySelector('.ui-main-region'), document.querySelector('.ui-media-canvas')].every(transparent),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
        panelCount: panels.length,
        panelsOutsideHorizontalViewport: panels.filter((panel) => {
          const rect = panel.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        }).length,
        buttonCount: document.querySelectorAll('.ui-button').length,
        fieldCount: document.querySelectorAll('input, textarea, select').length
      };
    })()`)
    const shot = await client.send('Page.captureScreenshot', definition.kind === 'music-visualizer'
      ? { format: 'png', fromSurface: true, clip: { x: 0, y: 0, width: definition.width, height: definition.height, scale: 1 } }
      : { format: 'png', fromSurface: true })
    await writeFile(resolve(outputDirectory, `${definition.kind}-${size}.png`), Buffer.from(shot.data, 'base64'))
    return { kind: definition.kind, layout: definition.layout, size, expected: size === 'minimum' ? { width: definition.minWidth, height: definition.minHeight } : { width: definition.width, height: definition.height }, ...metrics }
}

async function waitForTarget(predicate) {
  let lastTargets = []
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      lastTargets = targets
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target !== undefined) return target
    } catch { /* App is still starting. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for renderer target: ${JSON.stringify(lastTargets.map(({ title, type, url }) => ({ title, type, url })))}`)
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
