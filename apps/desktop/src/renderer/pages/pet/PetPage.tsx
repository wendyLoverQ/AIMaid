import { Container, PetItemSurface, TransparentCanvas, TransparentStage } from "../../components/ui";
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
import { PetItemInteractionController } from '../../shared/pet-item-interaction-controller';
import {
    PET_CANVAS_HEIGHT,
    PET_CANVAS_WIDTH
} from '../../../shared/pet-geometry';
import { PetBubble } from './PetBubble';
import { PetAudioContour } from './PetAudioContour';
import { startPetMusicPlayback } from './pet-music-playback';
import { playLocalAudioPaths, synthesizeAndPlay } from '../chat/tts-playback';
import { usePetBubbleQueue, type PetBubbleQueue } from './usePetBubbleQueue';
type PetHitTest = (clientX: number, clientY: number) => boolean;
type PetPointerClick = (event: MouseEvent) => void;
export default function PetPage(): React.JSX.Element {
    const [presentation, setPresentation] = useState<PetPresentationSnapshot | null>(null);
    const [menu, setMenu] = useState<{
        x: number;
        y: number;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { current: bubble, speechHeld, show: showBubble, expire: expireBubble } = usePetBubbleQueue();
    const [renderScale, setRenderScale] = useState(1);
    const [voiceMenu, setVoiceMenu] = useState({ roleName: '未选择', intimacy: '信赖 5 级' });
    const [visualizerStyle, setVisualizerStyle] = useState<MusicVisualizerStyle>('surround-bars');
    const readySentRef = useRef(false);
    const stageRef = useRef<HTMLElement>(null);
    const itemRef = useRef<HTMLDivElement>(null);
    const visualCanvasRef = useRef<HTMLCanvasElement>(null);
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
    useEffect(() => {
        const item = itemRef.current;
        if (item === null)
            return;
        const interaction = new PetItemInteractionController({
            item,
            hitTest: (x, y) => hitTestRef.current(x, y),
            setIgnoreMouseEvents: (ignore) => { void bridge.pet.setIgnoreMouseEvents(ignore); },
            dragStart: () => { void bridge.pet.dragStart(); },
            dragMove: () => { void bridge.pet.dragMove(); },
            dragEnd: () => { void bridge.pet.dragEnd(); },
            updateWindow: (update) => { void bridge.pet.updateWindow(update); },
            onScale: setRenderScale,
            onClick: (event) => pointerClickRef.current(event)
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
        showBubble(reminder.message, 'reminder');
        if (reminder.allowTts !== true)
            return;
        void synthesizeAndPlay(reminder.message).catch((reason: unknown) => {
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
        if (!await realtimeTtsEnabled())
            return;
        const audioPaths = latestAssistantAudioPaths(messages);
        await playLocalAudioPaths(audioPaths);
    }
    async function loadVoiceMenu(): Promise<void> {
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
        catch {
            setVoiceMenu({ roleName: '未选择', intimacy: '信赖 5 级' });
        }
    }
    async function cycleVoiceIntimacy(): Promise<void> {
        setMenu(null);
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
        const response = await bridge.core.invoke({ type: 'pet.voice_cache.clear', payload: {} });
        if (!response.success || response.payload === null) {
            showBubble(response.error?.message ?? '语音缓存清理失败。', 'error');
            return;
        }
        const value = response.payload as { deletedEntries?: number; deletedFiles?: number };
        showBubble(`语音缓存已清理：${value.deletedEntries ?? 0} 条记录，${value.deletedFiles ?? 0} 个文件。`, 'feedback');
    }
    return <TransparentStage ref={stageRef} data-display-mode={presentation?.mode ?? 'loading'} onContextMenu={(event) => {
            event.preventDefault();
            if (!hitTestRef.current(event.clientX, event.clientY))
                return;
            void bridge.pet.setIgnoreMouseEvents(false);
            void loadVoiceMenu();
            setMenu({ x: event.clientX, y: event.clientY });
        }}>
    <PetItemSurface ref={itemRef}>
      {presentation === null ? <Container>{error ?? '正在读取桌宠显示模式…'}</Container> : null}
      {presentation?.mode === 'image' ? <ImageMode canvasRef={visualCanvasRef} presentation={presentation} scale={renderScale} onAdvance={() => void execute('next-image')} onFirstFrame={revealPetWindow} registerHitTest={registerHitTest}/> : null}
      {presentation?.mode === 'png-sequence' ? <PngSequenceMode canvasRef={visualCanvasRef} presentation={presentation} scale={renderScale} onFirstFrame={revealPetWindow} registerHitTest={registerHitTest}/> : null}
      {presentation?.mode === 'live2d' ? <Live2DMode canvasRef={visualCanvasRef} role={presentation.live2dRole} scale={renderScale} registerHitTest={registerHitTest} registerPointerClick={registerPointerClick} registerContourReader={registerLiveContourReader} showBubble={showBubble}/> : null}
      <PetBubble message={bubble} speechHeld={speechHeld} onExpired={expireBubble}/>
    </PetItemSurface>
    {presentation !== null ? <PetAudioContour sourceCanvasRef={visualCanvasRef}
      readContour={presentation.mode === 'live2d' ? readLiveContour : undefined}
      sourceKey={presentation.mode === 'image' ? `image:${presentation.currentImage?.url ?? ''}` :
        presentation.mode === 'png-sequence' ? `png:${presentation.pngRole}` : `live2d:${presentation.live2dRole}`}
      visualizerStyle={visualizerStyle}/> : null}
    {menu !== null && presentation !== null ? <PetContextMenu position={menu} presentation={presentation} voiceMenu={voiceMenu} execute={(action) => void execute(action)} open={open} cycleVoiceIntimacy={() => void cycleVoiceIntimacy()} clearVoiceCache={() => void clearVoiceCache()} showCurrentConversation={() => void showCurrentConversation()} close={() => setMenu(null)}/> : null}
  </TransparentStage>;
}
async function realtimeTtsEnabled(): Promise<boolean> {
    const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['realtime_tts_enabled'] } });
    if (!response.success)
        return false;
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
        : <TransparentCanvas ref={canvasRef} width={canvasWidth} height={canvasHeight} aria-label={presentation.currentImage.name}/>;
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
    }, [onFirstFrame, presentation.paused, presentation.pngFps, presentation.pngFrames, presentation.pngRole, presentation.pngSourceFps, scale]);
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
    useEffect(() => {
        const canvas = ref.current;
        if (canvas === null || url === null)
            return;
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            drawPetImage(canvas, image);
            onFirstFrame();
        };
        image.src = url;
        return () => { image.onload = null; };
    }, [onFirstFrame, ref, scale, url]);
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
function Live2DMode({ canvasRef, role, scale, registerHitTest, registerPointerClick, registerContourReader, showBubble }: {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    role: string;
    scale: number;
    registerHitTest: (hitTest: PetHitTest | null) => void;
    registerPointerClick: (click: PetPointerClick | null) => void;
    registerContourReader: (reader: (() => AlphaContour | null) | null) => void;
    showBubble: PetBubbleQueue['show'];
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
            void runtime.handlePointerClick(event.clientX, event.clientY, event.ctrlKey, event.altKey).catch((reason: unknown) => {
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
    }, [canvasRef, registerContourReader, registerHitTest, registerPointerClick, showBubble]);
    useEffect(() => {
        const runtime = runtimeRef.current;
        if (runtime === null)
            return;
        void runtime.initialize(role).then(() => runtime.switchModel(role));
    }, [role]);
    useEffect(() => {
        runtimeRef.current?.setScale(scale);
    }, [scale]);
    useEffect(() => bridge.events.subscribe(['system.stream.progress', 'system.stream.completed', 'request.cancelled'], (event) => {
        if (event.type === 'system.stream.completed')
            showBubble('处理已完成。', 'feedback');
        else if (event.type === 'request.cancelled')
            showBubble('当前操作已取消。', 'feedback');
    }), [showBubble]);
    return <>
    <TransparentCanvas ref={canvasRef} aria-label="Live2D 桌宠模型"/>
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
