import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const testUrl = process.env.AIMAID_REMOTE_VIDEO_TEST_URL
if (!testUrl) throw new Error('AIMAID_REMOTE_VIDEO_TEST_URL is required')

const port = 19800 + Math.floor(Math.random() * 100)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/remote-video-runtime')
const profile = resolve(`artifacts/.remote-video-runtime-${Date.now()}`)
const useExistingData = process.env.AIMAID_REMOTE_VIDEO_USE_EXISTING_DATA === '1'
await mkdir(outputDirectory, { recursive: true })

const app = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore',
  windowsHide: true,
  env: useExistingData ? process.env : {
    ...process.env,
    AIMAID_DATA_ROOT: resolve(profile, 'data'),
    AIMAID_CONFIG_ROOT: resolve(profile, 'config'),
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: resolve(profile, 'logs')
  }
})

try {
  const initialTarget = await waitForTarget(() => true)
  const initial = await connect(initialTarget.webSocketDebuggerUrl)
  await waitForPreload(initial)
  await evaluate(initial, `window.aimaid.window.open('remote-video')`)
  const target = await waitForTarget((candidate) => candidate.url.includes('window=remote-video'))
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await delay(700)
  await setTextarea(client, '远程视频地址', testUrl)
  await clickButton(client, '开始解析')
  await waitForResult(client)
  await waitForThumbnail(client)

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, 'remote-video-result.png'), Buffer.from(screenshot.data, 'base64'))
  const report = await evaluate(client, `(() => {
    const feature = document.querySelector('.remote-video-result-feature');
    const media = document.querySelector('.remote-video-result-feature__media');
    const copy = document.querySelector('.remote-video-result-feature__copy');
    const images = [...document.querySelectorAll('.remote-video-result-feature img')];
    const actionButtons = [...document.querySelectorAll('.remote-video-result-feature__actions button')];
    const actionTops = actionButtons.map((button) => Math.round(button.getBoundingClientRect().top));
    const panelBottom = feature?.closest('.ui-product-panel__body')?.getBoundingClientRect().bottom ?? 0;
    return {
      status: document.querySelector('.ui-product-status')?.textContent?.trim() ?? '',
      resultVisible: Boolean(feature && feature.getBoundingClientRect().height > 200),
      twoColumnResult: Boolean(media && copy && media.getBoundingClientRect().right < copy.getBoundingClientRect().left),
      thumbnailLoaded: images.some((image) => image.complete && image.naturalWidth > 0),
      actionButtonsInline: actionTops.length >= 3 && new Set(actionTops).size === 1,
      actionButtonsVisible: actionButtons.length >= 3 && actionButtons.every((button) => button.getBoundingClientRect().bottom <= panelBottom),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      text: document.body.innerText
    };
  })()`)
  await writeFile(resolve(outputDirectory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (!report.status.includes('解析完成') || !report.resultVisible || !report.twoColumnResult || !report.thumbnailLoaded || !report.actionButtonsInline || !report.actionButtonsVisible || report.horizontalOverflow) {
    throw new Error('Remote video runtime verification failed')
  }
  client.close()
  initial.close()
} finally {
  try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Process may already be closed. */ }
}

async function waitForResult(client) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const state = await evaluate(client, `document.querySelector('.ui-product-status')?.textContent?.trim() ?? ''`)
    if (state.includes('解析完成')) return
    if (!state.includes('解析中') && !state.includes('就绪')) throw new Error(state)
    await delay(500)
  }
  throw new Error('Timed out waiting for remote video result')
}

async function waitForThumbnail(client) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(client, `[...document.querySelectorAll('.remote-video-result-feature img')].some((image) => image.complete && image.naturalWidth > 0)`)) return
    await delay(500)
  }
  const diagnostic = await evaluate(client, `(async () => {
    const itemId = document.querySelector('[data-remote-video-item]')?.getAttribute('data-remote-video-item') ?? '';
    const response = await window.aimaid.core.invoke({ type: 'remote_video.thumbnail', payload: { itemId } }, 30000);
    return { success: response.success, error: response.error?.message ?? '', mimeType: response.payload?.mimeType ?? '', dataLength: response.payload?.base64Data?.length ?? 0 };
  })()`)
  throw new Error(`Timed out waiting for remote video thumbnail: ${JSON.stringify(diagnostic)}`)
}

async function setTextarea(client, label, value) {
  const changed = await evaluate(client, `(() => {
    const input = document.querySelector(${JSON.stringify(`textarea[aria-label="${label}"]`)});
    if (!(input instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  if (!changed) throw new Error(`Textarea not found: ${label}`)
}

async function clickButton(client, label) {
  const clicked = await evaluate(client, `(() => {
    const target = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(${JSON.stringify(label)}));
    if (!target) return false;
    target.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Button not found: ${label}`)
}

async function waitForPreload(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(client, "typeof window.aimaid?.window?.open === 'function'")) return
    await delay(50)
  }
  throw new Error('Electron preload API did not become ready')
}

async function waitForTarget(predicate) {
  let lastTargets = []
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      lastTargets = targets
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target) return target
    } catch { /* App is still starting. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for renderer target: ${JSON.stringify(lastTargets)}`)
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
    if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(new Error(message.error.message))
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
