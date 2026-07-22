import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 9336
const appPath = resolve('release/win-unpacked/AIMaid.exe')
const outputDirectory = resolve('artifacts/ui-first-part')
const profile = resolve(`artifacts/.capture-reminders-${Date.now()}`)
const isolatedData = resolve(profile, 'data')
const app = spawn(appPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: isolatedData,
    AIMAID_CONFIG_ROOT: resolve(profile, 'config'),
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: resolve(profile, 'logs'),
    AIMAID_SESSION_ROOT: resolve(profile, 'session')
  }
})

await mkdir(outputDirectory, { recursive: true })
const report = []
try {
  const initialTarget = await waitForTarget(() => true)
  const initialClient = await connect(initialTarget.webSocketDebuggerUrl)
  await waitForPreload(initialClient)
  await delay(2_500)
  await evaluate(initialClient, `window.aimaid.window.open('reminders')`)
  const target = await waitForTarget((candidate) => candidate.id !== initialTarget.id && candidate.url.includes('window=reminders'))
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await delay(900)

  const dueAt = new Date(Date.now() + 86_400_000).toISOString()
  await evaluate(client, `(async () => {
    await window.aimaid.core.invoke({
      type: 'reminder.save',
      payload: {
        reminderId: null,
        title: '验收提醒',
        message: '用于验证列表层级、状态、快捷开关和操作区。',
        dueAt: ${JSON.stringify(dueAt)},
        repeat: 'daily',
        enabled: true,
        allowTts: true
      }
    });
    location.reload();
    return true;
  })()`)
  await delay(1_000)

  report.push(await capture(client, 'default'))
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('新增提醒'));
    button?.click();
    return Boolean(button);
  })()`)
  await delay(200)
  report.push(await capture(client, 'dialog'))
  await evaluate(client, `(() => {
    const close = [...document.querySelectorAll('dialog[open] button, [role="dialog"] button')].find((item) => item.textContent?.includes('取消'));
    close?.click();
    return Boolean(close);
  })()`)
  await evaluate(client, 'window.resizeTo(680, 500)')
  await delay(350)
  report.push(await capture(client, 'minimum'))

  const failures = report.flatMap((item) => {
    const messages = []
    if (!item.hasPage) messages.push('missing Page root')
    if (item.horizontalOverflow) messages.push('horizontal overflow')
    if (item.layoutOutsideViewport > 0) messages.push(`${item.layoutOutsideViewport} layout elements outside horizontal viewport`)
    if (item.size === 'dialog' && item.dialogCount !== 1) messages.push('editor dialog is not visible')
    return messages.map((message) => `reminders/${item.size}: ${message}`)
  })
  await writeFile(resolve(outputDirectory, 'reminders-metrics.json'), `${JSON.stringify({ isolatedData, windows: report, failures }, null, 2)}\n`)
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify(report, null, 2))
  client.close()
  initialClient.close()
} finally {
  try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Process may already have exited. */ }
  try { execFileSync(process.execPath, [resolve('scripts/kill-packaged-app.mjs')], { stdio: 'ignore' }) } catch { /* Cleanup is best effort. */ }
}

async function capture(client, size) {
  const metrics = await evaluate(client, `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const layout = [...document.querySelectorAll('.ui-page-toolbar, .ui-surface, dialog[open], [role="dialog"]')].filter(visible);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      hasPage: Boolean(document.querySelector('.ui-page')),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      layoutOutsideViewport: layout.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).length,
      visibleControlCount: [...document.querySelectorAll('button, input, textarea, select')].filter(visible).length,
      dialogCount: [...document.querySelectorAll('dialog[open], [role="dialog"]')].filter(visible).length,
      hasSeededReminder: document.body.innerText.includes('验收提醒')
    };
  })()`)
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, `reminders-${size}.png`), Buffer.from(screenshot.data, 'base64'))
  return { size, ...metrics }
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
