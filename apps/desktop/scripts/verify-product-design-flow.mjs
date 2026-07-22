import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const port = 19400 + Math.floor(Math.random() * 400)
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const outputDirectory = resolve('artifacts/product-design-audit')
const profile = resolve(`artifacts/.product-design-${Date.now()}`)

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

try {
  const initialTarget = await waitForTarget(() => true)
  const initial = await connect(initialTarget.webSocketDebuggerUrl)
  await waitForPreload(initial)
  await delay(1_500)
  await seedCharacter(initial)

  await evaluate(initial, `window.aimaid.window.open('main')`)
  const mainTarget = await waitForTarget((candidate) => candidate.url.includes('window=main'))
  const main = await connect(mainTarget.webSocketDebuggerUrl)
  await main.send('Page.enable')
  await delay(500)
  await capture(main, '01-workbench-before-click.png')
  const clickedWorkbench = await clickButton(main, '角色对话中心')
  const conversationTarget = await waitForTarget((candidate) => candidate.url.includes('window=voice-conversation'))
  const conversation = await connect(conversationTarget.webSocketDebuggerUrl)
  await conversation.send('Page.enable')
  await delay(700)
  const createdConversation = await clickButton(conversation, '新建会话')
  await delay(400)
  await capture(conversation, '02-workbench-click-opened-conversation.png')
  const conversationTitle = await evaluate(conversation, 'document.body.innerText')
  conversation.close()
  await closeTarget(conversationTarget.id)

  await evaluate(initial, `window.aimaid.window.open('characters')`)
  const charactersTarget = await waitForTarget((candidate) => candidate.url.includes('window=characters'))
  const characters = await connect(charactersTarget.webSocketDebuggerUrl)
  await characters.send('Page.enable')
  await delay(900)
  await capture(characters, '03-character-details.png')
  const characterText = await evaluate(characters, 'document.body.innerText')
  const clickedCard = await clickButton(characters, '角色卡')
  const cardTarget = await waitForTarget((candidate) => candidate.url.includes('window=template-card'))
  const card = await connect(cardTarget.webSocketDebuggerUrl)
  await card.send('Page.enable')
  await delay(500)
  await capture(card, '04-character-card-opened.png')
  const cardText = await evaluate(card, 'document.body.innerText')
  characters.close()
  card.close()
  await closeTarget(charactersTarget.id)
  await closeTarget(cardTarget.id)

  const surfaces = [
    ['reminders', '05-reminders'],
    ['notebook', '06-notebook'],
    ['settings', '07-settings'],
    ['appearance', '08-appearance'],
    ['status', '09-status'],
    ['timer', '10-timer'],
    ['bitcoin', '11-bitcoin'],
    ['video', '12-video-library'],
    ['remote-video', '13-remote-video'],
    ['remote-site-config', '14-remote-site-config'],
    ['vault', '15-vault'],
    ['scripts', '16-scripts']
  ]
  const surfaceChecks = []
  let notebookCreateRoundTrip = false
  let timerRecordRoundTrip = false
  let timerDeleteRoundTrip = false
  let appearanceSaveRoundTrip = false
  let scriptSaveRoundTrip = false
  let vaultSaveRoundTrip = false
  let videoSubtitleOpened = false
  let remoteSiteConfigOpened = false
  for (const [kind, name] of surfaces) {
    await evaluate(initial, `window.aimaid.window.open(${JSON.stringify(kind)})`)
    const target = await waitForTarget((candidate) => candidate.url.includes(`window=${kind}`))
    const client = await connect(target.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await delay(kind === 'settings' || kind === 'status' ? 2_000 : 700)
    if (kind === 'bitcoin') await waitForLoadingToFinish(client, 32_000)
    await capture(client, `${name}.png`)
    if (kind === 'notebook') {
      const created = await clickButton(client, '新建笔记')
      await delay(250)
      const titled = await setInput(client, '笔记标题', '点击验收笔记')
      await delay(900)
      await capture(client, '06b-notebook-created.png')
      await client.send('Page.reload', { ignoreCache: true })
      await delay(900)
      notebookCreateRoundTrip = created && titled && (await evaluate(client, 'document.body.innerText')).includes('点击验收笔记')
    }
    if (kind === 'appearance') {
      const selected = await clickButton(client, 'Fluent 雾白')
      await delay(500)
      await client.send('Page.reload', { ignoreCache: true })
      await delay(900)
      const currentTheme = await evaluate(client, `document.querySelector('[aria-current="true"]')?.textContent ?? ''`)
      appearanceSaveRoundTrip = selected && currentTheme.includes('Fluent 雾白')
    }
    if (kind === 'timer') {
      const started = await clickButton(client, '10 分钟')
      await delay(1_100)
      const saved = await clickButton(client, '保存记录')
      await delay(400)
      const openedRecords = await clickButton(client, '查看记录')
      await delay(300)
      await capture(client, '10b-timer-record-saved.png')
      timerRecordRoundTrip = started && saved && openedRecords && (await evaluate(client, 'document.body.innerText')).includes('1 次')
      const menuOpened = await openContextMenu(client, 'article')
      const deleted = await clickButton(client, '删除记录')
      await delay(400)
      timerDeleteRoundTrip = menuOpened && deleted && (await evaluate(client, 'document.body.innerText')).includes('历史\n0 次')
    }
    if (kind === 'video') {
      const clicked = await clickButton(client, '字幕')
      const subtitleTarget = await waitForTarget((candidate) => candidate.url.includes('window=video-subtitles'))
      videoSubtitleOpened = clicked
      await closeTarget(subtitleTarget.id)
    }
    if (kind === 'remote-video') {
      const clicked = await clickButton(client, '站点配置')
      const siteTarget = await waitForTarget((candidate) => candidate.url.includes('window=remote-site-config'))
      remoteSiteConfigOpened = clicked
      await closeTarget(siteTarget.id)
    }
    if (kind === 'vault') {
      const nameSet = await setInput(client, '名称', '验收密码条目')
      const accountSet = await setInput(client, '账号', 'product@example.com')
      const secretSet = await setInput(client, '密码', 'local-test-secret')
      const saved = await clickButton(client, '保存')
      await delay(500)
      await client.send('Page.reload', { ignoreCache: true })
      await delay(900)
      const persisted = await evaluate(client, `(() => ({
        name: document.querySelector('input[aria-label="名称"]')?.value ?? '',
        account: document.querySelector('input[aria-label="账号"]')?.value ?? '',
        secret: document.querySelector('input[aria-label="密码"]')?.value ?? ''
      }))()`)
      vaultSaveRoundTrip = nameSet && accountSet && secretSet && saved && persisted.name === '验收密码条目' && persisted.account === 'product@example.com' && persisted.secret === 'local-test-secret'
      await capture(client, '15b-vault-saved.png')
    }
    if (kind === 'scripts') {
      const commandSet = await setInput(client, '聊天指令', '-product-check')
      const nameSet = await setInput(client, '显示名称', '验收脚本')
      const pathSet = await setInput(client, '程序或脚本路径', 'C:\\Windows\\System32\\notepad.exe')
      const saved = await clickButton(client, '保存')
      await delay(500)
      await client.send('Page.reload', { ignoreCache: true })
      await delay(900)
      const scriptText = await evaluate(client, 'document.body.innerText')
      scriptSaveRoundTrip = commandSet && nameSet && pathSet && saved && scriptText.includes('-product-check') && scriptText.includes('验收脚本')
      await capture(client, '16b-script-saved.png')
    }
    surfaceChecks.push(await evaluate(client, `(() => ({
      kind: ${JSON.stringify(kind)},
      title: document.title,
      bodyTextLength: document.body.innerText.trim().length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      visibleErrorStates: [...document.querySelectorAll('.ui-error-state')].filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length,
      unresolvedLoading: /正在读取|正在加载/.test(document.body.innerText)
    }))()`))
    client.close()
    await closeTarget(target.id)
  }

  const report = {
    clickedWorkbench,
    conversationOpened: conversationTitle.includes('角色对话中心'),
    conversationCreated: createdConversation && conversationTitle.includes('新对话'),
    clickedCard,
    characterCardOpened: cardText.includes('角色卡'),
    characterStatusRenderedAsGenerated: characterText.includes('当前角色卡\n已生成'),
    absoluteDevelopmentPathVisible: /[A-Z]:\\Users\\/u.test(characterText),
    allSurfacesRendered: surfaceChecks.every((item) => item.bodyTextLength >= 20),
    surfaceOverflowCount: surfaceChecks.filter((item) => item.horizontalOverflow).length,
    surfaceErrorStateCount: surfaceChecks.reduce((total, item) => total + item.visibleErrorStates, 0),
    unresolvedLoadingCount: surfaceChecks.filter((item) => item.unresolvedLoading).length,
    notebookCreateRoundTrip,
    timerRecordRoundTrip,
    timerDeleteRoundTrip,
    appearanceSaveRoundTrip,
    scriptSaveRoundTrip,
    vaultSaveRoundTrip,
    videoSubtitleOpened,
    remoteSiteConfigOpened,
    surfaces: surfaceChecks
  }
  await writeFile(resolve(outputDirectory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`)
  const failed = !report.clickedWorkbench || !report.conversationOpened || !report.conversationCreated || !report.clickedCard || !report.characterCardOpened
    || !report.characterStatusRenderedAsGenerated || report.absoluteDevelopmentPathVisible || !report.allSurfacesRendered
    || report.surfaceOverflowCount > 0 || report.unresolvedLoadingCount > 0 || !report.notebookCreateRoundTrip || !report.timerRecordRoundTrip
    || !report.timerDeleteRoundTrip || !report.appearanceSaveRoundTrip || !report.scriptSaveRoundTrip || !report.vaultSaveRoundTrip
    || !report.videoSubtitleOpened || !report.remoteSiteConfigOpened
  if (failed) {
    throw new Error(`Product Design flow verification failed: ${JSON.stringify(report)}`)
  }
  console.log(JSON.stringify(report, null, 2))
  main.close()
  initial.close()
} finally {
  try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* Process may already be closed. */ }
}

async function seedCharacter(client) {
  await evaluate(client, `(async () => {
    const now = new Date().toISOString();
    const character = {
      roleId: 'product-design-role', name: '设计验收角色', voiceName: 'product-design-voice', roleTitle: '桌面助手',
      cardPath: '', sourceCardJson: '{"name":"设计验收角色"}', templateCardJson: '{"role":"桌面助手"}',
      preferredVoiceId: 'product-design-voice', validationStatus: 'valid', isEnabled: true, updatedAt: now,
      cardSummary: '用于产品设计点击验收。', cardSchemaVersion: '1', templateCardSourceHash: '',
      templateCardGenerationStatus: 'completed', templateCardGenerationMessage: '角色卡已生成',
      templateCardGeneratedAt: now, templateCardLastAttemptAt: now, templateCardIterationCount: 1,
      validationMessage: '字段完整', lastValidatedAt: now, avatarPath: 'C:/Users/demo/avatar.png'
    };
    await window.aimaid.core.invoke({ type: 'character.save', payload: { character } });
    return true;
  })()`)
}

async function clickButton(client, label) {
  return evaluate(client, `(() => {
    const target = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(${JSON.stringify(label)}));
    if (!target) return false;
    target.click();
    return true;
  })()`)
}

async function setInput(client, label, value) {
  return evaluate(client, `(() => {
    const input = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}

async function openContextMenu(client, selector) {
  return evaluate(client, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return false;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
    return true;
  })()`)
}

async function capture(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(resolve(outputDirectory, name), Buffer.from(shot.data, 'base64'))
}

async function closeTarget(id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => undefined)
}

async function waitForPreload(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(client, "typeof window.aimaid?.window?.open === 'function'")) return
    await delay(50)
  }
  throw new Error('Electron preload API did not become ready')
}

async function waitForLoadingToFinish(client, timeoutMs) {
  const attempts = Math.ceil(timeoutMs / 200)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const loading = await evaluate(client, `/正在读取|正在加载/.test(document.body.innerText)`)
    if (!loading) return
    await delay(200)
  }
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
