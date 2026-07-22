import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 9335
const appPath = resolve('release/win-unpacked/AIMaid.exe')
const outputDirectory = resolve('artifacts/ui-first-part')
const windows = [
  { kind: 'main', width: 1280, height: 820, minWidth: 960, minHeight: 680 },
  { kind: 'chat', width: 520, height: 360, pageRoot: false },
  { kind: 'characters', width: 1160, height: 800, minWidth: 1120, minHeight: 680, wait: 1_200 },
  { kind: 'template-card', width: 820, height: 680, minWidth: 720, minHeight: 560 },
  { kind: 'character-editor', width: 920, height: 720, minWidth: 820, minHeight: 620 },
  { kind: 'reminders', width: 760, height: 560, minWidth: 680, minHeight: 500, wait: 1_200 },
  { kind: 'notebook', width: 980, height: 680, minWidth: 920, minHeight: 520, wait: 1_000 },
  { kind: 'voice-conversation', width: 1260, height: 840, minWidth: 1040, minHeight: 720, wait: 1_200 },
  { kind: 'settings', width: 820, height: 680, minWidth: 720, minHeight: 560, wait: 5_500 },
  { kind: 'appearance', width: 1040, height: 920, minWidth: 460, minHeight: 760 },
  { kind: 'status', width: 1280, height: 820, minWidth: 960, minHeight: 680, wait: 3_500 },
  { kind: 'video', width: 1760, height: 940, minWidth: 1200, minHeight: 720, wait: 2_000, pageRoot: false }
]
const selectedWindows = process.env.AIMAID_CAPTURE_WINDOW === undefined
  ? windows
  : windows.filter(({ kind }) => kind === process.env.AIMAID_CAPTURE_WINDOW)

await mkdir(outputDirectory, { recursive: true })
const profile = resolve(`artifacts/.capture-first-${Date.now()}`)
const app = spawn(appPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  stdio: 'ignore', windowsHide: true,
  env: {
    ...process.env,
    AIMAID_DATA_ROOT: process.env.AIMAID_CAPTURE_DATA_ROOT ?? resolve(profile, 'data'),
    AIMAID_CONFIG_ROOT: resolve(profile, 'config'),
    AIMAID_CACHE_ROOT: resolve(profile, 'cache'),
    AIMAID_LOG_ROOT: resolve(profile, 'logs')
  }
})
const report = []

try {
  const initialTarget = await waitForTarget(() => true)
  const initialClient = await connect(initialTarget.webSocketDebuggerUrl)
  await waitForPreload(initialClient)
  await delay(2_500)
  if (process.env.AIMAID_CAPTURE_DATA_ROOT === undefined) await seedAcceptanceData(initialClient)

  for (const definition of selectedWindows) {
    await evaluate(initialClient, `window.aimaid.window.open(${JSON.stringify(definition.kind)})`)
    const target = await waitForTarget((candidate) => candidate.id !== initialTarget.id && candidate.url.includes(`window=${definition.kind}`))
    const client = await connect(target.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await delay(definition.wait ?? 650)
    if (definition.kind === 'settings') await evaluate(client, `(() => { document.querySelectorAll('[aria-label="关闭通知"]').forEach((button) => button.click()); return true })()`)

    if (definition.kind === 'characters') {
      await evaluate(client, `(async () => {
        const response = await window.aimaid.core.invoke({ type: 'character.list', payload: {} });
        const role = Array.isArray(response.payload) ? response.payload[0] : null;
        if (role) {
          localStorage.setItem('aimaid.template-card-role', JSON.stringify(role));
          localStorage.setItem('aimaid.character-editor-role', JSON.stringify(role));
        }
        return Boolean(role);
      })()`)
    }

    const defaultResult = await captureState(client, definition, 'default')
    report.push(defaultResult)

    if (definition.kind === 'video') {
      await evaluate(client, `(() => {
        const card = document.querySelector('.video-library-grid .ui-pressable--card');
        if (!card) return false;
        const rect = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.right - 8, clientY: rect.bottom - 8 }));
        return true;
      })()`)
      await delay(120)
      const menuState = await evaluate(client, `(() => {
        const menu = document.querySelector('.ui-context-menu--rich');
        const labels = [...document.querySelectorAll('.ui-context-menu--rich .ui-menu__label')];
        return { kind: 'video', size: 'context-menu', pageRoot: false, menuVisible: Boolean(menu), clippedLabels: labels.filter((label) => label.scrollWidth > label.clientWidth + 1).length, labels: labels.map((label) => label.textContent) };
      })()`)
      const menuScreenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      await writeFile(resolve(outputDirectory, 'video-context-menu.png'), Buffer.from(menuScreenshot.data, 'base64'))
      report.push(menuState)
      await evaluate(client, `document.querySelector('.ui-context-menu-layer')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    }

    for (const scale of [1, 1.25, 1.5]) {
      report.push(await captureDpiState(client, definition, scale))
    }

    if (definition.minWidth !== undefined && definition.minHeight !== undefined) {
      await evaluate(client, `window.resizeTo(${definition.minWidth}, ${definition.minHeight})`)
      await delay(350)
      const resized = await evaluate(client, `({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })`)
      const expectedViewport = { width: definition.minWidth + 2, height: definition.minHeight + 2 }
      const emulatedMinimum = Math.abs(resized.width - expectedViewport.width) > 3 || Math.abs(resized.height - expectedViewport.height) > 3
      if (emulatedMinimum) {
        await client.send('Emulation.setDeviceMetricsOverride', {
          width: expectedViewport.width,
          height: expectedViewport.height,
          deviceScaleFactor: resized.scale,
          mobile: false
        })
        await delay(180)
      }
      report.push({ ...await captureState(client, definition, 'minimum'), emulatedMinimum })
      if (emulatedMinimum) await client.send('Emulation.clearDeviceMetricsOverride')
    }

    client.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined)
    await delay(120)
  }

  initialClient.close()
  const failures = report.flatMap((item) => {
    const messages = []
    if (item.pageRoot !== false && !item.hasPage) messages.push('missing Page root')
    if (item.horizontalOverflow) messages.push('horizontal overflow')
    if (item.elementsOutsideHorizontalViewport > 0) messages.push(`${item.elementsOutsideHorizontalViewport} layout elements outside horizontal viewport`)
    if (item.visibleControlCount === 0 && item.bodyTextLength < 20) messages.push('no visible content')
    return messages.map((message) => `${item.kind}/${item.size}: ${message}`)
  })
  await writeFile(resolve(outputDirectory, 'metrics.json'), `${JSON.stringify({ windows: report, failures }, null, 2)}\n`)
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Process may already have exited. */ }
  try { execFileSync(process.execPath, [resolve('scripts/kill-packaged-app.mjs')], { stdio: 'ignore' }) } catch { /* Cleanup is best effort. */ }
}

async function seedAcceptanceData(client) {
  await evaluate(client, `(async () => {
    const now = new Date().toISOString();
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    const character = {
      roleId: 'acceptance-role', name: '验收角色', voiceName: 'acceptance-voice', roleTitle: '桌面助手',
      cardPath: '', sourceCardJson: JSON.stringify({ name: '验收角色', persona: '用于真实窗口布局验收。' }, null, 2),
      templateCardJson: JSON.stringify({ role: '桌面助手', tone: '清晰、自然' }, null, 2), preferredVoiceId: 'acceptance-voice',
      validationStatus: 'valid', isEnabled: true, updatedAt: now, cardSummary: '清晰、可靠的桌面助手。',
      cardSchemaVersion: '1', templateCardSourceHash: '', templateCardGenerationStatus: 'completed',
      templateCardGenerationMessage: '角色卡已生成', templateCardGeneratedAt: now, templateCardLastAttemptAt: now,
      templateCardIterationCount: 1, validationMessage: '字段完整', lastValidatedAt: now, avatarPath: ''
    };
    await window.aimaid.core.invoke({ type: 'character.save', payload: { character } });
    await window.aimaid.core.invoke({ type: 'reminder.save', payload: { reminderId: null, title: '整理今日记录', message: '检查任务进度并更新记事本', dueAt, repeat: 'daily', enabled: true, allowTts: true } });
    await window.aimaid.core.invoke({ type: 'notebook.save', payload: { note: { noteId: 'acceptance-note', title: 'UI 验收记录', contentMarkdown: '## 今日检查\\n\\n- 页面层级\\n- 响应式布局\\n- 键盘与状态', contentPlainText: '今日检查 页面层级 响应式布局 键盘与状态', attachmentIds: [], isPinned: true, isDeleted: false, createdAt: now, updatedAt: now } } });
    await window.aimaid.core.invoke({ type: 'voice_conversation.save', payload: { conversation: { conversationId: 'acceptance-conversation', voiceRoleId: character.roleId, title: '布局验收会话', preview: '继续检查消息区与输入区', createdAt: now, updatedAt: now } } });
    return true;
  })()`)
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
  if (definition.kind === 'settings') {
    await evaluate(client, `(() => {
      document.querySelectorAll('[aria-label="关闭通知"]').forEach((button) => button.click());
      return true;
    })()`)
    await delay(50)
  }
  await evaluate(client, `(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelectorAll('.ui-page-content--scroll, .ui-workspace-grid, .ui-surface--scroll').forEach((element) => { element.scrollTop = 0 });
  })()`)
  const metrics = await evaluate(client, `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const layoutElements = [...document.querySelectorAll('.ui-page-toolbar, .ui-workspace-grid, .ui-surface, .ui-settings-section')].filter(visible);
    const controls = [...document.querySelectorAll('button, input, textarea, select, [role="button"], [role="option"]')].filter(visible);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      hasPage: Boolean(document.querySelector('.ui-page')),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      elementsOutsideHorizontalViewport: layoutElements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).length,
      visibleControlCount: controls.length,
      bodyTextLength: document.body.innerText.trim().length,
      errorStateCount: document.querySelectorAll('.ui-error-state').length,
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      videoNavigationState: [...document.querySelectorAll('[data-video-navigation-item]')].slice(0, 12).map((element) => ({
        label: element.textContent?.trim(), pressed: element.getAttribute('aria-pressed'), background: getComputedStyle(element).backgroundColor
      }))
    };
  })()`)
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, `${definition.kind}-${size}.png`), Buffer.from(screenshot.data, 'base64'))
  return { kind: definition.kind, size, pageRoot: definition.pageRoot, expected: size === 'minimum' ? { width: definition.minWidth, height: definition.minHeight } : { width: definition.width, height: definition.height }, ...metrics }
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
