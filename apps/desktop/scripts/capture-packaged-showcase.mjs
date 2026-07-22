import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 9333
const appPath = resolve('release/win-unpacked/AIMaid.exe')
const outputDirectory = resolve('artifacts/ui-showcase')
await mkdir(outputDirectory, { recursive: true })

const app = spawn(appPath, [`--remote-debugging-port=${port}`], { stdio: 'ignore', windowsHide: true })

try {
  const initialTarget = await waitForTarget(() => true)
  const initialClient = await connect(initialTarget.webSocketDebuggerUrl)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(initialClient, "typeof window.aimaid?.window?.open === 'function'")) break
    await delay(50)
    if (attempt === 99) throw new Error('Electron preload API did not become ready')
  }
  const openResult = await initialClient.send('Runtime.evaluate', {
    expression: "window.aimaid?.window?.open?.('ui-showcase')",
    awaitPromise: true,
    returnByValue: true
  })
  if (openResult.exceptionDetails !== undefined) throw new Error(openResult.exceptionDetails.text)
  initialClient.close()

  const showcaseTarget = await waitForTarget((target) => target.url.includes('ui-showcase') || target.title.includes('控件展示'))
  const client = await connect(showcaseTarget.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await client.send('Runtime.enable')

  const metrics = await evaluate(client, `(() => {
    const content = document.querySelector('.ui-showcase__content');
    const sections = [...document.querySelectorAll('.ui-showcase__section')];
    const button = document.querySelector('.ui-button');
    const sectionMetrics = sections.map((section, index) => {
      const body = section.querySelector('.ui-showcase__section-body');
      const rect = section.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const nextRect = sections[index + 1]?.getBoundingClientRect();
      return {
        title: section.querySelector('h2')?.textContent ?? '',
        height: Math.round(rect.height),
        bodyHeight: Math.round(bodyRect.height),
        bodyClipped: bodyRect.bottom > rect.bottom + 1,
        overlapsNext: nextRect ? rect.bottom > nextRect.top + 1 : false
      };
    });
    return {
      sectionCount: sections.length,
      buttonCount: document.querySelectorAll('.ui-button').length,
      inputCount: document.querySelectorAll('input, textarea, select').length,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      buttonFontSize: button ? getComputedStyle(button).fontSize : null,
      bodyFontSize: getComputedStyle(document.body).fontSize,
      sections: sectionMetrics
    };
  })()`)

  const failures = []
  if (metrics.sectionCount !== 9) failures.push(`expected 9 sections, got ${metrics.sectionCount}`)
  if (metrics.buttonCount < 20) failures.push(`expected at least 20 buttons, got ${metrics.buttonCount}`)
  if (metrics.inputCount < 15) failures.push(`expected at least 15 form controls, got ${metrics.inputCount}`)
  if (Number.parseFloat(metrics.buttonFontSize) !== 14) failures.push(`expected 14px button text, got ${metrics.buttonFontSize}`)
  for (const section of metrics.sections) {
    if (section.bodyHeight <= 0) failures.push(`${section.title} has no visible body`)
    if (section.bodyClipped) failures.push(`${section.title} body is clipped`)
    if (section.overlapsNext) failures.push(`${section.title} overlaps the next section`)
  }

  for (const [name, ratio] of [['01-top', 0], ['02-middle', 0.5], ['03-bottom', 1]]) {
    await evaluate(client, `(() => { const el = document.querySelector('.ui-showcase__content'); el.scrollTop = (el.scrollHeight - el.clientHeight) * ${ratio}; return el.scrollTop; })()`)
    await delay(120)
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(resolve(outputDirectory, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }

  const checkboxResult = await evaluate(client, `(() => {
    const input = document.querySelector('.ui-check input:not(:disabled)');
    const before = input.checked;
    input.click();
    const loading = [...document.querySelectorAll('.ui-button')].find((button) => button.textContent.includes('加载中'));
    return { before, after: input.checked, sectionCount: document.querySelectorAll('.ui-showcase__section').length, loadingWidth: loading?.getBoundingClientRect().width ?? 0 };
  })()`)
  if (checkboxResult.before === checkboxResult.after) failures.push('checkbox state did not change')
  if (checkboxResult.sectionCount !== 9) failures.push('showcase disappeared after checkbox interaction')
  if (checkboxResult.loadingWidth < 72) failures.push(`loading button width collapsed to ${checkboxResult.loadingWidth}px`)

  await evaluate(client, `(() => {
    const trigger = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('展开菜单'));
    trigger.click();
    return true;
  })()`)
  await delay(50)
  const menuResult = await evaluate(client, `(() => {
    const menu = document.querySelector('.ui-menu[role=menu]');
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, viewportWidth: innerWidth, viewportHeight: innerHeight };
  })()`)
  if (menuResult === null) failures.push('menu did not open')
  else if (menuResult.left < 0 || menuResult.top < 0 || menuResult.right > menuResult.viewportWidth || menuResult.bottom > menuResult.viewportHeight) failures.push('menu is outside the viewport')
  const menuShot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, '04-menu.png'), Buffer.from(menuShot.data, 'base64'))
  await evaluate(client, `(() => {
    const trigger = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('展开菜单'));
    trigger.click();
    return true;
  })()`)
  await delay(50)

  await evaluate(client, `(() => {
    const trigger = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('打开对话框'));
    trigger.click();
    return true;
  })()`)
  await delay(50)
  const dialogResult = await evaluate(client, `(() => {
    const dialog = document.querySelector('.ui-dialog[open]');
    if (!dialog) return null;
    const rect = dialog.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, viewportWidth: innerWidth, viewportHeight: innerHeight };
  })()`)
  if (dialogResult === null) failures.push('dialog did not open')
  else if (dialogResult.left < 0 || dialogResult.top < 0 || dialogResult.right > dialogResult.viewportWidth || dialogResult.bottom > dialogResult.viewportHeight) failures.push('dialog is outside the viewport')
  const dialogShot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, '05-dialog.png'), Buffer.from(dialogShot.data, 'base64'))

  await evaluate(client, `(() => {
    const close = document.querySelector('.ui-dialog[open] .ui-icon-button');
    close?.click();
    window.resizeTo(900, 640);
    return true;
  })()`)
  await delay(250)
  const minimumResult = await evaluate(client, `(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    sectionCount: document.querySelectorAll('.ui-showcase__section').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
    contentHorizontalOverflow: (() => { const content = document.querySelector('.ui-showcase__content'); return content.scrollWidth > content.clientWidth + 1 })()
  }))()`)
  if (minimumResult.sectionCount !== 9) failures.push(`minimum viewport expected 9 sections, got ${minimumResult.sectionCount}`)
  if (minimumResult.horizontalOverflow || minimumResult.contentHorizontalOverflow) failures.push('showcase has horizontal overflow at registered minimum size')
  const minimumShot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, '06-minimum.png'), Buffer.from(minimumShot.data, 'base64'))

  await writeFile(resolve(outputDirectory, 'metrics.json'), `${JSON.stringify({ ...metrics, checkboxResult, menuResult, dialogResult, minimumResult, failures }, null, 2)}\n`)
  client.close()
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify(metrics, null, 2))
} finally {
  app.kill()
  try { execFileSync(process.execPath, [resolve('scripts/kill-packaged-app.mjs')], { stdio: 'ignore' }) } catch { /* Cleanup is best effort. */ }
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
