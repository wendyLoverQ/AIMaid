import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessageDto, CharacterDto, VoiceConversationDto } from '../../../shared/business'
import { Avatar, Badge, Button, ConfirmDialog, EmptyState, Inline, Input, LayoutSlot, ListBox, ListBoxItem, Page, PageContent, SearchBox, Select, Stack, Surface, Switch, Text, Textarea, WindowTitleBar, useToast } from '../../components/ui'
import { loadCharacters, setCurrentCharacter } from '../../features/characters/character-api'
import { bridge } from '../../shared/bridge'
import { publishPetBubble } from '../../shared/pet-bubble-channel'
import { attachAudioMetadata, stopAudioPlayback, synthesizeAndPlayPages } from '../chat/tts-playback'
import { runAgentConversation } from '../chat/agent-conversation'

export function VoiceConversationPage(): React.JSX.Element {
  const toast = useToast(); const [roles, setRoles] = useState<CharacterDto[]>([]); const [roleId, setRoleId] = useState('')
  const [conversations, setConversations] = useState<VoiceConversationDto[]>([]); const [conversationId, setConversationId] = useState<string>(); const [messages, setMessages] = useState<ChatMessageDto[]>([])
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({})
  const [query, setQuery] = useState(''); const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [speech, setSpeech] = useState(false); const [deleting, setDeleting] = useState(false)
  const [recording, setRecording] = useState(false); const [transcribing, setTranscribing] = useState(false)
  const recorder = useRef<MediaRecorder | undefined>(undefined); const recordingStream = useRef<MediaStream | undefined>(undefined); const chunks = useRef<Blob[]>([]); const discardRecording = useRef(false)
  const loadConversations = useCallback(async (selectedRoleId: string, search = ''): Promise<void> => {
    const response = await bridge.core.invoke({ type: 'voice_conversation.list', payload: { roleId: selectedRoleId, ...(search === '' ? {} : { search }) } })
    if (!response.success) throw new Error(response.error?.message ?? '会话列表读取失败。')
    const items = Array.isArray(response.payload) ? response.payload as VoiceConversationDto[] : []
    setConversations(items); const id = items.some((item) => item.conversationId === conversationId) ? conversationId : items[0]?.conversationId; setConversationId(id)
  }, [conversationId])
  const loadMessages = useCallback(async (id?: string): Promise<void> => {
    if (id === undefined) { setMessages([]); return }
    const response = await bridge.core.invoke({ type: 'chat.history', payload: { conversationId: id, limit: 100 } })
    if (!response.success) throw new Error(response.error?.message ?? '历史消息读取失败。')
    const payload = response.payload as { messages?: ChatMessageDto[] } | null; setMessages(payload?.messages ?? [])
  }, [])
  useEffect(() => { void Promise.all([loadCharacters(), bridge.core.invoke({ type: 'settings.get', payload: { keys: ['voice_conversation_center_speech'] } })]).then(async ([characters, setting]) => {
    if (!setting.success) throw new Error(setting.error?.message ?? '语音播报设置读取失败。')
    setRoles(characters.items); const selected = characters.currentRoleId || characters.items[0]?.roleId || ''; setRoleId(selected)
    const payload = setting.payload as { settings?: Array<{ key: string; value: string }> } | null; setSpeech(payload?.settings?.find((item) => item.key === 'voice_conversation_center_speech')?.value.toLowerCase() === 'true')
    if (selected !== '') await loadConversations(selected)
  }).catch((reason: unknown) => toast.show(String(reason), 'error')) }, [])
  useEffect(() => {
    void Promise.all(roles.filter((item) => item.avatarPath !== '').map(async (item) => {
      const response = await bridge.media.registerLocalFile(item.avatarPath)
      if (!response.success) throw new Error(response.error?.message ?? `角色“${item.name}”头像读取失败。`)
      return [item.roleId, response.payload?.url ?? ''] as const
    })).then((entries) => setAvatarUrls(Object.fromEntries(entries)))
      .catch((reason: unknown) => toast.show(reason instanceof Error ? reason.message : String(reason), 'error'))
  }, [roles, toast])
  useEffect(() => { void loadMessages(conversationId).catch((reason: unknown) => toast.show(String(reason), 'error')) }, [conversationId, loadMessages])
  useEffect(() => {
    const viewport = document.querySelector<HTMLElement>('.conversation-messages')
    if (viewport === null) return
    const frame = requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight })
    return () => cancelAnimationFrame(frame)
  }, [conversationId, messages])
  useEffect(() => () => { recorder.current?.stop(); recordingStream.current?.getTracks().forEach((track) => track.stop()) }, [])
  const selectRole = async (next: string): Promise<void> => { setRoleId(next); setConversationId(undefined); setMessages([]); await setCurrentCharacter(next); await loadConversations(next) }
  const openCharacterManager = async (): Promise<void> => {
    const response = await bridge.window.open('characters')
    if (!response.success) toast.show(response.error?.message ?? '角色管理打开失败。', 'error')
  }
  const createConversation = async (seed = '新对话'): Promise<VoiceConversationDto> => {
    const now = new Date().toISOString(); const conversation: VoiceConversationDto = { conversationId: `voice_chat_${crypto.randomUUID().replaceAll('-', '')}`, voiceRoleId: roleId, title: seed.slice(0, 24), preview: '', createdAt: now, updatedAt: now }
    const response = await bridge.core.invoke({ type: 'voice_conversation.save', payload: { conversation } }); if (!response.success) throw new Error(response.error?.message ?? '新建会话失败。')
    setConversations((current) => [conversation, ...current]); setConversationId(conversation.conversationId); setMessages([]); return conversation
  }
  const send = async (): Promise<void> => {
    const content = text.trim(); if (content === '' || roleId === '' || sending) return
    setText(''); setSending(true); publishPetBubble('正在生成回复…', 'processing', 'think')
    try {
      const conversation = conversations.find((item) => item.conversationId === conversationId) ?? await createConversation(content)
      const optimistic: ChatMessageDto = { id: -Date.now(), conversationId: conversation.conversationId, role: 'user', content, characterId: roleId, modelName: '', source: 'voice-conversation', metadataJson: '{}', createdAt: new Date().toISOString() }
      setMessages((current) => [...current, optimistic])
      const payload = await runAgentConversation(content, { conversationId: conversation.conversationId, characterId: roleId, source: 'voice_conversation_center' })
      const reply = payload.content.trim()
      const saved = await bridge.core.invoke({ type: 'voice_conversation.save', payload: { conversation: { ...conversation, preview: reply, updatedAt: new Date().toISOString() } } })
      if (!saved.success) throw new Error(saved.error?.message ?? '会话预览保存失败。')
      await loadMessages(conversation.conversationId); await loadConversations(roleId, query)
      const role = roles.find((item) => item.roleId === roleId)
      if (speech && reply !== '' && role?.preferredVoiceId !== undefined) {
        const paths = await synthesizeAndPlayPages(reply, role.preferredVoiceId,
          (page) => publishPetBubble(page, 'speech', actionTagForVoiceStyle(payload.voiceStyle)))
        if (payload.messageId > 0) await attachAudioMetadata(payload.messageId, paths, { voiceId: role.preferredVoiceId, source: 'voice_conversation_center' })
      } else if (reply !== '') {
        publishPetBubble(reply, 'feedback', actionTagForVoiceStyle(payload.voiceStyle))
      }
    } catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); publishPetBubble(message, 'error', 'error'); toast.show(message, 'error') } finally { setSending(false) }
  }
  const transcribe = async (audio: Blob): Promise<void> => {
    setTranscribing(true); publishPetBubble('正在识别语音…', 'processing', 'think')
    try {
      const dataUrl = await blobToDataUrl(audio)
      const imported = await bridge.speech.importAudioData(dataUrl)
      if (!imported.success || imported.payload === null) throw new Error(imported.error?.message ?? '录音保存失败。')
      const response = await bridge.core.invoke({ type: 'asr.transcribe', payload: {
        audioPath: imported.payload.path,
        characterId: roleId,
        ...(conversationId === undefined ? {} : { sessionId: conversationId }),
        language: 'zh',
        requestId: `aimaid_${crypto.randomUUID().replaceAll('-', '')}`
      } }, 120000)
      if (!response.success || typeof response.payload !== 'string') throw new Error(response.error?.message ?? '语音识别失败。')
      const recognized = response.payload.trim()
      if (recognized === '') throw new Error('语音识别没有返回文字。')
      setText((current) => current.trim() === '' ? recognized : `${current.trimEnd()} ${recognized}`)
      publishPetBubble(`我听到：${recognized}`, 'feedback', 'listen')
      toast.show('语音已转成文字，请确认后发送。', 'success')
    } finally { setTranscribing(false) }
  }
  const startRecording = async (): Promise<void> => {
    if (roleId === '' || recording || transcribing) return
    if (navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') { publishPetBubble('当前系统不支持麦克风录音。', 'error', 'error'); toast.show('当前系统不支持麦克风录音。', 'error'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const next = new MediaRecorder(stream, { mimeType }); chunks.current = []; discardRecording.current = false; recordingStream.current = stream; recorder.current = next
      next.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data) }
      next.onerror = () => { publishPetBubble('麦克风录音失败，请检查系统权限。', 'error', 'error'); toast.show('麦克风录音失败，请检查系统权限。', 'error') }
      next.onstop = () => {
        stream.getTracks().forEach((track) => track.stop()); recordingStream.current = undefined; recorder.current = undefined; setRecording(false)
        if (discardRecording.current) { chunks.current = []; return }
        const audio = new Blob(chunks.current, { type: next.mimeType }); chunks.current = []
        if (audio.size === 0) { publishPetBubble('没有录到声音，请重试。', 'error', 'error'); toast.show('没有录到声音，请重试。', 'error'); return }
        void transcribe(audio).catch((reason: unknown) => { const message = reason instanceof Error ? reason.message : String(reason); publishPetBubble(message, 'error', 'error'); toast.show(message, 'error') })
      }
      next.start(500); setRecording(true); publishPetBubble('正在听主人说话…', 'status', 'listen')
    } catch (reason) { const message = reason instanceof Error ? reason.message : '无法访问麦克风，请检查系统权限。'; recordingStream.current?.getTracks().forEach((track) => track.stop()); publishPetBubble(message, 'error', 'error'); toast.show(message, 'error') }
  }
  const stopRecording = (discard = false): void => {
    discardRecording.current = discard
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }
  const saveConversation = async (conversation: VoiceConversationDto): Promise<void> => {
    const response = await bridge.core.invoke({ type: 'voice_conversation.save', payload: { conversation } })
    if (!response.success) toast.show(response.error?.message ?? '会话标题保存失败。', 'error')
  }
  const saveSpeechPreference = async (enabled: boolean): Promise<void> => {
    const response = await bridge.core.invoke({ type: 'settings.save', payload: { values: { voice_conversation_center_speech: String(enabled) } } })
    if (!response.success) { setSpeech(!enabled); toast.show(response.error?.message ?? '语音播报设置保存失败。', 'error') }
  }
  const deleteConversation = async (): Promise<void> => {
    if (conversationId === undefined) return
    const response = await bridge.core.invoke({ type: 'voice_conversation.delete', payload: { conversationId } })
    if (!response.success) { toast.show(response.error?.message ?? '会话删除失败。', 'error'); return }
    setDeleting(false); setConversationId(undefined); setMessages([]); await loadConversations(roleId, query)
  }
  const selected = conversations.find((item) => item.conversationId === conversationId); const role = roles.find((item) => item.roleId === roleId)
  return <Page><WindowTitleBar title="角色对话中心"/><PageContent scroll={false}>
    {roles.length === 0 ? <EmptyState title="暂无可用角色" action={<Button variant="primary" onClick={() => void openCharacterManager()}>打开角色管理</Button>} /> : <LayoutSlot variant="conversation-workspace">
      <Surface variant="conversation-navigation"><Stack gap="md"><Select aria-label="当前角色" value={roleId} options={roles.map((item) => ({ value: item.roleId, label: item.name }))} onChange={(event) => void selectRole(event.target.value)}/><Button variant="primary" disabled={roleId === ''} onClick={() => void createConversation()}>新建会话</Button><SearchBox aria-label="搜索会话" value={query} onChange={(value) => { setQuery(value); void loadConversations(roleId, value) }}/></Stack><LayoutSlot variant="conversation-list">{conversations.length === 0 ? <EmptyState title="暂无会话"/> : <ListBox label="会话列表">{conversations.map((item) => { const conversationRole = roles.find((candidate) => candidate.roleId === item.voiceRoleId); return <ListBoxItem key={item.conversationId} selected={item.conversationId === conversationId} leading={<Avatar source={avatarUrls[item.voiceRoleId] ?? ''} fallback={conversationRole?.name ?? item.voiceRoleId} />} title={item.title} description={item.preview || undefined} onSelect={() => setConversationId(item.conversationId)}/> })}</ListBox>}</LayoutSlot></Surface>
      <Surface variant="conversation-detail">{selected === undefined ? <EmptyState title="选择或新建会话"/> : <>
        <LayoutSlot as="header" variant="conversation-header"><Inline><Avatar source={avatarUrls[roleId] ?? ''} fallback={role?.name || '助手'} /><Stack gap="xs"><Text size="xs" tone="muted">{role?.name ?? '助手'}</Text><Input aria-label="会话标题" value={selected.title} onChange={(event) => setConversations((current) => current.map((item) => item.conversationId === selected.conversationId ? { ...item, title: event.target.value } : item))} onBlur={() => void saveConversation(selected)}/></Stack></Inline><Inline><Switch label="播报新回复" checked={speech} onChange={(event) => { const enabled = event.target.checked; setSpeech(enabled); if (!enabled) stopAudioPlayback(); void saveSpeechPreference(enabled) }}/><Button variant="danger" size="sm" onClick={() => setDeleting(true)}>删除会话</Button></Inline></LayoutSlot>
        <LayoutSlot variant="conversation-messages" aria-live="polite">{messages.length === 0 ? <EmptyState title="还没有消息"/> : messages.map((message) => { const fromUser = message.role.toLowerCase() === 'user'; const messageRole = roles.find((item) => item.roleId === message.characterId) ?? role; return <LayoutSlot as="article" variant={fromUser ? 'conversation-message conversation-message--user' : 'conversation-message conversation-message--assistant'} key={message.id}><Avatar source={fromUser ? '' : avatarUrls[messageRole?.roleId ?? ''] ?? ''} fallback={fromUser ? '你' : messageRole?.name ?? '助手'} /><Stack gap="sm"><Inline><Badge>{fromUser ? '你' : messageRole?.name ?? '助手'}</Badge><Text size="xs" tone="muted">{new Date(message.createdAt).toLocaleString()}</Text></Inline><Text as="p" wrap>{message.content}</Text></Stack></LayoutSlot> })}</LayoutSlot>
        <LayoutSlot as="footer" variant="conversation-composer"><Textarea aria-label="消息" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }}/><Inline justify="end">{recording || transcribing || sending ? <Text size="xs" tone="muted">{recording ? '正在录音' : transcribing ? '正在识别语音…' : '正在生成回复…'}</Text> : null}<Inline>{recording ? <><Button size="sm" variant="ghost" onClick={() => stopRecording(true)}>取消录音</Button><Button size="sm" variant="danger" onClick={() => stopRecording()}>停止并识别</Button></> : <Button size="sm" disabled={transcribing || sending || roleId === ''} loading={transcribing} onClick={() => void startRecording()}>语音转文字</Button>}<Button variant="primary" loading={sending} disabled={text.trim() === '' || recording || transcribing} onClick={() => void send()}>发送</Button></Inline></Inline></LayoutSlot>
      </>}</Surface>
    </LayoutSlot>}
    <ConfirmDialog open={deleting} title="删除会话？" description="会话和历史消息将被删除。" confirmText="删除" confirmVariant="danger" onCancel={() => setDeleting(false)} onConfirm={() => void deleteConversation()}/>
  </PageContent></Page>
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('录音编码失败。'))
    reader.onerror = () => reject(reader.error ?? new Error('录音编码失败。'))
    reader.readAsDataURL(blob)
  })
}

function actionTagForVoiceStyle(voiceStyle: string): string {
  const normalized = voiceStyle.trim().toLowerCase()
  if (normalized === 'lively') return 'happy'
  if (normalized === 'close') return 'shy'
  if (normalized === 'soft') return 'smile'
  return 'speak'
}
