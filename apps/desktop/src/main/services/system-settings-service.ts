import { app, globalShortcut } from 'electron'
import { randomUUID } from 'node:crypto'
import type { CoreClient } from '../core/core-client'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'
import type { PetWindowManager } from '../windows/pet-window-manager'
import type { PetPresentationService } from './pet-presentation-service'
import { WINDOW_POSITION_SETTING_PREFIX, WINDOW_SIZE_SETTING_PREFIX } from '../windows/window-manager'
import { WINDOW_REGISTRY } from '../windows/window-registry'
import { HOTKEY_ACTIONS, isHotkeyAction } from '../../shared/system-settings'
import type { HotkeyAction, HotkeyBindingSnapshot, PlatformSettingsSnapshot } from '../../shared/system-settings'

interface CoreSettingsPayload {
  settings?: Array<{ key: string; value: string }>
}

export class SystemSettingsService {
  private readonly registered = new Map<HotkeyAction, string>()
  private values = new Map<string, string>()
  private bubbleCssKey: string | undefined

  constructor(
    private readonly windows: WindowManager,
    private readonly petWindows: PetWindowManager,
    private readonly presentation: PetPresentationService,
    private readonly core: CoreClient,
    private readonly log: Logger
  ) {}

  async initialize(): Promise<void> {
    await this.reload()
    this.windows.restoreSizes(this.values)
    this.windows.restorePositions(this.values)
    for (const definition of HOTKEY_ACTIONS) {
      const gesture = this.values.get(definition.settingKey) ?? definition.defaultGesture
      if (gesture !== '') this.tryRegister(definition.action, gesture)
    }
  }

  async getSnapshot(): Promise<PlatformSettingsSnapshot> {
    await this.reload()
    const login = app.getLoginItemSettings()
    return {
      autoStartEnabled: login.openAtLogin,
      hotkeys: HOTKEY_ACTIONS.map((definition): HotkeyBindingSnapshot => {
        const gesture = this.values.get(definition.settingKey) ?? definition.defaultGesture
        return {
          action: definition.action,
          label: definition.label,
          gesture,
          registered: gesture === '' || this.registered.get(definition.action) === toAccelerator(gesture)
        }
      })
    }
  }

  async setAutoStart(enabled: boolean): Promise<PlatformSettingsSnapshot> {
    const previous = app.getLoginItemSettings().openAtLogin
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false })
    try {
      await this.saveCore({ start_with_windows: String(enabled) })
    } catch (error) {
      app.setLoginItemSettings({ openAtLogin: previous, openAsHidden: false })
      throw error
    }
    return this.getSnapshot()
  }

  async setHotkey(actionValue: unknown, gestureValue: unknown): Promise<PlatformSettingsSnapshot> {
    if (!isHotkeyAction(actionValue) || typeof gestureValue !== 'string') throw new TypeError('快捷键参数无效。')
    const gesture = normalizeGesture(gestureValue)
    const definition = HOTKEY_ACTIONS.find((item) => item.action === actionValue)!
    const duplicate = HOTKEY_ACTIONS.find((item) => item.action !== actionValue &&
      normalizeGesture(this.values.get(item.settingKey) ?? item.defaultGesture).toLocaleLowerCase() === gesture.toLocaleLowerCase() && gesture !== '')
    if (duplicate !== undefined) throw new Error(`按键组合“${gesture}”已被“${duplicate.label}”占用。`)

    const previousGesture = this.values.get(definition.settingKey) ?? definition.defaultGesture
    const previous = this.registered.get(actionValue)
    if (previous !== undefined) globalShortcut.unregister(previous)
    this.registered.delete(actionValue)
    if (gesture !== '' && !this.tryRegister(actionValue, gesture)) {
      this.restoreHotkey(actionValue, previousGesture, new Error(`无法注册全局快捷键“${gesture}”，它可能已被其他应用占用。`))
    }
    try {
      await this.saveCore({ [definition.settingKey]: gesture })
      this.values.set(definition.settingKey, gesture)
    } catch (error) {
      const current = this.registered.get(actionValue)
      if (current !== undefined) globalShortcut.unregister(current)
      this.registered.delete(actionValue)
      this.restoreHotkey(actionValue, previousGesture, error)
    }
    return this.getSnapshot()
  }

  async setBubbleStyle(value: string): Promise<{ style: string }> {
    if (!['', 'normal', 'soft', 'lively', 'close'].includes(value)) throw new TypeError('气泡主题值无效。')
    await this.saveCore({ comic_bubble_style: value })
    this.values.set('comic_bubble_style', value)
    await this.applyBubbleStyle(value)
    return { style: value }
  }

  async applyVisualSettings(): Promise<void> {
    await this.applyBubbleStyle(this.values.get('comic_bubble_style') ?? '')
  }

  async dispose(): Promise<void> {
    const windowPlacements = { ...this.windows.sizeSettings(), ...this.windows.positionSettings() }
    try {
      if (Object.keys(windowPlacements).length > 0) await this.saveCore(windowPlacements)
    } finally {
      for (const accelerator of this.registered.values()) globalShortcut.unregister(accelerator)
      this.registered.clear()
    }
  }

  private async applyBubbleStyle(style: string): Promise<void> {
    const pet = this.windows.get('pet')
    if (pet === undefined) return
    if (this.bubbleCssKey !== undefined) {
      await pet.webContents.removeInsertedCSS(this.bubbleCssKey)
      this.bubbleCssKey = undefined
    }
    const css = bubbleStyleCss(style)
    if (css !== '') this.bubbleCssKey = await pet.webContents.insertCSS(css, { cssOrigin: 'author' })
  }

  private tryRegister(action: HotkeyAction, gesture: string): boolean {
    const accelerator = toAccelerator(gesture)
    const registered = globalShortcut.register(accelerator, () => { void this.execute(action) })
    if (registered) this.registered.set(action, accelerator)
    else this.log.warn('hotkey', 'Failed to register configured hotkey', { action, accelerator })
    return registered
  }

  private restoreHotkey(action: HotkeyAction, gesture: string, originalError: unknown): never {
    if (gesture === '') throw originalError instanceof Error ? originalError : new Error(String(originalError))
    if (gesture !== '' && this.tryRegister(action, gesture)) {
      throw originalError instanceof Error ? originalError : new Error(String(originalError))
    }
    const original = originalError instanceof Error ? originalError.message : String(originalError)
    throw new Error(`快捷键操作失败：${original}；回滚失败：无法恢复旧快捷键“${gesture}”。`, { cause: originalError })
  }

  private async execute(action: HotkeyAction): Promise<void> {
    const definition = HOTKEY_ACTIONS.find((item) => item.action === action)!
    if ('target' in definition && definition.target !== undefined) {
      const shown = this.windows.toggle(definition.target, 'pet', { trigger: 'global-hotkey' })
      const targetWindow = shown ? this.windows.get(definition.target) : undefined
      if (targetWindow !== undefined && this.windows.shouldPositionAtPet(definition.target)) {
        await this.petWindows.positionWindowAtItem(targetWindow)
        this.windows.rememberPosition(definition.target)
      }
      return
    }
    const parent = this.windows.get('pet')
    if (parent === undefined) return
    if (action === 'cycle-display-mode') await this.presentation.executeAction('cycle-mode', parent)
    else if (action === 'cycle-display-mode-reverse') this.presentation.executeHotkey('cycle-mode-reverse')
    else if (action === 'play-next') {
      const mode = this.presentation.currentMode()
      await this.presentation.executeAction(mode === 'image' ? 'next-image' : mode === 'png-sequence' ? 'cycle-png-role' : 'switch-live2d-role', parent)
    } else if (action === 'play-previous') this.presentation.executeHotkey('play-previous')
    this.petWindows.notifyPresentationChanged()
  }

  private async reload(): Promise<void> {
    const windowSizeKeys = Object.values(WINDOW_REGISTRY)
      .filter((definition) => definition.options.resizable === true)
      .map((definition) => `${WINDOW_SIZE_SETTING_PREFIX}${definition.id}`)
    const windowPositionKeys = Object.values(WINDOW_REGISTRY)
      .map((definition) => `${WINDOW_POSITION_SETTING_PREFIX}${definition.id}`)
    const keys = ['start_with_windows', 'comic_bubble_style', ...HOTKEY_ACTIONS.map((item) => item.settingKey), ...windowSizeKeys, ...windowPositionKeys]
    const payload = await this.invokeCore({ type: 'settings.get', payload: { keys } }) as CoreSettingsPayload
    this.values = new Map((payload.settings ?? []).map((item) => [item.key, item.value]))
  }

  private async saveCore(values: Record<string, string>): Promise<void> {
    await this.invokeCore({ type: 'settings.save', payload: { values } })
  }

  private async invokeCore(request: Parameters<CoreClient['invoke']>[1]): Promise<unknown> {
    const controller = new AbortController()
    return this.core.invoke(randomUUID(), request, controller.signal)
  }
}

function normalizeGesture(value: string): string {
  const raw = value.trim()
  if (raw === '') return ''
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  const key = normalizeKey(parts.at(-1)!)
  if (['Ctrl', 'Alt', 'Shift', 'Win'].includes(key)) throw new TypeError('快捷键必须包含一个非修饰键。')
  const modifiers = new Set(parts.slice(0, -1).map(normalizeModifier))
  return [...['Ctrl', 'Alt', 'Shift', 'Win'].filter((item) => modifiers.has(item)), key].join('+')
}

function normalizeModifier(value: string): string {
  const normalized = value.toLocaleLowerCase()
  if (normalized === 'control' || normalized === 'ctrl') return 'Ctrl'
  if (normalized === 'alt') return 'Alt'
  if (normalized === 'shift') return 'Shift'
  if (normalized === 'meta' || normalized === 'super' || normalized === 'win') return 'Win'
  throw new TypeError(`不支持的快捷键修饰键：${value}`)
}

function normalizeKey(value: string): string {
  const aliases: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space' }
  return aliases[value] ?? (value.length === 1 ? value.toUpperCase() : value)
}

function toAccelerator(gesture: string): string {
  return normalizeGesture(gesture).split('+').map((part) => part === 'Ctrl' ? 'CommandOrControl' : part === 'Win' ? 'Super' : part).join('+')
}

function bubbleStyleCss(style: string): string {
  const declarations: Record<string, string> = {
    normal: 'background:#fffdf8;border-color:#29251f;color:#241f19;box-shadow:0 12px 34px rgba(43,35,26,.18)',
    soft: 'background:#fff5f8;border-color:#d9a7b6;color:#5a3440;box-shadow:0 12px 34px rgba(190,125,147,.2)',
    lively: 'background:#fff7d6;border-color:#df9d24;color:#5b3900;box-shadow:0 12px 34px rgba(223,157,36,.25)',
    close: 'background:#ffe9ef;border-color:#d66382;color:#67263a;box-shadow:0 12px 34px rgba(214,99,130,.28)'
  }
  const value = declarations[style]
  return value === undefined ? '' : `.ui-pet-bubble{${value}}`
}
