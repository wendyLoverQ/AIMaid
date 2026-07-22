import type { WindowKind } from './windows'

export const HOTKEY_ACTIONS = [
  { action: 'open-chat', label: '聊天输入', settingKey: 'hotkey_open_chat', defaultGesture: 'Ctrl+Shift+F', target: 'chat' },
  { action: 'open-voice-input', label: '语音快速输入', settingKey: 'hotkey_open_voice_input', defaultGesture: 'Ctrl+Shift+S', target: 'voice-input' },
  { action: 'open-workbench', label: '工作台', settingKey: 'hotkey_open_workbench', defaultGesture: '', target: 'main' },
  { action: 'open-character-manager', label: '角色管理', settingKey: 'hotkey_open_character_manager', defaultGesture: '', target: 'characters' },
  { action: 'open-notebook', label: '记事本', settingKey: 'hotkey_open_notebook', defaultGesture: 'Ctrl+Shift+R', target: 'notebook' },
  { action: 'open-status', label: '状态面板', settingKey: 'hotkey_open_status', defaultGesture: 'Ctrl+Shift+T', target: 'status' },
  { action: 'open-system-settings', label: '系统设置', settingKey: 'hotkey_open_system_settings', defaultGesture: 'Ctrl+Shift+G', target: 'settings' },
  { action: 'open-appearance-settings', label: '外观设置', settingKey: 'hotkey_open_appearance_settings', defaultGesture: '', target: 'appearance' },
  { action: 'open-timer', label: '计时器', settingKey: 'hotkey_open_timer', defaultGesture: '', target: 'timer' },
  { action: 'open-reminders', label: '提醒事项', settingKey: 'hotkey_open_reminders', defaultGesture: '', target: 'reminders' },
  { action: 'open-vault', label: '密码库', settingKey: 'hotkey_open_vault', defaultGesture: 'Ctrl+Shift+P', target: 'vault' },
  { action: 'open-video-library', label: '视频库', settingKey: 'hotkey_open_video_library', defaultGesture: 'Ctrl+Shift+V', target: 'video' },
  { action: 'open-remote-video-center', label: '远程视频中心', settingKey: 'hotkey_open_remote_video_center', defaultGesture: 'Ctrl+Shift+Y', target: 'remote-video' },
  { action: 'open-voice-conversation-center', label: '角色对话中心', settingKey: 'hotkey_open_voice_conversation_center', defaultGesture: 'Ctrl+Shift+C', target: 'voice-conversation' },
  { action: 'open-command-manager', label: '快捷脚本', settingKey: 'hotkey_open_command_manager', defaultGesture: '', target: 'scripts' },
  { action: 'open-bitcoin-market', label: 'BTC 行情', settingKey: 'hotkey_open_bitcoin_market', defaultGesture: 'Ctrl+Shift+B', target: 'bitcoin' },
  { action: 'cycle-display-mode', label: '切换显示模式', settingKey: 'hotkey_cycle_display_mode', defaultGesture: 'Ctrl+Right' },
  { action: 'cycle-display-mode-reverse', label: '反向切换显示模式', settingKey: 'hotkey_cycle_display_mode_reverse', defaultGesture: 'Ctrl+Left' },
  { action: 'play-next', label: '播放下一个', settingKey: 'hotkey_play_next', defaultGesture: 'Ctrl+Down' },
  { action: 'play-previous', label: '播放上一个', settingKey: 'hotkey_play_previous', defaultGesture: 'Ctrl+Up' }
] as const satisfies readonly HotkeyDefinition[]

export interface HotkeyDefinition {
  action: string
  label: string
  settingKey: string
  defaultGesture: string
  target?: WindowKind
}

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]['action']

export interface HotkeyBindingSnapshot {
  action: HotkeyAction
  label: string
  gesture: string
  registered: boolean
}

export interface PlatformSettingsSnapshot {
  autoStartEnabled: boolean
  hotkeys: HotkeyBindingSnapshot[]
}

export function isHotkeyAction(value: unknown): value is HotkeyAction {
  return typeof value === 'string' && HOTKEY_ACTIONS.some((item) => item.action === value)
}
