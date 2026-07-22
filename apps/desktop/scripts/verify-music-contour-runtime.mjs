import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 20100 + Math.floor(Math.random() * 200)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/music-contour-runtime')
const profile = resolve(`artifacts/.music-contour-runtime-${Date.now()}`)
const configRoot = resolve(profile, 'config')
const logRoot = resolve(profile, 'logs')

await mkdir(outputDirectory, { recursive: true })
await mkdir(configRoot, { recursive: true })
await writeFile(resolve(configRoot, 'pet-presentation.json'), JSON.stringify({
  mode: 'live2d', paused: false, live2dRole: '符玄'
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

let client
let trayClient
let settingsClient
try {
  const target = await waitForTarget((candidate) => candidate.url.includes('window=pet'))
  client = await connect(target.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await waitFor(() => evaluate(client, `document.querySelector('canvas[aria-label="Live2D 桌宠模型"]') !== null`))
  await delay(2_000)

  const playback = await evaluate(client, `(async () => {
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await window.aimaid.core.invoke({ type: 'music.search_and_play', payload: { songName: 'night dancer' } }, 60000);
      if (result.success) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    return { success: result.success, error: result.error, payload: result.payload };
  })()`)
  if (!playback.success) throw new Error(`Music playback failed: ${JSON.stringify(playback.error)}`)

  await waitFor(() => evaluate(client, `(() => {
    const canvas = document.querySelector('.ui-pet-audio-contour');
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visible += 1;
    return visible > 100;
  })()`), 300)

  const metrics = await evaluate(client, `(() => {
    const source = document.querySelector('canvas[aria-label="Live2D 桌宠模型"]');
    const overlay = document.querySelector('.ui-pet-audio-contour');
    const sourceBounds = source.getBoundingClientRect();
    const overlayBounds = overlay.getBoundingClientRect();
    const stageBounds = overlay.parentElement.getBoundingClientRect();
    const pixels = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
    let visiblePixels = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visiblePixels += 1;
    return {
      independentStageLayer: source.parentElement !== overlay.parentElement && overlay.parentElement?.classList.contains('ui-transparent-stage'),
      sourceBounds: { x: sourceBounds.x, y: sourceBounds.y, width: sourceBounds.width, height: sourceBounds.height },
      overlayBounds: { x: overlayBounds.x, y: overlayBounds.y, width: overlayBounds.width, height: overlayBounds.height },
      stageBounds: { x: stageBounds.x, y: stageBounds.y, width: stageBounds.width, height: stageBounds.height },
      visiblePixels
    };
  })()`)

  const containsSource = metrics.overlayBounds.x <= metrics.sourceBounds.x && metrics.overlayBounds.y <= metrics.sourceBounds.y &&
    metrics.overlayBounds.x + metrics.overlayBounds.width >= metrics.sourceBounds.x + metrics.sourceBounds.width &&
    metrics.overlayBounds.y + metrics.overlayBounds.height >= metrics.sourceBounds.y + metrics.sourceBounds.height
  const tightlyBounded = metrics.overlayBounds.width < metrics.stageBounds.width / 2 && metrics.overlayBounds.height < metrics.stageBounds.height / 2
  if (!metrics.independentStageLayer || !containsSource || !tightlyBounded || metrics.visiblePixels <= 100) {
    throw new Error(`Visualizer is not an independent stage overlay: ${JSON.stringify(metrics)}`)
  }

  const interactionPerformancePromise = evaluate(client, `(async () => new Promise((resolveSample) => {
    const deltas = [];
    let previous = performance.now();
    const started = previous;
    const sample = (now) => {
      deltas.push(now - previous);
      previous = now;
      if (now - started < 1800) requestAnimationFrame(sample);
      else {
        const ordered = deltas.slice(1).sort((left, right) => left - right);
        const total = ordered.reduce((sum, value) => sum + value, 0);
        resolveSample({
          frameCount: ordered.length,
          averageFps: ordered.length / (total / 1000),
          p95FrameMs: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
          maximumFrameMs: ordered.at(-1) ?? 0
        });
      }
    };
    requestAnimationFrame(sample);
  }))()`)
  const centerX = metrics.sourceBounds.x + metrics.sourceBounds.width / 2
  const centerY = metrics.sourceBounds.y + metrics.sourceBounds.height / 2
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centerX, y: centerY, button: 'none', buttons: 0 })
  await delay(100)
  for (let index = 0; index < 6; index += 1) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centerX, y: centerY, deltaX: 0, deltaY: index % 2 === 0 ? -80 : 80 })
    await delay(40)
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centerX, y: centerY, button: 'left', buttons: 1, clickCount: 1 })
  for (let index = 1; index <= 12; index += 1) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centerX + index * 6, y: centerY + index * 2, button: 'left', buttons: 1 })
    await delay(16)
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centerX + 72, y: centerY + 24, button: 'left', buttons: 0, clickCount: 1 })
  const interactionPerformance = await interactionPerformancePromise
  if (interactionPerformance.frameCount < 70 || interactionPerformance.p95FrameMs > 50 || interactionPerformance.maximumFrameMs > 150) {
    throw new Error(`Pet drag/zoom performance regressed: ${JSON.stringify(interactionPerformance)}`)
  }

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const screenshotPath = resolve(outputDirectory, 'live2d-dynamic-contour.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

  const styleScreenshots = { 'surround-bars': screenshotPath }
  for (const style of ['surround-line', 'bottom-wave']) {
    const saved = await evaluate(client, `window.aimaid.core.invoke({ type: 'settings.save', payload: { values: { music_visualizer_style: '${style}' } } })`)
    if (!saved.success) throw new Error(`Visualizer style save failed: ${JSON.stringify(saved.error)}`)
    await waitFor(() => evaluate(client, `document.querySelector('.ui-pet-audio-contour')?.dataset.visualizerStyle === '${style}'`))
    await delay(500)
    const styleScreenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const stylePath = resolve(outputDirectory, `live2d-${style}.png`)
    await writeFile(stylePath, Buffer.from(styleScreenshot.data, 'base64'))
    styleScreenshots[style] = stylePath
  }

  await evaluate(client, `window.aimaid.window.open('tray-menu')`)
  const trayTarget = await waitForTarget((candidate) => candidate.url.includes('window=tray-menu'))
  trayClient = await connect(trayTarget.webSocketDebuggerUrl)
  await trayClient.send('Page.enable')
  await waitFor(() => evaluate(trayClient, `document.body.innerText.includes('NIGHT DANCER') && document.body.innerText.includes('imase')`))
  const trayScreenshot = await trayClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const trayScreenshotPath = resolve(outputDirectory, 'tray-music-controls.png')
  await writeFile(trayScreenshotPath, Buffer.from(trayScreenshot.data, 'base64'))

  await evaluate(trayClient, `document.querySelector('button[aria-label="暂停"]')?.click()`)
  await waitFor(() => evaluate(trayClient, `document.querySelector('button[aria-label="继续播放"]') !== null`))
  await waitFor(() => evaluate(client, `(() => {
    const canvas = document.querySelector('.ui-pet-audio-contour');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return false;
    return true;
  })()`))

  await evaluate(trayClient, `document.querySelector('button[aria-label="继续播放"]')?.click()`)
  await waitFor(() => evaluate(trayClient, `document.querySelector('button[aria-label="暂停"]') !== null`))
  await waitFor(() => evaluate(client, `(() => {
    const canvas = document.querySelector('.ui-pet-audio-contour');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  })()`))

  await evaluate(trayClient, `document.querySelector('button[aria-label="停止"]')?.click()`)
  await waitFor(() => evaluate(trayClient, `document.body.innerText.includes('当前未播放音乐')`))

  await evaluate(client, `window.aimaid.window.open('settings')`)
  const settingsTarget = await waitForTarget((candidate) => candidate.url.includes('window=settings'))
  settingsClient = await connect(settingsTarget.webSocketDebuggerUrl)
  await settingsClient.send('Page.enable')
  await waitFor(() => evaluate(settingsClient, `document.body.innerText.includes('音乐音浪样式') && document.body.innerText.includes('环绕柱条') && document.body.innerText.includes('环绕线条') && document.body.innerText.includes('底部倒置柱状')`))
  const settingsScreenshot = await settingsClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const settingsScreenshotPath = resolve(outputDirectory, 'settings-visualizer-styles.png')
  await writeFile(settingsScreenshotPath, Buffer.from(settingsScreenshot.data, 'base64'))

  const proof = {
    playback: playback.payload,
    ...metrics,
    interactionPerformance,
    screenshot: screenshotPath,
    styleScreenshots,
    settingsScreenshot: settingsScreenshotPath,
    trayControls: { currentSong: true, pause: true, resume: true, stop: true, screenshot: trayScreenshotPath }
  }
  await writeFile(resolve(outputDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof, null, 2))
} finally {
  settingsClient?.close()
  trayClient?.close()
  client?.close()
  app.kill()
  await delay(300)
}

const log = await readFile(resolve(logRoot, 'aimaid-desktop.jsonl'), 'utf8')
if (log.includes('[MusicContour] alpha capture failed')) throw new Error('Live2D alpha capture failed at runtime')

async function waitForTarget(predicate) {
  let lastTargets = []
  for (let attempt = 0; attempt < 180; attempt += 1) {
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

async function waitFor(predicate, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for dynamic music contour')
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
