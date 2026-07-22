import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceInputOrb } from '../../components/ui'
import type { VoiceInputOrbState } from '../../components/ui'
import { loadCharacters } from '../../features/characters/character-api'
import { bridge } from '../../shared/bridge'

export function VoiceInputPage(): React.JSX.Element {
  const [state, setState] = useState<VoiceInputOrbState>('starting')
  const [message, setMessage] = useState('正在打开麦克风')
  const recorderRef = useRef<MediaRecorder | undefined>(undefined)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const chunksRef = useRef<Blob[]>([])
  const characterIdRef = useRef('')
  const disposedRef = useRef(false)
  const discardRecordingRef = useRef(false)

  const fail = useCallback((reason: unknown): void => {
    discardRecordingRef.current = true
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = undefined
    setState('error')
    setMessage(reason instanceof Error ? reason.message : String(reason))
  }, [])

  const transcribe = useCallback(async (audio: Blob): Promise<void> => {
    setState('transcribing')
    setMessage('正在转成文字')
    const dataUrl = await blobToDataUrl(audio)
    const imported = await bridge.speech.importAudioData(dataUrl)
    if (!imported.success || imported.payload === null) throw new Error(imported.error?.message ?? '录音保存失败。')
    const response = await bridge.core.invoke({
      type: 'asr.transcribe',
      payload: {
        audioPath: imported.payload.path,
        characterId: characterIdRef.current,
        language: 'zh',
        requestId: `aimaid_${crypto.randomUUID().replaceAll('-', '')}`
      }
    }, 120_000)
    if (!response.success || typeof response.payload !== 'string') throw new Error(response.error?.message ?? '语音识别失败。')
    const recognized = response.payload.trim()
    if (recognized === '') throw new Error('语音识别没有返回文字。')
    const completed = await bridge.voiceInput.complete(recognized)
    if (!completed.success) throw new Error(completed.error?.message ?? '识别结果未能发送到聊天框。')
  }, [])

  const stopRecording = useCallback((): void => {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') {
      setMessage('正在结束录音')
      recorder.stop()
    }
  }, [])

  useEffect(() => {
    disposedRef.current = false
    document.body.classList.add('voice-input-surface')
    const start = async (): Promise<void> => {
      if (navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') {
        throw new Error('当前系统不支持麦克风录音。')
      }
      const [characters, stream, virtualKeys] = await Promise.all([
        loadCharacters(),
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
        loadVoiceInputVirtualKeys()
      ])
      if (disposedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const character = characters.items.find((item) => item.roleId === characters.currentRoleId)
      if (character === undefined) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('未找到当前角色，无法进行语音识别。')
      }
      characterIdRef.current = character.roleId
      streamRef.current = stream
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      recorderRef.current = recorder
      chunksRef.current = []
      discardRecordingRef.current = false
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) }
      recorder.onerror = () => fail(new Error('麦克风录音失败，请检查系统权限。'))
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = undefined
        recorderRef.current = undefined
        if (disposedRef.current || discardRecordingRef.current) {
          chunksRef.current = []
          return
        }
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType })
        chunksRef.current = []
        if (audio.size === 0) {
          fail(new Error('没有录到声音，请重试。'))
          return
        }
        void transcribe(audio).catch(fail)
      }
      recorder.start(500)
      setState('recording')
      setMessage('正在录音')
      const released = await bridge.core.invoke({ type: 'system.keyboard.wait_release', payload: { virtualKeys } }, 600_000)
      if (!released.success) throw new Error(released.error?.message ?? '全局快捷键松开检测失败。')
      if (!disposedRef.current) stopRecording()
    }
    void start().catch(fail)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void bridge.window.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      disposedRef.current = true
      discardRecordingRef.current = true
      window.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('voice-input-surface')
      recorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [fail, stopRecording, transcribe])

  return <VoiceInputOrb state={state} message={message} onActivate={() => {
    if (state === 'recording') stopRecording()
    else if (state === 'error') void bridge.window.close()
  }} />
}

async function loadVoiceInputVirtualKeys(): Promise<number[]> {
  const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['hotkey_open_voice_input'] } })
  if (!response.success) throw new Error(response.error?.message ?? '语音快捷键读取失败。')
  const payload = response.payload as { settings?: Array<{ key: string; value: string }> } | null
  const gesture = payload?.settings?.find((item) => item.key === 'hotkey_open_voice_input')?.value || 'Ctrl+Shift+S'
  return gesture.split('+').map((part) => virtualKey(part.trim()))
}

function virtualKey(part: string): number {
  const named: Record<string, number> = {
    Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Win: 0x5b,
    Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Escape: 0x1b, Space: 0x20,
    PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
    Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28, Insert: 0x2d, Delete: 0x2e
  }
  const known = named[part]
  if (known !== undefined) return known
  if (/^[A-Z0-9]$/u.test(part)) return part.charCodeAt(0)
  const functionKey = /^F(\d{1,2})$/u.exec(part)?.[1]
  if (functionKey !== undefined) {
    const number = Number(functionKey)
    if (number >= 1 && number <= 24) return 0x6f + number
  }
  throw new Error(`语音按住快捷键不支持按键“${part}”。`)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('录音读取结果无效。'))
    reader.onerror = () => reject(reader.error ?? new Error('录音读取失败。'))
    reader.readAsDataURL(blob)
  })
}
