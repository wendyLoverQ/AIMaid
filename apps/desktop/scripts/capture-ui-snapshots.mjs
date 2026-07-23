import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '../..')
const outputRoot = resolve(repoRoot, 'artifacts/ui-review/current')
const screenshotRoot = join(outputRoot, 'screenshots')
const port = 9357
const transparentKinds = new Set(['pet', 'chat', 'timer', 'tray-menu'])
const timeoutMs = 30_000

const kindsSource = await readFile(resolve(desktopRoot, 'src/shared/windows.ts'), 'utf8')
const registrySource = await readFile(resolve(desktopRoot, 'src/main/windows/window-registry.ts'), 'utf8')
const kindsBlock = kindsSource.match(/WINDOW_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? ''
const windowKinds = [...kindsBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((kind) => registrySource.includes(`${kind}:`) || registrySource.includes(`'${kind}':`))
const registry = Object.fromEntries(windowKinds.map((kind) => [kind, parseDimensions(registrySource, kind)]))
if (windowKinds.length === 0 || Object.values(registry).some(({ width, height }) => width === undefined || height === undefined)) {
  throw new Error('Could not resolve all WINDOW_KINDS dimensions from the current source files')
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(screenshotRoot, { recursive: true })
console.log(`Building desktop and Core before capturing ${windowKinds.length} windows...`)
execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd: desktopRoot, stdio: 'inherit' })

const appPath = resolve(desktopRoot, 'node_modules/electron/dist/electron.exe')
if (!existsSync(appPath)) throw new Error(`Electron executable not found: ${appPath}`)
const app = spawn(appPath, ['.', `--remote-debugging-port=${port}`, '--show-window=main'], {
  cwd: desktopRoot, stdio: 'ignore', windowsHide: true,
  env: { ...process.env, ELECTRON_RENDERER_URL: undefined }
})
const report = []
let initialClient

try {
  const initialTarget = await withTimeout(waitForTarget(() => true), timeoutMs, 'initial window')
  initialClient = await connect(initialTarget.webSocketDebuggerUrl)
  await waitForPreload(initialClient)
  await delay(1_000)

  for (let index = 0; index < windowKinds.length; index += 1) {
    const kind = windowKinds[index]
    const dimensions = registry[kind]
    const prefix = `${String(index + 1).padStart(2, '0')}_${kind}`
    const entry = {
      windowKind: kind, defaultWidth: dimensions.width, defaultHeight: dimensions.height,
      actualWidth: dimensions.width, actualHeight: dimensions.height, route: kind,
      status: 'failed', state: 'error', viewportScreenshot: '', fullScreenshots: [], scrollScreenshots: [],
      scrollable: false, transparentBackgroundAssisted: transparentKinds.has(kind), capturedAt: new Date().toISOString(), error: ''
    }
    try {
      await evaluate(initialClient, `window.aimaid.window.open(${JSON.stringify(kind)})`)
      const target = kind === 'main' ? initialTarget : await withTimeout(waitForTarget((candidate) => candidate.id !== initialTarget.id && candidate.url.includes(`window=${kind}`)), timeoutMs, kind)
      const client = kind === 'main' ? initialClient : await connect(target.webSocketDebuggerUrl)
      try {
        await client.send('Page.enable')
        await client.send('Runtime.enable')
        await withTimeout(waitForReady(client), timeoutMs, `${kind} renderer`)
        await delay(350)
        if (transparentKinds.has(kind)) await evaluate(client, neutralizeTransparency())
        const viewport = await evaluate(client, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })')
        entry.actualWidth = viewport.width
        entry.actualHeight = viewport.height
        const viewportFile = `${prefix}_${dimensions.width}x${dimensions.height}.png`
        await capture(client, viewportFile)
        entry.viewportScreenshot = `screenshots/${viewportFile}`
        const scroll = await evaluate(client, findScrollState())
        entry.scrollable = scroll.scrollable
        if (scroll.scrollable) {
          if (scroll.kind === 'document' && scroll.height <= 12_000) {
            const fullFile = `${prefix}_full.png`
            await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: viewport.width, height: scroll.height, scale: 1 } }).then((result) => writeFile(join(screenshotRoot, fullFile), Buffer.from(result.data, 'base64')))
            entry.fullScreenshots.push(`screenshots/${fullFile}`)
          } else {
            const segmentCount = Math.ceil(scroll.height / Math.max(1, viewport.height))
            for (let segment = 0; segment < segmentCount; segment += 1) {
              await evaluate(client, `window.__aimaidScroll(${segment * viewport.height})`)
              await delay(100)
              const file = `${prefix}_scroll_${String(segment + 1).padStart(2, '0')}.png`
              await capture(client, file)
              entry.scrollScreenshots.push(`screenshots/${file}`)
            }
            await evaluate(client, 'window.__aimaidScroll(0)')
          }
        }
        entry.status = 'captured'
        entry.state = classifyState(await evaluate(client, 'document.body.innerText'))
      } finally {
        if (kind !== 'main') {
          client.close()
          await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined)
        }
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
    }
    report.push(entry)
    await writeManifest(report)
    console.log(`${kind}: ${entry.status}`)
  }
} finally {
  initialClient?.close()
  try { app.kill() } catch {}
  try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
}

await writeManifest(report)
await writeIndex(report)
await createPdf()
await createZip()
const failures = report.filter((entry) => entry.status !== 'captured')
if (failures.length > 0) {
  console.error(`${failures.length} window(s) failed; see ${join(outputRoot, 'manifest.json')}`)
  process.exitCode = 1
}

function parseDimensions(source, kind) {
  const start = Math.max(source.indexOf(`${kind}:`), source.indexOf(`'${kind}':`))
  const line = source.slice(start).split('\n', 1)[0]
  const module = line.match(/moduleWindow\('[^']+',\s*(\d+),\s*(\d+)/)
  if (module) return { width: Number(module[1]), height: Number(module[2]) }
  const end = source.indexOf('\n  },', start)
  const section = source.slice(start, end < 0 ? start + 500 : end)
  const direct = section.match(/width:\s*(\d+)[\s\S]*?height:\s*(\d+)/)
  const match = direct
  return { width: match ? Number(match[1]) : undefined, height: match ? Number(match[2]) : undefined }
}

async function writeManifest(entries) { await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), windowKinds, entries }, null, 2)}\n`) }
function classifyState(text) { return /error|失败|错误/i.test(text) ? 'error' : /暂无|没有|空状态|未找到/i.test(text) ? 'empty' : 'normal' }
async function capture(client, file) { const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await writeFile(join(screenshotRoot, file), Buffer.from(shot.data, 'base64')) }
function neutralizeTransparency() { return `(() => { const style = document.createElement('style'); style.id = 'aimaid-snapshot-background'; style.textContent = 'html,body{background-color:#d9dde3!important;background-image:linear-gradient(45deg,#c9ced6 25%,transparent 25%),linear-gradient(-45deg,#c9ced6 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#c9ced6 75%),linear-gradient(-45deg,transparent 75%,#c9ced6 75%)!important;background-size:24px 24px!important;background-position:0 0,0 12px,12px -12px,-12px 0!important;}'; document.head.append(style); window.__aimaidSnapshotBackgroundAssisted = true; })()` }
function findScrollState() { return `(() => { const visible = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 }; const candidates = [...document.querySelectorAll('*')].filter(e => visible(e) && e.scrollHeight > e.clientHeight + 8 && ['auto','scroll'].includes(getComputedStyle(e).overflowY)); const target = candidates.sort((a,b) => b.scrollHeight-a.scrollHeight)[0]; window.__aimaidScroll = (value) => { if (target) target.scrollTop = value; else window.scrollTo(0,value) }; const height = target?.scrollHeight ?? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight); return { scrollable: Boolean(target) || height > innerHeight + 8, kind: target ? 'container' : 'document', height }; })()` }
async function waitForReady(client) { for (;;) { const ready = await evaluate(client, 'document.readyState === "complete"'); if (ready) return; await delay(100) } }
async function waitForPreload(client) { for (let i = 0; i < 300; i += 1) { if (await evaluate(client, 'typeof window.aimaid?.window?.open === "function"')) return; await delay(100) }; throw new Error('Electron preload API did not become ready') }
async function waitForTarget(predicate) { let last = []; for (let i = 0; i < 300; i += 1) { try { const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()); last = targets; const target = targets.find((item) => item.type === 'page' && predicate(item)); if (target) return target } catch {} await delay(100) }; throw new Error(`Timed out waiting for renderer target: ${JSON.stringify(last.map(({ title, url }) => ({ title, url })))}`) }
async function connect(url) { const socket = new WebSocket(url); await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }) }); let id = 0; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result) }); return { send(method, params = {}) { const requestId = ++id; socket.send(JSON.stringify({ id: requestId, method, params })); return new Promise((resolveSend, reject) => pending.set(requestId, { resolve: resolveSend, reject })) }, close() { socket.close() } } }
async function evaluate(client, expression) { const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed'); return result.result.value }
async function withTimeout(promise, ms, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms) })]) } finally { clearTimeout(timer) } }

async function writeIndex(entries) {
  const cards = entries.map((entry) => {
    const images = [entry.viewportScreenshot, ...entry.fullScreenshots, ...entry.scrollScreenshots].filter(Boolean)
      .map((path, index) => `<a href="${path}"><img src="${path}" alt="${escapeHtml(entry.windowKind)} ${index === 0 ? 'default' : index}"></a>`).join('')
    return `<article><h2>${escapeHtml(entry.windowKind)}</h2><p>${entry.defaultWidth} × ${entry.defaultHeight} · ${entry.status} · ${entry.state}</p>${images || `<pre>${escapeHtml(entry.error)}</pre>`}</article>`
  }).join('\n')
  await writeFile(join(outputRoot, 'index.html'), `<!doctype html><meta charset="utf-8"><title>AIMaid UI snapshots</title><style>body{margin:0;padding:24px;background:#eef1f5;color:#18212b;font:14px system-ui}main{display:grid;gap:24px;max-width:1500px;margin:auto}article{break-inside:avoid;page-break-before:always;padding:16px;background:#fff;border:1px solid #cbd3dc;border-radius:8px}article:first-child{page-break-before:auto}h2{margin:0 0 6px}p{color:#596675}img{display:block;max-width:100%;height:auto;margin:0 0 12px}pre{white-space:pre-wrap;color:#a22}</style><main>${cards}</main>\n`)
}
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
async function createPdf() { const helper = join(outputRoot, '.print-pdf.cjs'); await writeFile(helper, `const {app,BrowserWindow}=require('electron'); const path=require('node:path'); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false}); await w.loadFile(path.join(__dirname,'index.html')); const pdf=await w.webContents.printToPDF({printBackground:true,preferCSSPageSize:true}); require('node:fs').writeFileSync(path.join(__dirname,'AIMaid_UI截图总览.pdf'),pdf); await app.quit()})`); execFileSync(appPath, [helper], { cwd: outputRoot, stdio: 'ignore' }); await rm(helper, { force: true }) }
async function createZip() { const zip = join(outputRoot, 'AIMaid_UI截图原图.zip'); execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath 'screenshots','manifest.json','index.html' -DestinationPath '${zip}' -Force`], { cwd: outputRoot, stdio: 'ignore' }) }
