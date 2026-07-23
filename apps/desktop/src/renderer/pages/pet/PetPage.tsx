import { Container, PetItemSurface, PetPanelSurface, TransparentCanvas, TransparentStage } from "../../components/ui";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageDto } from '../../../shared/business';
import type { PetPresentationAction, PetPresentationSnapshot } from '../../../shared/presentation';
import type { AlphaContour } from '../../../shared/alpha-contour';
import { MUSIC_VISUALIZER_STYLE_KEY, parseMusicVisualizerStyle } from '../../../shared/music-visualizer';
import type { MusicVisualizerStyle } from '../../../shared/music-visualizer';
import type { WindowKind } from '../../../shared/windows';
import { UiIcon } from '../../components/ui';
import { ContextMenuSurface } from '../../components/ui';
import { PetRuntime } from '../../live2d/pet-runtime';
import { bridge } from '../../shared/bridge';
import { PetItemInteractionController, type PetVisualTransform } from '../../shared/pet-item-interaction-controller';
import {
    PET_CANVAS_HEIGHT,
    PET_CANVAS_WIDTH
} from '../../../shared/pet-geometry';
import { PetBubble } from './PetBubble';
import { captureAlphaContour, PetAudioContour } from './PetAudioContour';
import { startPetMusicPlayback } from './pet-music-playback';
import { playLocalAudioPaths, synthesizeAndPlayPages } from '../chat/tts-playback';
import { playCachedAudio } from '../chat/tts-playback';
import { usePetBubbleQueue, type PetBubbleQueue } from './usePetBubbleQueue';
type PetHitTest = (clientX: number, clientY: number) => boolean;
type PetPointerClick = (event: MouseEvent) => void;
const BUBBLE_ALPHA_GAP = 5;
const BUBBLE_TAIL_HEIGHT = 21;
const BUBBLE_ANCHOR_REFRESH_MS = 120;
const BUBBLE_FOLLOW_TIME_MS = 150;
const BUBBLE_TAIL_LEFT = 64;
const BUBBLE_WIDTH = 420;
export default function PetPage(): React.JSX.Element {
    const [presentation, setPresentation] = useState<PetPresentationSnapshot | null>(null);
    const [menu, setMenu] = useState<{
        x: number;
        y: number;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { current: bubble, speechHeld, show: showBubble, expire: expireBubble } = usePetBubbleQueue();
    const [renderScale, setRenderScale] = useState(1);
    const [liveVisualTransform, setLiveVisualTransform] = useState<PetVisualTransform>({ centerX: 0, centerY: 0, scale: 1 });
    const [voiceMenu, setVoiceMenu] = useState({ roleName: '未选择', intimacy: '信赖 5 级' });
    const [visualizerStyle, setVisualizerStyle] = useState<MusicVisualizerStyle>('surround-bars');
    const readySentRef = useRef(false);
    const stageRef = useRef<HTMLElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const itemRef = useRef<HTMLDivElement>(null);
    const visualCanvasRef = useRef<HTMLCanvasElement>(null);
    const presentationRef = useRef<PetPresentationSnapshot | null>(null);
    const liveContourReaderRef = useRef<(() => AlphaContour | null) | null>(null);
    const hitTestRef = useRef<PetHitTest>(() => false);
    const pointerClickRef = useRef<PetPointerClick>(() => undefined);
    const interactionRef = useRef<PetItemInteractionController | null>(null);
    useEffect(() => startPetMusicPlayback(), []);
    useEffect(() => {
        const load = (): void => {
            void loadMusicVisualizerStyle().then(setVisualizerStyle).catch((reason: unknown) => {
                console.error('[MusicVisualizer] style load failed', reason);
            });
        };
        load();
        return bridge.events.subscribe(['settings.changed'], load);
    }, []);
    const readLiveContour = useCallback((): AlphaContour | null => liveContourReaderRef.current?.() ?? null, []);
    const registerLiveContourReader = useCallback((reader: (() => AlphaContour | null) | null): void => {
        liveContourReaderRef.current = reader;
    }, []);
    const registerHitTest = useCallback((hitTest: PetHitTest | null): void => {
        hitTestRef.current = hitTest ?? (() => false);
        interactionRef.current?.refreshHitTest();
    }, []);
    const registerPointerClick = useCallback((click: PetPointerClick | null): void => {
        pointerClickRef.current = click ?? (() => undefined);
    }, []);
    const refreshPresentation = useCallback(async (): Promise<void> => {
        const response = await bridge.pet.presentation.get();
        if (response.success && response.payload !== null) {
            setPresentation(response.payload);
            setError(null);
        }
        else
            setError(response.error?.message ?? '桌宠显示配置读取失败。');
    }, []);
    const revealPetWindow = useCallback((): void => {
        if (readySentRef.current)
            return;
        readySentRef.current = true;
        void bridge.pet.ready();
    }, []);
    useEffect(() => {
        void refreshPresentation();
    }, [refreshPresentation]);
    useEffect(() => { presentationRef.current = presentation; }, [presentation]);
    const ensureVoiceCache = useCallback(async (announce: boolean): Promise<void> => {
        if (announce)
            showBubble('正在准备当前角色的点击语音缓存…', 'feedback');
        const response = await bridge.core.invoke({ type: 'pet.voice_cache.ensure', payload: { includeNextPeriod: true } }, 120_000);
        if (!response.success || response.payload === null) {
            showBubble(response.error?.message ?? '点击语音缓存生成失败。', 'error');
            return;
        }
        if (announce) {
            const value = response.payload as { message?: string };
            showBubble(value.message ?? '点击语音缓存已准备好。', 'feedback');
        }
    }, [showBubble]);
    useEffect(() => {
        void ensureVoiceCache(false);
        return bridge.events.subscribe(['character.changed', 'settings.changed'], (event) => {
            const envelope = isRecord(event.payload) ? event.payload : null;
            const data = envelope !== null && isRecord(envelope.data) ? envelope.data : null;
            if (event.type === 'character.changed') {
                void ensureVoiceCache(true);
                return;
            }
            const keys = data !== null && Array.isArray(data.keys) ? data.keys : [];
            if (keys.some((key) => key === 'voice_cache_period_hours' || key === 'user_config:App:VoiceCache:LazyCachePeriodHours'))
                void ensureVoiceCache(true);
        });
    }, [ensureVoiceCache]);
    useEffect(() => {
        const panel = panelRef.current;
        if (panel === null)
            return;
        const interaction = new PetItemInteractionController({
            item: panel,
            hitTest: (x, y) => hitTestRef.current(x, y),
            setIgnoreMouseEvents: (ignore) => { void bridge.pet.setIgnoreMouseEvents(ignore); },
            dragStart: () => { void bridge.pet.dragStart(); },
            dragMove: () => { void bridge.pet.dragMove(); },
            dragEnd: () => { void bridge.pet.dragEnd(); },
            updateWindow: (update) => { void bridge.pet.updateWindow(update); },
            onScale: setRenderScale,
            onVisualTransform: setLiveVisualTransform,
            onClick: (event) => {
                if (presentationRef.current?.mode === 'live2d') {
                    pointerClickRef.current(event);
                    return;
                }
                const canvas = visualCanvasRef.current;
                if (canvas !== null)
                    void playPetClickVoice(resolveImageBodyPart(canvas, event.clientX, event.clientY));
            }
        });
        interactionRef.current = interaction;
        const unsubscribe = bridge.pet.onLifecycle((event) => {
            if (event.type === 'display-changed' || event.type === 'resume') interaction.syncAfterDisplayChange();
            if (event.type === 'presentation-changed') void refreshPresentation();
            else if (event.type === 'reset-position') interaction.resetPosition();
        });
        return () => {
            unsubscribe();
            interaction.dispose();
            interactionRef.current = null;
        };
    }, [refreshPresentation]);
    useEffect(() => {
        interactionRef.current?.setLocked(menu !== null);
    }, [menu]);
    useEffect(() => {
        if (error !== null)
            showBubble(error, 'error');
    }, [error, showBubble]);
    useEffect(() => bridge.events.subscribe(['reminder.due'], (event) => {
        const envelope = isRecord(event.payload) ? event.payload : null;
        const reminder = envelope !== null && isRecord(envelope.data) ? envelope.data : null;
        if (reminder === null || typeof reminder.message !== 'string' || typeof reminder.reminderId !== 'string')
            return;
        if (reminder.allowTts !== true) {
            showBubble(reminder.message, 'reminder');
            return;
        }
        void synthesizeAndPlayPages(reminder.message, undefined,
            (page) => showBubble(page, 'reminder')).catch((reason: unknown) => {
            console.error('Reminder TTS playback failed', {
                reminderId: reminder.reminderId,
                error: reason instanceof Error ? reason.message : String(reason)
            });
        });
    }), [showBubble]);
    useEffect(() => {
        const cannotDraw = error !== null && presentation === null
            || presentation?.mode === 'image' && presentation.currentImage === null
            || presentation?.mode === 'png-sequence' && presentation.pngFrames.length === 0;
        if (!cannotDraw)
            return;
        const frame = requestAnimationFrame(revealPetWindow);
        return () => cancelAnimationFrame(frame);
    }, [error, presentation, revealPetWindow]);
    useEffect(() => {
        if (presentation === null)
            return;
        const url = presentation.mode === 'image'
            ? presentation.currentImage?.url
            : presentation.mode === 'png-sequence' ? presentation.pngFrames[0]?.url : undefined;
        if (url === undefined)
            localStorage.removeItem('aimaid.pet-current-image-url');
        else
            localStorage.setItem('aimaid.pet-current-image-url', url);
    }, [presentation]);
    useEffect(() => {
        if (bubble === null || presentation === null)
            return;
        const maskCanvas = document.createElement('canvas');
        let animationId = 0;
        let lastUpdatedAt = Number.NEGATIVE_INFINITY;
        let lastFrameAt = Number.NaN;
        let targetBottom: number | null = null;
        let targetLeft: number | null = null;
        let currentBottom: number | null = null;
        let currentLeft: number | null = null;
        const updateBubbleAnchor = (now: number): void => {
            if (now - lastUpdatedAt >= BUBBLE_ANCHOR_REFRESH_MS) {
                lastUpdatedAt = now;
                const bubbleHost = presentation.mode === 'live2d' ? stageRef.current : panelRef.current;
                const source = visualCanvasRef.current;
                const bubbleSurface = bubbleHost?.querySelector<HTMLElement>('.ui-pet-bubble') ?? null;
                if (bubbleHost !== null && source !== null && bubbleSurface !== null) {
                    const contour = presentation.mode === 'live2d'
                        ? readLiveContour()
                        : captureAlphaContour(source, maskCanvas);
                    if (contour !== null) {
                        const hostBounds = bubbleHost.getBoundingClientRect();
                        const sourceBounds = source.getBoundingClientRect();
                        const alphaTopPoint = contour.points.reduce((highest, point) => point.y < highest.y ? point : highest);
                        const alphaHitPoint = contour.points.reduce((nearest, point) => {
                            const nearestDistance = Math.hypot(nearest.x - contour.center.x, nearest.y - contour.center.y);
                            const distance = Math.hypot(point.x - contour.center.x, point.y - contour.center.y);
                            return distance < nearestDistance ? point : nearest;
                        });
                        const alphaTop = sourceBounds.top + alphaTopPoint.y * sourceBounds.height;
                        const alphaTopX = sourceBounds.left + alphaTopPoint.x * sourceBounds.width;
                        targetBottom = hostBounds.bottom - alphaTop + BUBBLE_ALPHA_GAP + BUBBLE_TAIL_HEIGHT;
                        targetLeft = alphaTopX - hostBounds.left - BUBBLE_TAIL_LEFT + BUBBLE_WIDTH / 2;
                        currentBottom ??= targetBottom;
                        currentLeft ??= targetLeft;
                        bubbleSurface.dataset.alphaAnchored = '';
                        bubbleSurface.dataset.alphaAnchorX = alphaTopX.toFixed(2);
                        bubbleSurface.dataset.alphaAnchorY = alphaTop.toFixed(2);
                        bubbleSurface.dataset.alphaHitX = (sourceBounds.left + alphaHitPoint.x * sourceBounds.width).toFixed(2);
                        bubbleSurface.dataset.alphaHitY = (sourceBounds.top + alphaHitPoint.y * sourceBounds.height).toFixed(2);
                    }
                }
            }
            const bubbleHost = presentation.mode === 'live2d' ? stageRef.current : panelRef.current;
            const bubbleSurface = bubbleHost?.querySelector<HTMLElement>('.ui-pet-bubble') ?? null;
            if (bubbleSurface !== null && targetBottom !== null && targetLeft !== null &&
                currentBottom !== null && currentLeft !== null) {
                if (presentation.mode === 'live2d') {
                    currentBottom = targetBottom;
                    currentLeft = targetLeft;
                }
                else {
                    const elapsed = Number.isNaN(lastFrameAt) ? 16 : Math.min(50, now - lastFrameAt);
                    const follow = 1 - Math.exp(-elapsed / BUBBLE_FOLLOW_TIME_MS);
                    currentBottom += (targetBottom - currentBottom) * follow;
                    currentLeft += (targetLeft - currentLeft) * follow;
                }
                bubbleSurface.style.setProperty('--pet-bubble-bottom', `${currentBottom.toFixed(2)}px`);
                bubbleSurface.style.setProperty('--pet-bubble-left', `${currentLeft.toFixed(2)}px`);
            }
            lastFrameAt = now;
            animationId = requestAnimationFrame(updateBubbleAnchor);
        };
        animationId = requestAnimationFrame(updateBubbleAnchor);
        return () => cancelAnimationFrame(animationId);
    }, [bubble, presentation, readLiveContour]);
    async function execute(action: PetPresentationAction): Promise<void> {
        const response = await bridge.pet.presentation.execute(action);
        if (response.success && response.payload !== null) {
            setPresentation(response.payload);
            setError(null);
        }
        else
            setError(response.error?.message ?? '桌宠操作失败。');
        setMenu(null);
    }
    function open(target: WindowKind): void {
        setMenu(null);
        void bridge.window.open(target);
    }
    async function showCurrentConversation(): Promise<void> {
        setMenu(null);
        const response = await bridge.core.invoke({ type: 'chat.history', payload: { limit: 40 } });
        if (!response.success || response.payload === null) {
            showBubble(response.error?.message ?? '当前对话读取失败。', 'error');
            return;
        }
        const payload = response.payload as {
            messages?: ChatMessageDto[];
        };
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        if (messages.length === 0) {
            showBubble('还没有可继续播放的当前对话。', 'feedback');
            return;
        }
        showBubble(messages.map(formatConversationMessage).join('\n').trim(), 'conversation');
        let ttsEnabled: boolean;
        try {
            ttsEnabled = await realtimeTtsEnabled();
        }
        catch (reason: unknown) {
            const message = reason instanceof Error ? reason.message : String(reason);
            showBubble(message || '实时 TTS 设置读取失败。', 'error');
            return;
        }
        if (!ttsEnabled)
            return;
        const audioPaths = latestAssistantAudioPaths(messages);
        await playLocalAudioPaths(audioPaths);
    }
    async function loadVoiceMenu(): Promise<void> {
        setVoiceMenu({ roleName: '正在读取…', intimacy: '正在读取…' });
        try {
            const response = await bridge.core.invoke({ type: 'pet.voice_menu.get', payload: {} });
            if (!response.success || response.payload === null)
                throw new Error(response.error?.message ?? '语音状态读取失败。');
            const value = response.payload as {
                roleName: string;
                intimacyLabel: string;
            };
            setVoiceMenu({ roleName: value.roleName, intimacy: value.intimacyLabel });
        }
        catch (reason: unknown) {
            setVoiceMenu({ roleName: '读取失败', intimacy: '读取失败' });
            const message = reason instanceof Error ? reason.message : String(reason);
            showBubble(message || '语音状态读取失败。', 'error');
        }
    }
    async function cycleVoiceIntimacy(): Promise<void> {
        setMenu(null);
        showBubble('正在切换好感度并准备对应语音缓存…', 'feedback');
        const response = await bridge.core.invoke({ type: 'pet.voice_intimacy.cycle', payload: {} });
        if (!response.success || response.payload === null) {
            showBubble(response.error?.message ?? '好感度切换失败。', 'error');
            return;
        }
        const value = response.payload as {
            roleName: string;
            intimacyLabel: string;
        };
        setVoiceMenu({ roleName: value.roleName, intimacy: value.intimacyLabel });
        showBubble(`好感度已切换为 ${value.intimacyLabel}`, 'feedback');
    }
    async function clearVoiceCache(): Promise<void> {
        setMenu(null);
        showBubble('正在清理并重新生成当前语音缓存…', 'feedback');
        const response = await bridge.core.invoke({ type: 'pet.voice_cache.clear', payload: {} });
        if (!response.success || response.payload === null) {
            showBubble(response.error?.message ?? '语音缓存清理失败。', 'error');
            return;
        }
        const value = response.payload as { message?: string; deletedEntries?: number; deletedFiles?: number; generatedEntries?: number };
        showBubble(value.message ?? `语音缓存已清理并重生成：删除 ${value.deletedEntries ?? 0} 条，生成 ${value.generatedEntries ?? 0} 条。`, 'feedback');
    }
    const playPetClickVoice = useCallback(async (bodyPart: string): Promise<void> => {
        const mode = presentationRef.current?.mode ?? 'unknown';
        const response = await bridge.core.invoke({ type: 'pet.voice.play', payload: { triggerId: 'click', bodyPart, source: `pet.${mode}` } });
        if (!response.success || response.payload === null) {
            showBubble(response.error?.message ?? '点击语音读取失败。', 'error');
            return;
        }
        const value = response.payload as { matched?: boolean; triggerId?: string; bodyPart?: string; text?: string; audioPath?: string; reason?: string };
        if (value.matched !== true || typeof value.audioPath !== 'string' || value.audioPath.length === 0) {
            showBubble('当前点击语音缓存尚未准备好。', 'feedback');
            return;
        }
        let played = false;
        let reason = 'play_failed';
        try {
            played = await playCachedAudio(value.audioPath);
            reason = played ? 'cache_match' : 'suppressed_audio_busy_or_muted';
            if (played && typeof value.text === 'string' && value.text.length > 0)
                showBubble(value.text, 'speech');
        }
        catch (error) {
            reason = error instanceof Error ? error.message : String(error);
            showBubble(`点击语音播放失败：${reason}`, 'error');
        }
        await bridge.core.invoke({
            type: 'pet.voice.playback.report',
            payload: {
                triggerId: value.triggerId ?? 'click', bodyPart: value.bodyPart ?? bodyPart,
                text: value.text ?? '', audioPath: value.audioPath, played, reason,
                source: `pet.${mode}`
            }
        });
    }, [showBubble]);
    return <TransparentStage ref={stageRef} data-display-mode={presentation?.mode ?? 'loading'} onContextMenu={(event) => {
            event.preventDefault();
            if (!hitTestRef.current(event.clientX, event.clientY))
                return;
            void bridge.pet.setIgnoreMouseEvents(false);
            void loadVoiceMenu();
            setMenu({ x: event.clientX, y: event.clientY });
        }}>
    <PetPanelSurface ref={panelRef}>
      <PetItemSurface ref={itemRef}>
        {presentation === null ? <Container>{error ?? '正在读取桌宠显示模式…'}</Container> : null}
        {presentation?.mode === 'image' ? <ImageMode canvasRef={visualCanvasRef} presentation={presentation} scale={renderScale} onAdvance={() => void execute('next-image')} onFirstFrame={revealPetWindow} registerHitTest={registerHitTest}/> : null}
        {presentation?.mode === 'png-sequence' ? <PngSequenceMode canvasRef={visualCanvasRef} presentation={presentation} scale={renderScale} onFirstFrame={revealPetWindow} registerHitTest={registerHitTest}/> : null}
      </PetItemSurface>
      {presentation?.mode !== 'live2d' ? <PetBubble message={bubble} speechHeld={speechHeld} onExpired={expireBubble}/> : null}
    </PetPanelSurface>
    {presentation?.mode === 'live2d' ? <Live2DMode canvasRef={visualCanvasRef} role={presentation.live2dRole} scale={renderScale} placement={liveVisualTransform} registerHitTest={registerHitTest} registerPointerClick={registerPointerClick} registerContourReader={registerLiveContourReader} showBubble={showBubble} playVoice={playPetClickVoice}/> : null}
    {presentation?.mode === 'live2d' ? <PetBubble message={bubble} speechHeld={speechHeld} onExpired={expireBubble}/> : null}
    {presentation !== null ? <PetAudioContour sourceCanvasRef={visualCanvasRef}
      readContour={presentation.mode === 'live2d' ? readLiveContour : undefined}
      sourceKey={presentation.mode === 'image' ? `image:${presentation.currentImage?.url ?? ''}` :
        presentation.mode === 'png-sequence' ? `png:${presentation.pngRole}` : `live2d:${presentation.live2dRole}`}
      visualAnchor={presentation.mode === 'live2d' ? { clientX: liveVisualTransform.centerX, clientY: liveVisualTransform.centerY } : undefined}
      visualizerStyle={visualizerStyle}/> : null}
    {menu !== null && presentation !== null ? <PetContextMenu position={menu} presentation={presentation} voiceMenu={voiceMenu} execute={(action) => void execute(action)} open={open} cycleVoiceIntimacy={() => void cycleVoiceIntimacy()} clearVoiceCache={() => void clearVoiceCache()} showCurrentConversation={() => void showCurrentConversation()} close={() => setMenu(null)}/> : null}
  </TransparentStage>;
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
function latestAssistantAudioPaths(messages: readonly ChatMessageDto[]): string[] {
    let paths: string[] = [];
    for (const message of messages) {
        if (message.role.toLowerCase() === 'user')
            continue;
        try {
            const metadata = JSON.parse(message.metadataJson) as {
                audioPaths?: unknown;
            };
            if (Array.isArray(metadata.audioPaths)) {
                const current = metadata.audioPaths.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
                if (current.length > 0)
                    paths = current;
            }
        }
        catch { /* old records may contain non-JSON metadata */ }
    }
    return paths;
}
function ImageMode({ canvasRef, presentation, scale, onAdvance, onFirstFrame, registerHitTest }: {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    presentation: PetPresentationSnapshot;
    scale: number;
    onAdvance: () => void;
    onFirstFrame: () => void;
    registerHitTest: (hitTest: PetHitTest | null) => void;
}): React.JSX.Element {
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null)
            return;
        registerHitTest((x, y) => isOpaqueCanvasPoint(canvas, x, y));
        return () => registerHitTest(null);
    }, [registerHitTest]);
    useEffect(() => {
        if (presentation.paused || presentation.currentImage === null)
            return;
        const timer = window.setInterval(onAdvance, presentation.imageIntervalSeconds * 1000);
        return () => window.clearInterval(timer);
    }, [onAdvance, presentation.currentImage, presentation.imageIntervalSeconds, presentation.paused]);
    useDrawCanvasImage(canvasRef, presentation.currentImage?.url ?? null, scale, onFirstFrame);
    const backingScale = scale * Math.min(window.devicePixelRatio || 1, 2);
    const canvasWidth = Math.max(1, Math.round(PET_CANVAS_WIDTH * backingScale));
    const canvasHeight = Math.max(1, Math.round(PET_CANVAS_HEIGHT * backingScale));
    return presentation.currentImage === null
        ? <Container>未找到图片。右键选择图片文件夹。</Container>
        : <TransparentCanvas ref={canvasRef} width={canvasWidth} height={canvasHeight} aria-label={presentation.currentImage.name} data-mode="image"/>;
}
async function loadMusicVisualizerStyle(): Promise<MusicVisualizerStyle> {
    const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: [MUSIC_VISUALIZER_STYLE_KEY] } });
    if (!response.success)
        throw new Error(response.error?.message ?? '音浪样式读取失败。');
    const payload = response.payload as { settings?: Array<{ key: string; value: string }> } | null;
    return parseMusicVisualizerStyle(payload?.settings?.find((item) => item.key === MUSIC_VISUALIZER_STYLE_KEY)?.value);
}
function PngSequenceMode({ canvasRef, presentation, scale, onFirstFrame, registerHitTest }: {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    presentation: PetPresentationSnapshot;
    scale: number;
    onFirstFrame: () => void;
    registerHitTest: (hitTest: PetHitTest | null) => void;
}): React.JSX.Element {
    const frameRef = useRef(0);
    const cacheRef = useRef(new Map<string, HTMLImageElement>());
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null)
            return;
        registerHitTest((x, y) => isOpaqueCanvasPoint(canvas, x, y));
        return () => registerHitTest(null);
    }, [registerHitTest]);
    useEffect(() => { frameRef.current = 0; cacheRef.current.clear(); }, [presentation.pngRole]);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null || presentation.pngFrames.length === 0)
            return;
        let disposed = false;
        let animationId = 0;
        let startedAt = performance.now() - frameRef.current * 1000 / presentation.pngSourceFps;
        let lastDisplayTick = 0;
        let lastCanvasWidth = canvas.width;
        let lastCanvasHeight = canvas.height;
        const load = (index: number): HTMLImageElement => {
            const normalized = (index + presentation.pngFrames.length) % presentation.pngFrames.length;
            const url = presentation.pngFrames[normalized]!.url;
            const existing = cacheRef.current.get(url);
            if (existing !== undefined)
                return existing;
            const image = new Image();
            image.crossOrigin = 'anonymous';
            image.src = url;
            cacheRef.current.set(url, image);
            return image;
        };
        const draw = (index: number): void => {
            const image = load(index);
            if (image.complete && image.naturalWidth > 0) {
                drawPetImage(canvas, image);
                onFirstFrame();
            }
            else
                image.addEventListener('load', () => {
                    if (!disposed) {
                        drawPetImage(canvas, image);
                        onFirstFrame();
                    }
                }, { once: true });
            for (let offset = 1; offset <= 24; offset++)
                load(index + offset);
        };
        draw(frameRef.current);
        const render = (now: number): void => {
            if (disposed)
                return;
            if (canvas.width !== lastCanvasWidth || canvas.height !== lastCanvasHeight) {
                lastCanvasWidth = canvas.width;
                lastCanvasHeight = canvas.height;
                draw(frameRef.current);
            }
            if (!presentation.paused) {
                const displayInterval = 1000 / presentation.pngFps;
                if (now - lastDisplayTick >= displayInterval) {
                    lastDisplayTick = now - ((now - lastDisplayTick) % displayInterval);
                    const next = Math.floor((now - startedAt) * presentation.pngSourceFps / 1000) % presentation.pngFrames.length;
                    if (next !== frameRef.current) {
                        frameRef.current = next;
                        draw(next);
                    }
                }
            }
            else
                startedAt = now - frameRef.current * 1000 / presentation.pngSourceFps;
            animationId = requestAnimationFrame(render);
        };
        animationId = requestAnimationFrame(render);
        return () => { disposed = true; cancelAnimationFrame(animationId); cacheRef.current.clear(); };
    }, [onFirstFrame, presentation.paused, presentation.pngFps, presentation.pngFrames, presentation.pngRole, presentation.pngSourceFps]);
    const backingScale = scale * Math.min(window.devicePixelRatio || 1, 2);
    const canvasWidth = Math.max(1, Math.round(PET_CANVAS_WIDTH * backingScale));
    const canvasHeight = Math.max(1, Math.round(PET_CANVAS_HEIGHT * backingScale));
    return presentation.pngFrames.length === 0
        ? <Container>未找到 PNG 序列素材。</Container>
        : <TransparentCanvas ref={canvasRef} width={canvasWidth} height={canvasHeight} aria-label={presentation.pngRole}/>;
}
function useDrawCanvasImage(
    ref: React.RefObject<HTMLCanvasElement | null>,
    url: string | null,
    scale: number,
    onFirstFrame: () => void
): void {
    const loadedImageRef = useRef<HTMLImageElement | null>(null);
    useEffect(() => {
        const canvas = ref.current;
        if (canvas === null || url === null)
            return;
        loadedImageRef.current = null;
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            loadedImageRef.current = image;
            drawPetImage(canvas, image);
            onFirstFrame();
        };
        image.src = url;
        return () => {
            image.onload = null;
            if (loadedImageRef.current === image)
                loadedImageRef.current = null;
        };
    }, [onFirstFrame, ref, url]);
    useEffect(() => {
        const canvas = ref.current;
        const image = loadedImageRef.current;
        if (canvas !== null && image !== null)
            drawPetImage(canvas, image);
    }, [ref, scale]);
}
function drawPetImage(canvas: HTMLCanvasElement, image: HTMLImageElement): void {
    const width = canvas.width;
    const height = canvas.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null)
        return;
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}
function isOpaqueCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom)
        return false;
    const x = Math.floor((clientX - rect.left) * canvas.width / rect.width);
    const y = Math.floor((clientY - rect.top) * canvas.height / rect.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null)
        return false;
    try {
        return context.getImageData(x, y, 1, 1).data[3]! >= 24;
    }
    catch (error) {
        console.error('[PetInteraction] canvas alpha read failed', error);
        return false;
    }
}
function resolveImageBodyPart(canvas: HTMLCanvasElement, clientX: number, clientY: number): string {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0)
        return 'body';
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const areas = [
        { id: 'face', x: 0.34, y: 0.10, width: 0.32, height: 0.15, priority: 140 },
        { id: 'hair', x: 0.26, y: 0.00, width: 0.48, height: 0.13, priority: 130 },
        { id: 'chest', x: 0.34, y: 0.26, width: 0.32, height: 0.18, priority: 130 },
        { id: 'head', x: 0.30, y: 0.04, width: 0.40, height: 0.18, priority: 120 },
        { id: 'foot', x: 0.18, y: 0.76, width: 0.64, height: 0.22, priority: 100 },
        { id: 'hand', x: 0.08, y: 0.25, width: 0.84, height: 0.22, priority: 90 },
        { id: 'leg', x: 0.25, y: 0.48, width: 0.50, height: 0.30, priority: 80 },
        { id: 'body', x: 0.25, y: 0.20, width: 0.50, height: 0.34, priority: 70 }
    ];
    return areas
        .filter((area) => x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height)
        .sort((left, right) => right.priority - left.priority || left.width * left.height - right.width * right.height)[0]?.id ?? 'body';
}
function PetContextMenu({ position, presentation, voiceMenu, execute, open, cycleVoiceIntimacy, clearVoiceCache, showCurrentConversation, close }: {
    position: {
        x: number;
        y: number;
    };
    presentation: PetPresentationSnapshot;
    voiceMenu: {
        roleName: string;
        intimacy: string;
    };
    execute: (action: PetPresentationAction) => void;
    open: (target: WindowKind) => void;
    cycleVoiceIntimacy: () => void;
    clearVoiceCache: () => void;
    showCurrentConversation: () => void;
    close: () => void;
}): React.JSX.Element {
    const icon = (name: Parameters<typeof UiIcon>[0]['name']): React.JSX.Element => <UiIcon name={name}/>;
    const items = [
        ...(presentation.mode !== 'live2d' ? [{ id: 'pause', label: presentation.paused ? '继续' : '暂停', icon: icon('pause'), onSelect: () => execute('toggle-pause') }] : []),
        { id: 'mode', label: `显示模式：${modeLabel(presentation.mode)}`, icon: icon('layers'), onSelect: () => execute('cycle-mode') },
        ...(presentation.mode === 'image' ? [
            { id: 'next-image', label: '切换图片', icon: icon('image'), onSelect: () => execute('next-image') },
            { id: 'interval', label: `${presentation.imageIntervalSeconds} 秒`, icon: icon('clock'), onSelect: () => execute('cycle-image-interval') },
            { id: 'folder', label: presentation.imageFolderName, icon: icon('folder'), onSelect: () => execute('cycle-image-folder') }
        ] : []),
        ...(presentation.mode === 'png-sequence' ? [
            { id: 'fps', label: `${presentation.pngFps} FPS`, icon: icon('gauge'), onSelect: () => execute('cycle-png-fps') },
            { id: 'png-role', label: presentation.pngRole || '未找到 PNG 角色', icon: icon('user'), onSelect: () => execute('cycle-png-role') },
            { id: 'carousel', label: presentation.pngCarousel ? '轮播模式' : '循环模式', icon: icon('repeat'), onSelect: () => execute('toggle-png-carousel') }
        ] : []),
        ...(presentation.mode === 'live2d' ? [{ id: 'live2d-role', label: `切换角色：${presentation.live2dRole}`, icon: icon('user'), onSelect: () => execute('switch-live2d-role') }] : []),
        { id: 'voice-role', label: voiceMenu.roleName, icon: icon('sparkles'), separated: true, onSelect: () => open('characters') },
        { id: 'intimacy', label: voiceMenu.intimacy, icon: icon('heart'), onSelect: cycleVoiceIntimacy },
        { id: 'voice-cache', label: '清除语音缓存', icon: icon('trash'), onSelect: clearVoiceCache },
        { id: 'status', label: '状态', icon: icon('activity'), separated: true, onSelect: () => open('status') },
        { id: 'workbench', label: '工作台', icon: icon('grid'), onSelect: () => open('main') },
        { id: 'conversation', label: '当前对话', icon: icon('message'), onSelect: showCurrentConversation },
        { id: 'appearance', label: '外观设置', icon: icon('palette'), onSelect: () => open('appearance') },
        { id: 'showcase', label: '控件展示', icon: icon('grid'), onSelect: () => open('ui-showcase') },
        { id: 'system', label: '系统', icon: icon('settings'), onSelect: () => open('settings') }
    ];
    return <ContextMenuSurface label="桌宠菜单" items={items} position={position} footer={`版本 ${bridge.app.version}`} onClose={close}/>;
}
function modeLabel(mode: PetPresentationSnapshot['mode']): string { return mode === 'image' ? '图片' : mode === 'png-sequence' ? 'PNG' : 'Live2D'; }
function Live2DMode({ canvasRef, role, scale, placement, registerHitTest, registerPointerClick, registerContourReader, showBubble, playVoice }: {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    role: string;
    scale: number;
    placement: PetVisualTransform;
    registerHitTest: (hitTest: PetHitTest | null) => void;
    registerPointerClick: (click: PetPointerClick | null) => void;
    registerContourReader: (reader: (() => AlphaContour | null) | null) => void;
    showBubble: PetBubbleQueue['show'];
    playVoice: (bodyPart: string) => Promise<void>;
}): React.JSX.Element {
    const runtimeRef = useRef<PetRuntime | null>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null)
            return;
        const runtime = new PetRuntime(canvas, {
            onState: () => undefined,
            onError: (message) => { if (message !== null) showBubble(message, 'error'); },
            onScale: () => undefined,
            onMetrics: () => undefined
        });
        runtimeRef.current = runtime;
        registerContourReader(() => runtime.captureAlphaContour());
        runtime.setScale(scale);
        registerHitTest((x, y) => runtime.containsPoint(x, y));
        registerPointerClick((event) => {
            void runtime.handlePointerClick(event.clientX, event.clientY, event.ctrlKey, event.altKey)
                .then((bodyPart) => bodyPart === null ? undefined : playVoice(bodyPart))
                .catch((reason: unknown) => {
                    showBubble(reason instanceof Error ? reason.message : String(reason), 'error');
                });
        });
        return () => {
            registerHitTest(null);
            registerPointerClick(null);
            registerContourReader(null);
            runtimeRef.current = null;
            runtime.dispose();
        };
    }, [canvasRef, playVoice, registerContourReader, registerHitTest, registerPointerClick, showBubble]);
    useEffect(() => {
        const runtime = runtimeRef.current;
        if (runtime === null)
            return;
        void runtime.initialize(role).then(() => runtime.switchModel(role));
    }, [role]);
    useEffect(() => {
        runtimeRef.current?.setScale(scale);
    }, [scale]);
    useEffect(() => {
        runtimeRef.current?.setViewportPlacement(placement.centerX, placement.centerY);
    }, [placement.centerX, placement.centerY]);
    useEffect(() => bridge.events.subscribe(['system.stream.progress', 'system.stream.completed', 'request.cancelled'], (event) => {
        if (event.type === 'system.stream.completed')
            showBubble('处理已完成。', 'feedback');
        else if (event.type === 'request.cancelled')
            showBubble('当前操作已取消。', 'feedback');
    }), [showBubble]);
    return <>
    <TransparentCanvas ref={canvasRef} data-mode="live2d" aria-label="Live2D 桌宠模型"/>
  </>;
}
function formatConversationMessage(message: ChatMessageDto): string {
    if (message.role.toLowerCase() === 'user')
        return `我：${message.content}`;
    let characterName = message.characterId.trim() || '助手';
    try {
        const metadata = JSON.parse(message.metadataJson) as {
            characterName?: unknown;
        };
        if (typeof metadata.characterName === 'string' && metadata.characterName.trim() !== '')
            characterName = metadata.characterName.trim();
    }
    catch { /* old records may have empty or non-JSON metadata */ }
    return `${characterName}：${message.content}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
