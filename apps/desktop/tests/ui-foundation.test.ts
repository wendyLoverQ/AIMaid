import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const filesUnder = (path: string, extension: string): string[] => readdirSync(resolve(desktopRoot, path), { withFileTypes: true }).flatMap((entry) => {
  const relative = `${path}/${entry.name}`
  return entry.isDirectory() ? filesUnder(relative, extension) : entry.name.endsWith(extension) ? [relative] : []
})

describe('renderer UI foundation', () => {
  it('defines every required design token category', () => {
    const tokens = read('src/renderer/theme/tokens.css')
    for (const token of [
      '--color-accent', '--font-family-sans', '--font-size-md', '--font-weight-semibold', '--line-height-normal',
      '--space-3', '--radius-md', '--border-default', '--shadow-md', '--z-dialog', '--duration-normal', '--ease-standard'
    ]) {
      expect(tokens).toContain(token)
    }
    for (const exact of [
      '--space-1: 2px', '--space-2: 4px', '--space-3: 6px', '--space-11: 48px',
      '--radius-sm: 6px', '--radius-md: 8px', '--radius-lg: 10px', '--radius-xl: 12px',
      '--control-height-xs: 24px', '--control-height-sm: 28px', '--control-height-md: 36px',
      '--control-height-lg: 44px', '--control-height-xl: 52px', '--duration-fast: 100ms',
      '--duration-normal: 140ms', '--duration-overlay-in: 180ms', '--duration-page: 220ms'
    ]) expect(tokens).toContain(exact)
  })

  it('exports the complete reusable UI surface', () => {
    const exports = read('src/renderer/components/ui.ts')
    for (const component of [
      'Button', 'IconButton', 'Input', 'Textarea', 'FormField', 'Select', 'Checkbox', 'RadioGroup',
      'Switch', 'Range', 'Slider', 'SearchBox', 'Combobox', 'SegmentedControl', 'Alert', 'Tag', 'Card', 'Accordion',
      'DataTable', 'Pagination', 'ConfirmDialog', 'FilePicker', 'AudioPlayer', 'AudioRecordRow',
      'SettingsSection', 'PageHeader', 'Toolbar', 'Tree', 'Spinner', 'CircularProgress', 'ScrollArea', 'Tooltip', 'Popover', 'Dialog', 'Drawer'
    ]) expect(exports, `${component} must be exported by components/ui`).toMatch(new RegExp(`\\b${component}\\b`, 'u'))
  })

  it('keeps loading buttons stable and disables duplicate submission', () => {
    const button = read('src/renderer/components/base/Button.tsx')
    expect(button).toContain("disabled={disabled === true || loading}")
    expect(button).toContain('ui-button__content--loading')
    expect(read('src/renderer/components/components.css')).toContain('.ui-button__content--loading { visibility: hidden; }')
  })

  it('has theme palettes but no dark, light, or system-following mode', () => {
    const catalog = read('src/renderer/pages/appearance/AppearanceSettingsPage.tsx')
    const runtime = read('src/renderer/pages/appearance/appearance-runtime.ts')
    const visibleCatalog = catalog.slice(catalog.indexOf('const THEMES'), catalog.indexOf('const DEFAULT_CONFIGURATION'))
    expect(visibleCatalog).not.toMatch(/_dark|深色|暗色|深黑|夜莺/iu)
    expect(runtime).not.toContain("root.style.colorScheme = dark ? 'dark' : 'light'")
    expect(runtime).not.toContain('prefers-color-scheme')
    expect(runtime).toContain("root.style.colorScheme = 'only light'")
  })

  it('keeps direct Electron bridge access inside renderer/shared/bridge', () => {
    const pageSources = [
      'src/renderer/App.tsx',
      'src/renderer/pages/main/MainPage.tsx',
      'src/renderer/pages/status/StatusPage.tsx',
      'src/renderer/pages/pet/PetPage.tsx',
      'src/renderer/pages/settings/SettingsPage.tsx'
    ].map(read).join('\n')
    expect(pageSources).not.toContain('window.aimaid')
    expect(pageSources).not.toContain('ipcRenderer')
  })

  it('only imports the Live2D boundary from PetWindow code', () => {
    const app = read('src/renderer/App.tsx')
    const mainPage = read('src/renderer/pages/main/MainPage.tsx')
    const statusPage = read('src/renderer/pages/status/StatusPage.tsx')
    const petPage = read('src/renderer/pages/pet/PetPage.tsx')
    expect(app).toContain("lazy(() => import('./pages/pet/PetPage'))")
    expect(mainPage).not.toContain('live2d')
    expect(statusPage).not.toContain("from '../../live2d")
    expect(petPage).toContain("from '../../live2d/pet-runtime'")
  })

  it('builds the sandboxed preload as CommonJS', () => {
    expect(read('electron.vite.config.ts')).toContain("entryFileNames: '[name].cjs'")
    expect(read('src/main/windows/window-factory.ts')).toContain("../preload/index.cjs")
  })

  it('forces every renderer window through the global UI root', () => {
    const entry = read('src/renderer/src.tsx')
    expect(entry).toContain("from './theme/GlobalUiRoot'")
    expect(entry).toContain('<GlobalUiRoot>')
    expect(read('src/renderer/styles.css')).toContain('@import "./theme/tokens.css"')
    expect(read('src/renderer/styles.css')).toContain('@import "./components/components.css"')
  })

  it('forbids page-level native controls and custom menu primitives', () => {
    const sources = [...filesUnder('src/renderer/pages', '.tsx'), ...filesUnder('src/renderer/features', '.tsx')]
    for (const source of sources) {
      const value = read(source)
      expect(value, `${source} must use global UI controls`).not.toMatch(/<(?:button|input|select|textarea|dialog|table)\b/u)
      expect(value, `${source} must not simulate buttons with div`).not.toMatch(/<div[^>]*\bonClick=/u)
      expect(value, `${source} must use global overlay controls`).not.toMatch(/role=["']menu(?:item)?["']/u)
    }
  })

  it('forbids visual color literals outside the global token and appearance catalogs', () => {
    const styles = [...filesUnder('src/renderer/pages', '.css'), ...filesUnder('src/renderer/features', '.css')]
    for (const source of styles) {
      expect(read(source), `${source} must use global color tokens`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu)
    }
  })

  it('uses one viewport and keeps scrolling inside page-owned content regions', () => {
    const globalStyles = read('src/renderer/styles.css')
    expect(globalStyles).toMatch(/html, body, #root \{[^}]*height: 100%;[^}]*overflow: hidden;/u)
    expect(globalStyles).toMatch(/#root > \.ui-container:has\(> \.ui-titlebar\) \{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/u)

    const styles = [...filesUnder('src/renderer/pages', '.css'), ...filesUnder('src/renderer/features', '.css')]
    for (const source of styles) {
      expect(read(source), `${source} must not subtract fixed pixels from the viewport`).not.toMatch(/calc\(100vh\s*-\s*\d/u)
    }
  })

  it('uses the shared product workspace for media, tools, and system windows', () => {
    const exports = read('src/renderer/components/ui.ts')
    for (const name of ['ProductPage', 'ProductWorkspace', 'ProductPanel', 'ProductSidebar', 'ProductToolbar', 'ProductStatusBar', 'ProductHero', 'ProductMetric']) {
      expect(exports, `${name} must be exported from components/ui`).toContain(name)
    }

    const sources = [
      'src/renderer/pages/video/VideoLibraryPage.tsx',
      'src/renderer/pages/video/VideoSubwindows.tsx',
      'src/renderer/pages/remote-video/RemoteVideoPage.tsx',
      'src/renderer/pages/remote-video/RemoteSiteConfigPage.tsx',
      'src/renderer/pages/bitcoin/BitcoinPage.tsx',
      'src/renderer/pages/bitcoin/CryptoSubwindowPages.tsx',
      'src/renderer/pages/timer/TimerPage.tsx',
      'src/renderer/pages/vault/VaultPage.tsx',
      'src/renderer/pages/scripts/ScriptsPage.tsx',
      'src/renderer/pages/system/AgentConfirmPage.tsx'
    ]
    for (const source of sources) {
      expect(read(source), `${source} must use ProductPage`).toContain('<ProductPage>')
      expect(read(source), `${source} must use ProductWorkspace`).toContain('<ProductWorkspace')
    }
  })

  it('keeps key settings and remote-video controls connected to recoverable actions', () => {
    const settings = read('src/renderer/pages/settings/SettingsPage.tsx')
    const remoteVideo = read('src/renderer/pages/remote-video/RemoteVideoPage.tsx')
    const voiceConversation = read('src/renderer/pages/voice-conversation/VoiceConversationPage.tsx')
    const scripts = read('src/renderer/pages/scripts/ScriptsPage.tsx')
    expect(settings).toContain("execute('switch-live2d-role')")
    expect(settings).toContain('onChange={(event) => void setLive2dRole(event.target.value)}')
    expect(settings).toContain('type="password" autoComplete="new-password"')
    expect(remoteVideo).toContain('async function pasteFromClipboard()')
    expect(remoteVideo).toContain("disabled={busy || url.trim() === ''}")
    expect(voiceConversation).toContain('action={<Button variant="primary"')
    expect(voiceConversation).toContain("bridge.window.open('characters')")
    expect(scripts).toContain('disabled={launcherId === \'\'}')
    expect(scripts).toContain('disabled={!canSave}')
  })

  it('keeps the responsive system-settings page vertically scrollable', () => {
    const settings = read('src/renderer/pages/settings/SettingsPage.tsx')
    const styles = read('src/renderer/components/components.css')
    expect(settings).toContain('<PageContent scroll={false}><LayoutSlot variant="settings-workspace">')
    expect(styles).toContain('.settings-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); height: 100%; }')
    expect(styles).toContain('.settings-content { padding: 0; overflow: auto; }')
    expect(styles).toContain('.settings-content__header { padding-top: var(--space-4); }')
  })

  it('renders the registered character avatar inside the bounded detail preview', () => {
    const styles = read('src/renderer/components/components.css')
    expect(styles).toContain('.character-summary .ui-visual-region > .ui-avatar--preview { width: 100%; height: 100%; border: 0; border-radius: 0; }')
    expect(styles).toContain('.character-summary .ui-visual-region > .ui-avatar--preview img { object-fit: cover; }')
  })

  it('keeps the character columns fixed and scrolls only the role list', () => {
    const source = read('src/renderer/features/characters/CharacterPage.tsx')
    const styles = read('src/renderer/components/components.css')
    expect(source).toContain('<PageContent scroll={false}>')
    expect(source).toContain('<LayoutSlot variant="character-page-layout">')
    expect(source).toContain('<Surface variant="character-detail">')
    expect(source).not.toContain('<Surface variant="character-detail" scroll>')
    expect(styles).toContain('.character-page-layout { display: grid; grid-template-rows: auto minmax(0, 1fr);')
    expect(styles).toContain('.character-workspace { display: grid; grid-template-columns: minmax(18.75rem, 21.25rem) minmax(0, 1fr); gap: var(--space-4); min-height: 0; height: 100%; overflow: hidden; }')
    expect(styles).toContain('.character-navigation .ui-listbox { min-height: 0; align-content: start; grid-auto-rows: max-content; overflow: auto; }')
    expect(styles).toContain('.character-detail { height: 100%; align-content: start; overflow: hidden; }')
  })

  it('connects role avatars and bottom scrolling in the voice conversation center', () => {
    const source = read('src/renderer/pages/voice-conversation/VoiceConversationPage.tsx')
    expect(source).toContain('bridge.media.registerLocalFile(item.avatarPath)')
    expect(source).toContain('leading={<Avatar source={avatarUrls[item.voiceRoleId]')
    expect(source).toContain("source={fromUser ? '' : avatarUrls[messageRole?.roleId ?? ''] ?? ''}")
    expect(source).toContain("document.querySelector<HTMLElement>('.conversation-messages')")
    expect(source).toContain('viewport.scrollTop = viewport.scrollHeight')
  })

  it('keeps the vault filters within the fixed sidebar width', () => {
    const vault = read('src/renderer/pages/vault/VaultPage.tsx')
    const styles = read('src/renderer/components/components.css')
    expect(vault).toContain('<ProductToolbar layout="stacked"')
    expect(styles).toContain('.ui-product-toolbar--stacked { grid-template-columns: minmax(0, 1fr); align-items: stretch; }')
    expect(styles).toContain('.ui-product-toolbar--stacked .ui-product-toolbar__actions .ui-field { width: 100%; min-width: 0; }')
  })

  it('shows script names before their command shortcuts', () => {
    const scripts = read('src/renderer/pages/scripts/ScriptsPage.tsx')
    expect(scripts).toContain('<Strong>{item.displayName}</Strong><InlineText>{item.commandText}</InlineText>')
  })

})
