import { Badge, CodeBlock, Container, EmptyState, Header, InlineText, LayoutSlot, LineBreak, MediaImage, Paragraph, ProductGrid, ProductList, ProductPage, ProductPanel, ProductSidebar, ProductStatusBar, ProductToolbar, ProductWorkspace, Section, SmallText, Strong } from '../../components/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VideoItemDto } from '../../../shared/business';
import { Button } from '../../components/ui';
import { Pressable } from '../../components/ui';
import { Input } from '../../components/ui';
import { Select } from '../../components/ui';
import { Switch } from '../../components/ui';
import { WindowTitleBar } from '../../components/ui';
import { Dialog } from '../../components/ui';
import { Menu } from '../../components/ui';
import { ContextMenuSurface } from '../../components/ui';
import { bridge } from '../../shared/bridge';
type SystemView = '全部视频' | '最近播放' | '未归档' | '收藏';
type VideoDialog = 'album-create' | 'album-rename' | 'album-delete' | 'tag-create' | 'tag-rename' | 'tag-delete' | 'import-folder' | 'import-target' | 'rename-video' | 'edit-tags' | 'edit-remark' | 'remove-record' | 'delete-local' | 'remove-album-item' | 'batch-tags' | 'batch-move' | 'batch-remove' | 'batch-remove-album' | 'batch-delete-local' | 'dependencies';
interface VideoAlbumDto {
    albumId: string;
    name: string;
    description: string;
    coverPath: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
}
interface VideoLibrarySnapshot {
    items: VideoItemDto[];
    albums: VideoAlbumDto[];
    tags: string[];
}
interface DependencyStatus {
    name: string;
    path: string;
    available: boolean;
}
const FILTERS = ['清除筛选', '未播放', '播放中', '已看完', '收藏', '无标签', '文件丢失', '缩略图失败', '本地文件', 'URL 视频', 'mp4', 'mkv', 'mov', 'avi'] as const;
export function VideoLibraryPage(): React.JSX.Element {
    const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingClickId = useRef('');
    const [items, setItems] = useState<VideoItemDto[]>([]);
    const [albums, setAlbums] = useState<VideoAlbumDto[]>([]);
    const [tags, setTags] = useState<string[]>([]);
    const [ready, setReady] = useState(false);
    const [status, setStatus] = useState('正在读取视频库…');
    const [busy, setBusy] = useState(false);
    const [view, setView] = useState<SystemView>('全部视频');
    const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('最近');
    const [selecting, setSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [dialog, setDialog] = useState<VideoDialog | null>(null);
    const [dialogItemId, setDialogItemId] = useState('');
    const [dialogValue, setDialogValue] = useState('');
    const [dialogExtra, setDialogExtra] = useState('');
    const [targetAlbumId, setTargetAlbumId] = useState<string>('');
    const [filter, setFilter] = useState('全部');
    const [filterMenuOpen, setFilterMenuOpen] = useState(false);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const [folderPath, setFolderPath] = useState('');
    const [recursive, setRecursive] = useState(false);
    const [pendingFilePaths, setPendingFilePaths] = useState<string[]>([]);
    const [selectedTag, setSelectedTag] = useState('');
    const [sidebarMenu, setSidebarMenu] = useState<{
        kind: 'album' | 'tag';
        id: string;
        x: number;
        y: number;
    } | null>(null);
    const [videoMenu, setVideoMenu] = useState<{ id: string; x: number; y: number } | null>(null);
    const [backgroundMenu, setBackgroundMenu] = useState<{ x: number; y: number } | null>(null);
    const [dependencyText, setDependencyText] = useState('');
    async function load(message?: string): Promise<void> {
        const response = await invokeVideo('video.list', {});
        if (!response.success) {
            showError(response.error?.message ?? '视频库读取失败');
            return;
        }
        const snapshot = readSnapshot(response.payload);
        setItems(snapshot.items);
        setAlbums(snapshot.albums);
        setTags(snapshot.tags);
        setSelectedIds((current) => current.filter((id) => snapshot.items.some((item) => item.videoId === id)));
        if (activeAlbumId !== null && !snapshot.albums.some((album) => album.albumId === activeAlbumId))
            setActiveAlbumId(null);
        setReady(true);
        setStatus(message ?? `已加载 ${snapshot.items.length} 个视频。`);
    }
    useEffect(() => { void load(); }, []);
    useEffect(() => {
        const refresh = (): void => { void load(); };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, []);
    const visible = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        const filtered = items.filter((item) => {
            if (activeAlbumId !== null && item.albumId !== activeAlbumId)
                return false;
            if (activeAlbumId === null && view === '收藏' && !item.isFavorite)
                return false;
            if (activeAlbumId === null && view === '最近播放' && item.lastPlayedAt == null)
                return false;
            if (activeAlbumId === null && view === '未归档' && item.albumId != null)
                return false;
            if (filter === '未播放' && item.lastPlayedAt != null)
                return false;
            if (filter === '播放中' && ((item.lastPositionSeconds ?? 0) <= 0 || item.isCompleted === true))
                return false;
            if (filter === '已看完' && item.isCompleted !== true)
                return false;
            if (filter === '收藏' && !item.isFavorite)
                return false;
            if (filter === '无标签' && item.tags.trim() !== '')
                return false;
            if (filter === '文件丢失' && !item.isFileMissing)
                return false;
            if (filter === '缩略图失败' && item.coverStatus !== 'Failed')
                return false;
            if (filter === '本地文件' && item.filePath === '')
                return false;
            if (filter === 'URL 视频' && item.filePath !== '')
                return false;
            if (['mp4', 'mkv', 'mov', 'avi'].includes(filter) && !item.filePath.toLocaleLowerCase().endsWith(`.${filter}`))
                return false;
            const itemTags = splitTags(item.tags);
            if (selectedTag === '__none__' && itemTags.length > 0)
                return false;
            if (selectedTag !== '' && selectedTag !== '__all__' && selectedTag !== '__none__' && !itemTags.some((tag) => tag.localeCompare(selectedTag, 'zh-CN', { sensitivity: 'accent' }) === 0))
                return false;
            return keyword === '' || [item.title, item.filePath, item.tags, item.remark ?? ''].some((value) => value.toLocaleLowerCase().includes(keyword));
        });
        return [...filtered].sort((left, right) => sort === '文件名'
            ? (left.title || left.filePath).localeCompare(right.title || right.filePath, 'zh-CN')
            : sort === '时长' ? (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0)
                : sort === '大小' ? (right.fileSize ?? 0) - (left.fileSize ?? 0)
                    : Date.parse(right.createdAt) - Date.parse(left.createdAt));
    }, [activeAlbumId, filter, items, query, selectedTag, sort, view]);
    useEffect(() => () => { if (clickTimer.current !== null) clearTimeout(clickTimer.current); }, []);
    async function play(id: string, includeVisibleQueue = false): Promise<void> {
        const videoIds = includeVisibleQueue ? visible.map((item) => item.videoId) : [id];
        const response = await invokeVideo('video.play', { videoIds, startVideoId: id });
        if (!response.success) {
            showError(response.error?.message ?? 'PotPlayer 启动失败。');
            return;
        }
        setStatus(includeVisibleQueue ? `已用 PotPlayer 播放当前列表（${videoIds.length} 项）。` : '已用 PotPlayer 播放当前视频。');
    }
    async function playBuiltIn(id: string): Promise<void> {
        const item = items.find((entry) => entry.videoId === id);
        if (item === undefined) {
            showError('视频记录不存在。');
            return;
        }
        localStorage.setItem('aimaid.video-playback', JSON.stringify(item));
        const response = await bridge.window.open('video-player');
        if (!response.success) {
            showError(response.error?.message ?? '内置播放器窗口打开失败。');
            return;
        }
        setStatus('已用内置播放器播放当前视频。');
    }
    function invokeCard(id: string): void {
        if (selecting) {
            setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
            return;
        }
        if (clickTimer.current !== null && pendingClickId.current === id) {
            clearTimeout(clickTimer.current);
            clickTimer.current = null;
            pendingClickId.current = '';
            void play(id, true);
            return;
        }
        if (clickTimer.current !== null) {
            clearTimeout(clickTimer.current);
            void play(pendingClickId.current, false);
        }
        pendingClickId.current = id;
        clickTimer.current = setTimeout(() => { clickTimer.current = null; pendingClickId.current = ''; void play(id, false); }, 500);
    }
    async function openSubtitles(): Promise<void> {
        const response = await bridge.window.open('video-subtitles');
        if (!response.success)
            showError(response.error?.message ?? '字幕管理窗口打开失败。');
    }
    async function handleAction(action: string, id = ''): Promise<void> {
        if (action === 'refresh')
            await load();
        else if (action === 'play')
            await playBuiltIn(id);
        else if (action === 'select') {
            setSelecting(true);
            setSelectedIds((current) => current.includes(id) ? current : [...current, id]);
        }
        else if (action === 'importFile')
            await chooseFiles();
        else if (action === 'importFolder')
            setDialog('import-folder');
        else if (action === 'newAlbum')
            openSimpleDialog('album-create');
        else if (action === 'copyPath') {
            const item = items.find((entry) => entry.videoId === id);
            if (item !== undefined)
                await navigator.clipboard.writeText(item.filePath || item.originalUrl);
        }
        else if (action === 'openLocation') {
            const item = items.find((entry) => entry.videoId === id);
            if (item?.filePath)
                await bridge.shell.showItemInFolder(item.filePath);
        }
        else if (action === 'rename')
            openItemDialog('rename-video', id, items.find((entry) => entry.videoId === id)?.title ?? '');
        else if (action === 'editTag')
            openItemDialog('edit-tags', id, items.find((entry) => entry.videoId === id)?.tags ?? '');
        else if (action === 'moveToAlbum')
            openItemDialog('batch-move', id);
        else if (action === 'removeFromAlbum')
            openItemDialog('remove-album-item', id);
        else if (action === 'remove')
            openItemDialog('remove-record', id);
        else if (action === 'deleteLocal')
            openItemDialog('delete-local', id);
        else if (action === 'regenerateCover')
            await run('video.refresh_metadata', { videoIds: [id] }, '视频元数据已刷新。');
    }
    function openSimpleDialog(next: VideoDialog, value = '', extra = ''): void { setDialogItemId(''); setDialogValue(value); setDialogExtra(extra); if (next === 'batch-move')
        setTargetAlbumId(activeAlbumId ?? ''); setDialog(next); }
    function openItemDialog(next: VideoDialog, id: string | undefined, value = ''): void { setDialogItemId(id ?? ''); setDialogValue(value); setDialogExtra(''); setTargetAlbumId(''); setDialog(next); }
    function closeDialog(): void { if (!busy)
        setDialog(null); }
    function exitSelection(): void { setSelecting(false); setSelectedIds([]); setMoreMenuOpen(false); }
    function targetIds(): string[] { return dialogItemId !== '' ? [dialogItemId] : selectedIds; }
    function showError(message: string): void { setStatus(message); }
    async function run(type: string, payload: Record<string, unknown>, successMessage: string, close = false): Promise<boolean> {
        setBusy(true);
        try {
            const response = await invokeVideo(type, payload);
            if (!response.success) {
                showError(response.error?.message ?? '操作失败。');
                return false;
            }
            if (close)
                setDialog(null);
            await load(successMessage);
            return true;
        }
        finally {
            setBusy(false);
        }
    }
    async function chooseFolder(): Promise<void> {
        const response = await bridge.dialog.openDirectory();
        const path = response.success ? response.payload?.filePaths[0] : undefined;
        if (path !== undefined)
            setFolderPath(path);
    }
    async function chooseFiles(): Promise<void> {
        const response = await bridge.dialog.openFile([{ name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'm2ts'] }], true);
        const paths = response.success ? readPaths(response.payload) : [];
        if (paths.length === 0)
            return;
        setPendingFilePaths(paths);
        setTargetAlbumId(activeAlbumId ?? '');
        setDialog('import-target');
    }
    async function importFiles(): Promise<void> {
        setBusy(true);
        try {
            let imported = 0;
            let updated = 0;
            let existing = 0;
            let failed = 0;
            let coverFailures = 0;
            for (const filePath of pendingFilePaths) {
                const response = await invokeVideo('video.import_file', { filePath, albumId: targetAlbumId || null });
                if (!response.success) {
                    failed += 1;
                    continue;
                }
                const result = isRecord(response.payload) ? response.payload : {};
                const status = result.status;
                if (status === 'New') imported += 1;
                else if (status === 'Updated') updated += 1;
                else existing += 1;
                if (typeof result.coverError === 'string' && result.coverError !== '') coverFailures += 1;
            }
            setPendingFilePaths([]);
            setDialog(null);
            await load(`导入完成：新增 ${imported} 个，更新 ${updated} 个，已存在 ${existing} 个${failed > 0 ? `，失败 ${failed} 个` : ''}${coverFailures > 0 ? `，封面失败 ${coverFailures} 个` : ''}。`);
        }
        finally {
            setBusy(false);
        }
    }
    async function importFolder(): Promise<void> {
        setBusy(true);
        try {
            const response = await invokeVideo('video.import_folder', { folderPath, recursive, albumId: targetAlbumId || null });
            if (!response.success) {
                showError(response.error?.message ?? '文件夹导入失败。');
                return;
            }
            const count = readNumber(response.payload, 'importedCount');
            const updated = readNumber(response.payload, 'updatedCount');
            const existing = readNumber(response.payload, 'existingCount');
            const failed = readNumber(response.payload, 'failedCount');
            const coverFailed = readNumber(response.payload, 'coverFailedCount');
            setFolderPath('');
            setDialog(null);
            await load(`导入完成：新增 ${count} 个，更新 ${updated} 个，已存在 ${existing} 个${failed > 0 ? `，失败 ${failed} 个` : ''}${coverFailed > 0 ? `，封面失败 ${coverFailed} 个` : ''}。`);
        }
        finally {
            setBusy(false);
        }
    }
    async function loadDependencies(): Promise<void> {
        const response = await invokeVideo('video.dependencies', {});
        if (!response.success) {
            showError(response.error?.message ?? '视频依赖检测失败。');
            return;
        }
        const rows = readDependencies(response.payload);
        setDependencyText(rows.length === 0 ? '没有返回依赖检测结果。' : rows.map((item) => `${item.name}：${item.available ? item.path || '可用' : '不可用'}`).join('\n'));
        setDialog('dependencies');
    }
    const counts: Record<SystemView, number> = {
        '全部视频': items.length,
        '最近播放': items.filter((item) => item.lastPlayedAt != null).length,
        '未归档': items.filter((item) => item.albumId == null).length,
        '收藏': items.filter((item) => item.isFavorite).length
    };
    const dialogItem = items.find((item) => item.videoId === dialogItemId);
    const dialogItemName = dialogItem?.title || dialogItem?.filePath.split(/[\\/]/).at(-1) || '当前视频';
    const currentTitle = activeAlbumId === null ? view : albums.find((album) => album.albumId === activeAlbumId)?.name ?? '专辑';
    return <ProductPage>
    <WindowTitleBar title={query.trim() === '' ? `${currentTitle} ${visible.length} 个视频` : `搜索结果 ${visible.length} 个视频`}/>
    <ProductWorkspace layout="media" data-product="video-library">
      <ProductSidebar title="视频导航" description={`${items.length} 个视频 · ${albums.length} 个专辑`}>
        <ProductList compact>{(['全部视频', '最近播放', '未归档', '收藏'] as const).map((name) => <Pressable data-video-navigation-item selected={activeAlbumId === null && selectedTag === '' && view === name} onClick={() => { setActiveAlbumId(null); setSelectedTag(''); setView(name); }} key={name}><InlineText>{name}</InlineText><SmallText>{counts[name]}</SmallText></Pressable>)}</ProductList>
        <Container><Header><InlineText>专辑</InlineText><Button size="sm" variant="ghost" onClick={() => openSimpleDialog('album-create')}>新建</Button></Header>
          <ProductList compact>{albums.length === 0 ? <Paragraph>暂无专辑</Paragraph> : albums.map((album) => <Pressable data-video-navigation-item key={album.albumId} selected={activeAlbumId === album.albumId} onClick={() => { setActiveAlbumId(album.albumId); setSelectedTag(''); setView('全部视频'); }} onContextMenu={(event) => { event.preventDefault(); setSidebarMenu({ kind: 'album', id: album.albumId, x: event.clientX, y: event.clientY }); }}><InlineText>{album.name}</InlineText><SmallText>{items.filter((item) => item.albumId === album.albumId).length}</SmallText></Pressable>)}</ProductList>
        </Container>
        <Container><Header><InlineText>标签</InlineText><Button size="sm" variant="ghost" onClick={() => openSimpleDialog('tag-create')}>新建</Button></Header><ProductList compact>
          <Pressable data-video-navigation-item selected={selectedTag === '__all__'} onClick={() => { setActiveAlbumId(null); setView('全部视频'); setSelectedTag('__all__'); }}><InlineText>全部标签</InlineText><SmallText>{items.length}</SmallText></Pressable>
          <Pressable data-video-navigation-item selected={selectedTag === '__none__'} onClick={() => { setActiveAlbumId(null); setView('全部视频'); setSelectedTag('__none__'); }}><InlineText>无标签</InlineText><SmallText>{items.filter((item) => splitTags(item.tags).length === 0).length}</SmallText></Pressable>
          {tags.map((tag) => <Pressable data-video-navigation-item key={tag} selected={selectedTag === tag} onClick={() => { setActiveAlbumId(null); setView('全部视频'); setSelectedTag(tag); }} onContextMenu={(event) => { event.preventDefault(); setSidebarMenu({ kind: 'tag', id: tag, x: event.clientX, y: event.clientY }); }}><InlineText>{tag}</InlineText><SmallText>{items.filter((item) => splitTags(item.tags).some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())).length}</SmallText></Pressable>)}
        </ProductList></Container>
        {sidebarMenu !== null ? <ContextMenuSurface label={sidebarMenu.kind === 'album' ? '专辑操作' : '标签操作'} position={sidebarMenu} onClose={() => setSidebarMenu(null)} items={sidebarMenu.kind === 'album' ? [
                { id: 'rename', label: '重命名专辑', onSelect: () => { const album = albums.find((item) => item.albumId === sidebarMenu.id); if (album !== undefined)
                        openSimpleDialog('album-rename', album.name, album.albumId); } },
                { id: 'delete', label: '删除专辑', danger: true, onSelect: () => { const album = albums.find((item) => item.albumId === sidebarMenu.id); if (album !== undefined)
                        openSimpleDialog('album-delete', album.name, album.albumId); } }
            ] : [
                { id: 'add', label: '添加标签', onSelect: () => openSimpleDialog('tag-create') },
                { id: 'rename', label: '重命名标签', onSelect: () => openSimpleDialog('tag-rename', sidebarMenu.id, sidebarMenu.id) },
                { id: 'delete', label: '删除标签', danger: true, onSelect: () => openSimpleDialog('tag-delete', sidebarMenu.id) }
            ]}/> : null}
      </ProductSidebar>
      <ProductPanel footer={<ProductStatusBar>{busy ? '正在处理…' : status}</ProductStatusBar>} scroll emphasis>
        {!selecting ? <ProductToolbar lead={<Input aria-label="搜索视频" value={query} onChange={(event) => setQuery(event.target.value)}/>} actions={<>{['最近', '文件名', '时长', '大小'].map((name) => <Button size="sm" variant={sort === name ? 'primary' : 'ghost'} onClick={() => setSort(name)} key={name}>{name}</Button>)}<Menu open={filterMenuOpen} label="视频筛选" onClose={() => setFilterMenuOpen(false)} items={FILTERS.map((name) => ({ id: name, label: name, onSelect: () => setFilter(name === '清除筛选' ? '全部' : name) }))}><Button size="sm" onClick={() => setFilterMenuOpen((value) => !value)}>{filter === '全部' ? '筛选' : filter}</Button></Menu><Button size="sm" onClick={() => void openSubtitles()}>字幕</Button><Button size="sm" onClick={() => void loadDependencies()}>依赖</Button><Button size="sm" onClick={() => setSelecting(true)}>批量选择</Button><Button size="sm" variant="primary" onClick={() => void chooseFiles()}>导入文件</Button><Button size="sm" onClick={() => { setTargetAlbumId(activeAlbumId ?? ''); setDialog('import-folder'); }}>导入文件夹</Button></>}/>
            : <ProductToolbar lead={<><Strong>已选择 {selectedIds.length} 项</Strong><Button size="sm" onClick={() => setSelectedIds(visible.map((item) => item.videoId))}>全选</Button><Button size="sm" onClick={exitSelection}>取消选择</Button></>} actions={<><Button size="sm" disabled={selectedIds.length === 0} onClick={() => openSimpleDialog('batch-tags')}>添加标签</Button><Button size="sm" disabled={selectedIds.length === 0} onClick={() => openSimpleDialog('batch-move')}>移动到专辑</Button><Button size="sm" disabled={selectedIds.length === 0} onClick={() => openSimpleDialog('batch-remove-album')}>从专辑移除</Button><Button size="sm" variant="danger" disabled={selectedIds.length === 0} onClick={() => openSimpleDialog('batch-remove')}>删除记录</Button><Menu open={moreMenuOpen} label="更多操作" onClose={() => setMoreMenuOpen(false)} items={[
                    { id: 'delete-local', label: '删除本地文件...', danger: true, onSelect: () => openSimpleDialog('batch-delete-local') },
                    { id: 'refresh', label: '重新生成缩略图', onSelect: () => { void run('video.refresh_metadata', { videoIds: selectedIds }, '视频元数据已刷新。'); } },
                    { id: 'favorite', label: '切换收藏', onSelect: () => { void Promise.all(selectedIds.map((videoId) => invokeVideo('video.toggle_favorite', { videoId }))).then(() => load('收藏状态已更新。')); } },
                    { id: 'remark', label: '编辑备注', disabled: selectedIds.length !== 1, onSelect: () => { if (selectedIds.length === 1)
                            openItemDialog('edit-remark', selectedIds[0], items.find((item) => item.videoId === selectedIds[0])?.remark ?? ''); } },
                    { id: 'copy', label: '复制文件路径', onSelect: () => { void navigator.clipboard.writeText(items.filter((item) => selectedIds.includes(item.videoId)).map((item) => item.filePath).filter(Boolean).join('\n')); } }
                ]}><Button size="sm" onClick={() => setMoreMenuOpen((value) => !value)}>更多</Button></Menu></>}/>}
        {!ready ? <EmptyState title="正在读取视频库"/> : visible.length === 0 ? <EmptyState
          title={items.length === 0 ? '视频库还是空的' : '没有匹配的视频'}
          action={items.length === 0 ? <Button variant="primary" onClick={() => void chooseFiles()}>导入第一个视频</Button> : undefined}
        /> : <LayoutSlot variant="video-library-grid" onContextMenu={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); setBackgroundMenu({ x: event.clientX, y: event.clientY }); } }}><ProductGrid density="cards">{visible.map((item) => <Pressable
          key={item.videoId}
          appearance="card"
          selected={selectedIds.includes(item.videoId)}
          aria-label={item.title || item.filePath}
          onClick={() => invokeCard(item.videoId)}
          onDoubleClick={(event) => event.preventDefault()}
          onKeyDown={(event) => { if (event.key === 'Enter' && !selecting) { event.preventDefault(); if (clickTimer.current !== null) clearTimeout(clickTimer.current); clickTimer.current = null; pendingClickId.current = ''; void play(item.videoId, true); } }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setVideoMenu({ id: item.videoId, x: event.clientX, y: event.clientY }); }}>
          <LayoutSlot variant="video-library-card__cover">
            {coverSource(item) !== '' ? <MediaImage src={coverSource(item)} alt=""/> : <Strong>VIDEO</Strong>}
            <SmallText>{formatDuration(item.durationSeconds ?? 0)}</SmallText>
          </LayoutSlot>
          <LayoutSlot variant="video-library-card__copy">
            <Strong>{item.title || item.filePath.split(/[\\/]/).at(-1) || '未命名视频'}</Strong>
            {[item.tags, item.remark ?? ''].filter(Boolean).join(' · ') !== '' ? <SmallText>{[item.tags, item.remark ?? ''].filter(Boolean).join(' · ')}</SmallText> : null}
            {item.isFavorite ? <Badge tone="accent">收藏</Badge> : item.isCompleted ? <Badge tone="success">已看完</Badge> : null}
          </LayoutSlot>
        </Pressable>)}</ProductGrid></LayoutSlot>}
      </ProductPanel>
    </ProductWorkspace>

    {videoMenu !== null ? <ContextMenuSurface label="视频操作" position={videoMenu} onClose={() => setVideoMenu(null)} items={[
      { id: 'play', label: '播放', onSelect: () => { void handleAction('play', videoMenu.id); } },
      { id: 'open', label: '打开所在位置', onSelect: () => { void handleAction('openLocation', videoMenu.id); } },
      { id: 'copy', label: '复制文件路径', onSelect: () => { void handleAction('copyPath', videoMenu.id); } },
      { id: 'tag', label: '添加标签…', separated: true, onSelect: () => { void handleAction('editTag', videoMenu.id); } },
      { id: 'move', label: '移动到专辑…', onSelect: () => { void handleAction('moveToAlbum', videoMenu.id); } },
      { id: 'unarchive', label: '从当前专辑移除', disabled: items.find((item) => item.videoId === videoMenu.id)?.albumId == null, onSelect: () => { void handleAction('removeFromAlbum', videoMenu.id); } },
      { id: 'select', label: '选择', separated: true, onSelect: () => { void handleAction('select', videoMenu.id); } },
      { id: 'cover', label: '重新生成缩略图', onSelect: () => { void handleAction('regenerateCover', videoMenu.id); } },
      { id: 'rename', label: '重命名显示名', onSelect: () => { void handleAction('rename', videoMenu.id); } },
      { id: 'remove', label: '删除库记录', separated: true, danger: true, onSelect: () => { void handleAction('remove', videoMenu.id); } },
      { id: 'delete', label: '删除本地文件…', danger: true, disabled: !items.find((item) => item.videoId === videoMenu.id)?.filePath, onSelect: () => { void handleAction('deleteLocal', videoMenu.id); } }
    ]}/> : null}
    {backgroundMenu !== null ? <ContextMenuSurface label="视频库操作" position={backgroundMenu} onClose={() => setBackgroundMenu(null)} items={[
      { id: 'import-file', label: '导入文件', onSelect: () => { void chooseFiles(); } },
      { id: 'import-folder', label: '导入文件夹', onSelect: () => setDialog('import-folder') },
      { id: 'new-album', label: '新建专辑', separated: true, onSelect: () => openSimpleDialog('album-create') },
      { id: 'refresh', label: '刷新视频库', onSelect: () => { void load(); } }
    ]}/> : null}

    <TextDialog open={dialog === 'album-create'} title="新建专辑" label="请输入专辑名称：" value={dialogValue} setValue={setDialogValue} busy={busy} close={closeDialog} confirm={() => void run('video.album.create', { name: dialogValue.trim(), description: '' }, '专辑已创建。', true)}/>
    <TextDialog open={dialog === 'album-rename'} title="重命名专辑" label="请输入新的专辑名称：" value={dialogValue} setValue={setDialogValue} busy={busy} close={closeDialog} confirm={() => void run('video.album.rename', { albumId: dialogExtra, name: dialogValue.trim() }, '专辑已重命名。', true)}/>
    <ConfirmDialog open={dialog === 'album-delete'} title="删除专辑" busy={busy} close={closeDialog} confirm={() => void run('video.album.delete', { albumId: dialogExtra }, '专辑已删除，视频已移到“未归档”。', true)}><Paragraph>删除专辑“{dialogValue}”？<LineBreak />专辑中的视频不会从本地磁盘删除，可在“未归档”中找到。</Paragraph></ConfirmDialog>
    <TextDialog open={dialog === 'tag-create'} title="添加标签" label="输入标签名称：" value={dialogValue} setValue={setDialogValue} busy={busy} close={closeDialog} confirm={() => void run('video.tag.create', { tag: dialogValue.trim() }, '标签已添加。', true)}/>
    <TextDialog open={dialog === 'tag-rename'} title="重命名标签" label="请输入新的标签名称：" value={dialogValue} setValue={setDialogValue} busy={busy} close={closeDialog} confirm={() => void run('video.tag.rename', { oldTag: dialogExtra, newTag: dialogValue.trim() }, '标签已重命名。', true)}/>
    <ConfirmDialog open={dialog === 'tag-delete'} title="删除标签" busy={busy} close={closeDialog} confirm={() => void run('video.tag.delete', { tag: dialogValue }, '标签已删除。', true)}><Paragraph>删除标签“{dialogValue}”？<LineBreak />视频文件不会被删除。</Paragraph></ConfirmDialog>
    <Dialog open={dialog === 'import-target'} title="选择目标专辑" description={`即将导入 ${pendingFilePaths.length} 个文件。`} onClose={closeDialog} footer={<><Button onClick={closeDialog}>取消</Button><Button variant="primary" disabled={busy || pendingFilePaths.length === 0} onClick={() => void importFiles()}>导入</Button></>}><AlbumSelector albums={albums} value={targetAlbumId} setValue={setTargetAlbumId}/></Dialog>
    <Dialog open={dialog === 'import-folder'} title="导入文件夹" onClose={closeDialog} footer={<><Button onClick={closeDialog}>取消</Button><Button variant="primary" disabled={busy || folderPath === ''} onClick={() => void importFolder()}>导入</Button></>}><Container><Container><Input label="文件夹路径" readOnly value={folderPath}/><Button onClick={() => void chooseFolder()}>浏览</Button></Container><AlbumSelector albums={albums} value={targetAlbumId} setValue={setTargetAlbumId}/><Switch label="包含子文件夹" checked={recursive} onChange={(event) => setRecursive(event.target.checked)}/></Container></Dialog>
    <TextDialog open={dialog === 'rename-video'} title="重命名显示名" label="请输入新的显示名：" value={dialogValue} setValue={setDialogValue} busy={busy} close={closeDialog} confirm={() => void run('video.set_display_name', { videoId: dialogItemId, displayName: dialogValue.trim() }, '显示名已更新。', true)}/>
    <TextDialog open={dialog === 'edit-remark'} title="编辑备注" label="备注：" value={dialogValue} setValue={setDialogValue} busy={busy} close={closeDialog} allowEmpty confirm={() => void run('video.set_remark', { videoId: dialogItemId, remark: dialogValue.trim() }, '备注已更新。', true)}/>
    <Dialog open={dialog === 'edit-tags' || dialog === 'batch-tags'} title={dialog === 'batch-tags' ? '批量添加标签' : '编辑标签'} onClose={closeDialog} footer={<><Button onClick={closeDialog}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void run('video.tag.set', { videoIds: targetIds(), tags: normalizeTagText(dialogValue), mode: dialog === 'batch-tags' ? 'merge' : 'replace' }, '标签已更新。', true)}>确定</Button></>}><Container><Input label="标签" value={dialogValue} onChange={(event) => setDialogValue(event.target.value)}/><Container>{tags.map((tag) => <Pressable key={tag} onClick={() => setDialogValue(normalizeTagText([dialogValue, tag].filter(Boolean).join(',')))}>{tag}</Pressable>)}</Container></Container></Dialog>
    <Dialog open={dialog === 'batch-move'} title="选择目标专辑" onClose={closeDialog} footer={<><Button onClick={closeDialog}>取消</Button><Button variant="primary" disabled={busy || targetIds().length === 0} onClick={() => void run('video.album.move', { videoIds: targetIds(), albumId: targetAlbumId || null }, '视频已移动。', true)}>确定</Button></>}><AlbumSelector albums={albums} value={targetAlbumId} setValue={setTargetAlbumId}/></Dialog>
    <ConfirmDialog open={dialog === 'remove-record'} title="删除库记录" busy={busy} close={closeDialog} confirm={() => void run('video.remove_records', { videoIds: [dialogItemId] }, '库记录已删除。', true)}><Paragraph>删除“{dialogItemName}”的库记录？<LineBreak />本地视频文件不会被删除。</Paragraph></ConfirmDialog>
    <ConfirmDialog open={dialog === 'delete-local'} title="删除本地文件" busy={busy} close={closeDialog} confirm={() => void run('video.delete_local_files', { videoIds: [dialogItemId] }, '本地文件已移入回收站，库记录已删除。', true)}><Paragraph>确定要删除本地视频文件？<LineBreak />该文件将被移入系统回收站，同时会从视频库移除。<LineBreak /><LineBreak />{dialogItemName}</Paragraph></ConfirmDialog>
    <ConfirmDialog open={dialog === 'remove-album-item'} title="从专辑移除" busy={busy} close={closeDialog} confirm={() => void run('video.album.move', { videoIds: [dialogItemId], albumId: null }, '视频已移到“未归档”。', true)}><Paragraph>将“{dialogItemName}”从当前专辑移除？<LineBreak />视频不会从本地磁盘删除，可在“未归档”中找到。</Paragraph></ConfirmDialog>
    <ConfirmDialog open={dialog === 'batch-remove'} title="删除库记录" busy={busy} close={closeDialog} confirm={() => void run('video.remove_records', { videoIds: selectedIds }, '库记录已删除。', true)}><Paragraph>删除 {selectedIds.length} 个视频的库记录？<LineBreak />本地视频文件不会被删除。</Paragraph></ConfirmDialog>
    <ConfirmDialog open={dialog === 'batch-remove-album'} title="从专辑移除" busy={busy} close={closeDialog} confirm={() => void run('video.album.move', { videoIds: selectedIds, albumId: null }, '视频已移到“未归档”。', true)}><Paragraph>将 {selectedIds.length} 个视频从当前专辑移除？<LineBreak />视频不会从本地磁盘删除，可在“未归档”中找到。</Paragraph></ConfirmDialog>
    <ConfirmDialog open={dialog === 'batch-delete-local'} title="删除本地文件" busy={busy} close={closeDialog} confirm={() => void run('video.delete_local_files', { videoIds: selectedIds }, '本地文件已移入回收站，库记录已删除。', true)}><Paragraph>确定要删除本地视频文件？<LineBreak />这些文件将被移入系统回收站，同时会从视频库移除。<LineBreak /><LineBreak />文件数量：{selectedIds.length}</Paragraph></ConfirmDialog>
    <Dialog open={dialog === 'dependencies'} title="视频依赖检测" onClose={closeDialog} footer={<Button variant="primary" onClick={closeDialog}>确定</Button>}><CodeBlock>{dependencyText}</CodeBlock></Dialog>
  </ProductPage>;
}
function TextDialog({ open, title, label, value, setValue, busy, close, confirm, allowEmpty = false }: {
    open: boolean;
    title: string;
    label: string;
    value: string;
    setValue: (value: string) => void;
    busy: boolean;
    close: () => void;
    confirm: () => void;
    allowEmpty?: boolean;
}): React.JSX.Element {
    return <Dialog open={open} title={title} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={busy || (!allowEmpty && value.trim() === '')} onClick={confirm}>确定</Button></>}><Input label={label} value={value} onChange={(event) => setValue(event.target.value)} autoFocus/></Dialog>;
}
function ConfirmDialog({ open, title, busy, close, confirm, children }: {
    open: boolean;
    title: string;
    busy: boolean;
    close: () => void;
    confirm: () => void;
    children: React.ReactNode;
}): React.JSX.Element {
    return <Dialog open={open} title={title} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="danger" disabled={busy} onClick={confirm}>删除</Button></>}>{children}</Dialog>;
}
function AlbumSelector({ albums, value, setValue }: {
    albums: VideoAlbumDto[];
    value: string;
    setValue: (value: string) => void;
}): React.JSX.Element {
    return <Select label="目标专辑" value={value} options={[{ value: '', label: '未归档' }, ...albums.map((album) => ({ value: album.albumId, label: album.name }))]} onChange={(event) => setValue(event.target.value)}/>;
}
function coverSource(item: VideoItemDto): string { if (item.coverPath === '' || item.coverStatus !== 'Ready')
    return ''; if (/^https?:/i.test(item.coverPath))
    return item.coverPath; return `file:///${item.coverPath.replaceAll('\\', '/')}`; }
function formatDuration(seconds: number): string { const value = Math.max(0, Math.round(seconds)); return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`; }
function readPaths(value: unknown): string[] { return isRecord(value) && Array.isArray(value.filePaths) ? value.filePaths.filter((item): item is string => typeof item === 'string') : []; }
function splitTags(value: string): string[] { return value.replaceAll('，', ',').split(',').map((tag) => tag.trim()).filter((tag, index, values) => tag !== '' && values.findIndex((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase()) === index); }
function normalizeTagText(value: string): string { return splitTags(value).join(','); }
function readSnapshot(value: unknown): VideoLibrarySnapshot {
    if (!isRecord(value))
        return { items: [], albums: [], tags: [] };
    return { items: Array.isArray(value.items) ? value.items as VideoItemDto[] : [], albums: Array.isArray(value.albums) ? value.albums as VideoAlbumDto[] : [], tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [] };
}
function readDependencies(value: unknown): DependencyStatus[] {
    const rows = Array.isArray(value) ? value : isRecord(value) ? Object.entries(value).map(([name, item]) => isRecord(item) ? { name, ...item } : { name, path: typeof item === 'string' ? item : '', available: Boolean(item) }) : [];
    return rows.filter(isRecord).map((item) => ({ name: typeof item.name === 'string' ? item.name : '工具', path: typeof item.path === 'string' ? item.path : typeof item.Path === 'string' ? item.Path : '', available: typeof item.available === 'boolean' ? item.available : item.Available === true }));
}
function readNumber(value: unknown, name: string): number { return isRecord(value) && typeof value[name] === 'number' ? value[name] : 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function invokeVideo(type: string, payload: Record<string, unknown>): Promise<{
    success: boolean;
    payload?: unknown;
    error?: {
        message?: string;
    } | null;
}> { return bridge.core.invoke({ type, payload } as never); }
