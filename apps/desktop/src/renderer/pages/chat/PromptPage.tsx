import { IconButton, Inline, MainRegion, Section, Textarea, UiIcon } from '../../components/ui';
import { useEffect, useRef, useState } from 'react';
import type { ChatCommandLauncherDto } from '../../../shared/business';
import { loadCharacters } from '../../features/characters/character-api';
import { bridge } from '../../shared/bridge';
import { publishPetBubble } from '../../shared/pet-bubble-channel';
import { attachAudioMetadata, synthesizeAndPlay } from './tts-playback';
import { runAgentConversation } from './agent-conversation';
export interface PromptSubmission {
    text: string;
    continueConversation: boolean;
    ttsPreviewOnly: boolean;
}
export function PromptPage(): React.JSX.Element {
    const input = useRef<HTMLTextAreaElement>(null);
    const recorder = useRef<MediaRecorder | undefined>(undefined);
    const recordingStream = useRef<MediaStream | undefined>(undefined);
    const chunks = useRef<Blob[]>([]);
    const discardRecording = useRef(false);
    const [text, setText] = useState('');
    const [recording, setRecording] = useState(false);
    const [transcribing, setTranscribing] = useState(false);
    useEffect(() => {
        document.body.classList.add('prompt-surface');
        const focus = (): void => {
            setText('');
            requestAnimationFrame(() => input.current?.focus());
        };
        window.addEventListener('focus', focus);
        focus();
        return () => {
            discardRecording.current = true;
            if (recorder.current?.state === 'recording')
                recorder.current.stop();
            recordingStream.current?.getTracks().forEach((track) => track.stop());
            document.body.classList.remove('prompt-surface');
            window.removeEventListener('focus', focus);
        };
    }, []);
    async function transcribe(audio: Blob, characterId: string): Promise<void> {
        setTranscribing(true);
        publishPetBubble('正在识别语音…', 'processing', 'think');
        try {
            const imported = await bridge.speech.importAudioData(await blobToDataUrl(audio));
            if (!imported.success || imported.payload === null)
                throw new Error(imported.error?.message ?? '录音保存失败。');
            const response = await bridge.core.invoke({ type: 'asr.transcribe', payload: {
                    audioPath: imported.payload.path,
                    characterId,
                    language: 'zh',
                    requestId: `aimaid_${crypto.randomUUID().replaceAll('-', '')}`
                } }, 120000);
            if (!response.success || typeof response.payload !== 'string')
                throw new Error(response.error?.message ?? '语音识别失败。');
            const recognized = response.payload.trim();
            if (recognized === '')
                throw new Error('语音识别没有返回文字。');
            setText(recognized);
            await submit(false, false, recognized);
        }
        catch (reason) {
            publishPetBubble(reason instanceof Error ? reason.message : String(reason), 'error', 'error');
        }
        finally {
            setTranscribing(false);
        }
    }
    async function startRecording(): Promise<void> {
        if (recording || transcribing)
            return;
        if (navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') {
            publishPetBubble('当前系统不支持麦克风录音。', 'error', 'error');
            return;
        }
        try {
            const character = await currentCharacter();
            if (character === undefined)
                throw new Error('请先选择一个聊天角色。');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
            const next = new MediaRecorder(stream, { mimeType });
            chunks.current = [];
            discardRecording.current = false;
            recordingStream.current = stream;
            recorder.current = next;
            next.ondataavailable = (event) => {
                if (event.data.size > 0)
                    chunks.current.push(event.data);
            };
            next.onerror = () => publishPetBubble('麦克风录音失败，请检查系统权限。', 'error', 'error');
            next.onstop = () => {
                stream.getTracks().forEach((track) => track.stop());
                recordingStream.current = undefined;
                recorder.current = undefined;
                setRecording(false);
                if (discardRecording.current) {
                    chunks.current = [];
                    return;
                }
                const audio = new Blob(chunks.current, { type: next.mimeType });
                chunks.current = [];
                if (audio.size === 0) {
                    publishPetBubble('没有录到声音，请重试。', 'error', 'error');
                    return;
                }
                void transcribe(audio, character.roleId);
            };
            next.start(500);
            setRecording(true);
            publishPetBubble('正在听主人说话…', 'status', 'listen');
        }
        catch (reason) {
            recordingStream.current?.getTracks().forEach((track) => track.stop());
            publishPetBubble(reason instanceof Error ? reason.message : '无法访问麦克风，请检查系统权限。', 'error', 'error');
        }
    }
    function stopRecording(discard = false): void {
        discardRecording.current = discard;
        if (recorder.current?.state === 'recording')
            recorder.current.stop();
    }
    async function submit(continueConversation: boolean, ttsPreviewOnly: boolean, promptText = text): Promise<void> {
        const prompt = promptText.trim();
        if (prompt === '')
            return;
        await bridge.window.hide();
        if (ttsPreviewOnly) {
            publishPetBubble('正在试听语音.....^_^', 'processing');
            try {
                const voiceId = await currentVoiceId();
                await synthesizeAndPlay(prompt, voiceId);
                publishPetBubble(prompt, 'speech', 'speak');
            }
            catch (reason) {
                publishPetBubble(reason instanceof Error ? reason.message : String(reason), 'error', 'error');
            }
            return;
        }
        try {
            if (prompt.startsWith('-')) {
                publishPetBubble(await runChatCommand(prompt), 'feedback');
                return;
            }
            const reminder = parseReminder(prompt);
            if (reminder.handled) {
                if (reminder.value === null) {
                    publishPetBubble('我没听清提醒时间。可以说：10分钟后提醒我喝水，或 明天 23:30 提醒我休息。', 'feedback');
                    return;
                }
                const response = await bridge.core.invoke({ type: 'reminder.save', payload: {
                        reminderId: null, title: reminder.value.title, message: `提醒：${reminder.value.title}`,
                        dueAt: reminder.value.dueAt.toISOString(), repeat: reminder.value.repeat, enabled: true, allowTts: true
                    } });
                if (!response.success)
                    throw new Error(response.error?.message ?? '提醒创建失败。');
                publishPetBubble(`已创建提醒：${reminder.value.title}\n时间：${formatMinute(reminder.value.dueAt)}`, 'feedback');
                return;
            }
            publishPetBubble('女仆正在跑腿通知.....^_^', 'processing', 'think');
            const character = await currentCharacter();
            const payload = await runAgentConversation(prompt, {
                ...(character === undefined ? {} : { characterId: character.roleId }),
                continueConversation,
                source: 'normal_chat'
            });
            const content = payload.content.trim() || 'Agent 返回了空回复。';
            publishPetBubble(content, 'speech', actionTagForVoiceStyle(payload.voiceStyle));
            if (payload.messageId > 0 && await realtimeTtsEnabled()) {
                const voiceId = character?.preferredVoiceId || undefined;
                const audioPath = await synthesizeAndPlay(content, voiceId);
                await attachAudioMetadata(payload.messageId, [audioPath], { voiceId: voiceId ?? '', source: 'prompt' });
            }
        }
        catch (reason) {
            publishPetBubble(reason instanceof Error ? reason.message : String(reason), 'error', 'error');
        }
    }
    return <MainRegion onMouseDown={(event) => {
            if (event.target === event.currentTarget)
                void bridge.window.hide();
        }}>
    <Section variant="prompt" aria-label="快捷输入" onMouseDown={(event) => event.stopPropagation()}>
      <Inline wrap={false} align="center">
      <Textarea ref={input} aria-label="快捷输入内容" value={text} rows={2} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                stopRecording(true);
                void bridge.window.hide();
                return;
            }
            if (event.key !== 'Enter')
                return;
            event.preventDefault();
            void submit(event.ctrlKey, event.shiftKey);
      }}/>
      <IconButton
        size="sm"
        label={recording ? '结束录音' : transcribing ? '正在识别语音' : '语音输入'}
        tooltip={recording ? '结束录音并发送' : '录音并发送'}
        loading={transcribing}
        aria-pressed={recording}
        onClick={() => recording ? stopRecording() : void startRecording()}
      >
        <UiIcon name={recording ? 'stop' : 'microphone'}/>
      </IconButton>
      </Inline>
    </Section>
  </MainRegion>;
}
async function currentVoiceId(): Promise<string | undefined> {
    return (await currentCharacter())?.preferredVoiceId || undefined;
}
async function currentCharacter() {
    const characters = await loadCharacters();
    return characters.items.find((item) => item.roleId === characters.currentRoleId);
}
async function realtimeTtsEnabled(): Promise<boolean> {
    const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['realtime_tts_enabled'] } });
    if (!response.success)
        throw new Error(response.error?.message ?? '实时 TTS 设置读取失败。');
    const payload = response.payload as {
        settings?: Array<{
            key: string;
            value: string;
        }>;
    } | null;
    const value = payload?.settings?.find((item) => item.key === 'realtime_tts_enabled')?.value;
    return value === undefined || value.toLowerCase() !== 'false';
}
async function runChatCommand(commandText: string): Promise<string> {
    const list = await bridge.core.invoke({ type: 'script.list', payload: {} });
    if (!list.success)
        throw new Error(list.error?.message ?? '快捷脚本读取失败。');
    const items = Array.isArray(list.payload) ? list.payload as ChatCommandLauncherDto[] : [];
    const launcher = items.find((item) => item.enabled && item.commandText === commandText);
    if (launcher === undefined)
        return `没有配置聊天命令：${commandText}`;
    const response = await bridge.core.invoke({ type: 'script.run', payload: { launcherId: launcher.launcherId } });
    return response.success && typeof response.payload === 'string' ? response.payload : response.error?.message ?? `启动失败：${launcher.displayName}`;
}
function parseReminder(input: string): {
    handled: boolean;
    value: {
        dueAt: Date;
        repeat: 'none' | 'daily';
        title: string;
    } | null;
} {
    if (!['提醒', '闹钟', '定时', '叫我', '喊我', '记得'].some((word) => input.toLocaleLowerCase().includes(word)))
        return { handled: false, value: null };
    const now = new Date();
    const minute = input.match(/(\d+)\s*(分钟|分)/);
    if (minute?.[1] !== undefined)
        return reminderValue(input, new Date(now.getTime() + Math.max(1, Number(minute[1])) * 60000), 'none');
    const hour = input.match(/(\d+)\s*(小时|钟头)/);
    if (hour?.[1] !== undefined)
        return reminderValue(input, new Date(now.getTime() + Math.max(1, Number(hour[1])) * 3600000), 'none');
    const daily = input.match(/每天\s*(\d{1,2})(?:[:：点]\s*(\d{1,2}))?/);
    if (daily?.[1] !== undefined) {
        const dueAt = atTime(now, Number(daily[1]), Number(daily[2] ?? 0));
        if (dueAt <= now)
            dueAt.setDate(dueAt.getDate() + 1);
        return reminderValue(input, dueAt, 'daily');
    }
    const tomorrow = input.match(/明天\s*(\d{1,2})(?:[:：点]\s*(\d{1,2}))?/);
    if (tomorrow?.[1] !== undefined) {
        const dueAt = atTime(now, Number(tomorrow[1]), Number(tomorrow[2] ?? 0));
        dueAt.setDate(dueAt.getDate() + 1);
        return reminderValue(input, dueAt, 'none');
    }
    return { handled: true, value: null };
}
function reminderValue(input: string, dueAt: Date, repeat: 'none' | 'daily'): {
    handled: true;
    value: {
        dueAt: Date;
        repeat: 'none' | 'daily';
        title: string;
    };
} {
    let title = input.replace(/\d+\s*(分钟|分|小时|钟头)/gi, '')
        .replace(/每天\s*\d{1,2}(?:[:：点]\s*\d{0,2})?/gi, '')
        .replace(/明天\s*\d{1,2}(?:[:：点]\s*\d{0,2})?/gi, '');
    for (const word of ['提醒我', '提醒', '闹钟', '定时', '叫我', '喊我', '记得'])
        title = title.replaceAll(word, '');
    title = title.replace(/^[ ，,。.：:]+|[ ，,。.：:]+$/g, '') || '该处理提醒事项了';
    return { handled: true, value: { dueAt, repeat, title } };
}
function atTime(now: Date, hour: number, minute: number): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.min(23, Math.max(0, hour)), Math.min(59, Math.max(0, minute)), 0);
}
function formatMinute(value: Date): string {
    const pad = (number: number): string => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
function actionTagForVoiceStyle(voiceStyle: string): string {
    const normalized = voiceStyle.trim().toLowerCase();
    if (normalized === 'lively')
        return 'happy';
    if (normalized === 'close')
        return 'shy';
    if (normalized === 'soft')
        return 'smile';
    return 'speak';
}
function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('录音读取失败。'));
        reader.onerror = () => reject(reader.error ?? new Error('录音读取失败。'));
        reader.readAsDataURL(blob);
    });
}
