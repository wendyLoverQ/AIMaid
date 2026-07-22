import { Alert, EmptyState, InlineText, Paragraph, ProductList, ProductPage, ProductPanel, ProductStatusBar, ProductWorkspace, Strong, VideoPlayer } from '../../components/ui';
import { useEffect, useRef, useState } from 'react';
import type { SubtitleItemDto, VideoItemDto } from '../../../shared/business';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { Dialog } from '../../components/ui';
import { bridge } from '../../shared/bridge';
import { restoredPlaybackPosition, VideoProgressSession } from '../../../shared/video-progress';
export function VideoPlayerPage(): React.JSX.Element {
    const [item] = useState<VideoItemDto | null>(() => readPlayback());
    const [source, setSource] = useState('');
    const [error, setError] = useState('');
    const [progressStatus, setProgressStatus] = useState('');
    const playerRef = useRef<HTMLVideoElement | null>(null);
    const progressSessionRef = useRef<VideoProgressSession | null>(null);
    useEffect(() => {
        void resolveSource(item).then((value) => {
            if (value === '') setError('这条视频记录没有可直接播放的媒体地址。');
            else setSource(value);
        }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '本地视频读取失败。'));
    }, [item]);
    useEffect(() => {
        if (item === null) return;
        const session = new VideoProgressSession(
            ({ positionSeconds, durationSeconds }) => bridge.core.invoke({ type: 'video.update_progress', payload: { videoId: item.videoId, positionSeconds, durationSeconds } }),
            setProgressStatus
        );
        progressSessionRef.current = session;
        const flush = (): void => {
            const player = playerRef.current;
            if (player !== null) session.flush(player.currentTime, player.duration);
        };
        window.addEventListener('beforeunload', flush);
        window.addEventListener('pagehide', flush);
        return () => {
            window.removeEventListener('beforeunload', flush);
            window.removeEventListener('pagehide', flush);
            const player = playerRef.current;
            session.dispose(player?.currentTime, player?.duration);
            progressSessionRef.current = null;
        };
    }, [item]);
    return <ProductPage>
    <WindowTitleBar title={item?.title || item?.filePath.split(/[\\/]/).at(-1) || '视频播放'}/>
    <ProductWorkspace layout="single">
      <ProductPanel title={item?.title || '视频播放'} description={item?.filePath || item?.originalUrl || '正在读取媒体地址'} emphasis scroll>
      {error !== '' ? <Alert tone="error" title="无法播放">{error}</Alert> : source === '' ? <Paragraph>正在读取视频…</Paragraph> : <VideoPlayer ref={playerRef} source={source} autoPlay onError={() => setError('当前视频格式或编码暂不受支持。')} onLoadedMetadata={(event) => {
        if (item === null) return;
        event.currentTarget.currentTime = restoredPlaybackPosition(item.lastPositionSeconds, event.currentTarget.duration, item.isCompleted);
      }} onTimeUpdate={(event) => progressSessionRef.current?.update(event.currentTarget.currentTime, event.currentTarget.duration)} onPause={(event) => progressSessionRef.current?.flush(event.currentTarget.currentTime, event.currentTarget.duration)} onEnded={(event) => progressSessionRef.current?.flush(event.currentTarget.currentTime, event.currentTarget.duration)}/>}
      </ProductPanel>
      {progressStatus !== '' ? <ProductStatusBar>{progressStatus}</ProductStatusBar> : null}
    </ProductWorkspace>
  </ProductPage>;
}
export function VideoSubtitlesPage(): React.JSX.Element {
    const [items, setItems] = useState<SubtitleItemDto[]>([]);
    const [selectedPath, setSelectedPath] = useState('');
    const [status, setStatus] = useState('正在读取字幕资源…');
    const [deleteOpen, setDeleteOpen] = useState(false);
    async function load(nextStatus?: string): Promise<void> {
        const response = await bridge.core.invoke({ type: 'subtitle.list', payload: {} });
        if (!response.success || !Array.isArray(response.payload)) {
            setStatus(response.error?.message ?? '字幕资源读取失败。');
            return;
        }
        const next = response.payload.filter(isSubtitleItem);
        setItems(next);
        if (!next.some((item) => item.path === selectedPath))
            setSelectedPath('');
        setStatus(nextStatus ?? (next.length === 0 ? '字幕资源已加载。' : `共 ${next.length} 个字幕文件。`));
    }
    useEffect(() => { void load(); }, []);
    async function add(): Promise<void> {
        const response = await bridge.dialog.openFile([{ name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt'] }, { name: '所有文件', extensions: ['*'] }], true);
        const paths = response.success ? readPaths(response.payload) : [];
        if (paths.length === 0)
            return;
        for (const sourcePath of paths) {
            const result = await bridge.core.invoke({ type: 'subtitle.import', payload: { sourcePath } });
            if (!result.success) {
                setStatus(result.error?.message ?? '字幕导入失败。');
                return;
            }
        }
        await load();
    }
    async function importFolder(): Promise<void> {
        const response = await bridge.dialog.openDirectory();
        const folderPath = response.success ? response.payload?.filePaths[0] : undefined;
        if (folderPath === undefined)
            return;
        const result = await bridge.core.invoke({ type: 'subtitle.import_folder', payload: { folderPath } });
        if (!result.success) {
            setStatus(result.error?.message ?? '字幕文件夹导入失败。');
            return;
        }
        const count = typeof result.payload === 'number' ? result.payload : 0;
        await load(`递归导入完成，共添加 ${count} 个字幕。`);
    }
    async function remove(): Promise<void> {
        if (selectedPath === '')
            return;
        const result = await bridge.core.invoke({ type: 'subtitle.delete', payload: { path: selectedPath } });
        if (!result.success) {
            setStatus(result.error?.message ?? '字幕删除失败。');
            return;
        }
        setDeleteOpen(false);
        setSelectedPath('');
        await load();
    }
    const selected = items.find((item) => item.path === selectedPath);
    const tools = <><Button size="sm" onClick={() => void add()}>添加字幕</Button><Button size="sm" onClick={() => void importFolder()}>递归导入</Button><Button size="sm" variant="danger" disabled={selected === undefined} onClick={() => setDeleteOpen(true)}>删除字幕</Button><Button size="sm" onClick={() => void load()}>刷新</Button></>;
    return <ProductPage>
    <WindowTitleBar title="我的字幕" tools={tools}/>
    <ProductWorkspace layout="single">
      <ProductPanel title="字幕资源" actions={<Strong>{items.length} 个文件</Strong>} scroll>
        {items.length === 0 ? <EmptyState title="还没有字幕文件" action={<Button variant="primary" onClick={() => void add()}>添加第一个字幕</Button>}/> : <ProductList>{items.map((item) => <Pressable selected={selectedPath === item.path} key={item.path} onClick={() => setSelectedPath(item.path)}><Strong>{item.name}</Strong><InlineText>{item.path}</InlineText></Pressable>)}</ProductList>}
      </ProductPanel>
      <ProductStatusBar>{status}</ProductStatusBar>
    </ProductWorkspace>
    <Dialog open={deleteOpen} title="我的字幕" onClose={() => setDeleteOpen(false)} footer={<><Button onClick={() => setDeleteOpen(false)}>否</Button><Button variant="danger" onClick={() => void remove()}>是</Button></>}><Paragraph>删除字幕“{selected?.name ?? ''}”？</Paragraph></Dialog>
  </ProductPage>;
}
function readPlayback(): VideoItemDto | null { try {
    const value = localStorage.getItem('aimaid.video-playback');
    return value === null ? null : JSON.parse(value) as VideoItemDto;
}
catch {
    return null;
} }
async function resolveSource(item: VideoItemDto | null): Promise<string> {
    if (item === null)
        return '';
    if (item.filePath === '')
        return item.originalUrl;
    const response = await bridge.media.registerLocalFile(item.filePath);
    if (!response.success || response.payload === null)
        throw new Error(response.error?.message ?? '本地视频读取失败。');
    return response.payload.url;
}
function readPaths(value: unknown): string[] { return typeof value === 'object' && value !== null && 'filePaths' in value && Array.isArray(value.filePaths) ? value.filePaths.filter((item): item is string => typeof item === 'string') : []; }
function isSubtitleItem(value: unknown): value is SubtitleItemDto { return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string' && 'path' in value && typeof value.path === 'string'; }
