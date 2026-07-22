export interface UserConfigurationFieldView {
  key: string
  label: string
  description: string
  kind: 'text' | 'boolean' | 'integer' | 'url'
}

export interface UserConfigurationGroupView {
  name: string
  fields: readonly UserConfigurationFieldView[]
}

const field = (key: string, label: string, description: string, kind: UserConfigurationFieldView['kind'] = 'text'): UserConfigurationFieldView => ({ key, label, description, kind })

// Only settings with a live consumer in the current Core are surfaced here.
// The remaining legacy catalog must not become clickable persistence-only UI.
export const USER_CONFIGURATION_GROUPS: readonly UserConfigurationGroupView[] = [
  {
    name: '网络', fields: [
      field('App:Proxy:Address', '网络代理', '状态探测等 Core 网络请求使用的 HTTP/HTTPS 代理地址，例如 127.0.0.1:6324。')
    ]
  },
  {
    name: 'TTS', fields: [
      field('App:Tts:Enabled', '启用 TTS', '是否启用语音合成服务。', 'boolean'),
      field('App:Tts:Endpoint', 'TTS 服务地址', '语音合成 HTTP 服务地址。', 'url'),
      field('App:Tts:StartScriptPath', 'TTS 启动脚本', '本地 TTS 服务启动脚本的完整路径。'),
      field('App:Tts:WorkingDirectory', 'TTS 工作目录', '启动 TTS 服务时使用的工作目录。'),
      field('App:Tts:StartupTimeoutSeconds', '启动超时（秒）', '等待本地 TTS 服务健康的基础超时时间。', 'integer'),
      field('App:Tts:RequestTimeoutSeconds', '请求超时（秒）', '单次语音合成请求的超时时间。', 'integer'),
      field('App:Tts:VoiceId', '默认音色 ID', '没有角色级音色资产映射时发送给外部 TTS 服务的默认音色。')
    ]
  },
  {
    name: '语音识别', fields: [
      field('App:Asr:Enabled', '启用语音识别', '在角色对话中心使用 AIProvider 将录音转成文字。', 'boolean'),
      field('App:Asr:Endpoint', 'AIProvider 服务地址', 'AIProvider 的 HTTP/HTTPS 根地址，不包含 /api/asr/transcriptions。', 'url'),
      field('App:Asr:RequestTimeoutSeconds', '识别超时（秒）', '单次录音上传和识别的最长等待时间。', 'integer')
    ]
  }
]
