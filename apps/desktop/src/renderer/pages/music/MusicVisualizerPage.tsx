import { MainRegion, MediaCanvas } from '../../components/ui';
import { useEffect, useRef } from 'react';
import type { IpcEventEnvelope } from '../../../shared/ipc';
import { bridge } from '../../shared/bridge';
interface MusicPlaybackState {
    url: string;
    title: string;
    singer: string;
    isPlaying: boolean;
}
export function MusicVisualizerPage(): React.JSX.Element {
    const canvas = useRef<HTMLCanvasElement>(null);
    const audio = useRef<HTMLAudioElement | null>(null);
    const playbackUrl = useRef('');
    const audioContext = useRef<AudioContext | null>(null);
    const analyser = useRef<AnalyserNode | null>(null);
    const fftTimer = useRef<number | null>(null);
    const masterAudio = useRef({ muted: false, volume: 100 });
    useEffect(() => {
        const postToVisualizer = (message: unknown): void => {
            if (!isRecord(message) || message.type !== 'fft' || !Array.isArray(message.bands) || canvas.current === null)
                return;
            const target = canvas.current;
            const width = Math.max(1, Math.round(target.clientWidth));
            const height = Math.max(1, Math.round(target.clientHeight));
            target.width = width;
            target.height = height;
            const context = target.getContext('2d');
            if (context === null)
                return;
            context.clearRect(0, 0, width, height);
            context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
            const values = message.bands.filter((value): value is number => typeof value === 'number');
            const barWidth = width / Math.max(1, values.length);
            values.forEach((value, index) => context.fillRect(index * barWidth, height * (1 - value), Math.max(1, barWidth - 2), height * value));
        };
        const stopLocal = (): void => {
            if (fftTimer.current !== null)
                window.clearInterval(fftTimer.current);
            fftTimer.current = null;
            audio.current?.pause();
            audio.current = null;
            playbackUrl.current = '';
            void audioContext.current?.close();
            audioContext.current = null;
            analyser.current = null;
        };
        const stop = async (): Promise<void> => {
            stopLocal();
            await bridge.core.invoke({ type: 'music.stop', payload: {} });
            await bridge.window.hide();
        };
        const play = async (state: MusicPlaybackState): Promise<void> => {
            if (!state.isPlaying || state.url === '' || state.url === playbackUrl.current)
                return;
            stopLocal();
            // Claim the URL before the first await. A newly opened window can receive both
            // music.current and music.playback.requested; only one of them may start playback.
            playbackUrl.current = state.url;
            masterAudio.current = await loadMasterAudio();
            if (playbackUrl.current !== state.url)
                return;
            if (masterAudio.current.muted || masterAudio.current.volume <= 0) {
                await stop();
                return;
            }
            const element = new Audio();
            element.crossOrigin = 'anonymous';
            element.src = state.url;
            element.preload = 'auto';
            element.volume = masterAudio.current.volume / 100;
            element.addEventListener('ended', () => { void stop(); }, { once: true });
            element.addEventListener('error', () => { void stop(); }, { once: true });
            const context = new AudioContext();
            const source = context.createMediaElementSource(element);
            const node = context.createAnalyser();
            node.fftSize = 1024;
            node.smoothingTimeConstant = 0;
            source.connect(node);
            node.connect(context.destination);
            audio.current = element;
            audioContext.current = context;
            analyser.current = node;
            await context.resume();
            await element.play();
            fftTimer.current = window.setInterval(() => {
                const current = analyser.current;
                if (current === null)
                    return;
                const samples = new Float32Array(1024);
                current.getFloatTimeDomainData(samples);
                const bands = frequencyBands(samples, 32);
                if (bands !== null)
                    postToVisualizer({ type: 'fft', bands });
            }, 33);
        };
        const loadCurrent = async (): Promise<void> => {
            const response = await bridge.core.invoke({ type: 'music.current', payload: {} });
            if (!response.success)
                throw new Error(response.error?.message ?? '当前音乐状态读取失败。');
            if (isPlaybackState(response.payload)) await play(response.payload);
        };
        const onCoreEvent = (event: IpcEventEnvelope): void => {
            if (event.type === 'settings.changed') {
                const data = readEventData(event.payload);
                if (!isRecord(data) || !Array.isArray(data.keys) ||
                    !data.keys.some((key) => key === 'master_audio_muted' || key === 'master_audio_volume'))
                    return;
                void loadMasterAudio().then((master) => {
                    masterAudio.current = master;
                    if (master.muted || master.volume <= 0)
                        void stop();
                    else if (audio.current !== null)
                        audio.current.volume = master.volume / 100;
                }).catch(() => { void stop(); });
                return;
            }
            if (event.type === 'music.playback.stopped') {
                stopLocal();
                return;
            }
            const data = readEventData(event.payload);
            if (event.type === 'music.playback.requested' && isRecord(data) && isPlaybackState(data.playback))
                void play(data.playback).catch((reason: unknown) => {
                    console.error('[MusicPlayback] start failed', reason);
                    void stop();
                });
        };
        const unsubscribe = bridge.events.subscribe(['music.playback.requested', 'music.playback.stopped', 'settings.changed'], onCoreEvent);
        void loadCurrent().catch((reason: unknown) => {
            console.error('[MusicPlayback] current state failed', reason);
            void stop();
        });
        return () => {
            unsubscribe();
            stopLocal();
        };
    }, []);
    return <MainRegion><MediaCanvas ref={canvas} aria-label="音乐可视化"/></MainRegion>;
}
function frequencyBands(samples: Float32Array, bandCount: number): number[] | null {
    if (!samples.some((sample) => Math.abs(sample) > 0.0001))
        return null;
    const real = new Float32Array(samples.length);
    const imaginary = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
        const hann = 0.5 * (1 - Math.cos(2 * Math.PI * index / (samples.length - 1)));
        real[index] = samples[index]! * hann;
    }
    fft(real, imaginary);
    const bands = new Array<number>(bandCount).fill(0);
    const halfSize = samples.length / 2;
    const usableBins = halfSize - 1;
    for (let band = 0; band < bandCount; band += 1) {
        const startBin = 1 + Math.floor(Math.pow(band / bandCount, 1.5) * usableBins);
        const calculatedEnd = 1 + Math.floor(Math.pow((band + 1) / bandCount, 1.5) * usableBins);
        const endBin = Math.min(halfSize, Math.max(startBin + 1, calculatedEnd));
        let sum = 0;
        for (let bin = startBin; bin < endBin; bin += 1)
            sum += Math.hypot(real[bin]!, imaginary[bin]!);
        bands[band] = sum / Math.max(1, endBin - startBin);
    }
    const maxValue = Math.max(0.001, ...bands);
    return maxValue > 0.001 ? bands.map((value) => Math.min(1, value / maxValue)) : bands;
}
function fft(real: Float32Array, imaginary: Float32Array): void {
    const length = real.length;
    for (let index = 1, reversed = 0; index < length; index += 1) {
        let bit = length >> 1;
        for (; (reversed & bit) !== 0; bit >>= 1)
            reversed ^= bit;
        reversed ^= bit;
        if (index < reversed) {
            const realValue = real[index]!;
            real[index] = real[reversed]!;
            real[reversed] = realValue;
            const imaginaryValue = imaginary[index]!;
            imaginary[index] = imaginary[reversed]!;
            imaginary[reversed] = imaginaryValue;
        }
    }
    for (let size = 2; size <= length; size <<= 1) {
        const angle = -2 * Math.PI / size;
        const stepReal = Math.cos(angle);
        const stepImaginary = Math.sin(angle);
        for (let offset = 0; offset < length; offset += size) {
            let twiddleReal = 1;
            let twiddleImaginary = 0;
            for (let index = 0; index < size / 2; index += 1) {
                const even = offset + index;
                const odd = even + size / 2;
                const evenReal = real[even]!;
                const evenImaginary = imaginary[even]!;
                const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
                const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
                real[odd] = evenReal - oddReal;
                imaginary[odd] = evenImaginary - oddImaginary;
                real[even] = evenReal + oddReal;
                imaginary[even] = evenImaginary + oddImaginary;
                const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
                twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
                twiddleReal = nextReal;
            }
        }
    }
}
function readEventData(value: unknown): unknown { return isRecord(value) ? value.data : null; }
async function loadMasterAudio(): Promise<{
    muted: boolean;
    volume: number;
}> {
    const response = await bridge.core.invoke({ type: 'settings.get', payload: { keys: ['master_audio_muted', 'master_audio_volume'] } });
    if (!response.success)
        throw new Error(response.error?.message ?? '主音量设置读取失败。');
    const payload = response.payload as {
        settings?: Array<{
            key: string;
            value: string;
        }>;
    } | null;
    const settings = new Map(payload?.settings?.map((item) => [item.key, item.value]));
    const parsed = Number.parseInt(settings.get('master_audio_volume') ?? '100', 10);
    const volume = Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 100;
    return { muted: settings.get('master_audio_muted')?.toLowerCase() === 'true' || volume <= 0, volume };
}
function isPlaybackState(value: unknown): value is MusicPlaybackState {
    return isRecord(value) && typeof value.url === 'string' && typeof value.title === 'string' &&
        typeof value.singer === 'string' && typeof value.isPlaying === 'boolean';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
