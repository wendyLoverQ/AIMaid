import { Badge, Button, Checkbox, Container, DescriptionList, DescriptionTerm, DescriptionValue, Dialog, Drawer, EmptyState, FormLabel, InlineText, Input, LayoutSlot, LineBreak, MediaImage, Meter, Paragraph, Pressable, ProductPage, ProductPanel, ProductStatusBar, ProductTabNavigation, ProductWorkspace, Select, Section, SmallText, Strong, Switch, Textarea, TimeValue, Title2, Title3, UiIcon, WindowTitleBar } from '../../components/ui';
import { useEffect, useState } from 'react';
import { bridge } from '../../shared/bridge';
type Tab = '解析结果' | '下载记录' | '播放记录';
type DownloadStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
interface RemoteFormat {
    formatId: string;
    selector: string;
    displayName: string;
    width?: number | null;
    height?: number | null;
    fps?: number | null;
    hasVideo: boolean;
    hasAudio: boolean;
    fileSize?: number | null;
}
interface RemoteItem {
    itemId: string;
    originalUrl: string;
    title: string;
    author: string;
    siteName: string;
    videoId: string;
    durationSeconds: number;
    thumbnailUrl: string;
    publishedAt?: string | null;
    isLive: boolean;
    downloadStatus: string;
    formats: RemoteFormat[];
}
interface ResolveResult {
    items: RemoteItem[];
    diagnosticSummary: string;
}
interface DownloadRecord {
    taskId: string;
    itemId: string;
    originalUrl: string;
    title: string;
    author: string;
    siteName: string;
    outputPath: string;
    quality: string;
    status: DownloadStatus;
    progress: number;
    speed: string;
    eta: string;
    errorMessage: string;
    fileSize: number;
    createdAt: string;
    startedAt?: string | null;
    finishedAt?: string | null;
}
interface PlayRecord {
    historyId: string;
    itemId?: string | null;
    originalUrl: string;
    title: string;
    author: string;
    siteName: string;
    action: string;
    cachePath: string;
    playedAt: string;
}
interface Settings {
    downloadRoot: string;
    cacheRoot: string;
    fileNameTemplate: string;
    defaultQualityPreference: string;
    downloadThumbnail: boolean;
    downloadInfoJson: boolean;
    downloadSubtitles: boolean;
    overwriteExisting: boolean;
    autoImportToVideoLibrary: boolean;
    maxConcurrentDownloads: number;
    ytDlpPath: string;
    ffmpegPath: string;
    potPlayerPath: string;
    updatedAt: string;
}
interface Diagnostics {
    checkedAt: string;
    ytDlpPath: string;
    ytDlpExists: boolean;
    ffmpegPath: string;
    ffmpegExists: boolean;
    potPlayerPath: string;
    potPlayerExists: boolean;
    downloadRoot: string;
    downloadRootWritable: boolean;
    activeDownloads: number;
    lastOperation: string;
    lastStatus: string;
    lastMessage: string;
}
const DEFAULT_SETTINGS: Settings = { downloadRoot: '', cacheRoot: '', fileNameTemplate: '%(title)s [%(id)s].%(ext)s', defaultQualityPreference: 'bestvideo+bestaudio/best', downloadThumbnail: true, downloadInfoJson: true, downloadSubtitles: true, overwriteExisting: false, autoImportToVideoLibrary: true, maxConcurrentDownloads: 2, ytDlpPath: '', ffmpegPath: '', potPlayerPath: '', updatedAt: '' };
export function RemoteVideoPage(): React.JSX.Element {
    const [tab, setTab] = useState<Tab>('解析结果');
    const [url, setUrl] = useState('');
    const [rightPanel, setRightPanel] = useState<'settings' | 'diagnostics' | null>(null);
    const [results, setResults] = useState<RemoteItem[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
    const [plays, setPlays] = useState<PlayRecord[]>([]);
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
    const [diagnosticText, setDiagnosticText] = useState('暂无诊断记录。');
    const [recordThumbnails, setRecordThumbnails] = useState<Record<string, string>>({});
    const [selectedResultId, setSelectedResultId] = useState('');
    const [formatSelector, setFormatSelector] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('就绪');
    const [deleteTaskId, setDeleteTaskId] = useState('');
    const selectedResult = results.find((item) => item.itemId === selectedResultId) ?? results[0];
    async function invoke(type: Parameters<typeof bridge.core.invoke>[0]['type'], payload: Record<string, unknown> = {}, timeout = 120000): Promise<unknown> {
        const response = await bridge.core.invoke({ type, payload } as Parameters<typeof bridge.core.invoke>[0], timeout);
        if (!response.success)
            throw new Error(response.error?.message ?? 'Core 请求失败。');
        return response.payload;
    }
    async function refreshRecords(): Promise<void> {
        const [downloadPayload, playPayload] = await Promise.all([
            invoke('remote_video.download.list', {}, 30000),
            invoke('remote_video.play.list', {}, 30000)
        ]);
        const downloadList = Array.isArray(downloadPayload) ? downloadPayload as DownloadRecord[] : [];
        const playList = Array.isArray(playPayload) ? playPayload as PlayRecord[] : [];
        setDownloads(downloadList);
        setPlays(playList);
        void loadRecordThumbnails([...downloadList, ...playList].filter((r) => 'itemId' in r && typeof r.itemId === 'string' && r.itemId !== '').map((r) => ('itemId' in r ? r.itemId : '') as string));
    }
    async function loadRecordThumbnails(ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const unique = [...new Set(ids.filter((id) => id !== '' && !recordThumbnails[id]))];
        if (unique.length === 0) return;
        await Promise.all(unique.map(async (itemId) => {
            try {
                const payload = await invoke('remote_video.thumbnail', { itemId }, 30000) as { mimeType: string; base64Data: string };
                if (payload.mimeType.startsWith('image/') && payload.base64Data !== '') {
                    const source = `data:${payload.mimeType};base64,${payload.base64Data}`;
                    setRecordThumbnails((current) => ({ ...current, [itemId]: source }));
                }
            }
            catch { /* non-critical */ }
        }));
    }
    async function load(): Promise<void> {
        try {
            const [settingsPayload, diagnosticPayload] = await Promise.all([
                invoke('remote_video.settings.get', {}, 30000),
                invoke('remote_video.diagnostics', {}, 30000)
            ]);
            if (settingsPayload !== null)
                setSettings(settingsPayload as Settings);
            if (diagnosticPayload !== null)
                applyDiagnostics(diagnosticPayload as Diagnostics);
            await refreshRecords();
        }
        catch (error) {
            setStatus(messageOf(error));
        }
    }
    useEffect(() => { void load(); }, []);
    useEffect(() => {
        if (!downloads.some((item) => item.status === 'Queued' || item.status === 'Running'))
            return;
        const timer = window.setInterval(() => { void refreshRecords().catch((error: unknown) => setStatus(messageOf(error))); }, 1000);
        return () => window.clearInterval(timer);
    }, [downloads]);
    useEffect(() => { setFormatSelector(selectedResult?.formats[0]?.selector ?? ''); }, [selectedResult?.itemId]);
    async function resolve(): Promise<void> {
        if (url.trim() === '') {
            setStatus('请先粘贴视频 URL、UP主主页、频道地址、播放列表或 UID。');
            return;
        }
        setBusy(true);
        setStatus('解析中…');
        try {
            const payload = await invoke('remote_video.resolve', { input: url }) as ResolveResult;
            const items = Array.isArray(payload.items) ? payload.items : [];
            setResults(items);
            setSelectedIds([]);
            setSelectedResultId(items[0]?.itemId ?? '');
            setDiagnosticText(payload.diagnosticSummary || '解析完成。');
            setTab('解析结果');
            setStatus(`解析完成，已加载 ${items.length} 条。`);
            void loadThumbnails(items);
        }
        catch (error) {
            setStatus(messageOf(error));
            setDiagnosticText(messageOf(error));
        }
        finally {
            setBusy(false);
        }
    }
    async function loadThumbnails(items: RemoteItem[]): Promise<void> {
        await Promise.all(items.map(async (item) => {
            try {
                const payload = await invoke('remote_video.thumbnail', { itemId: item.itemId }, 30000) as { mimeType: string; base64Data: string };
                if (!payload.mimeType.startsWith('image/') || payload.base64Data === '') return;
                const source = `data:${payload.mimeType};base64,${payload.base64Data}`;
                setResults((current) => current.map((candidate) => candidate.itemId === item.itemId ? { ...candidate, thumbnailUrl: source } : candidate));
                setRecordThumbnails((current) => ({ ...current, [item.itemId]: source }));
            }
            catch { /* The result remains usable while the explicit empty-cover state is shown. */ }
        }));
    }
    async function pasteFromClipboard(): Promise<void> {
        try {
            const value = await navigator.clipboard.readText();
            setUrl(value);
            setStatus(value.trim() === '' ? '剪贴板中没有可解析的链接。' : '已从剪贴板粘贴链接。');
        }
        catch (error) {
            setStatus(`无法读取剪贴板：${messageOf(error)}`);
        }
    }
    async function play(item: RemoteItem, mode: 'direct' | 'cache'): Promise<void> {
        setBusy(true);
        setStatus(mode === 'direct' ? '正在解析播放地址…' : '正在缓存视频…');
        try {
            await invoke('remote_video.play', { itemId: item.itemId, formatSelector: item.itemId === selectedResult?.itemId ? formatSelector : '', mode });
            setStatus(mode === 'direct' ? 'PotPlayer 已启动' : '缓存播放文件已发送到 PotPlayer');
            await refreshRecords();
        }
        catch (error) {
            setStatus(messageOf(error));
            setDiagnosticText(messageOf(error));
        }
        finally {
            setBusy(false);
        }
    }
    async function startDownloads(ids: string[]): Promise<void> {
        if (ids.length === 0) {
            setStatus('请先选择要下载的视频。');
            return;
        }
        try {
            await invoke('remote_video.download.start', { itemIds: ids, formatSelector }, 30000);
            setTab('下载记录');
            setStatus(`已添加 ${ids.length} 个下载任务。`);
            await refreshRecords();
        }
        catch (error) {
            setStatus(messageOf(error));
        }
    }
    async function saveSettings(): Promise<void> {
        try {
            const payload = await invoke('remote_video.settings.save', { settings }, 30000);
            if (payload !== null)
                setSettings(payload as Settings);
            setStatus('下载设置已保存');
            setRightPanel(null);
        }
        catch (error) {
            setStatus(messageOf(error));
        }
    }
    async function refreshDiagnostics(): Promise<void> {
        try {
            applyDiagnostics(await invoke('remote_video.diagnostics', {}, 30000) as Diagnostics);
        }
        catch (error) {
            setDiagnosticText(messageOf(error));
        }
    }
    function applyDiagnostics(value: Diagnostics): void {
        setDiagnostics(value);
        setDiagnosticText([
            `检查时间：${formatDate(value.checkedAt)}`,
            `yt-dlp：${value.ytDlpExists ? '可用' : '不可用'} ${value.ytDlpPath}`,
            `FFmpeg：${value.ffmpegExists ? '可用' : '不可用'} ${value.ffmpegPath}`,
            `PotPlayer：${value.potPlayerExists ? '可用' : '不可用'} ${value.potPlayerPath}`,
            `下载目录：${value.downloadRootWritable ? '可写' : '不可写'} ${value.downloadRoot}`,
            `活动下载：${value.activeDownloads}`,
            `最近操作：${value.lastOperation || '无'} / ${value.lastStatus || '无'}`,
            value.lastMessage || ''
        ].filter(Boolean).join('\n'));
    }
    async function deleteDownload(): Promise<void> {
        try {
            await invoke('remote_video.download.delete', { taskId: deleteTaskId }, 30000);
            setDeleteTaskId('');
            await refreshRecords();
            setStatus('下载记录已删除');
        }
        catch (error) {
            setStatus(messageOf(error));
        }
    }
    async function copyText(value: string, successMessage: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(value);
            setStatus(successMessage);
        }
        catch {
            setStatus('复制失败，请检查剪贴板权限');
        }
    }
    const tabs: Array<{ label: Tab; count: number }> = [
        { label: '解析结果', count: results.length },
        { label: '下载记录', count: downloads.length },
        { label: '播放记录', count: plays.length }
    ];
    const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: Tab): void => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = tabs.findIndex((item) => item.label === current);
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const nextTab = tabs[nextIndex]?.label;
        if (nextTab === undefined) return;
        setTab(nextTab);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    };
    return <ProductPage>
    <WindowTitleBar title="远程视频中心"/>
    <ProductWorkspace layout="single" data-product="remote-video">
      <ProductPanel emphasis>
        <LayoutSlot variant="remote-video-hero">
          <LayoutSlot variant="remote-video-hero__composer">
            <Textarea id="remote-video-source" rows={2} aria-label="远程视频地址" placeholder="粘贴视频链接、作者主页、频道地址、播放列表或 UID" value={url} onChange={(event) => setUrl(event.target.value)}/>
            <Container><Button onClick={() => void pasteFromClipboard()}>粘贴</Button><Button disabled={url.trim() === ''} onClick={() => { setUrl(''); setStatus('已清空输入。'); }}>清空</Button><Button variant="primary" disabled={busy || url.trim() === ''} onClick={() => void resolve()}>{busy ? '解析中…' : '开始解析'}</Button></Container>
          </LayoutSlot>
        </LayoutSlot>
      </ProductPanel>
      <ProductTabNavigation label="远程视频内容" tabs={tabs.map((item) => <Pressable role="tab" id={`remote-video-tab-${item.label}`} aria-controls="remote-video-tabpanel" selected={tab === item.label} tabIndex={tab === item.label ? 0 : -1} key={item.label} onKeyDown={(event) => onTabKeyDown(event, item.label)} onClick={() => setTab(item.label)}><Strong>{item.label}</Strong><SmallText>{item.count}</SmallText></Pressable>)} actions={<><Button onClick={() => { setRightPanel('diagnostics'); void refreshDiagnostics(); }}>诊断</Button><Button onClick={() => void bridge.window.open('remote-site-config')}>站点配置</Button><Button onClick={() => setRightPanel('settings')}>下载设置</Button></>}/>
      <ProductPanel scroll>
        <Container id="remote-video-tabpanel" role="tabpanel" aria-labelledby={`remote-video-tab-${tab}`}>
          {tab === '解析结果' ? <ResultTab items={results} selected={selectedResult} selectedIds={selectedIds} formatSelector={formatSelector} busy={busy} select={setSelectedResultId} selectIds={setSelectedIds} setFormatSelector={setFormatSelector} play={play} download={(ids) => void startDownloads(ids)} copyText={copyText}/> : null}
          {tab === '下载记录' ? <DownloadTab items={downloads} thumbnailFor={(id) => recordThumbnails[id] ?? results.find((item) => item.itemId === id)?.thumbnailUrl ?? ''} refresh={() => void refreshRecords()} cancel={(id) => void invoke('remote_video.download.cancel', { taskId: id }, 30000).then(refreshRecords).catch((error: unknown) => setStatus(messageOf(error)))} play={(id) => void invoke('remote_video.download.play', { taskId: id }, 120000).then(refreshRecords).catch((error: unknown) => setStatus(messageOf(error)))} openLocation={(path) => void bridge.shell.showItemInFolder(path)} remove={setDeleteTaskId}/> : null}
          {tab === '播放记录' ? <PlayTab items={plays} thumbnailFor={(id) => recordThumbnails[id] ?? results.find((item) => item.itemId === id)?.thumbnailUrl ?? ''} refresh={() => void refreshRecords()} replay={(id) => void invoke('remote_video.play.replay', { historyId: id }, 120000).then(refreshRecords).catch((error: unknown) => setStatus(messageOf(error)))}/> : null}
        </Container>
      </ProductPanel>
      <ProductStatusBar>{status}</ProductStatusBar>
    </ProductWorkspace>
    <Drawer open={rightPanel === 'settings'} title="下载设置" onClose={() => setRightPanel(null)}>
      <Container>
        <Section><Title3>文件设置</Title3><PathInput label="下载目录" value={settings.downloadRoot} browse onChange={(value) => setSettings({ ...settings, downloadRoot: value })}/><PathInput label="缓存目录" value={settings.cacheRoot} browse onChange={(value) => setSettings({ ...settings, cacheRoot: value })}/><Input label="命名模板" value={settings.fileNameTemplate} onChange={(event) => setSettings({ ...settings, fileNameTemplate: event.target.value })}/></Section>
        <Section><Title3>下载内容</Title3><RemoteToggle title="保存封面" checked={settings.downloadThumbnail} onChange={(value) => setSettings({ ...settings, downloadThumbnail: value })}/><RemoteToggle title="保存信息文件" checked={settings.downloadInfoJson} onChange={(value) => setSettings({ ...settings, downloadInfoJson: value })}/><RemoteToggle title="下载字幕" checked={settings.downloadSubtitles} onChange={(value) => setSettings({ ...settings, downloadSubtitles: value })}/><RemoteToggle title="覆盖同名文件" checked={settings.overwriteExisting} onChange={(value) => setSettings({ ...settings, overwriteExisting: value })}/><RemoteToggle title="加入视频库" checked={settings.autoImportToVideoLibrary} onChange={(value) => setSettings({ ...settings, autoImportToVideoLibrary: value })}/></Section>
        <Section><Title3>工具路径</Title3><Input label="yt-dlp" value={settings.ytDlpPath} onChange={(event) => setSettings({ ...settings, ytDlpPath: event.target.value })}/><Input label="FFmpeg" value={settings.ffmpegPath} onChange={(event) => setSettings({ ...settings, ffmpegPath: event.target.value })}/><Input label="PotPlayer" value={settings.potPlayerPath} onChange={(event) => setSettings({ ...settings, potPlayerPath: event.target.value })}/></Section>
        <Section><Title3>同时下载数</Title3><Paragraph>建议保持较小数量，避免站点限流。</Paragraph><Select value={String(settings.maxConcurrentDownloads)} options={[1, 2, 3, 4].map((value) => ({ value: String(value), label: String(value) }))} onChange={(event) => setSettings({ ...settings, maxConcurrentDownloads: Number(event.target.value) })}/></Section>
        <Button variant="primary" onClick={() => void saveSettings()}>保存设置</Button>
      </Container>
    </Drawer>
    <Drawer open={rightPanel === 'diagnostics'} title="诊断" onClose={() => setRightPanel(null)}>
      <Container><Title3>解析与播放诊断</Title3><Paragraph>这里显示真实工具和下载目录状态；Cookie 和签名地址不会返回前端。</Paragraph><Container><Button onClick={() => void copyText(diagnosticText, '脱敏诊断已复制')}>复制脱敏诊断</Button><Button onClick={() => void refreshDiagnostics()}>刷新诊断</Button>{selectedResult !== undefined ? <Button onClick={() => void bridge.shell.openExternal(selectedResult.originalUrl)}>打开原网页</Button> : null}</Container><Textarea rows={20} readOnly value={diagnosticText}/>{diagnostics !== null && diagnostics.activeDownloads > 0 ? <Paragraph>当前有 {diagnostics.activeDownloads} 个活动下载任务。</Paragraph> : null}</Container>
    </Drawer>
    <Dialog open={deleteTaskId !== ''} title="删除下载记录" onClose={() => setDeleteTaskId('')} footer={<><Button onClick={() => setDeleteTaskId('')}>取消</Button><Button variant="danger" onClick={() => void deleteDownload()}>删除</Button></>}><Paragraph>确定删除这条下载记录？<LineBreak />已完成任务会按原有规则同步处理本地文件和视频库记录。</Paragraph></Dialog>
  </ProductPage>;
}
function ResultTab({ items, selected, selectedIds, formatSelector, busy, select, selectIds, setFormatSelector, play, download, copyText }: {
    items: RemoteItem[];
    selected: RemoteItem | undefined;
    selectedIds: string[];
    formatSelector: string;
    busy: boolean;
    select: (id: string) => void;
    selectIds: (ids: string[]) => void;
    setFormatSelector: (value: string) => void;
    play: (item: RemoteItem, mode: 'direct' | 'cache') => Promise<void>;
    download: (ids: string[]) => void;
    copyText: (value: string, successMessage: string) => Promise<void>;
}): React.JSX.Element {
    const formatOptions = selected?.formats.map((item) => ({ value: item.selector, label: item.displayName })) ?? [];
    if (items.length === 0)
        return <EmptyState title="还没有解析结果" description="先在上方粘贴链接，封面、标题和可用画质会显示在这里。" action={<Button onClick={() => document.getElementById('remote-video-source')?.focus()}>输入链接</Button>}/>;
    if (items.length === 1 && selected !== undefined) return <LayoutSlot variant="remote-video-result-feature" data-remote-video-item={selected.itemId}>
      <LayoutSlot variant="remote-video-result-feature__media"><RemoteThumbnail source={selected.thumbnailUrl} alt={selected.title}/><Badge tone={selected.isLive ? 'danger' : 'neutral'}>{selected.isLive ? '直播中' : durationText(selected.durationSeconds)}</Badge></LayoutSlot>
      <LayoutSlot variant="remote-video-result-feature__copy">
        <Container><Badge tone="accent">{selected.siteName || '远程视频'}</Badge><Title2>{selected.title}</Title2><Paragraph>{selected.author || '未知作者'}</Paragraph></Container>
        <DescriptionList data-remote-video-facts><Container><DescriptionTerm>发布时间</DescriptionTerm><DescriptionValue>{formatDate(selected.publishedAt)}</DescriptionValue></Container><Container><DescriptionTerm>视频时长</DescriptionTerm><DescriptionValue>{durationText(selected.durationSeconds)}</DescriptionValue></Container><Container><DescriptionTerm>视频 ID</DescriptionTerm><DescriptionValue>{selected.videoId || '未知'}</DescriptionValue></Container><Container><DescriptionTerm>可用画质</DescriptionTerm><DescriptionValue>{selected.formats.length > 0 ? `${selected.formats.length} 种` : '自动'}</DescriptionValue></Container></DescriptionList>
        <FormLabel>清晰度<Select value={formatSelector} onChange={(event) => setFormatSelector(event.target.value)} options={formatOptions.length > 0 ? formatOptions : [{ value: '', label: '自动｜最高画质' }]}/></FormLabel>
        <LayoutSlot variant="remote-video-result-feature__actions"><Button variant="primary" disabled={busy} onClick={() => void play(selected, 'direct')}>播放</Button><Button disabled={busy || selected.isLive} onClick={() => void play(selected, 'cache')}>缓存后播放</Button><Button disabled={selected.isLive} onClick={() => download([selected.itemId])}>下载</Button><Button onClick={() => void copyText(selected.originalUrl, '链接已复制')}>复制链接</Button></LayoutSlot>
      </LayoutSlot>
    </LayoutSlot>;
    return <Container>
      <LayoutSlot variant="remote-video-result-toolbar"><Container><InlineText>已解析 {items.length} 项 · 已选择 {selectedIds.length} 项</InlineText></Container><Container><Button size="sm" onClick={() => selectIds(items.map((item) => item.itemId))}>全选</Button><Button size="sm" onClick={() => selectIds(items.filter((item) => item.downloadStatus !== 'Downloaded').map((item) => item.itemId))}>选未下载</Button><Button size="sm" onClick={() => selectIds(items.filter((item) => !selectedIds.includes(item.itemId)).map((item) => item.itemId))}>反选</Button><Button size="sm" variant="primary" disabled={selectedIds.length === 0} onClick={() => download(selectedIds)}>下载所选</Button></Container></LayoutSlot>
      <LayoutSlot variant="remote-video-result-grid" role="listbox" aria-label="解析结果">{items.map((item) => <LayoutSlot as="article" variant="remote-video-result-card" role="option" aria-selected={selected?.itemId === item.itemId} tabIndex={0} key={item.itemId} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item.itemId); } }} onClick={() => select(item.itemId)}>
        <Checkbox aria-label={`选择 ${item.title}`} checked={selectedIds.includes(item.itemId)} onClick={(event) => event.stopPropagation()} onChange={(event) => selectIds(event.target.checked ? [...selectedIds, item.itemId] : selectedIds.filter((id) => id !== item.itemId))}/>
        <LayoutSlot variant="remote-video-result-card__media"><RemoteThumbnail source={item.thumbnailUrl} alt={item.title}/><SmallText>{durationText(item.durationSeconds)}</SmallText></LayoutSlot>
        <LayoutSlot variant="remote-video-result-card__copy"><Strong>{item.title}</Strong><Container><InlineText>{item.author || '未知作者'}</InlineText><InlineText>{item.siteName}</InlineText><Badge tone={item.downloadStatus === 'Downloaded' || item.downloadStatus === 'Completed' ? 'success' : 'neutral'}>{downloadText(item.downloadStatus)}</Badge></Container></LayoutSlot>
        <LayoutSlot variant="remote-video-result-card__actions"><Button size="sm" onClick={(event) => { event.stopPropagation(); void play(item, 'direct'); }}>播放</Button><Button size="sm" disabled={item.isLive} onClick={(event) => { event.stopPropagation(); void play(item, 'cache'); }}>缓存</Button><Button size="sm" disabled={item.isLive} onClick={(event) => { event.stopPropagation(); download([item.itemId]); }}>下载</Button></LayoutSlot>
      </LayoutSlot>)}</LayoutSlot>
    </Container>;
}
function DownloadTab({ items, thumbnailFor, refresh, cancel, play, openLocation, remove }: {
    items: DownloadRecord[];
    thumbnailFor: (itemId: string) => string;
    refresh: () => void;
    cancel: (id: string) => void;
    play: (id: string) => void;
    openLocation: (path: string) => void;
    remove: (id: string) => void;
}): React.JSX.Element {
    return <Container><LayoutSlot variant="remote-video-result-toolbar"><Container><Paragraph>包含进行中和已完成的任务</Paragraph></Container><Button onClick={refresh}>刷新</Button></LayoutSlot>{items.length === 0 ? <EmptyState title="暂无下载记录" description="下载任务、速度与进度会显示在这里。"/> : <LayoutSlot variant="remote-video-record-list">{items.map((item) => <LayoutSlot as="article" variant="remote-video-record-card" key={item.taskId}>
      <LayoutSlot variant="remote-video-result-card__media"><RemoteThumbnail source={thumbnailFor(item.itemId)} alt={item.title}/></LayoutSlot>
      <LayoutSlot variant="remote-video-record-card__main"><Container><Strong>{item.title}</Strong><Badge tone={downloadTone(item.status)}>{downloadText(item.status)}</Badge></Container><LayoutSlot variant="remote-video-record-card__meta"><InlineText>{item.author || '未知作者'}</InlineText><InlineText>{fileSize(item.fileSize)}</InlineText><TimeValue>{formatDate(item.createdAt)}</TimeValue>{item.status === 'Running' ? <InlineText>{item.speed} · {item.eta}</InlineText> : null}</LayoutSlot>{item.status === 'Running' || item.status === 'Queued' ? <Container><Meter value={item.progress} max={100}/><InlineText>{item.progress.toFixed(0)}%</InlineText></Container> : null}{item.errorMessage !== '' ? <Paragraph>{item.errorMessage}</Paragraph> : null}</LayoutSlot>
      <LayoutSlot variant="remote-video-record-card__actions">
        <Button size="sm" variant="danger" disabled={item.status !== 'Running' && item.status !== 'Queued'} onClick={() => item.status === 'Running' || item.status === 'Queued' ? cancel(item.taskId) : undefined} visibility={item.status === 'Running' || item.status === 'Queued' ? 'visible' : 'hidden'}>取消</Button>
        <Button size="sm" disabled={item.status !== 'Completed'} onClick={() => item.status === 'Completed' ? play(item.taskId) : undefined} visibility={item.status === 'Completed' ? 'visible' : 'hidden'}>播放</Button>
        <Button size="sm" disabled={item.status !== 'Completed'} onClick={() => item.status === 'Completed' ? openLocation(item.outputPath) : undefined} visibility={item.status === 'Completed' ? 'visible' : 'hidden'}>位置</Button>
        <Button size="sm" variant="danger" disabled={item.status === 'Running' || item.status === 'Queued'} onClick={() => remove(item.taskId)}>删除</Button>
      </LayoutSlot>
    </LayoutSlot>)}</LayoutSlot>}</Container>;
}
function PlayTab({ items, thumbnailFor, refresh, replay }: {
    items: PlayRecord[];
    thumbnailFor: (itemId: string) => string;
    refresh: () => void;
    replay: (id: string) => void;
}): React.JSX.Element {
    return <Container><LayoutSlot variant="remote-video-result-toolbar"><Container><Paragraph>最近共 {items.length} 条记录</Paragraph></Container><Button onClick={refresh}>刷新</Button></LayoutSlot>{items.length === 0 ? <EmptyState title="暂无播放记录" description="直接播放与缓存播放记录会显示在这里。"/> : <LayoutSlot variant="remote-video-record-list">{items.map((item) => <LayoutSlot as="article" variant="remote-video-record-card" key={item.historyId} onDoubleClick={() => replay(item.historyId)}>
      <LayoutSlot variant="remote-video-result-card__media"><RemoteThumbnail source={thumbnailFor(item.itemId ?? '')} alt={item.title}/></LayoutSlot>
      <LayoutSlot variant="remote-video-record-card__main"><Strong>{item.title}</Strong><LayoutSlot variant="remote-video-record-card__meta"><InlineText>{item.author || '未知作者'}</InlineText><InlineText>{item.siteName}</InlineText></LayoutSlot></LayoutSlot>
      <Badge tone="accent">{playActionText(item.action)}</Badge><TimeValue>{formatDate(item.playedAt)}</TimeValue><LayoutSlot variant="remote-video-record-card__actions"><Button size="sm" onClick={() => replay(item.historyId)}>再次播放</Button></LayoutSlot>
    </LayoutSlot>)}</LayoutSlot>}</Container>;
}
function RemoteThumbnail({ source, alt }: { source: string; alt: string }): React.JSX.Element {
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [source]);
    return source.trim() !== '' && !failed ? <MediaImage src={source} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : <Container data-remote-video-thumbnail-empty><UiIcon name="image"/><SmallText>暂无封面</SmallText></Container>;
}
function RemoteToggle({ title, checked, onChange }: {
    title: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}): React.JSX.Element { return <Switch label={title} checked={checked} onChange={(event) => onChange(event.target.checked)}/>; }
function PathInput({ label, value, onChange, browse }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    browse?: boolean;
}): React.JSX.Element { return <Container><Input label={label} value={value} onChange={(event) => onChange(event.target.value)}/>{browse === true ? <Button size="sm" onClick={() => void bridge.dialog.openDirectory().then((response) => { const path = response.payload?.filePaths[0]; if (response.success && path !== undefined)
    onChange(path); })}>浏览</Button> : null}</Container>; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatDate(value?: string | null): string { if (!value)
    return '未知'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN'); }
function durationText(seconds: number): string { if (!Number.isFinite(seconds) || seconds <= 0)
    return '未知'; const total = Math.round(seconds); const h = Math.floor(total / 3600); const m = Math.floor(total % 3600 / 60); const s = total % 60; return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }
function fileSize(bytes: number): string { if (!Number.isFinite(bytes) || bytes <= 0)
    return '未知大小'; const units = ['B', 'KB', 'MB', 'GB']; let value = bytes; let index = 0; while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
} return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`; }
function downloadText(status: string): string { return ({ Queued: '排队中', Running: '下载中', Completed: '已下载', Downloaded: '已下载', Failed: '下载失败', Cancelled: '已取消' } as Record<string, string>)[status] ?? status; }
function downloadTone(status: DownloadStatus): 'neutral' | 'info' | 'success' | 'danger' { return status === 'Completed' ? 'success' : status === 'Running' ? 'info' : status === 'Failed' ? 'danger' : 'neutral'; }
function playActionText(action: string): string { return ({ CachePlay: '缓存播放', DirectStream: '直接播放', Downloaded: '本地播放', Replay: '再次播放' } as Record<string, string>)[action] ?? action; }
